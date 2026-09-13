# Changelog

All notable changes to this project will be documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `experiments/`: runnable reproductions of the two claims vk-guard rests on —
  that o1js compilation is deterministic, and that a warm cache cannot serve a
  verification key contradicting the source. `npm run experiments` prints the tables
  published in the README and exits non-zero if either property fails, so it doubles as
  a platform check.
- `docs/DESIGN.md`: design rationale and the o1js findings behind it, including gates
  carrying no source location, the `emitDecoratorMetadata` requirement that rules out
  esbuild-based loaders, and the dual CJS/ESM entry points that silently break
  `instanceof`.
- Snapshots now record a compact gate-type histogram per method, and drift reports show
  which gate types moved — `Poseidon 550 -> 561 (+11)`, which is one more hash. The full
  constraint system stays out of the snapshot; the histogram is a handful of integers and
  the example's complete snapshot is under 1.4 kB.

### Changed

- The suite's shared o1js compile cache moved out of the temp-project tree, which was
  deleting it on every run and forcing every circuit to recompile from cold. Repeat runs
  are roughly 172s to 147s. Tests using deliberately different circuits must still
  compile them, which is the remaining cost.

### Added

- `vk-guard explain`: reports what each method's constraint system is composed of —
  gate-type shares, repeated structural blocks, and wire locality — using
  `analyzeMethods()` only, so it runs in seconds without compiling. It exists because a
  row count is not actionable on its own: the example's `increment()` is a single field
  addition that compiles to 615 rows, 550 of which are Poseidon gates from the
  framework's state commitment (fifty hashes at 11 rows each) rather than user
  arithmetic.
- `summarizeGates`, `diffComposition` and `renderComposition` are exported from the
  library for tools that want the same analysis.

  Deliberately absent: source-to-gate mapping and witness inspection. o1js records no
  source location on gates and does not expose per-gate witness values, so neither can be
  done faithfully; vk-guard reports the composition the data supports instead of guessing.

### Changed

- Bumped the pinned GitHub Actions to their current majors: `actions/checkout` v4 -> v7,
  `actions/setup-node` v4 -> v7, `actions/cache` v4 -> v6, `actions/github-script`
  v7 -> v9. GitHub is deprecating the Node 20 action runtime and was already forcing the
  v4 actions onto Node 24, so this was overdue.

  **Compatibility:** `action.yml` is published surface, so this raises the action-runtime
  floor for every consumer of `auditinfra-io/vk-guard`. Hosted runners are unaffected.
  Self-hosted runners too old to provide the Node 24 action runtime must be updated, or
  pinned to `auditinfra-io/vk-guard@v0.1.0`, which keeps the v4 actions. Dependabot still
  holds majors for these four so the next bump is also a deliberate, noted change rather
  than an automated PR.

### Fixed

- `VK_GUARD_VERSION` is read from `package.json` at runtime instead of being a second
  literal, so a release that bumped only the manifest can no longer publish a CLI that
  reports the previous version or writes it into snapshots. The release workflow now also
  refuses to publish when the built CLI and `package.json` disagree, and the Action
  derives its default npm version from the pinned checkout rather than a hardcoded one.

### Changed

- README reflects that vk-guard is published: plain `npm install --save-dev vk-guard`,
  and the Action pinned to the `@v0` major alias rather than `@main` with
  `source: action`. `source` is now documented as the way to run an unreleased commit.

### Fixed

- The release workflow no longer triggers on both `release: published` and `push: tags`.
  Cutting a GitHub Release creates the tag as well, so both fired and two runs raced to
  publish the same version, one of them failing on "cannot publish over the previously
  published version". Releases are now the only trigger, and a `concurrency` group
  prevents two runs for the same ref from overlapping regardless.

## [0.1.0] - 2026-09-12

First release.

### Added

- Verification-key and constraint-count regression checking for o1js projects. Records
  each contract's verification key hash, contract digest, and per-method row counts and
  circuit digests into a committed `.vk-guard.json`, and fails on drift.
- Distinct reporting for an o1js version change. When the recorded o1js version moved and
  every compared verification key moved with it, the output says so and explains that
  deployed zkApps must be redeployed — rather than reading as a regression in the user's
  own code. The upgrade is only offered as the explanation when the evidence fits: if any
  key held steady, or if method circuit digests also moved, vk-guard says the upgrade does
  not account for the drift.
- Guarantees that a check never passes because nothing ran. Zero contracts discovered
  exits 1, a contract that fails to compile exits 1 with the error rather than being
  skipped, a snapshot entry with no matching contract is reported explicitly, and every
  run prints what it actually checked.
- `check` and `update` commands with `--rows-only`, `--json`, `--entry`, `--cache-dir`,
  `--snapshot`, `--tsconfig` and `--root`. The rows-only fast path skips `compile()` and
  compares row counts and circuit digests, which still detects any circuit change.
- Optional `rowTolerance` configuration. Tolerances apply to row counts only and never
  silence a verification key or circuit digest change.
- Composite GitHub Action mirroring o1js-scan, with o1js compile-artifact caching keyed on
  the o1js version plus lockfile hash, and a pull request comment summarizing drift. Its
  `source` input selects whether vk-guard is installed from npm or built from the action's
  own checkout.
- `examples/counter`, a real zkApp (one `SmartContract` and one `ZkProgram`) whose
  verification keys and row counts are committed and checked by CI on every pull request
  via `npm run example:check`, so vk-guard guards itself.
- Release workflow publishing to npm when a GitHub Release is published, gated on the full
  test suite and the example self-check, with tarball content verification and major-tag
  aliasing.

### Notes on correctness

- o1js compilation was verified deterministic before anything was built on it: cold cache,
  warm cache, and `forceRecompile` runs in separate processes all produce an identical
  verification key hash, and CI re-proves this cross-machine on every pull request.
- o1js's `Cache.FileSystem` is content-addressed on the circuit hash, so recompiling edited
  source against a warm cache yields a different verification key and cannot produce a
  false pass. `forceRecompile` is therefore not needed. The cache directory is namespaced
  by o1js version, since that content address does not encode it.
- `verificationKey.data` is deliberately not stored. It is a multi-kilobyte blob, and the
  hash is sufficient to answer whether the key changed.
- Contracts are built with the real TypeScript compiler. o1js's `@method` decorator needs
  `emitDecoratorMetadata`, which esbuild does not implement, so transpile-only loaders
  cannot load o1js contracts at all.
- Supports Node.js 20 and newer. `@types/node` and vitest are pinned to versions that
  support that floor, so the support claim is actually tested.

[Unreleased]: https://github.com/auditinfra-io/vk-guard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/auditinfra-io/vk-guard/releases/tag/v0.1.0
