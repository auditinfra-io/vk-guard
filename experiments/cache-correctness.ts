import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Can a warm o1js cache serve a verification key that no longer reflects the
 * source?
 *
 * This is the worst failure mode vk-guard could have: a stale cache returning a
 * matching key would make `check` pass on a circuit that actually changed — a
 * false pass, silently. The answer determines whether the tool must pay for
 * `forceRecompile` on every run.
 *
 * Method: compile, change the circuit by exactly one constraint, recompile
 * against THE SAME cache, then restore the original and compile again.
 *
 * A safe cache must produce a different key for the changed circuit, and return
 * to the original key when the source returns.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'worker.js');
const CACHE = join(HERE, '.cache-correctness');

type Result = { vkHash: string; rows: number; digest: string; seconds: number };

/**
 * The two circuit variants differ by one `assertNotEquals`, selected by an env
 * var the fixture reads. Toggling an env var rather than rewriting and
 * rebuilding source keeps the experiment to three compiles and removes the build
 * step as a variable.
 */
function compile(label: string, extraConstraint: boolean): Result & { label: string } {
  const out = execFileSync(process.execPath, [WORKER, CACHE], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, EXTRA_CONSTRAINT: extraConstraint ? '1' : '0' },
  });
  return { label, ...(JSON.parse(out) as Result) };
}

rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });

console.log('Compiling three times against one shared cache, changing the circuit in between.\n');

const original = compile('original, cold cache', false);
const changed = compile('one extra constraint, SAME warm cache', true);
const restored = compile('original restored, same cache', false);
const runs = [original, changed, restored];

const width = Math.max(...runs.map((r) => r.label.length));
console.log(`${'run'.padEnd(width)}  ${'rows'.padStart(5)}  verification key hash`);
for (const r of runs) {
  console.log(
    `${r.label.padEnd(width)}  ${String(r.rows).padStart(5)}  ${r.vkHash.slice(0, 10)}…${r.vkHash.slice(-4)}`
  );
}

const detectedChange = changed.vkHash !== original.vkHash;
const roundTripped = restored.vkHash === original.vkHash;
const safe = detectedChange && roundTripped;

console.log('');
console.log(`changed circuit produced a different key : ${detectedChange ? 'yes' : 'NO'}`);
console.log(`restoring the source restored the key    : ${roundTripped ? 'yes' : 'NO'}`);
console.log(
  `\n${safe ? 'CACHE IS SAFE' : 'CACHE IS UNSAFE'}: a warm cache ${safe ? 'cannot' : 'CAN'} serve a key that contradicts the source.`
);
if (safe) {
  console.log('forceRecompile is therefore unnecessary, and vk-guard keeps the cache for the speedup.');
} else {
  console.error('vk-guard must use forceRecompile on this platform, or checks can pass falsely.');
}
rmSync(CACHE, { recursive: true, force: true });
process.exit(safe ? 0 : 1);
