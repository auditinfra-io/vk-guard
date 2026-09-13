# Experiments

vk-guard rests on two claims about o1js that would be irresponsible to assume.
These scripts measure them, so the claims in the README are reproducible rather
than asserted.

```bash
npm run experiments
```

Each script exits non-zero if its property does **not** hold, so they double as a
platform check: if determinism fails on your hardware, a committed snapshot is
meaningless there and vk-guard will say so rather than quietly producing noise.

## 1. Is compilation deterministic? (`determinism.ts`)

Everything vk-guard does depends on this. If compiling an unchanged contract
produced different verification keys, a committed hash would be worthless and
every check would be a coin flip.

Three compiles of one unchanged contract, each in a **separate process** —
in-process runs would measure o1js's memoisation, not the compiler:

| run | seconds | rows | verification key hash |
| --- | ---: | ---: | --- |
| cold cache | 16.2 | 615 | `2409148662…2417` |
| warm cache | 2.5 | 615 | `2409148662…2417` |
| forceRecompile | 14.1 | 615 | `2409148662…2417` |

**Deterministic.** One distinct key across three runs, including a fully forced
recompile. The example project's committed snapshot re-proves this on GitHub's
runners on every pull request, which extends the result across machines.

## 2. Can a stale cache cause a false pass? (`cache-correctness.ts`)

The worst failure mode this tool could have. If a warm cache returned a key that
no longer matched the source, `check` would pass on a circuit that really
changed — silently, which is far worse than a crash.

Three compiles against **one shared cache**, changing the circuit by exactly one
constraint in between:

| run | rows | verification key hash |
| --- | ---: | --- |
| original, cold cache | 615 | `2409148662…2417` |
| one extra constraint, same warm cache | 616 | `1238812145…5290` |
| original restored, same cache | 615 | `2409148662…2417` |

**The cache is safe.** The changed circuit produced a different key, and
restoring the source restored the original key.

This is not luck. o1js's `Cache.FileSystem` is content-addressed: each entry's
`.header` holds a `uniqueId` derived from the circuit hash, and a read whose
`uniqueId` does not match is treated as a miss.

### Why this matters for the tool's design

A naive implementation would pass `forceRecompile: true` on every check to be
safe, paying roughly 6x (16.2s vs 2.5s above) on every CI run. This experiment
shows that cost is unnecessary, so vk-guard keeps the cache.

One gap remains, and the tool closes it by construction: that `uniqueId` does
**not** encode the o1js version, so an upgrade that changed key derivation
without changing the circuit hash could in principle reuse an artifact across
versions. vk-guard namespaces its cache directory by o1js version
(`.vk-guard-cache/o1js-<version>/`), which makes that unreachable.

## Notes

- Both scripts compile a deliberately tiny contract. The questions are about
  o1js's behaviour, not circuit complexity, and a small circuit keeps each run
  to seconds rather than minutes.
- Timings come from this container and will differ on your hardware. The
  **equality** of the hashes is the result; the seconds are context.
