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
  const contracts = Object.fromEntries(
    Object.keys(snap.contracts)
      .sort()
      .map((name) => [name, orderedContract(snap.contracts[name]!)])
  );
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
  const methods = Object.fromEntries(
    Object.keys(c.methods)
      .sort()
      .map((name) => {
        const entry = c.methods[name]!;
        const ordered: MethodEntry = { rows: entry.rows };
        if (entry.digest !== undefined) ordered.digest = entry.digest;
        return [name, ordered];
      })
  );
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
  if (!isRecord(o.contracts)) {
    throw new Error(`${path} is missing "contracts". Regenerate it with \`vk-guard update\`.`);
  }
  const contracts = Object.fromEntries(
    Object.entries(o.contracts).map(([name, value]) => [name, validateContract(value, path, name)])
  );
  const config = validateConfig(o.config, path);
  return {
    vkGuardVersion: typeof o.vkGuardVersion === 'string' ? o.vkGuardVersion : '0.0.0',
    o1jsVersion: o.o1jsVersion,
    rowsOnly: o.rowsOnly === true,
    config,
    contracts,
  };
}

function validateContract(value: unknown, path: string, name: string): ContractEntry {
  if (!isRecord(value)) invalid(path, `contract "${name}" must be an object`);
  if (typeof value.file !== 'string') invalid(path, `contract "${name}" is missing a string "file"`);
  if (value.kind !== 'SmartContract' && value.kind !== 'ZkProgram') {
    invalid(path, `contract "${name}" has an invalid "kind"`);
  }
  if (!isRecord(value.methods)) invalid(path, `contract "${name}" is missing "methods"`);

  const methods = Object.fromEntries(Object.entries(value.methods).map(([method, entry]) => {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.rows) || (entry.rows as number) < 0) {
      invalid(path, `method "${name}.${method}" must have a non-negative integer "rows"`);
    }
    if (entry.digest !== undefined && typeof entry.digest !== 'string') {
      invalid(path, `method "${name}.${method}" has a non-string "digest"`);
    }
    return [method, { rows: entry.rows as number, ...(entry.digest === undefined ? {} : { digest: entry.digest as string }) }];
  }));
  for (const key of ['verificationKeyHash', 'digest'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      invalid(path, `contract "${name}" has a non-string "${key}"`);
    }
  }
  return {
    file: value.file as string,
    kind: value.kind as ContractEntry['kind'],
    methods,
    ...(value.verificationKeyHash === undefined ? {} : { verificationKeyHash: value.verificationKeyHash as string }),
    ...(value.digest === undefined ? {} : { digest: value.digest as string }),
  };
}

function validateConfig(value: unknown, path: string): Snapshot['config'] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) invalid(path, '"config" must be an object');
  if (value.rowTolerance === undefined) return {};
  if (!isRecord(value.rowTolerance)) invalid(path, '"config.rowTolerance" must be an object');
  const rowTolerance = Object.fromEntries(Object.entries(value.rowTolerance).map(([key, tolerance]) => {
    if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
      invalid(path, `row tolerance "${key}" must be a non-negative number`);
    }
    return [key, tolerance as number];
  }));
  return { rowTolerance };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(path: string, message: string): never {
  throw new Error(`${path}: ${message}. Regenerate it with \`vk-guard update\`.`);
}
