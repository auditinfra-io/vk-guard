import { SmartContract, state, State, method, Field, Poseidon } from 'o1js';

/**
 * A deliberately small zkApp. Its verification key and per-method row counts are
 * committed in `.vk-guard.json` next to it, and CI runs `vk-guard check` here on
 * every pull request — so vk-guard guards itself.
 *
 * If o1js changes how it builds these circuits, this check is what tells us.
 */
export class Counter extends SmartContract {
  @state(Field) count = State<Field>();

  @method async increment(by: Field) {
    const current = this.count.getAndRequireEquals();
    this.count.set(current.add(by));
  }

  @method async reset(seed: Field) {
    const current = this.count.getAndRequireEquals();
    this.count.set(Poseidon.hash([seed, current]));
  }
}
