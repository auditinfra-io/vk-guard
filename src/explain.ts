import type { RawGate } from './discover.js';

/**
 * Constraint-system composition for one method.
 *
 * This exists because a row count alone is not actionable. `Counter.increment()`
 * is a single field addition, yet it compiles to 615 rows — 550 of them Poseidon
 * gates emitted by the framework's state commitment, not by the developer's
 * arithmetic. Knowing that split is the difference between "my circuit is
 * mysteriously large" and "89% of this is fixed zkApp overhead".
 */
export type GateComposition = {
  rows: number;
  gateCount: number;
  byType: TypeShare[];
  /** Contiguous runs of one gate type, largest first. */
  blocks: GateBlock[];
  /**
   * Share of wire references that stay within `LOCAL_WIRE_SPAN` rows. Low
   * locality means values are threaded across distant parts of the circuit.
   */
  wireLocality: number;
};

export type TypeShare = { type: string; count: number; share: number };
export type GateBlock = { type: string; start: number; end: number; count: number };

/** A run shorter than this is structural noise rather than a recognisable block. */
const MIN_BLOCK = 8;
/** Wire hops within this many rows count as local. */
const LOCAL_WIRE_SPAN = 16;

export function summarizeGates(gates: RawGate[], rows: number): GateComposition {
  const counts = new Map<string, number>();
  for (const g of gates) counts.set(g.type, (counts.get(g.type) ?? 0) + 1);

  const total = gates.length || 1;
  const byType: TypeShare[] = [...counts.entries()]
    .map(([type, count]) => ({ type, count, share: count / total }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const blocks: GateBlock[] = [];
  let start = 0;
  for (let i = 1; i <= gates.length; i++) {
    const prev = gates[i - 1];
    if (i === gates.length || gates[i]!.type !== prev!.type) {
      const count = i - start;
      if (count >= MIN_BLOCK) blocks.push({ type: prev!.type, start, end: i - 1, count });
      start = i;
    }
  }
  blocks.sort((a, b) => b.count - a.count || a.start - b.start);

  let localWires = 0;
  let totalWires = 0;
  for (let row = 0; row < gates.length; row++) {
    for (const w of gates[row]!.wires) {
      totalWires++;
      if (Math.abs(w.row - row) <= LOCAL_WIRE_SPAN) localWires++;
    }
  }

  return {
    rows,
    gateCount: gates.length,
    byType,
    blocks,
    wireLocality: totalWires === 0 ? 1 : localWires / totalWires,
  };
}

/** Compare two compositions; used to say WHAT changed structurally, not why. */
export function diffComposition(before: GateComposition, after: GateComposition): TypeDelta[] {
  const types = new Set([...before.byType, ...after.byType].map((t) => t.type));
  const countOf = (c: GateComposition, type: string) =>
    c.byType.find((t) => t.type === type)?.count ?? 0;

  return [...types]
    .map((type) => {
      const b = countOf(before, type);
      const a = countOf(after, type);
      return { type, before: b, after: a, delta: a - b };
    })
    .filter((d) => d.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.type.localeCompare(y.type));
}

export type TypeDelta = { type: string; before: number; after: number; delta: number };

const BAR_WIDTH = 24;

export function renderComposition(name: string, c: GateComposition): string {
  const out: string[] = [`${name}   ${c.rows} rows`];

  for (const t of c.byType) {
    const filled = Math.max(1, Math.round(t.share * BAR_WIDTH));
    const bar = '█'.repeat(filled) + '·'.repeat(Math.max(0, BAR_WIDTH - filled));
    const pct = (t.share * 100).toFixed(1).padStart(5);
    out.push(`  ${t.type.padEnd(12)} ${String(t.count).padStart(6)}  ${pct}%  ${bar}`);
  }

  // Listing 50 identical 11-row Poseidon blocks tells the reader nothing.
  // Collapsing them to "50 x Poseidon, 11 rows each" says the useful thing:
  // the block size is one hash, so the circuit performs fifty of them.
  const shapes = new Map<string, { type: string; size: number; times: number }>();
  for (const b of c.blocks) {
    const key = `${b.type}:${b.count}`;
    const seen = shapes.get(key);
    if (seen) seen.times++;
    else shapes.set(key, { type: b.type, size: b.count, times: 1 });
  }
  const ranked = [...shapes.values()].sort(
    (a, b) => b.size * b.times - a.size * a.times || a.type.localeCompare(b.type)
  );

  if (ranked.length > 0) {
    out.push('', '  structure:');
    for (const r of ranked.slice(0, 4)) {
      const rows = r.size * r.times;
      const share = c.gateCount === 0 ? 0 : (rows / c.gateCount) * 100;
      const each = r.times === 1 ? `${r.size} rows` : `${r.times} x ${r.size} rows`;
      out.push(
        `    ${r.type.padEnd(12)} ${each.padEnd(16)} ${String(rows).padStart(5)} rows  ${share.toFixed(1)}%`
      );
    }
  }

  out.push('', `  wire locality: ${(c.wireLocality * 100).toFixed(1)}% of wires stay within ${LOCAL_WIRE_SPAN} rows`);
  return out.join('\n');
}
