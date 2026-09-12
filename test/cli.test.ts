import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, runCli, COUNTER, TMP_ROOT, SHARED_CACHE } from './helpers.js';

beforeAll(() => {
  mkdirSync(TMP_ROOT, { recursive: true });
  mkdirSync(SHARED_CACHE, { recursive: true });
});

function readSnap(dir: string) {
  return JSON.parse(readFileSync(join(dir, '.vk-guard.json'), 'utf8'));
}

// Case 1 + Case 9
describe('baseline and unchanged check', () => {
  it('update writes a snapshot and a subsequent check passes', () => {
    const dir = makeProject('unchanged', { 'src/Counter.ts': COUNTER });

    const update = runCli(dir, ['update']);
    expect(update.code, update.all).toBe(0);

    const snap = readSnap(dir);
    expect(snap.o1jsVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(snap.contracts.Counter.verificationKeyHash).toMatch(/^\d+$/);
    expect(Object.keys(snap.contracts.Counter.methods).sort()).toEqual(['increment', 'reset']);

    const check = runCli(dir, ['check']);
    expect(check.code, check.all).toBe(0);
    expect(check.stdout).toContain('No drift');
    // The summary must always attribute the silence to real work.
    expect(check.stdout).toMatch(/1 contract, 2 methods, o1js /);
  });
});

// Case 2
describe('a changed method body', () => {
  it('fails and reports verification key drift', () => {
    const dir = makeProject('changed-body', { 'src/Counter.ts': COUNTER });
    expect(runCli(dir, ['update']).code).toBe(0);
    const before = readSnap(dir).contracts.Counter.verificationKeyHash;

    // Replace the arithmetic: a genuinely different circuit.
    writeFileSync(
      join(dir, 'src/Counter.ts'),
      COUNTER.replace('this.count.set(current.add(by));', 'this.count.set(current.mul(by).add(by));')
    );

    const check = runCli(dir, ['check']);
    expect(check.code, check.all).toBe(1);
    expect(check.stdout).toContain('verification key changed');
    expect(check.stdout).toContain('Counter');
    expect(check.stdout).toContain('Counter.increment()');
    // o1js did not move, so this must read as the user's own edit.
    expect(check.stdout).toContain('follows from a change in your own code');
    expect(readSnap(dir).contracts.Counter.verificationKeyHash).toBe(before);
  });
});

// Case 3: the mutation test. Case 1's project, plus exactly one extra constraint.
describe('mutation test', () => {
  it('detects a single added constraint', () => {
    const dir = makeProject('mutation', { 'src/Counter.ts': COUNTER });
    expect(runCli(dir, ['update']).code).toBe(0);
    const baseRows = readSnap(dir).contracts.Counter.methods.increment.rows;

    // One extra constraint, nothing else changed.
    writeFileSync(
      join(dir, 'src/Counter.ts'),
      COUNTER.replace(
        '    this.count.set(current.add(by));',
        '    const next = current.add(by);\n    next.assertNotEquals(Field(999983));\n    this.count.set(next);'
      )
    );

    const check = runCli(dir, ['check']);
    expect(check.code, check.all).toBe(1);
    expect(check.stdout).toContain('Counter.increment()');
    expect(check.stdout).toContain(`${baseRows} -> ${baseRows + 1} rows (+1)`);
    expect(check.stdout).toContain('verification key changed');
  });

  it('detects the added constraint on the rows-only fast path too', () => {
    const dir = makeProject('mutation-rows', { 'src/Counter.ts': COUNTER });
    expect(runCli(dir, ['update', '--rows-only']).code).toBe(0);
    writeFileSync(
      join(dir, 'src/Counter.ts'),
      COUNTER.replace(
        '    this.count.set(current.add(by));',
        '    const next = current.add(by);\n    next.assertNotEquals(Field(999983));\n    this.count.set(next);'
      )
    );
    const check = runCli(dir, ['check', '--rows-only']);
    expect(check.code, check.all).toBe(1);
    expect(check.stdout).toContain('Counter.increment()');
  });
});

// Case 4
describe('a comment-only edit', () => {
  it('does not move the verification key', () => {
    const dir = makeProject('comment-only', { 'src/Counter.ts': COUNTER });
    expect(runCli(dir, ['update']).code).toBe(0);

    const reformatted = COUNTER.replace(
      'export class Counter extends SmartContract {',
      '/** A counter. This comment is new. */\nexport class Counter extends SmartContract {\n  // formatting only'
    ).replace(
      '    this.count.set(current.add(by));',
      '    this.count.set(\n      current.add(by)\n    ); // reformatted'
    );
    writeFileSync(join(dir, 'src/Counter.ts'), reformatted);

    const check = runCli(dir, ['check']);
    // If this ever fails, the finding is about o1js's VK stability, not vk-guard.
    expect(check.code, `VK moved on a comment-only edit:\n${check.all}`).toBe(0);
    expect(check.stdout).toContain('No drift');
  });
});

// Case 6
describe('zero contracts discovered', () => {
  it('exits 1 and never 0', () => {
    const dir = makeProject('empty', {
      'src/util.ts': 'export const helper = (a: number) => a + 1;\n',
    });
    const check = runCli(dir, ['check']);
    expect(check.code, check.all).toBe(1);
    expect(check.stdout).toContain('no contracts found; check --entry');
  });

  it('exits 1 on update too, rather than writing an empty baseline', () => {
    const dir = makeProject('empty-update', {
      'src/util.ts': 'export const helper = (a: number) => a + 1;\n',
    });
    const update = runCli(dir, ['update']);
    expect(update.code, update.all).toBe(1);
  });

  it('exits 1 when the entry glob matches nothing at all', () => {
    const dir = makeProject('no-match', { 'src/Counter.ts': COUNTER });
    const check = runCli(dir, ['check', '--entry', 'contracts/**/*.ts']);
    expect(check.code, check.all).toBe(1);
    expect(check.stdout).toContain('no contracts found');
  });
});

// Case 7
describe('a contract that fails to compile', () => {
  it('exits 1 with the error surfaced, and never skips it', () => {
    const dir = makeProject('broken', {
      'src/Broken.ts': `import { SmartContract, method, Field } from 'o1js';

export class Broken extends SmartContract {
  @method async boom(x: Field) {
    throw new Error('circuit construction exploded');
  }
}
`,
    });
    const check = runCli(dir, ['check']);
    expect(check.code, check.all).toBe(1);
    expect(check.all).toContain('Broken');
    expect(check.all).toContain('circuit construction exploded');
    expect(check.all).toContain('rather than skipping it');
  });
});

// Case 8
describe('--rows-only', () => {
  it('never writes verificationKeyHash entries', () => {
    const dir = makeProject('rows-only-write', { 'src/Counter.ts': COUNTER });
    const update = runCli(dir, ['update', '--rows-only']);
    expect(update.code, update.all).toBe(0);

    const raw = readFileSync(join(dir, '.vk-guard.json'), 'utf8');
    expect(raw).not.toContain('verificationKeyHash');
    const snap = JSON.parse(raw);
    expect(snap.rowsOnly).toBe(true);
    expect(snap.contracts.Counter.methods.increment.rows).toBeGreaterThan(0);

    const check = runCli(dir, ['check', '--rows-only']);
    expect(check.code, check.all).toBe(0);
    expect(check.stdout).toContain('rows-only');
  });

  it('never reads verificationKeyHash entries from a full snapshot', () => {
    const dir = makeProject('rows-only-read', { 'src/Counter.ts': COUNTER });
    expect(runCli(dir, ['update']).code).toBe(0);

    // Corrupt only the VK hash. A rows-only check must not consult it.
    const snap = readSnap(dir);
    snap.contracts.Counter.verificationKeyHash = 'DEFINITELY_NOT_THE_REAL_HASH';
    writeFileSync(join(dir, '.vk-guard.json'), JSON.stringify(snap, null, 2));

    const check = runCli(dir, ['check', '--rows-only']);
    expect(check.code, check.all).toBe(0);
  });

  it('refuses a full check against a rows-only snapshot instead of passing vacuously', () => {
    const dir = makeProject('rows-only-mismatch', { 'src/Counter.ts': COUNTER });
    expect(runCli(dir, ['update', '--rows-only']).code).toBe(0);
    const check = runCli(dir, ['check']);
    expect(check.code, check.all).toBe(1);
    expect(check.stdout).toContain('--rows-only');
  });
});

describe('missing snapshot', () => {
  it('fails rather than silently passing', () => {
    const dir = makeProject('no-snapshot', { 'src/Counter.ts': COUNTER });
    const check = runCli(dir, ['check', '--rows-only']);
    expect(check.code, check.all).toBe(1);
    expect(check.stdout).toContain('no snapshot at');
  });
});

describe('--json', () => {
  it('emits parseable output with the drift details', () => {
    const dir = makeProject('json-out', { 'src/Counter.ts': COUNTER });
    expect(runCli(dir, ['update', '--rows-only']).code).toBe(0);
    writeFileSync(
      join(dir, 'src/Counter.ts'),
      COUNTER.replace(
        '    this.count.set(current.add(by));',
        '    const next = current.add(by);\n    next.assertNotEquals(Field(999983));\n    this.count.set(next);'
      )
    );
    const check = runCli(dir, ['check', '--rows-only', '--json']);
    expect(check.code).toBe(1);
    const parsed = JSON.parse(check.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.mode).toBe('rows-only');
    expect(parsed.contractsChecked).toBe(1);
    expect(parsed.rowChanges[0].delta).toBe(1);
    expect(parsed.methodDigestChanges[0].method).toBe('increment');
  });
});

// Case 5, end to end: a snapshot recorded under a different o1js version.
// Installing two o1js versions side by side is impractical in a test, so the
// snapshot is rewritten to describe a prior version whose keys differed —
// which is exactly the state a real upgrade leaves behind.
describe('snapshot recorded under a different o1js version', () => {
  it('gives the version-change message, not the ordinary drift message', () => {
    const dir = makeProject('version-change', { 'src/Counter.ts': COUNTER });
    expect(runCli(dir, ['update']).code).toBe(0);

    const snap = readSnap(dir);
    const realVersion = snap.o1jsVersion;
    snap.o1jsVersion = '0.0.1-previous';
    snap.contracts.Counter.verificationKeyHash = '12345678901234567890123456789012345678901234567890';
    writeFileSync(join(dir, '.vk-guard.json'), JSON.stringify(snap, null, 2));

    const check = runCli(dir, ['check']);
    expect(check.code, check.all).toBe(1);
    expect(check.stdout).toContain(`o1js 0.0.1-previous -> ${realVersion}`);
    expect(check.stdout).toContain('must be redeployed');
    // Crucially, it must NOT read as a regression in the user's own code.
    expect(check.stdout).not.toContain('follows from a change in your own code');
    // Circuits did not move, so it must not hedge about the user's edits either.
    expect(check.stdout).not.toContain('not purely the upgrade');
  });

  it('still blames the code when o1js moved but some keys held steady', () => {
    const dir = makeProject('version-change-partial', {
      'src/Counter.ts': COUNTER,
      'src/Other.ts': `import { SmartContract, state, State, method, Field } from 'o1js';

export class Other extends SmartContract {
  @state(Field) v = State<Field>();

  @method async touch(x: Field) {
    this.v.set(this.v.getAndRequireEquals().add(x));
  }
}
`,
    });
    expect(runCli(dir, ['update']).code).toBe(0);

    // Only one key is stale; the other still matches the working tree.
    const snap = readSnap(dir);
    snap.o1jsVersion = '0.0.1-previous';
    snap.contracts.Counter.verificationKeyHash = '999';
    writeFileSync(join(dir, '.vk-guard.json'), JSON.stringify(snap, null, 2));

    const check = runCli(dir, ['check']);
    expect(check.code, check.all).toBe(1);
    expect(check.stdout).toContain('does not explain this');
    expect(check.stdout).not.toContain('All 1 verification key changed as a result');
  });
});
