import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  equalityAssertions,
  inequalityAssertion,
  parseWorkerOutput,
  RESULT_MARKER,
  runWorker,
  type CaseResult,
  type Measurement,
} from '../experiments/harness.js';

const original: Measurement = {
  vkHash: 'key-original',
  vkDataSha256: 'a'.repeat(64),
  rows: 615,
  digest: 'digest-original',
  elapsedMs: 10,
};
const changed: Measurement = {
  vkHash: 'key-changed',
  vkDataSha256: 'b'.repeat(64),
  rows: 616,
  digest: 'digest-changed',
  elapsedMs: 10,
};

function result(id: string, measurement?: Measurement): CaseResult {
  return {
    id,
    circuit: id === 'A' ? 'original' : 'added-constraint',
    cache: 'synthetic',
    options: { forceRecompile: false, extraConstraint: id === 'A' ? '0' : '1' },
    measurement,
  };
}

describe('experiment assertion harness (synthetic measurements)', () => {
  test('correct cache mutation, cold control, and restoration pass', () => {
    const a = result('A', original);
    const b = result('B', changed);
    const c = result('C', changed);
    const d = result('D', original);
    const assertions = [
      inequalityAssertion('row changed', a, b, 'rows', 1),
      inequalityAssertion('digest changed', a, b, 'digest'),
      inequalityAssertion('key changed', a, b, 'vkHash'),
      ...equalityAssertions('warm/cold', b, c),
      ...equalityAssertions('restored', a, d),
    ];
    expect(assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  test('warm/cold key disagreement fails independently', () => {
    const disagreement = { ...changed, vkHash: 'another-key' };
    const assertions = equalityAssertions(
      'warm/cold',
      result('B', changed),
      result('C', disagreement)
    );
    expect(assertions.find((a) => a.name.endsWith('vkHash'))?.passed).toBe(false);
  });

  test('a mutation which did not change the circuit fails', () => {
    const a = result('A', original);
    const b = result('B', original);
    expect(inequalityAssertion('row changed', a, b, 'rows', 1).passed).toBe(false);
    expect(inequalityAssertion('digest changed', a, b, 'digest').passed).toBe(false);
    expect(inequalityAssertion('key changed', a, b, 'vkHash').passed).toBe(false);
  });

  test('restoration mismatch fails', () => {
    expect(
      equalityAssertions('restored', result('A', original), result('D', changed)).some(
        (a) => !a.passed
      )
    ).toBe(true);
  });

  test('missing measurements and malformed worker results fail', () => {
    expect(
      equalityAssertions('missing', result('A', original), result('B')).every((a) => !a.passed)
    ).toBe(true);
    expect(() => parseWorkerOutput('diagnostic only')).toThrow(/expected one/);
    expect(() => parseWorkerOutput(`${RESULT_MARKER}{"vkHash":"incomplete"}\n`)).toThrow(
      /invalid measurements/
    );
  });
});

describe('worker process failures', () => {
  test('crashes retain useful diagnostics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vk-guard-harness-test-'));
    const worker = join(directory, 'crash.mjs');
    await writeFile(worker, "console.error('synthetic crash detail'); process.exit(7);\n");
    const outcome = await runWorker({
      worker,
      cacheDir: directory,
      extraConstraint: '0',
      timeoutMs: 1_000,
    });
    expect('error' in outcome && outcome.error.kind).toBe('worker-exit');
    expect(outcome.stderr).toContain('synthetic crash detail');
  });

  test('timeouts report the configured limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vk-guard-harness-test-'));
    const worker = join(directory, 'hang.mjs');
    await writeFile(worker, 'setTimeout(() => {}, 10_000);\n');
    const outcome = await runWorker({
      worker,
      cacheDir: directory,
      extraConstraint: '0',
      timeoutMs: 25,
    });
    expect('error' in outcome && outcome.error.kind).toBe('timeout');
    expect('error' in outcome && outcome.error.message).toContain('25 ms');
  });
});
