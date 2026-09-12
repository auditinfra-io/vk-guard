import { join, resolve } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { loadProject } from './project.js';
import { discover, DEFAULT_ENTRY } from './discover.js';
import { measure } from './analyze.js';
import { readSnapshot, writeSnapshot, snapshotExists, SNAPSHOT_FILE } from './snapshot.js';
import { compare, type Comparison } from './compare.js';
import { renderComparison, summaryLine } from './report.js';
import type { Measured, Snapshot } from './types.js';

// package.json is the release source of truth. Keeping another literal here
// allowed npm releases to report (and write into snapshots) the previous
// version when the release checklist only bumped package.json.
export const VK_GUARD_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

export type RunOptions = {
  root: string;
  mode: 'check' | 'update';
  entry?: string[];
  rowsOnly?: boolean;
  cacheDir?: string;
  snapshotPath?: string;
  tsconfig?: string;
  json?: boolean;
  onProgress?: (message: string) => void;
};

export type RunResult = {
  exitCode: number;
  output: string;
  summary: string;
  comparison?: Comparison;
  measured: Measured[];
};

export async function run(opts: RunOptions): Promise<RunResult> {
  const root = resolve(opts.root);
  const rowsOnly = opts.rowsOnly ?? false;
  const snapshotPath = opts.snapshotPath ?? join(root, SNAPSHOT_FILE);

  const cacheRoot = join(root, '.vk-guard-cache');
  const ctx = await loadProject(root, cacheRoot);

  // Rebuilt from scratch every run: importing a stale artifact from a previous
  // run is precisely the class of false pass this tool must not have.
  const buildDir = join(cacheRoot, 'build');
  rmSync(buildDir, { recursive: true, force: true });

  const { contracts, scannedFiles, semanticErrorCount } = await discover(ctx, {
    root,
    entry: opts.entry,
    tsconfig: opts.tsconfig,
    buildDir,
  });

  // Hard requirement: a run that found nothing is a failure, not a pass.
  // Exiting 0 here would manufacture confidence out of an empty search.
  if (contracts.length === 0) {
    const patterns = (opts.entry?.length ? opts.entry : DEFAULT_ENTRY).join(', ');
    return {
      exitCode: 1,
      summary: `0 contracts, 0 methods, o1js ${ctx.o1jsVersion}`,
      measured: [],
      output:
        `no contracts found; check --entry\n\n` +
        `Searched ${scannedFiles} file(s) matching: ${patterns}\n` +
        `vk-guard looks for exported SmartContract subclasses and ZkProgram objects.\n` +
        `A run that checks nothing is reported as a failure, never as a pass.`,
    };
  }

  const measured = await measure(ctx, contracts, {
    rowsOnly,
    cacheDir: opts.cacheDir,
    onProgress: opts.onProgress,
  });

  const summary = summaryLine(measured, ctx.o1jsVersion, rowsOnly);
  const warnings =
    semanticErrorCount > 0
      ? `\n\nNote: the project has ${semanticErrorCount} TypeScript type error(s). ` +
        `Measurement used the emitted JavaScript, which was produced successfully.`
      : '';

  if (opts.mode === 'update') {
    const existing = snapshotExists(snapshotPath) ? safeRead(snapshotPath) : undefined;
    const snapshot: Snapshot = {
      vkGuardVersion: VK_GUARD_VERSION,
      o1jsVersion: ctx.o1jsVersion,
      rowsOnly,
      // Policy is the user's, not ours: carry it across a baseline rewrite.
      config: existing?.config,
      contracts: Object.fromEntries(measured.map((m) => [m.name, stripName(m)])),
    };
    writeSnapshot(snapshotPath, snapshot);
    return {
      exitCode: 0,
      summary,
      measured,
      output: `Snapshot written to ${snapshotPath}\n${summary}${warnings}`,
    };
  }

  if (!snapshotExists(snapshotPath)) {
    return {
      exitCode: 1,
      summary,
      measured,
      output:
        `no snapshot at ${snapshotPath}\n\n` +
        `Run \`vk-guard update\` to record the current state as the baseline, then\n` +
        `commit the file so CI can compare against it.\n\n${summary}`,
    };
  }

  const snapshot = readSnapshot(snapshotPath);

  if (!rowsOnly && snapshot.rowsOnly) {
    return {
      exitCode: 1,
      summary,
      measured,
      output:
        `the snapshot at ${snapshotPath} was recorded with --rows-only, so it holds no\n` +
        `verification key hashes to compare against. Re-record it with \`vk-guard update\`\n` +
        `(without --rows-only), or run this check with --rows-only.\n\n${summary}`,
    };
  }

  const comparison = compare(snapshot, measured, ctx.o1jsVersion, rowsOnly);
  const body = renderComparison(comparison, rowsOnly);

  if (opts.json) {
    return {
      exitCode: comparison.failed ? 1 : 0,
      summary,
      comparison,
      measured,
      output: JSON.stringify(
        {
          ok: !comparison.failed,
          mode: rowsOnly ? 'rows-only' : 'full',
          summary,
          o1js: {
            snapshot: comparison.o1jsBefore,
            current: comparison.o1jsAfter,
            changed: comparison.o1jsChanged,
            explainsVerificationKeyChanges: comparison.versionChangeExplainsVk,
          },
          contractsChecked: measured.length,
          methodsChecked: measured.reduce((n, m) => n + Object.keys(m.methods).length, 0),
          verificationKeyChanges: comparison.vkChanges,
          methodDigestChanges: comparison.methodDigestChanges,
          rowChanges: comparison.rowChanges,
          addedContracts: comparison.addedContracts,
          removedContracts: comparison.removedContracts,
          addedMethods: comparison.addedMethods,
          removedMethods: comparison.removedMethods,
          typeErrorCount: semanticErrorCount,
        },
        null,
        2
      ),
    };
  }

  const output = comparison.failed
    ? `${body}\n\n${summary}${warnings}`
    : `No drift.\n${summary}${warnings}`;

  return { exitCode: comparison.failed ? 1 : 0, summary, comparison, measured, output };
}

function stripName(m: Measured) {
  const { name, ...entry } = m;
  void name;
  return entry;
}

function safeRead(path: string): Snapshot | undefined {
  try {
    return readSnapshot(path);
  } catch {
    return undefined;
  }
}

export { compare, readSnapshot, writeSnapshot, serializeSnapshot } from './exports.js';
export type { Snapshot, Measured, ContractEntry, MethodEntry } from './types.js';
export type { Comparison } from './compare.js';
