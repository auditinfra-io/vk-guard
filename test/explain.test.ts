import { describe, it, expect } from 'vitest';
import { summarizeGates, diffComposition, renderComposition } from '../src/explain.js';
import type { RawGate } from '../src/discover.js';

const wire = (row: number) => ({ row, col: 0 });
function gate(type: string, row: number, reach = 0): RawGate {
  return { type, wires: [wire(row + reach)], coeffs: [] };
}
/** n gates of one type starting at `from`, each wiring to itself. */
function run(type: string, from: number, n: number): RawGate[] {
  return Array.from({ length: n }, (_, i) => gate(type, from + i));
}

describe('summarizeGates', () => {
  it('reports each gate type with its share', () => {
    const gates = [...run('Poseidon', 0, 55), ...run('Generic', 55, 5)];
    const c = summarizeGates(gates, 60);

    expect(c.gateCount).toBe(60);
    expect(c.byType[0]).toEqual({ type: 'Poseidon', count: 55, share: 55 / 60 });
    expect(c.byType[1]!.type).toBe('Generic');
  });

  it('sorts types by count, largest first', () => {
    const gates = [...run('Generic', 0, 9), ...run('Poseidon', 9, 40), ...run('Zero', 49, 20)];
    expect(summarizeGates(gates, 69).byType.map((t) => t.type)).toEqual([
      'Poseidon',
      'Zero',
      'Generic',
    ]);
  });

  // The point of the feature: a trivial method compiling to hundreds of rows
  // should be legible as "N repeated hashes", not an undifferentiated total.
  it('finds repeated contiguous blocks of one type', () => {
    const gates: RawGate[] = [];
    for (let i = 0; i < 5; i++) {
      gates.push(...run('Poseidon', gates.length, 11));
      gates.push(...run('Generic', gates.length, 1));
    }
    const c = summarizeGates(gates, gates.length);
    const poseidon = c.blocks.filter((b) => b.type === 'Poseidon');
    expect(poseidon).toHaveLength(5);
    expect(poseidon.every((b) => b.count === 11)).toBe(true);

    // Rendering must collapse them rather than list five identical lines.
    const text = renderComposition('X.m()', c);
    expect(text).toContain('5 x 11 rows');
  });

  it('ignores runs too short to be a recognisable block', () => {
    const gates = [...run('Poseidon', 0, 3), ...run('Generic', 3, 3), ...run('Zero', 6, 3)];
    expect(summarizeGates(gates, 9).blocks).toHaveLength(0);
  });

  it('measures wire locality', () => {
    const local = Array.from({ length: 10 }, (_, i) => gate('Generic', i, 1));
    expect(summarizeGates(local, 10).wireLocality).toBe(1);

    const distant = Array.from({ length: 10 }, (_, i) => gate('Generic', i, 500));
    expect(summarizeGates(distant, 10).wireLocality).toBe(0);
  });

  it('does not divide by zero on an empty circuit', () => {
    const c = summarizeGates([], 0);
    expect(c.gateCount).toBe(0);
    expect(c.byType).toEqual([]);
    expect(c.wireLocality).toBe(1);
    expect(() => renderComposition('X.m()', c)).not.toThrow();
  });
});

describe('diffComposition', () => {
  it('reports which gate types moved and by how much', () => {
    const before = summarizeGates([...run('Poseidon', 0, 550), ...run('Generic', 550, 15)], 565);
    const after = summarizeGates([...run('Poseidon', 0, 561), ...run('Generic', 561, 14)], 575);

    expect(diffComposition(before, after)).toEqual([
      { type: 'Poseidon', before: 550, after: 561, delta: 11 },
      { type: 'Generic', before: 15, after: 14, delta: -1 },
    ]);
  });

  it('reports a gate type that appeared or vanished entirely', () => {
    const before = summarizeGates(run('Generic', 0, 10), 10);
    const after = summarizeGates([...run('Generic', 0, 10), ...run('Rot64', 10, 8)], 18);

    expect(diffComposition(before, after)).toEqual([
      { type: 'Rot64', before: 0, after: 8, delta: 8 },
    ]);
  });

  it('is empty when nothing changed', () => {
    const c = summarizeGates(run('Poseidon', 0, 20), 20);
    expect(diffComposition(c, c)).toEqual([]);
  });
});
