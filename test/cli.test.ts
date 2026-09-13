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
    expect(check.stdout).toMatch(/compared verification keys? changed/);
    expect(check.stdout).toContain('Counter');
    expect(check.stdout).toContain('Counter.increment()');
    // The o1js version is reported as a fact, not as an exoneration, and the
    // unchanged version must not be turned into a claim about the source.
    expect(check.stdout).toContain('o1js version unchanged');
    expect(check.stdout).toContain('does not determine the cause');
    expect(check.stdout).not.toMatch(/your own code|must be redeployed/i);
    // A failed check never rewrites the baseline.
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
describe('a snapshot recorded under a different o1js version', () => {
  it('reports the version change and the key difference without attributing one to the other', () => {
    const dir = makeProject('version-change', { 'src/Counter.ts': COUNTER });
    expect(runCli(dir, ['update']).code).toBe(0);

    const snap = readSnap(dir);
    const realVersion = snap.o1jsVersion;
    snap.o1jsVersion = '0.0.1-previous';
    snap.contracts.Counter.verificationKeyHash = '12345678901234567890123456789012345678901234567890';
    writeFileSync(join(dir, '.vk-guard.json'), JSON.stringify(snap, null, 2));

    const check = runCli(dir, ['check']);
    expect(check.code, check.all).toBe(1);

    // Both facts are reported.
    expect(check.stdout).toContain(`o1js version changed: 0.0.1-previous -> ${realVersion}`);
    expect(check.stdout).toContain('verification key');
    // Neither is presented as the cause of the other.
    expect(check.stdout).toContain('does not determine the cause');
    expect(check.stdout).not.toMatch(/as a result|must be redeployed|will stop matching/i);
    expect(check.stdout).not.toMatch(/follows from a change in your own code/i);

    // Conditional consequences, not asserted deployment breakage.
    expect(check.stdout).toContain('If an account still holds a previous key');
    expect(check.stdout).toContain('reads no chain state');
  });
});

describe('duplicate target names', () => {
  // Two distinct classes that both end up named "Counter". A snapshot is keyed
  // by name, so without rejection one would overwrite the other and the
  // overwritten contract would be silently unguarded.
  const DUPE_A = `import { SmartContract, state, State, method, Field } from 'o1js';

export class Counter extends SmartContract {
  @state(Field) count = State<Field>();
  @method async a(by: Field) {
    this.count.set(this.count.getAndRequireEquals().add(by));
  }
}
`;
  const DUPE_B = `import { SmartContract, state, State, method, Field } from 'o1js';

export class Counter extends SmartContract {
  @state(Field) total = State<Field>();
  @method async b(by: Field) {
    this.total.set(this.total.getAndRequireEquals().mul(by));
  }
}
`;

  it('fails check, naming each conflict and its files', () => {
    const dir = makeProject('dupe-check', { 'src/A.ts': DUPE_A, 'src/B.ts': DUPE_B });
    const res = runCli(dir, ['check', '--rows-only']);
    expect(res.code, res.all).toBe(1);
    expect(res.all).toContain('duplicate target name');
    expect(res.all).toContain('Counter');
    expect(res.all).toContain('src/A.ts');
    expect(res.all).toContain('src/B.ts');
    expect(res.all).toMatch(/unique name|--entry/);
  });

  it('fails update and leaves an existing baseline byte-for-byte unchanged', () => {
    const dir = makeProject('dupe-update', { 'src/A.ts': DUPE_A });
    expect(runCli(dir, ['update', '--rows-only']).code).toBe(0);

    const snapshotPath = join(dir, '.vk-guard.json');
    const before = readFileSync(snapshotPath);

    writeFileSync(join(dir, 'src/B.ts'), DUPE_B);
    const res = runCli(dir, ['update', '--rows-only']);
    expect(res.code, res.all).toBe(1);
    expect(res.all).toContain('duplicate target name');

    // Byte-for-byte, not merely parse-equal.
    expect(readFileSync(snapshotPath).equals(before)).toBe(true);
  });

  it('rejects a SmartContract and a ZkProgram sharing a name', () => {
    const dir = makeProject('dupe-kinds', {
      'src/A.ts': DUPE_A,
      'src/P.ts': `import { ZkProgram, Field } from 'o1js';

export const Counter = ZkProgram({
  name: 'Counter',
  publicInput: Field,
  methods: { go: { privateInputs: [], async method(x: Field) { x.assertEquals(x); } } },
});
`,
    });
    const res = runCli(dir, ['check', '--rows-only']);
    expect(res.code, res.all).toBe(1);
    expect(res.all).toContain('duplicate target name');
  });

  it('identical measurements do not make duplicate names acceptable', () => {
    // Byte-identical circuits, so every measured value would agree. The names
    // still collide in the snapshot, so this must still fail.
    const dir = makeProject('dupe-identical', { 'src/A.ts': DUPE_A, 'src/A2.ts': DUPE_A });
    const res = runCli(dir, ['check', '--rows-only']);
    expect(res.code, res.all).toBe(1);
    expect(res.all).toContain('duplicate target name');
  });

  it('re-exporting the same target from several files is not a duplicate', () => {
    const dir = makeProject('re-export', {
      'src/Counter.ts': COUNTER,
      'src/index.ts': `export { Counter } from './Counter.js';\n`,
    });
    const res = runCli(dir, ['update', '--rows-only']);
    expect(res.code, res.all).toBe(0);
    // Discovered once, by object identity.
    expect(res.stdout).toMatch(/1 contract, /);
  });

  it('distinct uniquely named targets still work', () => {
    const dir = makeProject('unique-names', {
      'src/A.ts': DUPE_A,
      'src/B.ts': DUPE_B.replace('class Counter', 'class Totals'),
    });
    const res = runCli(dir, ['update', '--rows-only']);
    expect(res.code, res.all).toBe(0);
    expect(res.stdout).toMatch(/2 contracts, /);
  });
});

describe('explain', () => {
  it('reports the constraint composition without compiling', () => {
    const dir = makeProject('explain-basic', { 'src/Counter.ts': COUNTER });
    // No --cache-dir and no compile: explain uses analyzeMethods() only.
    const res = runCli(dir, ['explain', '--rows-only']);
    expect(res.code, res.all).toBe(0);

    expect(res.stdout).toContain('Counter.increment()');
    expect(res.stdout).toContain('Counter.reset()');
    expect(res.stdout).toContain('Poseidon');
    expect(res.stdout).toMatch(/wire locality: \d+\.\d%/);
    expect(res.stdout).toMatch(/2 method\(s\), \d+ rows total, o1js /);
  });

  it('emits machine-readable output with --json', () => {
    const dir = makeProject('explain-json', { 'src/Counter.ts': COUNTER });
    const res = runCli(dir, ['explain', '--json', '--rows-only']);
    expect(res.code, res.all).toBe(0);

    const parsed = JSON.parse(res.stdout);
    expect(parsed.o1jsVersion).toMatch(/^\d+\.\d+\.\d+/);
    const inc = parsed.methods.find(
      (m: { contract: string; method: string }) => m.method === 'increment'
    );
    expect(inc.composition.rows).toBeGreaterThan(0);
    expect(inc.composition.gateCount).toBeGreaterThan(0);

    // Shares must account for the whole circuit.
    const total = inc.composition.byType.reduce(
      (n: number, t: { count: number }) => n + t.count,
      0
    );
    expect(total).toBe(inc.composition.gateCount);

    // A zkApp method is dominated by framework hashing, not user arithmetic.
    const poseidon = inc.composition.byType.find((t: { type: string }) => t.type === 'Poseidon');
    expect(poseidon.share).toBeGreaterThan(0.5);
  });

  it('exits 1 when no contracts are found, like check does', () => {
    const dir = makeProject('explain-empty', {
      'src/util.ts': 'export const helper = (a: number) => a + 1;\n',
    });
    const res = runCli(dir, ['explain', '--rows-only']);
    expect(res.code, res.all).toBe(1);
    expect(res.stdout).toContain('no contracts found');
  });
});
