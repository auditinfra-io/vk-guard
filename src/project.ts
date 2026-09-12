import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, parse } from 'node:path';

/**
 * Everything we need from the project under test. We always resolve o1js from
 * the PROJECT, never from vk-guard's own node_modules: the whole point of the
 * tool is to report on the o1js the project actually builds against, and o1js
 * is declared as a peer dependency for that reason.
 */
export type ProjectContext = {
  root: string;
  o1jsVersion: string;
  o1js: Record<string, unknown>;
};

export async function loadProject(root: string, cacheRoot: string): Promise<ProjectContext> {
  const require = createRequire(join(root, 'package.json'));

  let cjsEntry: string;
  try {
    cjsEntry = require.resolve('o1js');
  } catch {
    throw new Error(
      `could not resolve o1js from ${root}. vk-guard measures the project's own o1js; ` +
        `install it there (npm install o1js).`
    );
  }

  const o1jsVersion = readPackageVersion(cjsEntry, root);
  const o1js = await importProjectO1js(root, cacheRoot);
  return { root, o1jsVersion, o1js };
}

/**
 * Import o1js exactly as the project's own compiled contracts will.
 *
 * o1js ships dual entry points: `exports.node.require` -> dist/node/index.cjs
 * and `exports.node.import` -> dist/node/index.js. Resolving with
 * `require.resolve` therefore yields a DIFFERENT module instance than the ESM
 * `import 'o1js'` inside the user's contracts, and the two instances have
 * distinct `SmartContract` identities — so every contract silently failed the
 * `instanceof`-style check and discovery found nothing.
 *
 * Importing through a shim placed inside the project tree makes Node apply the
 * project's own resolution and conditions, guaranteeing we hold the same
 * `SmartContract` object the contracts extend.
 */
async function importProjectO1js(root: string, cacheRoot: string): Promise<Record<string, unknown>> {
  mkdirSync(cacheRoot, { recursive: true });
  const shim = join(cacheRoot, 'o1js-resolver.mjs');
  writeFileSync(shim, `export * as o1js from 'o1js';\n`, 'utf8');
  try {
    const mod = (await import(pathToFileURL(shim).href)) as { o1js: Record<string, unknown> };
    return mod.o1js;
  } catch (e) {
    throw new Error(
      `could not import o1js from ${root}: ${(e as Error).message}\n` +
        `vk-guard loads the project's own o1js so that measurements match its build.`
    );
  }
}

/** The project's package.json "type", so emitted JS is interpreted correctly. */
export function projectModuleType(root: string): 'module' | 'commonjs' {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return pkg.type === 'module' ? 'module' : 'commonjs';
  } catch {
    return 'commonjs';
  }
}

/**
 * Find o1js's own package.json by walking up from its resolved entry point.
 *
 * `require.resolve('o1js/package.json')` does not work: o1js declares an
 * `exports` map, and Node refuses subpaths that the map does not list.
 */
function readPackageVersion(entry: string, root: string): string {
  let dir = dirname(entry);
  const stopAt = parse(dir).root;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === 'o1js' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // not this directory; keep walking
    }
    const parent = dirname(dir);
    if (parent === dir || dir === stopAt) break;
    dir = parent;
  }
  throw new Error(
    `resolved o1js at ${entry} (from ${root}) but could not locate its package.json to read the version.`
  );
}
