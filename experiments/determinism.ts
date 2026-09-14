import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Does compiling the same unchanged contract twice produce the same verification
 * key?
 *
 * Everything vk-guard does rests on this. If o1js compilation were not
 * deterministic, a committed verification key hash would be meaningless and every
 * check would be a coin flip. This is the first thing that was measured, before
 * any of the tool was built, and it is re-measured here so the claim in the
 * README is reproducible rather than asserted.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'worker.js');
const CACHE = join(HERE, '.cache-determinism');

type Result = { vkHash: string; rows: number; digest: string; seconds: number };

function compile(label: string, cacheDir: string, force = false): Result & { label: string } {
  const out = execFileSync(process.execPath, [WORKER, cacheDir, force ? 'force' : ''], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return { label, ...(JSON.parse(out) as Result) };
}

rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });

console.log('Compiling the same contract three ways, each in a separate process.\n');

const runs = [
  compile('cold cache', CACHE),
  compile('warm cache', CACHE),
  compile('forceRecompile', CACHE, true),
];

const width = Math.max(...runs.map((r) => r.label.length));
console.log(
  `${'run'.padEnd(width)}  ${'seconds'.padStart(7)}  ${'rows'.padStart(5)}  verification key hash`
);
for (const r of runs) {
  console.log(
    `${r.label.padEnd(width)}  ${String(r.seconds).padStart(7)}  ${String(r.rows).padStart(5)}  ${r.vkHash.slice(0, 10)}…${r.vkHash.slice(-4)}`
  );
}

const hashes = new Set(runs.map((r) => r.vkHash));
const digests = new Set(runs.map((r) => r.digest));
const deterministic = hashes.size === 1 && digests.size === 1;

console.log(
  `\n${deterministic ? 'DETERMINISTIC' : 'NOT DETERMINISTIC'}: ${hashes.size} distinct verification key(s) across ${runs.length} runs.`
);
if (!deterministic) {
  console.error(
    "\nvk-guard's core premise does not hold on this platform. Do not trust a snapshot here."
  );
}
rmSync(CACHE, { recursive: true, force: true });
process.exit(deterministic ? 0 : 1);
