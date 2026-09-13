import { join, resolve } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { loadProject } from './project.js';
import { discover, DEFAULT_ENTRY } from './discover.js';
import { measure } from './analyze.js';
import { readSnapshot, writeSnapshot, snapshotExists, SNAPSHOT_FILE } from './snapshot.js';
import { compare, type Comparison } from './compare.js';
import { renderComparison, summaryLine } from './report.js';
import { summarizeGates, renderComposition, type GateComposition } from './explain.js';
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
          },
          // Observations, not attributions. `explainsVerificationKeyChanges` was
          // removed rather than renamed: it asserted that an o1js upgrade caused
          // the drift, which a snapshot comparison cannot establish.
          observations: {
            comparedVerificationKeys: comparison.vkChanges.length + comparison.vkUnchanged.length,
            verificationKeysChanged: comparison.vkChanges.length,
            verificationKeysUnchanged: comparison.vkUnchanged.length,
            allComparedKeysChanged: comparison.allComparedKeysChanged,
            methodDigestsChanged: comparison.methodDigestsChanged,
            causeDetermined: false,
          },
          contractsChecked: measured.length,
          methodsChecked: measured.reduce((n, m) => n + Object.keys(m.methods).length, 0),
          // `contractsChecked` counts what was measured, which is not the same
          // as what was compared. These two say where the baseline could not
          // back a comparison, so a consumer can tell a clean run from a run
          // that proved nothing for part of the project.
          verificationKeysNotCompared: comparison.vkNotCompared,
          circuitDigestsNotCompared: comparison.digestNotCompared,
          verificationKeyChanges: comparison.vkChanges,
          methodDigestChanges: comparison.methodDigestChanges,
          gateTypeChanges: comparison.gateTypeChanges,
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

export type ExplainOptions = {
  root: string;
  entry?: string[];
  tsconfig?: string;
  json?: boolean;
  onProgress?: (message: string) => void;
};

export type ExplainResult = {
  exitCode: number;
  output: string;
  compositions: { contract: string; method: string; composition: GateComposition }[];
};

/**
 * Report what each method's constraint system is actually made of.
 *
 * Uses `analyzeMethods()` only — no `compile()` — so it runs in seconds. o1js
 * attaches no source location to gates, so this reports the composition of the
 * circuit (which gate types, in which row ranges), never a claim about which
 * line of TypeScript produced them.
 */
export async function explain(opts: ExplainOptions): Promise<ExplainResult> {
  const root = resolve(opts.root);
  const cacheRoot = join(root, '.vk-guard-cache');
  const ctx = await loadProject(root, cacheRoot);

  const buildDir = join(cacheRoot, 'build');
  rmSync(buildDir, { recursive: true, force: true });

  const { contracts, scannedFiles } = await discover(ctx, {
    root,
    entry: opts.entry,
    tsconfig: opts.tsconfig,
    buildDir,
  });

  // Same rule as `check`: finding nothing is a failure, never a quiet success.
  if (contracts.length === 0) {
    const patterns = (opts.entry?.length ? opts.entry : DEFAULT_ENTRY).join(', ');
    return {
      exitCode: 1,
      compositions: [],
      output:
        `no contracts found; check --entry\n\n` +
        `Searched ${scannedFiles} file(s) matching: ${patterns}`,
    };
  }

  const compositions: ExplainResult['compositions'] = [];
  const missingGates: string[] = [];

  for (const d of contracts) {
    opts.onProgress?.(`analyzing ${d.name}`);
    const analysis = await d.target.analyzeMethods();
    for (const [method, info] of Object.entries(analysis)) {
      if (!info.gates) {
        // Never silently present an empty circuit as a real result.
        missingGates.push(`${d.name}.${method}()`);
        continue;
      }
      compositions.push({
        contract: d.name,
        method,
        composition: summarizeGates(info.gates, info.rows),
      });
    }
  }

  if (compositions.length === 0) {
    return {
      exitCode: 1,
      compositions: [],
      output:
        `this o1js version did not expose gate data for any method, so there is ` +
        `nothing to explain.\nAffected: ${missingGates.join(', ')}`,
    };
  }

  if (opts.json) {
    return {
      exitCode: 0,
      compositions,
      output: JSON.stringify(
        { o1jsVersion: ctx.o1jsVersion, methods: compositions, methodsWithoutGates: missingGates },
        null,
        2
      ),
    };
  }

  const body = compositions
    .map((c) => renderComposition(`${c.contract}.${c.method}()`, c.composition))
    .join('\n\n');

  const totalRows = compositions.reduce((n, c) => n + c.composition.rows, 0);
  const note =
    missingGates.length > 0
      ? `\n\nNo gate data for: ${missingGates.join(', ')}`
      : '';

  return {
    exitCode: 0,
    compositions,
    output:
      `${body}\n\n${compositions.length} method(s), ${totalRows} rows total, o1js ${ctx.o1jsVersion}${note}`,
  };
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
export { summarizeGates, diffComposition, renderComposition } from './explain.js';
export type { GateComposition, TypeShare, GateBlock, TypeDelta } from './explain.js';
