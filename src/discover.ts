import { glob } from 'tinyglobby';
import { pathToFileURL } from 'node:url';
import { relative, resolve, isAbsolute } from 'node:path';
import type { ProjectContext } from './project.js';
import { buildProject } from './build.js';

export const DEFAULT_ENTRY = ['src/**/*.ts'];
const ALWAYS_IGNORE = ['**/node_modules/**', '**/*.d.ts', '**/dist/**', '**/.vk-guard-cache/**'];

/** A provable target found in the project: a SmartContract subclass or a ZkProgram. */
export type Discovered = {
  name: string;
  kind: 'SmartContract' | 'ZkProgram';
  /** Source file, relative to the project root, for the snapshot's `file` field. */
  file: string;
  target: AnalyzableTarget;
};

/**
 * The shape vk-guard actually depends on. Verified against o1js 3.0.0: both
 * `SmartContract` (static members) and the object returned by `ZkProgram()`
 * expose these, though their `compile()` option bags differ slightly.
 */
/**
 * What o1js reports per method. `gates` is the constraint system itself —
 * verified against o1js 3.0.0, each gate carries its type, the 7-cell wire
 * permutation, and its coefficients. It is large (hundreds of entries per
 * method), so it is read for `explain` and never written to a snapshot.
 */
export type MethodAnalysis = {
  rows: number;
  digest: string;
  gates?: RawGate[];
};

export type RawGate = {
  type: string;
  wires: { row: number; col: number }[];
  coeffs: string[];
};

export type AnalyzableTarget = {
  name: string;
  analyzeMethods(): Promise<Record<string, MethodAnalysis>>;
  digest(): Promise<string>;
  compile(options?: {
    cache?: unknown;
    forceRecompile?: boolean;
  }): Promise<{ verificationKey: { data: string; hash: { toString(): string } } }>;
};

export type DiscoverOptions = {
  root: string;
  entry?: string[];
  tsconfig?: string;
  buildDir: string;
};

export async function discover(
  ctx: ProjectContext,
  opts: DiscoverOptions
): Promise<{ contracts: Discovered[]; scannedFiles: number; semanticErrorCount: number }> {
  const patterns = opts.entry?.length ? opts.entry : DEFAULT_ENTRY;
  const matches = await glob(patterns, {
    cwd: opts.root,
    absolute: true,
    ignore: ALWAYS_IGNORE,
    dot: false,
  });
  const files = matches.filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f)).sort();

  if (files.length === 0) {
    return { contracts: [], scannedFiles: 0, semanticErrorCount: 0 };
  }

  const tsFiles = files.filter((f) => /\.tsx?$/.test(f));
  const loadable = new Map<string, string>();
  let semanticErrorCount = 0;

  if (tsFiles.length > 0) {
    const built = buildProject(opts.root, tsFiles, opts.buildDir, opts.tsconfig);
    semanticErrorCount = built.semanticErrorCount;
    for (const [src, out] of built.outputs) loadable.set(src, out);
  }
  for (const f of files) if (!/\.tsx?$/.test(f)) loadable.set(f, f);

  const SmartContract = ctx.o1js.SmartContract as (new (...a: never[]) => unknown) | undefined;
  if (typeof SmartContract !== 'function') {
    throw new Error(`the resolved o1js does not export SmartContract; is o1js ${ctx.o1jsVersion} supported?`);
  }

  const contracts: Discovered[] = [];
  const seen = new Set<unknown>();

  for (const [src, out] of [...loadable.entries()].sort()) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(out).href)) as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `failed to import ${relative(opts.root, src)}: ${(e as Error).message}\n` +
          `vk-guard must load every entry file; it will not silently skip one.`
      );
    }
    for (const exported of Object.values(mod)) {
      if (exported == null || seen.has(exported)) continue;
      const kind = classify(exported, SmartContract);
      if (!kind) continue;
      seen.add(exported);
      const target = exported as AnalyzableTarget;
      contracts.push({ name: target.name, kind, file: toRelative(opts.root, src), target });
    }
  }

  contracts.sort((a, b) => a.name.localeCompare(b.name));
  return { contracts, scannedFiles: files.length, semanticErrorCount };
}

function classify(
  value: unknown,
  SmartContract: Function
): 'SmartContract' | 'ZkProgram' | undefined {
  if (typeof value === 'function') {
    if (value === SmartContract) return undefined;
    if (SmartContract.prototype.isPrototypeOf(value.prototype)) return 'SmartContract';
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  const looksLikeProgram =
    typeof o.name === 'string' &&
    typeof o.analyzeMethods === 'function' &&
    typeof o.compile === 'function' &&
    typeof o.digest === 'function';
  return looksLikeProgram ? 'ZkProgram' : undefined;
}

function toRelative(root: string, file: string): string {
  const abs = isAbsolute(file) ? file : resolve(root, file);
  return relative(root, abs).split('\\').join('/');
}
