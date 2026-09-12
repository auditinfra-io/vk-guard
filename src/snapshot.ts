import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { Snapshot, ContractEntry, MethodEntry } from './types.js';

export const SNAPSHOT_FILE = '.vk-guard.json';

/**
 * Serialize with a stable key order so the committed file produces minimal,
 * reviewable diffs: top-level keys in a fixed sequence, contracts and methods
 * sorted by name. Without this, key order would follow discovery order and a
 * trivial reordering of imports would show up as a large diff.
 */
export function serializeSnapshot(snap: Snapshot): string {
  const contracts: Record<string, unknown> = {};
  for (const name of Object.keys(snap.contracts).sort()) {
    const c = snap.contracts[name]!;
    contracts[name] = orderedContract(c);
  }
  const out: Record<string, unknown> = {
    vkGuardVersion: snap.vkGuardVersion,
    o1jsVersion: snap.o1jsVersion,
  };
  if (snap.rowsOnly) out.rowsOnly = true;
  if (snap.config && Object.keys(snap.config).length > 0) out.config = snap.config;
  out.contracts = contracts;
  return JSON.stringify(out, null, 2) + '\n';
}

function orderedContract(c: ContractEntry): Record<string, unknown> {
  const methods: Record<string, MethodEntry> = {};
  for (const m of Object.keys(c.methods).sort()) {
    const entry = c.methods[m]!;
    const ordered: MethodEntry = { rows: entry.rows };
    if (entry.digest !== undefined) ordered.digest = entry.digest;
    methods[m] = ordered;
  }
  const out: Record<string, unknown> = { file: c.file, kind: c.kind };
  if (c.verificationKeyHash !== undefined) out.verificationKeyHash = c.verificationKeyHash;
  if (c.digest !== undefined) out.digest = c.digest;
  out.methods = methods;
  return out;
}

export function writeSnapshot(path: string, snap: Snapshot): void {
  writeFileSync(path, serializeSnapshot(snap), 'utf8');
}

export function snapshotExists(path: string): boolean {
  return existsSync(path);
}

export function readSnapshot(path: string): Snapshot {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `no snapshot at ${path}. Run \`vk-guard update\` to create the baseline, then commit it.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  return validateSnapshot(parsed, path);
}

function validateSnapshot(parsed: unknown, path: string): Snapshot {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.o1jsVersion !== 'string') {
    throw new Error(`${path} is missing "o1jsVersion". Regenerate it with \`vk-guard update\`.`);
  }
  if (typeof o.contracts !== 'object' || o.contracts === null) {
    throw new Error(`${path} is missing "contracts". Regenerate it with \`vk-guard update\`.`);
  }
  return {
    vkGuardVersion: typeof o.vkGuardVersion === 'string' ? o.vkGuardVersion : '0.0.0',
    o1jsVersion: o.o1jsVersion,
    rowsOnly: o.rowsOnly === true,
    config: (o.config as Snapshot['config']) ?? undefined,
    contracts: o.contracts as Record<string, ContractEntry>,
  };
}
