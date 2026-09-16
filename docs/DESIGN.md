# Design notes

Why vk-guard is built the way it is, and what had to be discovered about o1js to
build it. Most of what follows is not in o1js's documentation; it was found by
reading its type definitions and by measurement.

## The problem

Changing a circuit changes its verification key. If an account is deployed
holding the previous key, proofs generated for the changed circuit will not
verify against it, and applying the change may require an authorized
verification-key update or a redeployment, depending on account permissions. The
o1js CHANGELOG documents circuit-level changes of this kind repeatedly — group
operation changes, a VK-hash fix, and a `Provable.if()` rewrite.

vk-guard measures locally and reads no chain state, so it reports the key
difference and the conditional consequences, never a claim about what is
currently deployed.

o1Labs runs verification-key regression tests for o1js itself, in
[`tests/vk-regression/`](https://github.com/o1-labs/o1js/tree/main/tests/vk-regression).
Application developers had nothing equivalent. vk-guard is that, for your project.

## Findings about o1js

### Gates carry no source location

```ts
type Gate = { type: GateType; wires: { row: number; col: number }[]; coeffs: string[] }
```

That is the whole structure. There is no file, no line, no label, and no
annotation API anywhere in the public surface.

This is the single fact that shapes `vk-guard explain`. A tool cannot map a gate
back to the TypeScript that produced it, so vk-guard does not pretend to. It
reports which gate *types* occupy which row ranges — the question the data can
answer — and says plainly in its help text and README that source mapping is not
something it does.

The same fact rules out per-gate witness inspection: witness values are not
exposed per gate, and they are secret by nature.

### Contracts must be built with the real TypeScript compiler

o1js's `@method` decorator reads its parameter types at runtime from
`design:paramtypes`, which is emitted only by TypeScript's
`emitDecoratorMetadata`. **esbuild does not implement that option.** Loading a
contract through any esbuild-based loader — `tsx`, `ts-node` in transpile mode,
most bundlers — fails inside `sortMethodArguments` with:

```
TypeError: Cannot read properties of undefined (reading 'map')
```

which names neither decorators nor metadata. vk-guard therefore drives `tsc`
itself, using the project's own `tsconfig.json`, and defaults
`experimentalDecorators`, `emitDecoratorMetadata` and `useDefineForClassFields`
when a project is silent about them.

It captures emitted paths from the compiler's `writeFile` callback rather than
deriving them, because deriving them from `outDir`/`rootDir` breaks on `.mts`
and `.cts` and on projects whose layout differs from the assumed one.

### o1js has two entry points, and mixing them breaks `instanceof`

`package.json` maps `exports.node.require` to `dist/node/index.cjs` and
`exports.node.import` to `dist/node/index.js`. Resolving o1js with
`require.resolve` therefore yields a **different module instance** than the ESM
`import 'o1js'` inside a user's compiled contract — with a different
`SmartContract` identity. Every contract silently failed the subclass check and
discovery found nothing.

vk-guard imports o1js through a shim written into the project's own tree, so Node
applies the project's resolution and conditions and returns the same instance the
contracts extend.

Relatedly, `require.resolve('o1js/package.json')` fails outright: the `exports`
map does not list that subpath. The version is read by walking up from the
resolved entry point.

### Compile-cache policy and measured evidence

`Cache.FileSystem` selects files by `persistentId` and validates the requested
`uniqueId` against the adjacent header. Current upstream header construction
uses a Pickles identifying hash, not necessarily the method digest. Measured in
[`experiments/cache-correctness.ts`](../experiments/README.md): changing one
constraint is compared in both a warm cache and an independent cold cache, then
the original is restored and compared with another cold control.

Passing means only that no stale-key mismatch was observed for that mutation and
recorded configuration. Historical measurements found a substantial warm-cache
speedup; they are not a performance guarantee.

vk-guard namespaces its cache directory by o1js version
(`.vk-guard-cache/o1js-<version>/`) as a conservative policy. An identifier's
lack of an explicit npm version does not prove unsafe reuse, and namespacing is
not proof of complete isolation. Cross-version and cross-backend behavior must
be tested separately. Identical source is insufficient if environment-dependent
circuit construction or compilation options differ.

## Design decisions

### The snapshot stores hashes and histograms, never keys or gates

`verificationKey.data` is a multi-kilobyte base64 blob. Committing it would make
the file unreadable and produce enormous, unreviewable diffs. The hash is a
binding commitment to the key, which is sufficient to answer the only question
asked: did it change?

The full constraint system is likewise excluded — hundreds of gate objects per
method. But its *type histogram* is a handful of integers, so that is stored:
it is what lets a drift report say `Poseidon 550 -> 561 (+11)`, which is one more
hash, rather than only that a row count moved. The example project's complete
snapshot is under 1.4 kB.

### Method digests, not just row counts

`analyzeMethods()` returns a per-method `digest` alongside `rows`. A row count is
a weak fingerprint: a refactor can swap one constraint for another and leave the
count identical. The digest moves whenever the circuit moves, and it is available
without `compile()` — which is what makes `--rows-only` a real check rather than
a rubber stamp.

### A check never passes because nothing ran

A check that succeeds because it found nothing is worse than no check: it
manufactures confidence. So zero contracts discovered exits 1, a contract that
fails to compile exits 1 with the error rather than being skipped, a snapshot
entry with no matching contract is reported explicitly, and every run prints what
it actually examined.

Lookups into snapshot data go through an `Object.hasOwn` guard. Contract and
method names come from user code and hand-edited JSON, so a contract named
`toString` would otherwise resolve against `Object.prototype`, read as
present-but-blank, and have its key comparison skipped — reporting no drift. A
false pass is the one outcome this tool must never produce, however far-fetched
the name.

### Tolerances apply to rows, never to keys

Exact row matching is too noisy for some teams, so `rowTolerance` exists. It
never applies to a verification key hash or a circuit digest, which are always
compared exactly. Because any circuit change also moves the digest, a tolerance
cannot make a changed circuit pass; it suppresses row-count findings only, which
matters most during an o1js upgrade where key changes are already accepted but
large proving-time regressions still need surfacing.

## Why the test suite takes minutes

The integration tests compile real circuits with real o1js. A distinct circuit
costs roughly 15-45 seconds of proving-system setup, and the suite exercises
about six of them, so a full run is a few minutes.

This is deliberate and not optimisable away. Mocking `compile()` would remove the
only thing the tests actually verify — that vk-guard detects a real verification
key change — and the mutation test, which adds a single constraint and requires
the check to fail, is the evidence that the tool detects rather than merely
agrees.

A shared o1js cache is kept outside the temp-project tree so repeat runs reuse
compiled artifacts (roughly 172s to 147s here). Tests that deliberately use
*different* circuits must still compile them, which is the remaining cost and the
point of the exercise.

## Scope

vk-guard reports **that** a verification key changed, and what changed
structurally. It does not attempt to explain **why** — attributing a key change
to a specific line is not something the available data supports honestly.

It performs no security analysis. For soundness bugs such as under-constrained
witnesses, see [o1js-scan](https://github.com/auditinfra-io/o1js-scan), a static
analyzer that runs in milliseconds. The two are complements: o1js-scan asks
whether a circuit is *correct*; vk-guard asks whether it *changed*.
