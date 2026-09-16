import { readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupInvocation,
  equalityAssertions,
  gitCommit,
  inequalityAssertion,
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
const name = 'cache-correctness';
const options = parseOptions(process.argv.slice(2));
const temporaryDirectory = await invocationDirectory(name);
const cases: CaseResult[] = [];
const assertions: AssertionResult[] = [];
let harnessError: { kind: 'harness'; message: string } | undefined;

async function compile(
  id: string,
  circuit: CaseResult['circuit'],
  cache: string,
  extraConstraint: '0' | '1'
) {
  const result = await runWorker({
    worker: WORKER,
    cacheDir: join(temporaryDirectory, cache),
    extraConstraint,
    timeoutMs: options.timeoutMs,
  });
  const entry: CaseResult = {
    id,
    circuit,
    cache,
    options: { forceRecompile: false, extraConstraint },
    ...('error' in result ? { error: result.error } : { measurement: result.measurement }),
    diagnostics: { stdout: result.stdout, stderr: result.stderr },
  };
  cases.push(entry);
  return entry;
}

try {
  console.log('Running cache mutation and independent cold-cache controls in fresh processes.');
  const a = await compile('A', 'original', 'shared', '0');
  const b = await compile('B', 'added-constraint', 'shared', '1');
  const c = await compile('C', 'added-constraint', 'changed-cold', '1');
  const d = await compile('D', 'original', 'shared', '0');
  const e = await compile('E', 'original', 'original-cold', '0');

  assertions.push(
    inequalityAssertion('B has exactly one additional row vs A', a, b, 'rows', 1),
    inequalityAssertion('B method digest differs from A', a, b, 'digest'),
    inequalityAssertion('B verification-key Field hash differs from A', a, b, 'vkHash'),
    ...equalityAssertions('B warm changed equals C cold changed', b, c),
    ...equalityAssertions('D restored equals A original', a, d),
    ...equalityAssertions('E cold original equals A original', a, e)
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
) as {
  version: string;
};
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
    compilationOptions: { cache: 'Cache.FileSystem(case directory)', forceRecompile: false },
    fixture: 'Probe',
    fixtureVariants: ['EXTRA_CONSTRAINT=0', 'EXTRA_CONSTRAINT=1'],
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
if (status === 'passed')
  console.log('No stale-key mismatch observed for this mutation under the recorded configuration.');
else
  console.error(
    'Cache-correctness experiment failed; inspect the structured result and diagnostics.'
  );
process.exitCode = status === 'passed' ? 0 : 1;
