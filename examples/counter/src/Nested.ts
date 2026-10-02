import { SmartContract, state, State, method, Field, PublicKey } from 'o1js';

/**
 * One contract calling another's @method. Counter and HashChain never do this,
 * and that turned out to matter: o1js 3.1.0 changed how a caller witnesses the
 * callee's account update in a nested @method call, which changes the CALLER's
 * verification key, and neither existing example noticed. Measured on the
 * upgrade from 3.0.0, Caller.callAdd() went from 1399 to 1548 rows while Callee
 * was untouched.
 *
 * Keeping a nested call in the dogfood example means the next o1js release that
 * moves this path fails CI here instead of passing silently.
 */
export class Callee extends SmartContract {
  @state(Field) total = State<Field>();

  @method.returns(Field) async add(x: Field) {
    const current = this.total.getAndRequireEquals();
    const next = current.add(x);
    this.total.set(next);
    return next;
  }
}

export class Caller extends SmartContract {
  @method async callAdd(callee: PublicKey, x: Field) {
    const target = new Callee(callee);
    await target.add(x);
  }
}
