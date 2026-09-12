import { describe, it, expect } from 'vitest';
import { compare } from '../src/compare.js';
import { renderComparison, summaryLine } from '../src/report.js';
import { serializeSnapshot } from '../src/snapshot.js';
import { VK_GUARD_VERSION } from '../src/index.js';
import { readFileSync } from 'node:fs';
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
          methods: { withdraw: { rows: 3110 } },
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
        methods: { withdraw: { rows: 3150 } },
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
          methods: { withdraw: { rows: 3110 } },
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
        methods: { withdraw: { rows: 3500 } },
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

describe('summary line', () => {
  it('states what was actually checked', () => {
    expect(summaryLine(measured(), '2.4.0', false)).toBe('1 contract, 2 methods, o1js 2.4.0');
  });

  it('marks the rows-only fast path', () => {
    expect(summaryLine(measured(), '2.4.0', true)).toContain('rows-only');
  });
});

describe('package metadata', () => {
  // The snapshot records vkGuardVersion; a drifting constant would misattribute
  // which version of the tool produced a baseline.
  it('keeps VK_GUARD_VERSION in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(VK_GUARD_VERSION).toBe(pkg.version);
  });
});
