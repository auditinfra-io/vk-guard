import { ZkProgram, Field, Poseidon } from 'o1js';

/**
 * A ZkProgram alongside the SmartContract, so the example covers both kinds of
 * target vk-guard discovers. ZkProgram exposes its own compile(),
 * analyzeMethods() and digest(), with a slightly different compile() option bag
 * than SmartContract — this keeps that path exercised in CI.
 */
export const HashChain = ZkProgram({
  name: 'HashChain',
  publicInput: Field,
  publicOutput: Field,

  methods: {
    step: {
      privateInputs: [Field],
      async method(start: Field, salt: Field) {
        return { publicOutput: Poseidon.hash([start, salt]) };
      },
    },
  },
});
