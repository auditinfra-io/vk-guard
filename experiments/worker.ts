import { createHash } from 'node:crypto';
import { Cache } from 'o1js';
import { Probe } from './fixtures/Probe.js';
import { RESULT_MARKER } from './harness.js';

/**
 * Compiles Probe once and prints the result as JSON. Run as a child process so
 * each measurement gets a genuinely fresh o1js instance — compilation state and
 * analyzeMethods() results are memoised per process, so repeated in-process
 * calls would measure the memo, not the compiler.
 *
 * argv: [cacheDir | 'none'] [forceRecompile?]
 */
const cacheDir = process.argv[2];
const force = process.argv[3] === 'force';

const started = Date.now();
const analysis = await Probe.analyzeMethods();
const { verificationKey } = await Probe.compile({
  cache: cacheDir === 'none' ? Cache.None : Cache.FileSystem(cacheDir),
  forceRecompile: force,
});

const bump = (analysis as Record<string, { rows: number; digest: string }>).bump!;
process.stdout.write(
  `${RESULT_MARKER}${JSON.stringify({
    vkHash: verificationKey.hash.toString(),
    vkDataSha256: createHash('sha256').update(verificationKey.data).digest('hex'),
    rows: bump.rows,
    digest: bump.digest,
    elapsedMs: Date.now() - started,
  })}\n`
);
