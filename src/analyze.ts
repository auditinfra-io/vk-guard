import { join } from 'node:path';
import type { ProjectContext } from './project.js';
import type { Discovered } from './discover.js';
import type { Measured } from './types.js';
import type { RawGate } from './discover.js';

export type MeasureOptions = {
  rowsOnly: boolean;
  cacheDir: string | undefined;
  onProgress?: (message: string) => void;
};

/**
 * Default compile cache location, namespaced by o1js version.
 *
 * o1js's FileSystem cache is content-addressed: each entry's `.header` holds a
 * uniqueId built from the circuit hash, and a read that does not match the
 * requested uniqueId is a miss (see o1js cache.ts). We verified empirically
 * that editing a method and recompiling against the same warm cache yields a
 * DIFFERENT verification key, so the cache cannot produce a false pass within a
 * given o1js version, and `forceRecompile` is not needed for correctness.
 *
 * That uniqueId does not encode the o1js version, however. Segregating the
 * cache by version removes the one remaining way a stale artifact could be
 * reused — an o1js upgrade that changes key derivation without changing the
 * circuit hash — while keeping the large speedup of a warm cache.
 */
export function defaultCacheDir(root: string, o1jsVersion: string): string {
  return join(root, '.vk-guard-cache', `o1js-${o1jsVersion}`);
}

export async function measure(
  ctx: ProjectContext,
  discovered: Discovered[],
  opts: MeasureOptions
): Promise<Measured[]> {
  const cache = opts.rowsOnly ? undefined : makeCache(ctx, opts.cacheDir);
  const results: Measured[] = [];

  for (const d of discovered) {
    opts.onProgress?.(
      opts.rowsOnly ? `analyzing ${d.name}` : `compiling ${d.name} (this can take minutes)`
    );

    const analysis = await failLoudly(d, 'analyzeMethods()', () => d.target.analyzeMethods());

    const methods = Object.fromEntries(
      Object.entries(analysis).map(([methodName, info]) => [
        methodName,
        { rows: info.rows, digest: info.digest, ...gateTypesOf(info.gates) },
      ])
    );

    const entry: Measured = {
      name: d.name,
      kind: d.kind,
      file: d.file,
      methods,
    };

    const digest = await failLoudly(d, 'digest()', () => d.target.digest());
    entry.digest = digest;

    if (!opts.rowsOnly) {
      const { verificationKey } = await failLoudly(d, 'compile()', () =>
        d.target.compile(cache ? { cache } : {})
      );
      entry.verificationKeyHash = verificationKey.hash.toString();
    }

    results.push(entry);
  }

  return results;
}

/**
 * A contract that cannot be measured is a hard failure, never a skip. Silently
 * dropping it would let `check` pass on a project whose circuits were never
 * examined — the exact false confidence this tool exists to prevent.
 */
async function failLoudly<T>(d: Discovered, what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as Error;
    throw new Error(
      `${d.name} (${d.file}) failed during ${what}:\n  ${err.message}\n` +
        `vk-guard cannot verify this contract, so the check fails rather than skipping it.`
    );
  }
}

function makeCache(ctx: ProjectContext, cacheDir: string | undefined): unknown {
  const Cache = ctx.o1js.Cache as
    | { FileSystem(dir: string): unknown; FileSystemDefault: unknown }
    | undefined;
  if (!Cache) return undefined;
  const dir = cacheDir ?? defaultCacheDir(ctx.root, ctx.o1jsVersion);
  return Cache.FileSystem(dir);
}

/**
 * Count gates by type. Returns nothing when o1js did not supply gates, so the
 * snapshot simply omits the field rather than recording a misleading empty
 * histogram that would later read as "this circuit has no gates".
 */
function gateTypesOf(gates: RawGate[] | undefined): { gateTypes?: Record<string, number> } {
  if (!gates || gates.length === 0) return {};
  const counts: Record<string, number> = {};
  for (const g of gates) counts[g.type] = (counts[g.type] ?? 0) + 1;
  const sorted = Object.fromEntries(
    Object.entries(counts).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
  );
  return { gateTypes: sorted };
}
