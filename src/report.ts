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

  if (c.versionChangeExplainsVk) {
    out.push(renderVersionChange(c));
  } else if (c.vkChanges.length > 0) {
    out.push(renderOrdinaryVkDrift(c));
  }

  if (c.methodDigestChanges.length > 0) {
    const lines = c.methodDigestChanges.map((d) => `  ${d.contract}.${d.method}()`);
    out.push(
      `Circuit changed (method digest differs) in:\n${lines.join('\n')}\n` +
        (rowsOnly
          ? `The verification key for these contracts will have changed too.\n` +
            `Re-run without --rows-only to see the new key hashes.`
          : `This is the constraint-level evidence behind the key changes above.`)
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
    out.push(`New methods:\n${c.addedMethods.map((m) => `  ${m.contract}.${m.method}()`).join('\n')}`);
  }
  if (c.removedMethods.length > 0) {
    out.push(
      `Methods in the snapshot that no longer exist:\n` +
        c.removedMethods.map((m) => `  ${m.contract}.${m.method}()`).join('\n')
    );
  }

  return out.join('\n\n');
}

function renderVersionChange(c: Comparison): string {
  const n = c.vkChanges.length;
  // When circuits moved too, the upgrade is not the only cause in play. Saying
  // so keeps the tool from talking a user out of reviewing their own diff.
  const caveat = c.circuitsAlsoChanged
    ? `\n\nNote: method circuits changed as well (see digests below), so your own\n` +
      `edits are contributing too — this is not purely the upgrade.`
    : '';
  return (
    `o1js ${c.o1jsBefore} -> ${c.o1jsAfter}\n` +
    `All ${plural(n, 'verification key')} changed as a result.\n` +
    `Deployed zkApps compiled with the previous version will no longer\n` +
    `match on-chain verification keys and must be redeployed.\n\n` +
    c.vkChanges.map((v) => `  ${v.contract}   vk ${abbrev(v.before)} -> ${abbrev(v.after)}`).join('\n') +
    caveat
  );
}

function renderOrdinaryVkDrift(c: Comparison): string {
  const n = c.vkChanges.length;
  const versionNote = c.o1jsChanged
    ? `o1js also changed (${c.o1jsBefore} -> ${c.o1jsAfter}), but ${plural(c.vkUnchanged.length, 'key')} ` +
      `did not move,\nso the upgrade alone does not explain this.\n\n`
    : `o1js is unchanged (${c.o1jsAfter}), so this follows from a change in your own code.\n\n`;
  return (
    `${plural(n, 'verification key')} changed.\n` +
    versionNote +
    c.vkChanges.map((v) => `  ${v.contract}   vk ${abbrev(v.before)} -> ${abbrev(v.after)}`).join('\n') +
    `\n\nAny already-deployed instance of ${n === 1 ? 'this contract' : 'these contracts'} will stop matching\n` +
    `its on-chain verification key. If this change is intended, redeploy and run\n` +
    `\`vk-guard update\` to accept the new baseline.`
  );
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
