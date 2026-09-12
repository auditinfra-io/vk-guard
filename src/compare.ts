import type { Snapshot, Measured, SnapshotConfig } from './types.js';

export type VkChange = { contract: string; before: string; after: string };
export type DigestChange = { contract: string; method: string };
export type RowChange = {
  contract: string;
  method: string;
  before: number;
  after: number;
  delta: number;
  tolerance: number;
  withinTolerance: boolean;
};

export type Comparison = {
  o1jsBefore: string;
  o1jsAfter: string;
  o1jsChanged: boolean;
  /** True when the o1js version moved AND that is the plausible cause of VK drift. */
  versionChangeExplainsVk: boolean;
  /**
   * True when method circuits themselves changed. A pure o1js upgrade can move
   * verification keys while leaving circuits identical; if digests moved too,
   * the source changed as well and the upgrade is not the whole story.
   */
  circuitsAlsoChanged: boolean;
  vkChanges: VkChange[];
  /** Contracts whose VK was compared and found unchanged. */
  vkUnchanged: string[];
  methodDigestChanges: DigestChange[];
  rowChanges: RowChange[];
  addedContracts: string[];
  /** Snapshot entries with no matching contract in the working tree. */
  removedContracts: { name: string; file: string }[];
  addedMethods: { contract: string; method: string }[];
  removedMethods: { contract: string; method: string }[];
  comparedContracts: number;
  comparedMethods: number;
  failed: boolean;
};

export function compare(
  snapshot: Snapshot,
  measured: Measured[],
  currentO1jsVersion: string,
  rowsOnly: boolean
): Comparison {
  const config: SnapshotConfig = snapshot.config ?? {};
  const byName = new Map(measured.map((m) => [m.name, m]));

  const c: Comparison = {
    o1jsBefore: snapshot.o1jsVersion,
    o1jsAfter: currentO1jsVersion,
    o1jsChanged: snapshot.o1jsVersion !== currentO1jsVersion,
    versionChangeExplainsVk: false,
    circuitsAlsoChanged: false,
    vkChanges: [],
    vkUnchanged: [],
    methodDigestChanges: [],
    rowChanges: [],
    addedContracts: [],
    removedContracts: [],
    addedMethods: [],
    removedMethods: [],
    comparedContracts: 0,
    comparedMethods: 0,
    failed: false,
  };

  for (const [name, prev] of Object.entries(snapshot.contracts)) {
    if (!byName.has(name)) {
      c.removedContracts.push({ name, file: prev.file });
    }
  }

  for (const m of measured) {
    const prev = snapshot.contracts[m.name];
    if (!prev) {
      c.addedContracts.push(m.name);
      continue;
    }
    c.comparedContracts++;

    // Verification keys are always compared exactly. No tolerance applies here:
    // any change to a VK breaks every already-deployed instance of the contract.
    if (!rowsOnly && prev.verificationKeyHash && m.verificationKeyHash) {
      if (prev.verificationKeyHash !== m.verificationKeyHash) {
        c.vkChanges.push({
          contract: m.name,
          before: prev.verificationKeyHash,
          after: m.verificationKeyHash,
        });
      } else {
        c.vkUnchanged.push(m.name);
      }
    }

    for (const [method, cur] of Object.entries(m.methods)) {
      const before = prev.methods?.[method];
      if (!before) {
        c.addedMethods.push({ contract: m.name, method });
        continue;
      }
      c.comparedMethods++;

      // The circuit digest is exact, like the VK hash. A tolerance may soften a
      // row-count finding, but it must never make a changed circuit look clean.
      if (before.digest && cur.digest && before.digest !== cur.digest) {
        c.methodDigestChanges.push({ contract: m.name, method });
      }

      if (before.rows !== cur.rows) {
        const tolerance = toleranceFor(config, m.name, method);
        const delta = cur.rows - before.rows;
        c.rowChanges.push({
          contract: m.name,
          method,
          before: before.rows,
          after: cur.rows,
          delta,
          tolerance,
          withinTolerance: Math.abs(delta) <= tolerance,
        });
      }
    }

    for (const method of Object.keys(prev.methods ?? {})) {
      if (!(method in m.methods)) c.removedMethods.push({ contract: m.name, method });
    }
  }

  // A version change is offered as the explanation only when the evidence fits:
  // the version moved and every compared VK moved with it. If some VKs held
  // steady, the upgrade alone does not account for the drift and the ordinary
  // regression reading is the honest one.
  c.versionChangeExplainsVk =
    c.o1jsChanged && c.vkChanges.length > 0 && c.vkUnchanged.length === 0;
  c.circuitsAlsoChanged = c.methodDigestChanges.length > 0;

  c.failed =
    c.vkChanges.length > 0 ||
    c.methodDigestChanges.length > 0 ||
    c.rowChanges.some((r) => !r.withinTolerance) ||
    c.addedContracts.length > 0 ||
    c.removedContracts.length > 0 ||
    c.addedMethods.length > 0 ||
    c.removedMethods.length > 0;

  return c;
}

/** Most specific tolerance wins: "Contract.method", then "Contract", then "default". */
function toleranceFor(config: SnapshotConfig, contract: string, method: string): number {
  const t = config.rowTolerance;
  if (!t) return 0;
  return t[`${contract}.${method}`] ?? t[contract] ?? t.default ?? 0;
}
