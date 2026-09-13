import { SmartContract, state, State, method, Field } from 'o1js';

/**
 * The contract every experiment compiles. Deliberately tiny: the questions under
 * test are about o1js's compilation behaviour, not about circuit complexity, and
 * a small circuit keeps each run to roughly half a minute.
 *
 * `EXTRA_CONSTRAINT` is read at build time by cache-correctness, which needs two
 * source variants that differ by exactly one constraint.
 */
export class Probe extends SmartContract {
  @state(Field) value = State<Field>();

  @method async bump(by: Field) {
    const current = this.value.getAndRequireEquals();
    const next = current.add(by);
    if (process.env.EXTRA_CONSTRAINT === '1') {
      next.assertNotEquals(Field(999983));
    }
    this.value.set(next);
  }
}
