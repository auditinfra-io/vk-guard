import type { Comparison } from './compare.js';
import type { Measured } from './types.js';

/** VK hashes are long decimal field elements; abbreviate for human output. */
export function abbrev(hash: string): string {
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-4)}` : hash;
}

/**
 * The one-line account of what was actually examined. It is printed on success
 * as well as failure so that a silent pass is always attributable to real work:
 * "0 contracts" can never masquerade as a clean run.
 */
export function summaryLine(measured: Measured[], o1jsVersion: string, rowsOnly: boolean): string {
  const methods = measured.reduce((n, m) => n + Object.keys(m.methods).length, 0);
  const mode = rowsOnly ? ', rows-only (no verification keys)' : '';
  return `${plural(measured.length, 'contract')}, ${plural(methods, 'method')}, o1js ${o1jsVersion}${mode}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function renderComparison(c: Comparison, rowsOnly: boolean): string {
  const out: string[] = [];

  // Printed first: a coverage hole outranks any drift found elsewhere in the
  // same run, because it says part of the run proved nothing.
  if (c.vkNotCompared.length > 0) {
    out.push(
      `No verification key to compare for:\n` +
        c.vkNotCompared.map((n) => `  ${n}`).join('\n') +
        `\n\nThe snapshot entry carries no \`verificationKeyHash\`, so this run could not\n` +
        `check the one thing that breaks deployed zkApps. Every snapshot written by\n` +
        `\`vk-guard update\` records one, so the field was removed after the fact —\n` +
        `most often by a merge-conflict resolution in .vk-guard.json.\n` +
        `Re-record the baseline with \`vk-guard update\`. Reported as a failure and not\n` +
        `a pass: a missing key is not evidence that the key is unchanged.`
    );
  }

  if (c.digestNotCompared.length > 0) {
    out.push(
      `No circuit digest to compare for:\n` +
        c.digestNotCompared.map((d) => `  ${d.contract}.${d.method}()`).join('\n') +
        `\n\nThe snapshot entry carries no \`digest\` for these methods, so a circuit\n` +
        `change in them would go undetected. Re-record with \`vk-guard update\`.`
    );
  }

  if (c.vkChanges.length > 0) {
    out.push(renderVkChanges(c));
  }

  if (c.methodDigestChanges.length > 0) {
    const lines = c.methodDigestChanges.map((d) => `  ${d.contract}.${d.method}()`);
    out.push(
      `Circuit changed (method digest differs) in:\n${lines.join('\n')}\n` +
        (rowsOnly
          ? `--rows-only does not compile, so no verification key was measured in this\n` +
            `run. Run a full check to measure whether the keys differ.`
          : `This is the constraint-level evidence behind the key differences above.`)
    );
  }

  // Structural detail sits directly under the digest changes it explains: a
  // reader who sees "the circuit changed" immediately learns in what way.
  if (c.gateTypeChanges.length > 0) {
    const lines: string[] = [];
    for (const g of c.gateTypeChanges) {
      lines.push(`  ${g.contract}.${g.method}()`);
      for (const d of g.deltas) {
        const sign = d.delta > 0 ? '+' : '';
        lines.push(
          `    ${d.type.padEnd(12)} ${String(d.before).padStart(6)} -> ${String(d.after).padEnd(6)} (${sign}${d.delta})`
        );
      }
    }
    out.push(`Gate types that moved:\n${lines.join('\n')}`);
  }

  const failingRows = c.rowChanges.filter((r) => !r.withinTolerance);
  const toleratedRows = c.rowChanges.filter((r) => r.withinTolerance);

  if (failingRows.length > 0) {
    out.push(`Constraint count changed:\n${failingRows.map(renderRow).join('\n')}`);
  }
  if (toleratedRows.length > 0) {
    // Printed even though they pass: a tolerance hides a failure, not a fact.
    out.push(
      `Constraint count changed within tolerance (not a failure):\n` +
        toleratedRows.map(renderRow).join('\n')
    );
  }

  if (c.removedContracts.length > 0) {
    const lines = c.removedContracts.map((r) => `  ${r.name}  (was ${r.file})`);
    out.push(
      `In the snapshot but not found in the project:\n${lines.join('\n')}\n` +
        `This means one of: the contract was removed, it was renamed, or discovery\n` +
        `is not reaching it (check --entry). vk-guard cannot tell these apart — if the\n` +
        `removal is intended, re-run \`vk-guard update\`.`
    );
  }
  if (c.addedContracts.length > 0) {
    out.push(
      `Not in the snapshot:\n${c.addedContracts.map((n) => `  ${n}`).join('\n')}\n` +
        `Run \`vk-guard update\` to record a baseline for them.`
    );
  }
  if (c.addedMethods.length > 0) {
    out.push(
      `New methods:\n${c.addedMethods.map((m) => `  ${m.contract}.${m.method}()`).join('\n')}`
    );
  }
  if (c.removedMethods.length > 0) {
    out.push(
      `Methods in the snapshot that no longer exist:\n` +
        c.removedMethods.map((m) => `  ${m.contract}.${m.method}()`).join('\n')
    );
  }

  return out.join('\n\n');
}

/**
 * Report verification key differences as observations.
 *
 * Deliberately makes no causal claim. A comparison of two snapshots cannot
 * distinguish an application edit from a dependency, SDK or build configuration
 * change, so the o1js version and the digest state are reported as facts
 * alongside the key differences rather than as an explanation for them.
 *
 * The consequence wording is conditional for the same reason: vk-guard reads no
 * chain state, so it cannot know whether anything is deployed, which key an
 * account holds, or whether permissions allow a key update.
 */
function renderVkChanges(c: Comparison): string {
  const changed = c.vkChanges.length;
  const compared = changed + c.vkUnchanged.length;

  const facts = [
    `${changed} of ${plural(compared, 'compared verification key')} changed` +
      (c.vkUnchanged.length > 0 ? ` (${c.vkUnchanged.length} unchanged).` : '.'),
  ];
  if (c.vkNotCompared.length > 0) {
    facts.push(`${plural(c.vkNotCompared.length, 'key')} could not be compared.`);
  }
  if (c.o1jsChanged) facts.push(`o1js version changed: ${c.o1jsBefore} -> ${c.o1jsAfter}.`);
  else facts.push(`o1js version unchanged (${c.o1jsAfter}).`);
  if (c.methodDigestsChanged) facts.push('Method circuit digests also changed.');
  facts.push('This comparison does not determine the cause.');

  const list = c.vkChanges
    .map((v) => {
      const kind = v.kind ? `  (${v.kind})` : '';
      return `  ${v.contract}   vk ${abbrev(v.before)} -> ${abbrev(v.after)}${kind}`;
    })
    .join('\n');

  return `${facts.join('\n')}\n\n${list}\n\n${consequenceNote(c)}`;
}

/**
 * What a key difference may imply, stated conditionally. Kept short here; the
 * README carries the full explanation.
 */
function consequenceNote(c: Comparison): string {
  const kinds = new Set(c.vkChanges.map((v) => v.kind));
  const lines: string[] = [];

  if (kinds.has('SmartContract') || kinds.has(undefined)) {
    lines.push(
      'If an account still holds a previous key, proofs from the changed circuit will',
      'not verify against it. Applying the change may require an authorized',
      'verification-key update or a redeployment, depending on account permissions.'
    );
  }
  if (kinds.has('ZkProgram')) {
    lines.push(
      'For a ZkProgram, anything pinning a previous key will not verify proofs from',
      'the changed program. A ZkProgram has no deployed account of its own.'
    );
  }
  lines.push(
    'vk-guard reads no chain state and cannot confirm what is deployed. Accepting a',
    'new baseline with `vk-guard update` records the new key locally; it does not',
    'change any key on-chain. See README, "What a verification key change means".'
  );
  return lines.join('\n');
}

function renderRow(r: RowLike): string {
  const sign = r.delta > 0 ? '+' : '';
  const tol = r.tolerance > 0 ? ` [tolerance ±${r.tolerance}]` : '';
  return `  ${r.contract}.${r.method}()   ${r.before} -> ${r.after} rows (${sign}${r.delta})${tol}`;
}

type RowLike = {
  contract: string;
  method: string;
  before: number;
  after: number;
  delta: number;
  tolerance: number;
};
