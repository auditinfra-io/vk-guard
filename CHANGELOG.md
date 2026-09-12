# Changelog

All notable changes to this project will be documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
