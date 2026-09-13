import { describe, it, expect } from 'vitest';
import { compare } from '../src/compare.js';
import { renderComparison, summaryLine } from '../src/report.js';
import { readSnapshot, serializeSnapshot } from '../src/snapshot.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers.js';
import type { Snapshot, Measured } from '../src/types.js';

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    vkGuardVersion: '0.1.0',
    o1jsVersion: '2.3.0',
    contracts: {
      MyContract: {
        file: 'src/MyContract.ts',
        kind: 'SmartContract',
        verificationKeyHash: '111',
        methods: { deposit: { rows: 1842, digest: 'd1' }, withdraw: { rows: 3110, digest: 'd2' } },
      },
    },
    ...over,
  };
}

function measured(over: Partial<Measured> = {}): Measured[] {
  return [
    {
      name: 'MyContract',
      file: 'src/MyContract.ts',
      kind: 'SmartContract',
      verificationKeyHash: '111',
      methods: { deposit: { rows: 1842, digest: 'd1' }, withdraw: { rows: 3110, digest: 'd2' } },
      ...over,
    },
  ];
}

describe('compare', () => {
  it('reports no drift when nothing changed', () => {
    const c = compare(snapshot(), measured(), '2.3.0', false);
    expect(c.failed).toBe(false);
    expect(c.vkChanges).toHaveLength(0);
    expect(c.comparedContracts).toBe(1);
    expect(c.comparedMethods).toBe(2);
  });

  // Case 5: the single most valuable distinction the tool makes.
  it('uses the distinct version-change message when o1js moved and all VKs moved', () => {
    const c = compare(snapshot({ o1jsVersion: '2.3.0' }), measured({ verificationKeyHash: '999' }), '2.4.0', false);
    expect(c.o1jsChanged).toBe(true);
    expect(c.versionChangeExplainsVk).toBe(true);

    const text = renderComparison(c, false);
    expect(text).toContain('o1js 2.3.0 -> 2.4.0');
    expect(text).toContain('must be redeployed');
    // It must NOT read as an ordinary regression in the user's own code.
    expect(text).not.toContain('follows from a change in your own code');
  });

  it('uses the ordinary regression message when o1js is unchanged', () => {
    const c = compare(snapshot(), measured({ verificationKeyHash: '999' }), '2.3.0', false);
    expect(c.versionChangeExplainsVk).toBe(false);

    const text = renderComparison(c, false);
    expect(text).toContain('follows from a change in your own code');
    expect(text).not.toContain('-> 2.4.0');
  });

  it('does not blame the version when some VKs held steady', () => {
    const snap = snapshot();
    snap.contracts.Other = {
      file: 'src/Other.ts',
      kind: 'SmartContract',
      verificationKeyHash: '222',
      methods: { go: { rows: 10, digest: 'x' } },
    };
    const m = [
      ...measured({ verificationKeyHash: '999' }),
      {
        name: 'Other',
        file: 'src/Other.ts',
        kind: 'SmartContract' as const,
        verificationKeyHash: '222',
        methods: { go: { rows: 10, digest: 'x' } },
      },
    ];
    const c = compare(snap, m, '2.4.0', false);
    expect(c.o1jsChanged).toBe(true);
    expect(c.versionChangeExplainsVk).toBe(false);
    expect(renderComparison(c, false)).toContain('does not explain this');
  });

  it('notes when circuits changed alongside an o1js upgrade', () => {
    const c = compare(
      snapshot(),
      measured({
        verificationKeyHash: '999',
        methods: { deposit: { rows: 1900, digest: 'CHANGED' }, withdraw: { rows: 3110, digest: 'd2' } },
      }),
      '2.4.0',
      false
    );
    expect(c.versionChangeExplainsVk).toBe(true);
    expect(c.circuitsAlsoChanged).toBe(true);
    expect(renderComparison(c, false)).toContain('not purely the upgrade');
  });
});

describe('row tolerance', () => {
  it('passes a row change within tolerance but still prints it', () => {
    const snap = snapshot({
      contracts: {
        MyContract: {
          file: 'src/MyContract.ts',
          kind: 'SmartContract',
          verificationKeyHash: '111',
          // Equal digests on both sides: this fixture stands for a normal
          // project whose row count moved within tolerance. Every snapshot
          // `vk-guard update` writes carries a per-method digest (see
          // examples/counter/.vk-guard.json), so leaving them out would make
          // the fixture also exercise a missing-digest coverage hole — a
          // different condition, which now fails on its own.
          methods: { withdraw: { rows: 3110, digest: 'w1' } },
        },
      },
      config: { rowTolerance: { default: 0, 'MyContract.withdraw': 100 } },
    });
    const m: Measured[] = [
      {
        name: 'MyContract',
        file: 'src/MyContract.ts',
        kind: 'SmartContract',
        verificationKeyHash: '111',
        methods: { withdraw: { rows: 3150, digest: 'w1' } },
      },
    ];
    const c = compare(snap, m, '2.3.0', false);
    expect(c.failed).toBe(false);
    expect(c.rowChanges[0]!.withinTolerance).toBe(true);
    expect(renderComparison(c, false)).toContain('within tolerance');
  });

  it('fails a row change beyond tolerance', () => {
    const snap = snapshot({
      contracts: {
        MyContract: {
          file: 'src/MyContract.ts',
          kind: 'SmartContract',
          verificationKeyHash: '111',
          // Digests present so this test stays sensitive to the ROW logic:
          // without them the missing-digest guard would fail the run on its
          // own, and a broken tolerance would still look caught.
          methods: { withdraw: { rows: 3110, digest: 'w1' } },
        },
      },
      config: { rowTolerance: { 'MyContract.withdraw': 10 } },
    });
    const m: Measured[] = [
      {
        name: 'MyContract',
        file: 'src/MyContract.ts',
        kind: 'SmartContract',
        verificationKeyHash: '111',
        methods: { withdraw: { rows: 3500, digest: 'w1' } },
      },
    ];
    expect(compare(snap, m, '2.3.0', false).failed).toBe(true);
  });

  // The explicit guarantee from the brief: tolerance is a row-count concept only.
  it('never lets a tolerance silence a verification key change', () => {
    const snap = snapshot({ config: { rowTolerance: { default: 1_000_000 } } });
    const c = compare(snap, measured({ verificationKeyHash: 'DIFFERENT' }), '2.3.0', false);
    expect(c.failed).toBe(true);
    expect(c.vkChanges).toHaveLength(1);
  });

  it('never lets a tolerance silence a circuit digest change', () => {
    const snap = snapshot({ config: { rowTolerance: { default: 1_000_000 } } });
    const c = compare(
      snap,
      measured({ methods: { deposit: { rows: 1843, digest: 'MOVED' }, withdraw: { rows: 3110, digest: 'd2' } } }),
      '2.3.0',
      true
    );
    expect(c.failed).toBe(true);
    expect(c.methodDigestChanges).toEqual([{ contract: 'MyContract', method: 'deposit' }]);
  });
});

describe('snapshot entries with no matching contract', () => {
  it('reports them explicitly rather than passing', () => {
    const c = compare(snapshot(), [], '2.3.0', false);
    expect(c.failed).toBe(true);
    expect(c.removedContracts).toEqual([{ name: 'MyContract', file: 'src/MyContract.ts' }]);

    const text = renderComparison(c, false);
    expect(text).toContain('removed');
    expect(text).toContain('renamed');
    expect(text).toContain('--entry');
  });

  it('reports a contract that is new to the snapshot', () => {
    const c = compare(snapshot({ contracts: {} }), measured(), '2.3.0', false);
    expect(c.failed).toBe(true);
    expect(c.addedContracts).toEqual(['MyContract']);
  });
});

describe('snapshot serialization', () => {
  it('orders keys stably regardless of insertion order', () => {
    const a = serializeSnapshot(snapshot());
    const reordered = snapshot();
    reordered.contracts = {
      Zebra: { file: 'src/Z.ts', kind: 'SmartContract', verificationKeyHash: '1', methods: { b: { rows: 1 }, a: { rows: 2 } } },
      Alpha: { file: 'src/A.ts', kind: 'SmartContract', verificationKeyHash: '2', methods: { z: { rows: 1 } } },
    };
    const text = serializeSnapshot(reordered);
    expect(text.indexOf('Alpha')).toBeLessThan(text.indexOf('Zebra'));
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
    expect(a).toBe(serializeSnapshot(snapshot()));
  });

  it('never stores verificationKey.data', () => {
    expect(serializeSnapshot(snapshot())).not.toContain('"data"');
  });
});

describe('snapshot validation', () => {
  it('rejects malformed method data with an actionable error', () => {
    const path = join(REPO_ROOT, 'test', '.tmp', 'malformed-snapshot.json');
    mkdirSync(join(REPO_ROOT, 'test', '.tmp'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      o1jsVersion: '3.0.0',
      contracts: {
        Counter: { file: 'src/Counter.ts', kind: 'SmartContract', methods: { increment: { rows: -1 } } },
      },
    }));
    expect(() => readSnapshot(path)).toThrow(/Counter\.increment.*non-negative integer.*vk-guard update/);
  });

  it('rejects invalid row tolerances before comparison', () => {
    const path = join(REPO_ROOT, 'test', '.tmp', 'malformed-config.json');
    mkdirSync(join(REPO_ROOT, 'test', '.tmp'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      o1jsVersion: '3.0.0', config: { rowTolerance: { default: -1 } }, contracts: {},
    }));
    expect(() => readSnapshot(path)).toThrow(/row tolerance "default" must be a non-negative number/);
  });

  it('preserves __proto__ as an own contract and method key', () => {
    const path = join(REPO_ROOT, 'test', '.tmp', 'prototype-named-contract.json');
    const contract = {
      file: 'src/Prototype.ts',
      kind: 'SmartContract',
      methods: Object.fromEntries([['__proto__', { rows: 1, digest: 'method-digest' }]]),
    };
    writeFileSync(path, JSON.stringify({
      o1jsVersion: '3.0.0',
      contracts: Object.fromEntries([['__proto__', contract]]),
    }));

    const parsed = readSnapshot(path);
    expect(Object.hasOwn(parsed.contracts, '__proto__')).toBe(true);
    expect(Object.hasOwn(parsed.contracts.__proto__!.methods, '__proto__')).toBe(true);

    const serialized = JSON.parse(serializeSnapshot(parsed)) as Snapshot;
    expect(Object.hasOwn(serialized.contracts, '__proto__')).toBe(true);
    expect(Object.hasOwn(serialized.contracts.__proto__!.methods, '__proto__')).toBe(true);
  });
});

describe('summary line', () => {
  it('states what was actually checked', () => {
    expect(summaryLine(measured(), '2.4.0', false)).toBe('1 contract, 2 methods, o1js 2.4.0');
  });

  it('marks the rows-only fast path', () => {
    expect(summaryLine(measured(), '2.4.0', true)).toContain('rows-only');
  });
});

// Contract and method names come from the user's project and from hand-edited
// JSON, so they can collide with Object.prototype members. Before the `own()`
// guard, a contract named `toString` was found on the prototype, treated as a
// snapshot entry with no verificationKeyHash, and its key comparison silently
// skipped — reporting no drift. These lock that false pass shut.
describe('names that collide with Object.prototype', () => {
  const PROTO_NAMES = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'];

  for (const name of PROTO_NAMES) {
    it(`treats a contract named "${name}" as new when the snapshot lacks it`, () => {
      const snap: Snapshot = {
        vkGuardVersion: '0.1.0',
        o1jsVersion: '3.0.0',
        contracts: {},
      };
      const m: Measured[] = [
        {
          name,
          file: 'src/Odd.ts',
          kind: 'SmartContract',
          verificationKeyHash: 'abc',
          methods: { go: { rows: 10, digest: 'd' } },
        },
      ];
      const c = compare(snap, m, '3.0.0', false);
      expect(c.addedContracts).toEqual([name]);
      expect(c.comparedContracts).toBe(0);
      expect(c.failed).toBe(true);
    });

    it(`still compares the verification key of a contract named "${name}"`, () => {
      const snap: Snapshot = {
        vkGuardVersion: '0.1.0',
        o1jsVersion: '3.0.0',
        contracts: {
          [name]: {
            file: 'src/Odd.ts',
            kind: 'SmartContract',
            verificationKeyHash: 'BEFORE',
            methods: { go: { rows: 10, digest: 'd' } },
          },
        },
      };
      const m: Measured[] = [
        {
          name,
          file: 'src/Odd.ts',
          kind: 'SmartContract',
          verificationKeyHash: 'AFTER',
          methods: { go: { rows: 10, digest: 'd' } },
        },
      ];
      const c = compare(snap, m, '3.0.0', false);
      expect(c.comparedContracts).toBe(1);
      expect(c.vkChanges).toEqual([{ contract: name, before: 'BEFORE', after: 'AFTER' }]);
      expect(c.failed).toBe(true);
    });
  }

  it('treats a method named "toString" as new rather than inheriting one', () => {
    const snap: Snapshot = {
      vkGuardVersion: '0.1.0',
      o1jsVersion: '3.0.0',
      contracts: {
        C: { file: 'src/C.ts', kind: 'SmartContract', verificationKeyHash: 'k', methods: {} },
      },
    };
    const m: Measured[] = [
      {
        name: 'C',
        file: 'src/C.ts',
        kind: 'SmartContract',
        verificationKeyHash: 'k',
        methods: { toString: { rows: 5, digest: 'd' } },
      },
    ];
    const c = compare(snap, m, '3.0.0', false);
    expect(c.addedMethods).toEqual([{ contract: 'C', method: 'toString' }]);
    expect(c.comparedMethods).toBe(0);
  });

  it('does not inherit a row tolerance from Object.prototype', () => {
    const snap: Snapshot = {
      vkGuardVersion: '0.1.0',
      o1jsVersion: '3.0.0',
      // No tolerance is configured for anything, so the default of 0 must apply
      // even though `rowTolerance.constructor` resolves on the prototype.
      config: { rowTolerance: {} },
      contracts: {
        // `constructor` as a key collides with Object.prototype, which also
        // defeats TypeScript's contextual typing here — hence the assertion.
        constructor: {
          file: 'src/C.ts',
          kind: 'SmartContract' as const,
          verificationKeyHash: 'k',
          methods: { go: { rows: 10, digest: 'd' } },
        },
      },
    };
    const m: Measured[] = [
      {
        name: 'constructor',
        file: 'src/C.ts',
        kind: 'SmartContract',
        verificationKeyHash: 'k',
        methods: { go: { rows: 99, digest: 'd' } },
      },
    ];
    const c = compare(snap, m, '3.0.0', false);
    expect(c.rowChanges[0]!.tolerance).toBe(0);
    expect(c.rowChanges[0]!.withinTolerance).toBe(false);
    expect(c.failed).toBe(true);
  });
});

describe('gate type changes', () => {
  const withGates = (
    rows: number,
    digest: string,
    gateTypes: Record<string, number>
  ) => ({
    file: 'src/C.ts',
    kind: 'SmartContract' as const,
    verificationKeyHash: 'k',
    methods: { m: { rows, digest, gateTypes } },
  });

  function snapWith(gateTypes: Record<string, number>, rows = 615, digest = 'd1'): Snapshot {
    return {
      vkGuardVersion: '0.1.0',
      o1jsVersion: '3.0.0',
      contracts: { C: withGates(rows, digest, gateTypes) },
    };
  }
  function measuredWith(gateTypes: Record<string, number>, rows = 626, digest = 'd2'): Measured[] {
    return [{ name: 'C', ...withGates(rows, digest, gateTypes) }];
  }

  // Adding one Poseidon hash costs 11 rows. The report should say that in gate
  // terms, not merely that a number moved.
  it('reports which gate types grew and shrank', () => {
    const c = compare(
      snapWith({ Poseidon: 550, Zero: 50, Generic: 15 }),
      measuredWith({ Poseidon: 561, Zero: 51, Generic: 14 }),
      '3.0.0',
      true
    );
    expect(c.gateTypeChanges).toEqual([
      {
        contract: 'C',
        method: 'm',
        deltas: [
          { type: 'Poseidon', before: 550, after: 561, delta: 11 },
          { type: 'Generic', before: 15, after: 14, delta: -1 },
          { type: 'Zero', before: 50, after: 51, delta: 1 },
        ],
      },
    ]);
    expect(renderComparison(c, true)).toContain('Poseidon        550 -> 561');
  });

  it('says nothing when the snapshot predates gate histograms', () => {
    const snap: Snapshot = {
      vkGuardVersion: '0.1.0',
      o1jsVersion: '3.0.0',
      contracts: {
        C: {
          file: 'src/C.ts',
          kind: 'SmartContract',
          verificationKeyHash: 'k',
          methods: { m: { rows: 615, digest: 'd1' } },
        },
      },
    };
    const c = compare(snap, measuredWith({ Poseidon: 561 }), '3.0.0', true);
    expect(c.methodDigestChanges).toHaveLength(1);
    // No histogram to compare against, so no claim is made either way.
    expect(c.gateTypeChanges).toEqual([]);
    expect(renderComparison(c, true)).not.toContain('Gate types that moved');
  });

  it('does not report gate changes when the circuit is unchanged', () => {
    const same = { Poseidon: 550, Generic: 15 };
    const c = compare(snapWith(same), measuredWith(same, 615, 'd1'), '3.0.0', true);
    expect(c.gateTypeChanges).toEqual([]);
    expect(c.failed).toBe(false);
  });

  it('reports a gate type appearing for the first time', () => {
    const c = compare(
      snapWith({ Generic: 10 }),
      measuredWith({ Generic: 10, Rot64: 8 }),
      '3.0.0',
      true
    );
    expect(c.gateTypeChanges[0]!.deltas).toEqual([
      { type: 'Rot64', before: 0, after: 8, delta: 8 },
    ]);
  });
});

describe('a baseline field that is absent cannot read as unchanged', () => {
  // `verificationKeyHash` and the per-method `digest` are optional in the
  // snapshot schema, but every snapshot `vk-guard update` writes carries both.
  // A field that goes missing afterwards — a merge-conflict resolution in
  // .vk-guard.json is the likely route — used to leave the comparison silently
  // skipped while the contract was still counted in `comparedContracts`.
  //
  // Measured before this change, with a genuinely changed key:
  //   VK present in the snapshot -> vkChanges=1  failed=true
  //   VK absent  from the snapshot -> vkChanges=0  failed=FALSE
  //
  // Both runs report `comparedContracts: 1`. This is the same false pass the
  // `own()` helper guards against one field over, reached by another route.

  function snapshotWithoutVk(): Snapshot {
    const s = snapshot();
    delete (s.contracts.MyContract as { verificationKeyHash?: string }).verificationKeyHash;
    return s;
  }

  it('fails when the snapshot has no verification key to compare', () => {
    const c = compare(snapshotWithoutVk(), measured({ verificationKeyHash: '222' }), '2.3.0', false);
    expect(c.vkNotCompared).toEqual(['MyContract']);
    expect(c.failed).toBe(true);
  });

  it('does not report the absent key as unchanged', () => {
    const c = compare(snapshotWithoutVk(), measured({ verificationKeyHash: '222' }), '2.3.0', false);
    expect(c.vkUnchanged).toEqual([]);
    expect(c.vkChanges).toEqual([]);
  });

  it('says so in the report, rather than printing a clean run', () => {
    const c = compare(snapshotWithoutVk(), measured({ verificationKeyHash: '222' }), '2.3.0', false);
    const out = renderComparison(c, false);
    expect(out).toContain('No verification key to compare');
    expect(out).toContain('MyContract');
    expect(out).toContain('vk-guard update');
  });

  it('still fails when the key would not have changed anyway', () => {
    // The point is the missing evidence, not the value behind it. A run that
    // cannot check is not a run that checked and found nothing.
    const c = compare(snapshotWithoutVk(), measured(), '2.3.0', false);
    expect(c.vkNotCompared).toEqual(['MyContract']);
    expect(c.failed).toBe(true);
  });

  it('fails when a method has no digest to compare', () => {
    const s = snapshot();
    delete (s.contracts.MyContract!.methods.withdraw as { digest?: string }).digest;
    const c = compare(s, measured(), '2.3.0', false);
    expect(c.digestNotCompared).toEqual([{ contract: 'MyContract', method: 'withdraw' }]);
    expect(c.failed).toBe(true);
    expect(renderComparison(c, false)).toContain('No circuit digest to compare');
  });

  it('leaves a complete snapshot passing exactly as before', () => {
    const c = compare(snapshot(), measured(), '2.3.0', false);
    expect(c.vkNotCompared).toEqual([]);
    expect(c.digestNotCompared).toEqual([]);
    expect(c.vkUnchanged).toEqual(['MyContract']);
    expect(c.failed).toBe(false);
  });

  it('does not fire on --rows-only, where skipping the key is the point', () => {
    // A rows-only run never measures a key, so "not compared" would be noise on
    // every contract. The whole-snapshot guard in index.ts already refuses the
    // dangerous direction: a FULL check against a rows-only snapshot.
    const m = measured();
    delete (m[0] as { verificationKeyHash?: string }).verificationKeyHash;
    const c = compare(snapshot(), m, '2.3.0', true);
    expect(c.vkNotCompared).toEqual([]);
    expect(c.failed).toBe(false);
  });
});
