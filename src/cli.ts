#!/usr/bin/env node
import { run, explain, VK_GUARD_VERSION } from './index.js';

const USAGE = `vk-guard ${VK_GUARD_VERSION} — verification-key and constraint-count regression guard for o1js

Usage:
  vk-guard [check]            compare the project against .vk-guard.json (default)
  vk-guard update             accept the current state as the new baseline
  vk-guard explain            show what each method's constraint system is made of

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

The explain command uses analyzeMethods() only, so it runs in seconds. o1js
records no source location on gates, so it reports which gate types occupy
which rows, not which line of TypeScript produced them.

Exit codes:
  0  no drift
  1  drift, no contracts found, or a contract could not be measured
`;

type Parsed = {
  mode: 'check' | 'update' | 'explain';
  entry: string[];
  rowsOnly: boolean;
  json: boolean;
  cacheDir?: string;
  snapshotPath?: string;
  tsconfig?: string;
  root: string;
};

/**
 * An argument error, carrying whether the help text belongs after it.
 *
 * The distinction exists because the same error is rendered two ways: a person
 * gets the message and, for an unknown option, the usage text; a `--json`
 * consumer gets the message alone, since a screenful of help inside a JSON
 * string is not something a machine reads.
 */
class ParseError extends Error {
  readonly usage: boolean;
  constructor(message: string, usage = false) {
    super(message);
    this.usage = usage;
  }
}

/**
 * Whether `--json` was asked for, read straight from the raw arguments.
 *
 * Argument parsing can fail before there is a parsed result to consult, and a
 * failure there is exactly when a CI integration needs a parseable answer: the
 * composite action redirects stdout to a file, so a parse error that wrote only
 * to stderr left that file empty, `JSON.parse` threw, and the job failed with no
 * machine-readable explanation of the misconfiguration that caused it.
 */
function wantsJson(argv: string[]): boolean {
  return argv.includes('--json');
}

function parseArgs(argv: string[]): Parsed | { help: true } | { version: true } {
  const parsed: Parsed = {
    mode: 'check',
    entry: [],
    rowsOnly: false,
    json: false,
    root: process.cwd(),
  };
  let i = 0;
  if (argv[0] === 'check' || argv[0] === 'update' || argv[0] === 'explain') {
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
        throw new ParseError(`unknown option: ${arg}`, true);
    }
  }
  return parsed;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith('--')) throw new ParseError(`${flag} requires a value`);
  return v;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    const err = e as Error;
    // Same rule as every other failure: --json means stdout carries a JSON
    // object, whatever went wrong. A misconfigured invocation is a result too.
    if (wantsJson(argv)) {
      process.stdout.write(
        JSON.stringify({ ok: false, reason: 'bad-arguments', error: err.message }, null, 2) + '\n'
      );
    } else {
      const usage = err instanceof ParseError && err.usage ? `\n${USAGE}` : '';
      process.stderr.write(`vk-guard: ${err.message}\n${usage}`);
    }
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
    if (parsed.mode === 'explain') {
      const result = await explain({
        root: parsed.root,
        entry: parsed.entry,
        tsconfig: parsed.tsconfig,
        json: parsed.json,
        onProgress: parsed.json ? undefined : (m) => process.stderr.write(`  ${m}\n`),
      });
      process.stdout.write(result.output + '\n');
      return result.exitCode;
    }

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
