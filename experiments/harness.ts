import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const RESULT_MARKER = 'VK_GUARD_EXPERIMENT_RESULT=';
export const SCHEMA_VERSION = 1;

export type Measurement = {
  vkHash: string;
  vkDataSha256: string;
  rows: number;
  digest: string;
  elapsedMs: number;
};

export type CaseResult = {
  id: string;
  circuit: 'original' | 'added-constraint';
  cache: string;
  options: { forceRecompile: boolean; extraConstraint: '0' | '1' };
  measurement?: Measurement;
  error?: StructuredError;
  diagnostics?: { stdout: string; stderr: string };
};

export type AssertionResult = { name: string; passed: boolean; detail: string };
export type StructuredError = {
  kind: 'worker-exit' | 'timeout' | 'malformed-output' | 'harness';
  message: string;
  exitCode?: number | null;
  signal?: string | null;
};

type WorkerOutcome =
  | { measurement: Measurement; stdout: string; stderr: string }
  | { error: StructuredError; stdout: string; stderr: string };

const execFileAsync = promisify(execFile);

export function parseWorkerOutput(stdout: string): Measurement {
  const lines = stdout.split(/\r?\n/);
  const marked = lines.filter((line) => line.startsWith(RESULT_MARKER));
  if (marked.length !== 1)
    throw new Error(`expected one ${RESULT_MARKER} line, got ${marked.length}`);
  const value: unknown = JSON.parse(marked[0]!.slice(RESULT_MARKER.length));
  if (!isMeasurement(value))
    throw new Error('worker result is missing or has invalid measurements');
  return value;
}

function isMeasurement(value: unknown): value is Measurement {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Measurement>;
  return (
    typeof v.vkHash === 'string' &&
    v.vkHash.length > 0 &&
    typeof v.vkDataSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(v.vkDataSha256) &&
    typeof v.digest === 'string' &&
    v.digest.length > 0 &&
    typeof v.rows === 'number' &&
    Number.isInteger(v.rows) &&
    v.rows >= 0 &&
    typeof v.elapsedMs === 'number' &&
    Number.isFinite(v.elapsedMs) &&
    v.elapsedMs >= 0
  );
}

export async function runWorker(options: {
  worker: string;
  cacheDir: string;
  extraConstraint: '0' | '1';
  forceRecompile?: boolean;
  timeoutMs: number;
}): Promise<WorkerOutcome> {
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(
      process.execPath,
      [options.worker, options.cacheDir, options.forceRecompile ? 'force' : 'normal'],
      {
        encoding: 'utf8',
        timeout: options.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, EXTRA_CONSTRAINT: options.extraConstraint },
      }
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (cause) {
    const error = cause as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string | null;
      signal?: string | null;
      killed?: boolean;
    };
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
    const timedOut = error.killed === true || error.signal === 'SIGTERM';
    return {
      error: {
        kind: timedOut ? 'timeout' : 'worker-exit',
        message: timedOut
          ? `worker exceeded ${options.timeoutMs} ms timeout`
          : `worker failed: ${error.message}`,
        exitCode: typeof error.code === 'number' ? error.code : null,
        signal: error.signal ?? null,
      },
      stdout,
      stderr,
    };
  }
  try {
    return { measurement: parseWorkerOutput(stdout), stdout, stderr };
  } catch (cause) {
    return {
      error: { kind: 'malformed-output', message: (cause as Error).message },
      stdout,
      stderr,
    };
  }
}

export function equalityAssertions(
  prefix: string,
  left: CaseResult,
  right: CaseResult
): AssertionResult[] {
  return (['vkHash', 'digest', 'rows', 'vkDataSha256'] as const).map((field) => ({
    name: `${prefix}: ${field}`,
    passed:
      left.measurement !== undefined &&
      right.measurement !== undefined &&
      left.measurement[field] === right.measurement[field],
    detail:
      left.measurement === undefined || right.measurement === undefined
        ? 'measurement unavailable'
        : `${String(left.measurement[field])} ${left.measurement[field] === right.measurement[field] ? '==' : '!='} ${String(right.measurement[field])}`,
  }));
}

export function inequalityAssertion(
  name: string,
  left: CaseResult,
  right: CaseResult,
  field: keyof Measurement,
  expectedDelta?: number
): AssertionResult {
  const a = left.measurement?.[field];
  const b = right.measurement?.[field];
  const deltaOk =
    expectedDelta === undefined ||
    (typeof a === 'number' && typeof b === 'number' && b - a === expectedDelta);
  return {
    name,
    passed: a !== undefined && b !== undefined && a !== b && deltaOk,
    detail:
      a === undefined || b === undefined
        ? 'measurement unavailable'
        : `${String(a)} -> ${String(b)}${expectedDelta === undefined ? '' : ` (expected delta ${expectedDelta})`}`,
  };
}

export function parseOptions(argv: string[]) {
  let outputDir = resolve('experiments/results');
  let timeoutMs = 5 * 60 * 1000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output-dir') outputDir = resolve(requiredValue(argv, ++i, arg));
    else if (arg?.startsWith('--output-dir=')) outputDir = resolve(arg.slice(13));
    else if (arg === '--timeout-ms') timeoutMs = positiveInt(requiredValue(argv, ++i, arg), arg);
    else if (arg?.startsWith('--timeout-ms='))
      timeoutMs = positiveInt(arg.slice(13), '--timeout-ms');
    else throw new Error(`unknown option: ${arg}`);
  }
  return { outputDir, timeoutMs };
}

function requiredValue(argv: string[], index: number, option: string) {
  const value = argv[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function positiveInt(value: string, option: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${option} must be a positive integer`);
  return parsed;
}

export async function invocationDirectory(name: string) {
  const directory = join(
    tmpdir(),
    `vk-guard-${name}-${process.pid}-${Date.now()}-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)}`
  );
  await mkdir(directory, { recursive: false });
  return directory;
}

export async function cleanupInvocation(directory: string) {
  const expectedPrefix = join(tmpdir(), 'vk-guard-');
  if (!directory.startsWith(expectedPrefix))
    throw new Error(`refusing to remove unexpected path: ${directory}`);
  await rm(directory, { recursive: true, force: true });
}

export async function sha256Files(files: string[]) {
  const hash = createHash('sha256');
  for (const file of files)
    hash
      .update(basename(file))
      .update('\0')
      .update(await readFile(file))
      .update('\0');
  return hash.digest('hex');
}

export async function writeResult(outputDir: string, name: string, result: unknown) {
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, `${name}.json`);
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}

export async function gitCommit(root: string) {
  try {
    return (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
    ).stdout.trim();
  } catch {
    return null;
  }
}
