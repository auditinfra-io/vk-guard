# Compilation experiments

These experiments collect narrowly scoped evidence about o1js compilation
reproducibility and filesystem-cache invalidation. A passing run describes the
`Probe` fixture, resolved dependencies, backend request, and machine recorded in
its JSON; it is not a universal guarantee about other circuits, versions,
backends, or environments.

```bash
npm run experiments
```

The command builds the harness and runs both experiments. Each compilation is a
fresh Node process. Results are written to `experiments/results/` even when a
worker fails. To retain them elsewhere or change the five-minute worker limit,
invoke either built experiment directly:

```bash
npm run experiments:build
node experiments/.build/determinism.js --output-dir ./artifacts --timeout-ms 600000
node experiments/.build/cache-correctness.js --output-dir ./artifacts --timeout-ms 600000
```

The output directory is never used for temporary caches. Every invocation owns
a unique temporary directory and removes only that directory. Diagnostics are
retained per case in JSON. A crash, timeout, malformed result, missing
measurement, or failed assertion makes the script exit nonzero. `O1JS_BACKEND`
may request a backend; an unavailable request is allowed to fail rather than
being silently skipped. The installed public API exposes a backend preference,
not a reliable post-initialization effective-backend observation, so the result
records the effective backend as `unknown`.

## Determinism comparison

`determinism.ts` compiles the original fixture four ways:

1. empty filesystem cache A;
2. the resulting warm cache A;
3. cache A with `forceRecompile: true`;
4. independent empty filesystem cache B.

Every worker explicitly receives `EXTRA_CONSTRAINT=0`. The harness independently
compares the o1js verification-key Field hash, method digest, row count, and a
separately labelled SHA-256 fingerprint of `verificationKey.data`.

The installed o1js implementation defaults an omitted compile cache to
`Cache.FileSystemDefault`; omission therefore does **not** mean “no cache.” This
experiment passes explicit `Cache.FileSystem(...)` objects. o1js also supports
`Cache.None` for a genuinely uncached case, but that is not one of these four
comparisons. In the installed implementation, `forceRecompile` bypasses cached
prover-key reads while compilation still receives the configured cache.

## Cache mutation and cold controls

`cache-correctness.ts` runs these cases sequentially:

| Case | Circuit | Cache |
| --- | --- | --- |
| A | original | initially empty shared cache |
| B | added constraint | shared cache after A |
| C | added constraint | independent empty cache |
| D | original restored | shared cache after B |
| E | original | another independent empty cache |

The changed fixture must add exactly one row and change both its method digest
and verification-key Field hash. B and C must agree on every measurement; D and
E must each agree with A. Thus the success statement is deliberately bounded:
**no stale-key mismatch was observed for this mutation under the recorded
configuration.**

Filesystem cache lookup uses a stable `persistentId` to choose the file and
validates the requested `uniqueId` against its header before reading data. In
the inspected o1js version, prover-key header construction obtains the
identifying component from a Pickles identifying hash. It should not be
described as merely the method circuit digest. Likewise, absence of an explicit
npm version string in an identifier does not by itself demonstrate unsafe
cross-version reuse.

Identical source text is not sufficient for identical compilation output when
environment-dependent circuit construction (such as this fixture's switch) or
compile options differ. Cross-version and cross-backend behavior is outside
these experiments unless those combinations are run and compared separately.
vk-guard's version-separated production cache directories are a conservative
policy, not proof of complete cache isolation.

## Reproducibility record

Each JSON file includes its schema version; vk-guard version and Git commit;
resolved o1js, Node, OS, and architecture; requested/effective backend fields;
compilation options and fixture variant; fixture/build-input and lockfile
SHA-256 fingerprints; elapsed time and measurements per case; every assertion;
overall status; and structured errors and diagnostics on failure. The harness
does not collect arbitrary environment variables, credentials, host names, or
other machine identifiers.

## Historical measurements

Earlier repository documentation recorded 615 rows for the original fixture,
616 for its one-constraint mutation, and materially faster warm-cache timings.
Those timings were historical observations from their particular container,
not current benchmarks or guarantees. Inspect the checked-in JSON results for
the measurements actually obtained by the current harness.

Synthetic tests in `test/experiments-harness.test.ts` exercise harness success
and failure handling without claiming anything about compiler behavior. They
remain distinct from the real o1js integration experiments.
