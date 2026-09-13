import type { Snapshot, Measured, SnapshotConfig } from './types.js';

/**
 * Read a key from a plain object, ignoring anything inherited from
 * `Object.prototype`.
 *
 * Snapshot keys are contract and method names supplied by the user's project
 * and by hand-edited JSON, so nothing stops one being called `toString`,
 * `constructor`, or `valueOf`. A bare `record[key]` would then return an
 * inherited function instead of `undefined`, and the caller would treat a
 * contract that is absent from the snapshot as present-but-blank: its
 * `verificationKeyHash` reads as `undefined`, the key comparison is skipped,
 * and the run reports no drift. That is a false pass, which is the one
 * outcome this tool must never produce.
 */
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (record === undefined) return undefined;
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export type VkChange = {
  contract: string;
  /**
   * Recorded so the report can distinguish a SmartContract, which may have a
   * deployed account holding a key, from a ZkProgram, which does not have an
   * account of its own — its key matters to whatever verifies its proofs.
   */
  kind?: 'SmartContract' | 'ZkProgram';
  before: string;
  after: string;
};
export type DigestChange = { contract: string; method: string };
/** Which gate types moved for one method, and by how much. */
export type GateTypeChange = {
  contract: string;
  method: string;
  deltas: { type: string; before: number; after: number; delta: number }[];
};

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
  /**
   * Every verification key that was actually compared differed.
   *
   * Purely observational, and deliberately independent of `o1jsChanged`. A
   * comparison of two snapshots cannot tell whether drift came from application
   * edits, a dependency or SDK change, or build configuration, so no field here
   * encodes a cause. Requires at least one real comparison: contracts in
   * `vkNotCompared` are excluded, because a key that was never compared is not
   * evidence of anything.
   */
  allComparedKeysChanged: boolean;
  /** Observational: at least one method's circuit digest differed. */
  methodDigestsChanged: boolean;
  vkChanges: VkChange[];
  /** Contracts whose VK was compared and found unchanged. */
  vkUnchanged: string[];
  /**
   * Contracts a full check could NOT compare, because one side carried no
   * verification key hash.
   *
   * `verificationKeyHash` is optional in the snapshot schema, so a hand-edit or
   * a merge-conflict resolution that drops the line leaves an entry that still
   * looks complete. Without this list the contract is counted in
   * `comparedContracts`, its key is never compared, and the run passes — the
   * same false pass `own()` guards against one field over, reached by a
   * different route. Absence of a key is not evidence that the key is
   * unchanged, so these fail rather than passing quietly.
   */
  vkNotCompared: string[];
  methodDigestChanges: DigestChange[];
  /** Methods whose circuit digest could not be compared, for the same reason. */
  digestNotCompared: DigestChange[];
  /**
   * Structural detail behind the digest changes: which gate types grew or shrank.
   * Reports WHAT changed in the circuit, never why — attributing a gate to a line
   * of source is not something o1js's data supports.
   */
  gateTypeChanges: GateTypeChange[];
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
  assertUniqueNames(measured);

  const config: SnapshotConfig = snapshot.config ?? {};
  const byName = new Map(measured.map((m) => [m.name, m]));

  const c: Comparison = {
    o1jsBefore: snapshot.o1jsVersion,
    o1jsAfter: currentO1jsVersion,
    o1jsChanged: snapshot.o1jsVersion !== currentO1jsVersion,
    allComparedKeysChanged: false,
    methodDigestsChanged: false,
    vkChanges: [],
    vkUnchanged: [],
    vkNotCompared: [],
    methodDigestChanges: [],
    digestNotCompared: [],
    gateTypeChanges: [],
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
    const prev = own(snapshot.contracts, m.name);
    if (!prev) {
      c.addedContracts.push(m.name);
      continue;
    }
    c.comparedContracts++;

    // Verification keys are always compared exactly. No tolerance applies here:
    // a key either matches the baseline or it does not, and the consequences of a
    // mismatch depend on deployment state vk-guard cannot see.
    //
    // Three outcomes, not two. Folding "could not compare" into the silent
    // else-branch is what let a changed key pass: `vkChanges` and `vkUnchanged`
    // would both be empty, which is indistinguishable from a clean run.
    if (!rowsOnly) {
      if (!prev.verificationKeyHash || !m.verificationKeyHash) {
        c.vkNotCompared.push(m.name);
      } else if (prev.verificationKeyHash !== m.verificationKeyHash) {
        c.vkChanges.push({
          contract: m.name,
          kind: m.kind,
          before: prev.verificationKeyHash,
          after: m.verificationKeyHash,
        });
      } else {
        c.vkUnchanged.push(m.name);
      }
    }

    for (const [method, cur] of Object.entries(m.methods)) {
      const before = own(prev.methods, method);
      if (!before) {
        c.addedMethods.push({ contract: m.name, method });
        continue;
      }
      c.comparedMethods++;

      // The circuit digest is exact, like the VK hash. A tolerance may soften a
      // row-count finding, but it must never make a changed circuit look clean.
      // Same three-way split: a missing digest is unknown, not equal.
      if (!before.digest || !cur.digest) {
        c.digestNotCompared.push({ contract: m.name, method });
      } else if (before.digest !== cur.digest) {
        c.methodDigestChanges.push({ contract: m.name, method });

        const deltas = gateTypeDeltas(before.gateTypes, cur.gateTypes);
        if (deltas.length > 0) {
          c.gateTypeChanges.push({ contract: m.name, method, deltas });
        }
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
      if (own(m.methods, method) === undefined) {
        c.removedMethods.push({ contract: m.name, method });
      }
    }
  }

  // Observations only. Earlier versions inferred that an o1js upgrade "explained"
  // the drift when every key moved with it, and that unchanged o1js meant the
  // application source must have changed. Neither follows: a comparison of two
  // snapshots cannot separate application edits from dependency, SDK or build
  // configuration changes. Both inferences are gone rather than softened.
  c.allComparedKeysChanged = c.vkChanges.length > 0 && c.vkUnchanged.length === 0;
  c.methodDigestsChanged = c.methodDigestChanges.length > 0;

  c.failed =
    c.vkChanges.length > 0 ||
    c.vkNotCompared.length > 0 ||
    c.digestNotCompared.length > 0 ||
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
  return own(t, `${contract}.${method}`) ?? own(t, contract) ?? own(t, 'default') ?? 0;
}

/**
 * Gate-type deltas between two histograms. Absent on either side means the
 * snapshot predates histograms, in which case there is nothing to compare and we
 * say nothing rather than reporting every type as newly appeared.
 */
function gateTypeDeltas(
  before: Record<string, number> | undefined,
  after: Record<string, number> | undefined
): GateTypeChange['deltas'] {
  if (!before || !after) return [];
  const types = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...types]
    .map((type) => {
      const b = own(before, type) ?? 0;
      const a = own(after, type) ?? 0;
      return { type, before: b, after: a, delta: a - b };
    })
    .filter((d) => d.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.type.localeCompare(y.type));
}

/**
 * Reject measured targets that share a name.
 *
 * The snapshot keys contracts by name alone, so two distinct targets with the
 * same name would silently collapse into one entry — the second overwriting the
 * first, leaving a contract unguarded while the run still reported success.
 * Discovery rejects this earlier and more helpfully; this guard exists because
 * `compare()` is exported, so a programmatic caller can reach it without going
 * through discovery at all.
 */
function assertUniqueNames(measured: Measured[]): void {
  // A Map is used rather than a plain object precisely because names like
  // `toString` are legal here; Map keys carry no prototype.
  const counts = new Map<string, number>();
  for (const m of measured) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);

  const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  if (duplicated.length === 0) return;

  const detail = duplicated
    .map((name) => {
      const files = measured.filter((m) => m.name === name).map((m) => m.file);
      return `  ${name}  (${files.join(', ')})`;
    })
    .join('\n');
  throw new Error(
    `duplicate target names passed to compare():\n${detail}\n` +
      `A snapshot is keyed by name, so these would overwrite each other and leave ` +
      `a target unguarded. Give each target a unique name.`
  );
}
