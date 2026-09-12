#!/usr/bin/env node
import { run, VK_GUARD_VERSION } from './index.js';

const USAGE = `vk-guard ${VK_GUARD_VERSION} — verification-key and constraint-count regression guard for o1js

Usage:
  vk-guard [check]            compare the project against .vk-guard.json (default)
  vk-guard update             accept the current state as the new baseline

Options:
  --rows-only                 skip compile(); use analyzeMethods() only (fast path)
  --json                      machine-readable output
  --entry <glob>              override discovery (repeatable; default: src/**/*.ts)
  --cache-dir <path>          o1js compile cache location
  --snapshot <path>           snapshot file (default: .vk-guard.json)
  --tsconfig <path>           tsconfig to build with (default: nearest tsconfig.json)
  --root <path>               project root (default: cwd)
  -h, --help                  show this help
  -v, --version               show version

Exit codes:
  0  no drift
  1  drift, no contracts found, or a contract could not be measured
`;

type Parsed = {
  mode: 'check' | 'update';
  entry: string[];
  rowsOnly: boolean;
  json: boolean;
  cacheDir?: string;
  snapshotPath?: string;
  tsconfig?: string;
  root: string;
};

function parseArgs(argv: string[]): Parsed | { help: true } | { version: true } {
  const parsed: Parsed = {
    mode: 'check',
    entry: [],
    rowsOnly: false,
    json: false,
    root: process.cwd(),
  };
  let i = 0;
  if (argv[0] === 'check' || argv[0] === 'update') {
    parsed.mode = argv[0];
    i = 1;
  }
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        return { help: true };
      case '-v':
      case '--version':
        return { version: true };
      case '--rows-only':
        parsed.rowsOnly = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--entry':
        parsed.entry.push(requireValue(argv, ++i, '--entry'));
        break;
      case '--cache-dir':
        parsed.cacheDir = requireValue(argv, ++i, '--cache-dir');
        break;
      case '--snapshot':
        parsed.snapshotPath = requireValue(argv, ++i, '--snapshot');
        break;
      case '--tsconfig':
        parsed.tsconfig = requireValue(argv, ++i, '--tsconfig');
        break;
      case '--root':
        parsed.root = requireValue(argv, ++i, '--root');
        break;
      default:
        throw new Error(`unknown option: ${arg}\n\n${USAGE}`);
    }
  }
  return parsed;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
  return v;
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`vk-guard: ${(e as Error).message}\n`);
    return 1;
  }

  if ('help' in parsed) {
    process.stdout.write(USAGE);
    return 0;
  }
  if ('version' in parsed) {
    process.stdout.write(`${VK_GUARD_VERSION}\n`);
    return 0;
  }

  try {
    const result = await run({
      root: parsed.root,
      mode: parsed.mode,
      entry: parsed.entry,
      rowsOnly: parsed.rowsOnly,
      json: parsed.json,
      cacheDir: parsed.cacheDir,
      snapshotPath: parsed.snapshotPath,
      tsconfig: parsed.tsconfig,
      // Progress goes to stderr so --json keeps stdout clean and parseable.
      onProgress: parsed.json ? undefined : (m) => process.stderr.write(`  ${m}\n`),
    });
    process.stdout.write(result.output + '\n');
    return result.exitCode;
  } catch (e) {
    // Any failure to measure is a failure of the check. We never fall back to
    // reporting success on an error path.
    const err = e as Error;
    if (parsed.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: err.message }, null, 2) + '\n');
    } else {
      process.stderr.write(`vk-guard: ${err.message}\n`);
    }
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`vk-guard: ${(e as Error).stack ?? String(e)}\n`);
    process.exit(1);
  }
);
