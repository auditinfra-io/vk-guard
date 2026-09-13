import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TMP_ROOT = join(REPO_ROOT, 'test', '.tmp');
export const CLI = join(REPO_ROOT, 'dist', 'cli.js');

/**
 * A shared o1js compile cache across the whole suite.
 *
 * Safe to share because the cache is content-addressed on the circuit (see
 * experiments/cache-correctness.ts): a changed method produces a different key,
 * so one test cannot poison another's result.
 *
 * Deliberately NOT under TMP_ROOT. Temp projects are wiped between runs, and
 * when this lived alongside them every run deleted its own cache and recompiled
 * every circuit from cold — the single largest cost in the suite. Keeping it in
 * node_modules/.cache makes repeat runs reuse compiled artifacts while staying
 * out of git and out of the published package.
 */
export const SHARED_CACHE = join(REPO_ROOT, 'node_modules', '.cache', 'vk-guard-test-o1js');

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    lib: ['ES2022'],
    strict: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    useDefineForClassFields: false,
    skipLibCheck: true,
    outDir: 'build',
    rootDir: '.',
  },
  include: ['src/**/*.ts'],
};

/**
 * Create an isolated project under test/.tmp so Node's module resolution walks
 * up to the repo's own node_modules and finds o1js there.
 */
export function makeProject(name: string, files: Record<string, string>): string {
  const dir = join(TMP_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `fixture-${name}`, version: '0.0.0', private: true, type: 'module' }, null, 2)
  );
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

export type CliResult = { code: number; stdout: string; stderr: string; all: string };

export function runCli(cwd: string, args: string[]): CliResult {
  if (!existsSync(CLI)) throw new Error(`CLI not built at ${CLI}; run \`npm run build\` first.`);
  const useCache = !args.includes('--cache-dir') && !args.includes('--rows-only');
  const full = useCache ? [...args, '--cache-dir', SHARED_CACHE] : args;
  const res = spawnSync(process.execPath, [CLI, ...full], {
    cwd,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  return { code: res.status ?? -1, stdout, stderr, all: stdout + stderr };
}

export const COUNTER = `import { SmartContract, state, State, method, Field, Poseidon } from 'o1js';

export class Counter extends SmartContract {
  @state(Field) count = State<Field>();

  @method async increment(by: Field) {
    const current = this.count.getAndRequireEquals();
    this.count.set(current.add(by));
  }

  @method async reset(seed: Field) {
    const current = this.count.getAndRequireEquals();
    this.count.set(Poseidon.hash([seed, current]));
  }
}
`;
