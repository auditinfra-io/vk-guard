import { Cache } from 'o1js';
import { Probe } from './fixtures/Probe.js';

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
  ...(cacheDir && cacheDir !== 'none' ? { cache: Cache.FileSystem(cacheDir) } : {}),
  forceRecompile: force,
});

const bump = (analysis as Record<string, { rows: number; digest: string }>).bump!;
process.stdout.write(
  JSON.stringify({
    vkHash: verificationKey.hash.toString(),
    rows: bump.rows,
    digest: bump.digest,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  })
);
