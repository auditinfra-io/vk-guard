import { readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupInvocation,
  equalityAssertions,
  gitCommit,
  invocationDirectory,
  parseOptions,
  runWorker,
  SCHEMA_VERSION,
  sha256Files,
  writeResult,
  type AssertionResult,
  type CaseResult,
} from './harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SOURCE = join(ROOT, 'experiments');
const WORKER = join(HERE, 'worker.js');
const name = 'determinism';
const options = parseOptions(process.argv.slice(2));
const temporaryDirectory = await invocationDirectory(name);
const cases: CaseResult[] = [];
const assertions: AssertionResult[] = [];
let harnessError: { kind: 'harness'; message: string } | undefined;

async function compile(id: string, cache: string, forceRecompile = false) {
  const result = await runWorker({
    worker: WORKER,
    cacheDir: join(temporaryDirectory, cache),
    extraConstraint: '0',
    forceRecompile,
    timeoutMs: options.timeoutMs,
  });
  const entry: CaseResult = {
    id,
    circuit: 'original',
    cache,
    options: { forceRecompile, extraConstraint: '0' },
    ...('error' in result ? { error: result.error } : { measurement: result.measurement }),
    diagnostics: { stdout: result.stdout, stderr: result.stderr },
  };
  cases.push(entry);
  return entry;
}

try {
  console.log('Running original fixture with cold, warm, forced, and independent cold caches.');
  const coldA = await compile('A-cold', 'cache-a');
  const warmA = await compile('A-warm', 'cache-a');
  const forcedA = await compile('A-forceRecompile', 'cache-a', true);
  const coldB = await compile('B-cold-independent', 'cache-b');
  assertions.push(
    ...equalityAssertions('warm cache A equals cold cache A', coldA, warmA),
    ...equalityAssertions('forceRecompile equals cold cache A', coldA, forcedA),
    ...equalityAssertions('independent cold cache B equals cold cache A', coldA, coldB)
  );
} catch (error) {
  harnessError = { kind: 'harness', message: (error as Error).message };
} finally {
  await cleanupInvocation(temporaryDirectory);
}

const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const o1jsPackage = JSON.parse(
  await readFile(join(ROOT, 'node_modules/o1js/package.json'), 'utf8')
) as { version: string };
const status =
  harnessError === undefined &&
  cases.every((entry) => !entry.error) &&
  assertions.every((a) => a.passed)
    ? 'passed'
    : 'failed';
const result = {
  schemaVersion: SCHEMA_VERSION,
  experiment: name,
  status,
  generatedAt: new Date().toISOString(),
  project: {
    name: packageJson.name,
    version: packageJson.version,
    gitCommit: await gitCommit(ROOT),
  },
  environment: {
    o1jsVersion: o1jsPackage.version,
    nodeVersion: process.version,
    os: platform(),
    osRelease: release(),
    architecture: arch(),
    backend: { requested: process.env.O1JS_BACKEND ?? 'default', effective: 'unknown' },
  },
  configuration: {
    timeoutMs: options.timeoutMs,
    compilationOptions: { cache: 'Cache.FileSystem(case directory)', forceRecompile: 'per case' },
    fixture: 'Probe',
    fixtureVariants: ['EXTRA_CONSTRAINT=0'],
    fixtureBuildInputSha256: await sha256Files([
      join(SOURCE, 'fixtures/Probe.ts'),
      join(SOURCE, 'worker.ts'),
      join(SOURCE, 'tsconfig.json'),
    ]),
    lockfileSha256: await sha256Files([join(ROOT, 'package-lock.json')]),
  },
  cases,
  assertions,
  ...(harnessError ? { errors: [harnessError] } : {}),
};
const outputPath = await writeResult(options.outputDir, name, result);
for (const assertion of assertions)
  console.log(`${assertion.passed ? 'PASS' : 'FAIL'} ${assertion.name}: ${assertion.detail}`);
console.log(`Result: ${outputPath}`);
console.log(
  status === 'passed'
    ? 'All recorded measurements matched under this configuration.'
    : 'Determinism experiment failed; inspect the structured result and diagnostics.'
);
process.exitCode = status === 'passed' ? 0 : 1;
