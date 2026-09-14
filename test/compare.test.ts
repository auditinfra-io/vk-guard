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

  // The comparison reports observations. It cannot separate application edits
  // from dependency, SDK or build configuration changes, so none of these may
  // assert a cause.
  const NO_CAUSE = /does not determine the cause/;

  function withSecond(hash: string) {
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
        verificationKeyHash: hash,
        methods: { go: { rows: 10, digest: 'x' } },
      },
    ];
    return { snap, m };
  }

  it('SDK version changed, all measured keys changed: states both, claims neither caused the other', () => {
    const c = compare(snapshot({ o1jsVersion: '2.3.0' }), measured({ verificationKeyHash: '999' }), '2.4.0', false);
    expect(c.o1jsChanged).toBe(true);
    expect(c.allComparedKeysChanged).toBe(true);

    const text = renderComparison(c, false);
    expect(text).toContain('o1js version changed: 2.3.0 -> 2.4.0');
    expect(text).toMatch(NO_CAUSE);
    // No attribution in either direction.
    expect(text).not.toMatch(/as a result|caused|because of|explain/i);
    expect(text).not.toMatch(/must be redeployed|will stop matching/i);
  });

  it('SDK version changed, only some keys changed: does not treat unchanged keys as exculpating', () => {
    const { snap, m } = withSecond('222');
    const c = compare(snap, m, '2.4.0', false);
    expect(c.o1jsChanged).toBe(true);
    expect(c.allComparedKeysChanged).toBe(false);
    expect(c.vkUnchanged).toEqual(['Other']);

    const text = renderComparison(c, false);
    expect(text).toContain('1 of 2 compared verification keys changed');
    expect(text).toMatch(NO_CAUSE);
    expect(text).not.toMatch(/does not explain|cannot explain/i);
  });

  it('SDK version changed and method digests changed: reports both as observations', () => {
    const c = compare(
      snapshot(),
      measured({
        verificationKeyHash: '999',
        methods: { deposit: { rows: 1900, digest: 'CHANGED' }, withdraw: { rows: 3110, digest: 'd2' } },
      }),
      '2.4.0',
      false
    );
    expect(c.methodDigestsChanged).toBe(true);

    const text = renderComparison(c, false);
    expect(text).toContain('Method circuit digests also changed');
    expect(text).toMatch(NO_CAUSE);
    // Must not infer that the user edited source.
    expect(text).not.toMatch(/your own|edits are contributing|not purely the upgrade/i);
  });

  it('SDK version unchanged but keys changed: does not conclude the source changed', () => {
    const c = compare(snapshot(), measured({ verificationKeyHash: '999' }), '2.3.0', false);
    expect(c.o1jsChanged).toBe(false);

    const text = renderComparison(c, false);
    expect(text).toContain('o1js version unchanged (2.3.0)');
    expect(text).toMatch(NO_CAUSE);
    expect(text).not.toMatch(/follows from a change in your own code|your own code/i);
  });

  it('missing key measurements alongside changed keys: uncompared is not counted as unchanged', () => {
    const { snap, m } = withSecond('222');
    delete (m[1] as { verificationKeyHash?: string }).verificationKeyHash;
    const c = compare(snap, m, '2.3.0', false);

    expect(c.vkChanges).toHaveLength(1);
    expect(c.vkNotCompared).toEqual(['Other']);
    expect(c.vkUnchanged).toEqual([]);
    // One key compared, and it changed. The uncompared one is excluded rather
    // than silently treated as unchanged.
    expect(c.allComparedKeysChanged).toBe(true);
    expect(c.failed).toBe(true);
    expect(renderComparison(c, false)).toContain('1 key could not be compared');
  });

  it('zero comparable keys: makes no all-changed claim', () => {
    const snap = snapshot();
    delete snap.contracts.MyContract!.verificationKeyHash;
    const m = measured();
    delete (m[0] as { verificationKeyHash?: string }).verificationKeyHash;

    const c = compare(snap, m, '2.3.0', false);
    expect(c.vkChanges).toEqual([]);
    expect(c.vkUnchanged).toEqual([]);
    // Requires at least one real comparison, so this stays false.
    expect(c.allComparedKeysChanged).toBe(false);
    expect(c.vkNotCompared).toEqual(['MyContract']);
    expect(c.failed).toBe(true);
  });

  it('distinguishes a ZkProgram from a SmartContract in the consequence note', () => {
    const snap = snapshot();
    snap.contracts.MyContract!.kind = 'ZkProgram';
    const m = measured({ kind: 'ZkProgram', verificationKeyHash: '999' });
    const text = renderComparison(compare(snap, m, '2.3.0', false), false);

    expect(text).toContain('ZkProgram has no deployed account of its own');
    expect(text).not.toContain('depending on account permissions');
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

  it('rejects a gate count that cannot be subtracted', () => {
    // A non-numeric count reaches the report as `550 -> x (NaN)`: NaN is never
    // equal to zero, so it survives the "did this move?" filter and is printed
    // as a change. A histogram that cannot be subtracted is a malformed
    // snapshot, and this says so instead.
    const path = join(REPO_ROOT, 'test', '.tmp', 'malformed-gate-types.json');
    mkdirSync(join(REPO_ROOT, 'test', '.tmp'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      o1jsVersion: '3.0.0',
      contracts: {
        Counter: {
          file: 'src/Counter.ts',
          kind: 'SmartContract',
          methods: { increment: { rows: 1, digest: 'd', gateTypes: { Poseidon: 'many' } } },
        },
      },
    }));
    expect(() => readSnapshot(path)).toThrow(
      /gate type "Poseidon" of method "Counter\.increment" must be a non-negative integer/
    );
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
      expect(c.vkChanges).toHaveLength(1);
      expect(c.vkChanges[0]).toMatchObject({ contract: name, before: 'BEFORE', after: 'AFTER' });
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

describe('duplicate names at the compare() boundary', () => {
  // compare() is exported, so a programmatic caller can reach it without going
  // through discovery. The snapshot is keyed by name, so duplicates must be
  // rejected here too rather than silently collapsing.
  const dupe = (name: string, hash: string): Measured => ({
    name,
    file: `src/${hash}.ts`,
    kind: 'SmartContract',
    verificationKeyHash: hash,
    methods: { m: { rows: 1, digest: 'd' } },
  });

  it('throws, naming the conflict and its files', () => {
    expect(() => compare(snapshot(), [dupe('Dup', 'a'), dupe('Dup', 'b')], '2.3.0', false)).toThrow(
      /duplicate target names/i
    );
    try {
      compare(snapshot(), [dupe('Dup', 'a'), dupe('Dup', 'b')], '2.3.0', false);
    } catch (e) {
      expect((e as Error).message).toContain('Dup');
      expect((e as Error).message).toContain('src/a.ts');
      expect((e as Error).message).toContain('src/b.ts');
    }
  });

  it('throws even when the duplicates measured identically', () => {
    const a = dupe('Dup', 'same');
    const b = { ...a, file: 'src/other.ts' };
    expect(() => compare(snapshot(), [a, b], '2.3.0', false)).toThrow(/duplicate target names/i);
  });

  it('rejects a name that collides with Object.prototype too', () => {
    expect(() =>
      compare(snapshot(), [dupe('toString', 'a'), dupe('toString', 'b')], '2.3.0', false)
    ).toThrow(/duplicate target names/i);
  });

  it('accepts distinct names', () => {
    expect(() => compare(snapshot(), [dupe('A', 'a'), dupe('B', 'b')], '2.3.0', false)).not.toThrow();
  });
});
