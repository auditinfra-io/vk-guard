# vk-guard

[![CI](https://github.com/auditinfra-io/vk-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/auditinfra-io/vk-guard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/vk-guard)](https://www.npmjs.com/package/vk-guard)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Verification-key and constraint-count regression guard for [o1js](https://github.com/o1-labs/o1js) zkApps.**

> **Status: not yet published to npm.** `npm install vk-guard` and the npm badge above
> will not resolve until the first release is pushed. Until then, install from git and
> run the Action with `source: action` (both shown below). Everything else works today —
> CI runs the full suite plus a self-check against [`examples/counter`](examples/counter)
> on every pull request.

Changing a circuit changes its verification key. A changed verification key no longer
matches the one stored on-chain, so every already-deployed instance of that zkApp
breaks and must be redeployed. The o1js CHANGELOG documents this happening repeatedly —
group operation changes, a VK-hash fix, and a `Provable.if()` rewrite were each
described as breaking deployed contracts.

o1Labs runs verification-key regression tests for o1js itself
([`tests/vk-regression/`](https://github.com/o1-labs/o1js/tree/main/tests/vk-regression)).
App developers have had nothing equivalent for their own projects.

vk-guard snapshots your contracts' verification key hashes and per-method constraint
counts into a committed file, and fails CI when they drift.

```
$ vk-guard check

1 verification key changed.
o1js is unchanged (3.0.0), so this follows from a change in your own code.

  Counter   vk 1760987873…1876 -> 1733037291…2723

Any already-deployed instance of this contract will stop matching
its on-chain verification key. If this change is intended, redeploy and run
`vk-guard update` to accept the new baseline.

Circuit changed (method digest differs) in:
  Counter.increment()

Constraint count changed:
  Counter.increment()   615 -> 616 rows (+1)

1 contract, 2 methods, o1js 3.0.0
```

## Install

Requires Node.js 20 or newer and an o1js project.

```bash
# once published:
npm install --save-dev vk-guard

# until then, install straight from git:
npm install --save-dev github:auditinfra-io/vk-guard
```

o1js is a **peer dependency**. vk-guard always measures the o1js your project builds
against, never a copy of its own.

## Usage

```bash
npx vk-guard update      # record the current state as the baseline, then commit .vk-guard.json
npx vk-guard check       # compare against the baseline (exit 1 on drift)
```

| Command / flag | Meaning |
| --- | --- |
| `vk-guard check` | Compare against the snapshot. The default command. |
| `vk-guard update` | Accept the current state as the new baseline. |
| `--rows-only` | Skip `compile()`. Compares constraint rows and circuit digests only. Seconds instead of minutes. |
| `--json` | Machine-readable output on stdout. |
| `--entry <glob>` | Override discovery. Repeatable. Default `src/**/*.ts`. |
| `--cache-dir <path>` | o1js compile cache location. |
| `--snapshot <path>` | Snapshot file. Default `.vk-guard.json`. |
| `--tsconfig <path>` | tsconfig to build with. Default: nearest `tsconfig.json`. |
| `--root <path>` | Project root. Default: cwd. |

Exit code `0` means no drift. Exit code `1` means drift, no contracts found, or a
contract that could not be measured.

## The o1js upgrade case

When o1js itself is upgraded, **every** verification key changes. A naive diff reports
"42 things changed" and the reader shrugs. That is exactly when they most need to
understand the consequence, so vk-guard says something different:

```
o1js 2.3.0 -> 2.4.0
All 4 verification keys changed as a result.
Deployed zkApps compiled with the previous version will no longer
match on-chain verification keys and must be redeployed.

  MyContract   vk 1a2b3c4d5e…7890 -> 9f8e7d6c5b…4321
```

vk-guard only offers the upgrade as the explanation when the evidence fits: the version
moved **and** every compared key moved with it. If some keys held steady, the upgrade
does not account for the drift and you get the ordinary regression message instead.

It also checks the per-method circuit digests. A pure o1js upgrade can move verification
keys while leaving circuits identical; if the digests moved too, your own edits are
contributing as well, and vk-guard says so rather than letting the upgrade take the blame.

## A check never passes because nothing ran

A check that succeeds because it found nothing is worse than no check — it manufactures
false confidence. So:

- **Zero contracts discovered exits 1**, with `no contracts found; check --entry`. Never 0.
- **A contract that fails to compile exits 1** with the error. It is never skipped.
- **A snapshot entry with no matching contract is reported explicitly** — removed, renamed,
  or discovery is broken. vk-guard cannot tell these apart, so it says so and you decide.
- **Every run prints what it actually checked**: `4 contracts, 17 methods, o1js 2.4.0`.
  Silence is always attributable.

## Snapshot format

`.vk-guard.json` is human-readable, stably ordered, and meant to be committed:

```json
{
  "vkGuardVersion": "0.1.0",
  "o1jsVersion": "3.0.0",
  "contracts": {
    "Counter": {
      "file": "src/Counter.ts",
      "kind": "SmartContract",
      "verificationKeyHash": "17609878734510172312999390341520149576174096919885406581548138984158042861876",
      "digest": "28b21ef82c11eac43caef828304800537ba7ebde5fa2f699de224531db17e008",
      "methods": {
        "increment": { "rows": 615, "digest": "b36e671c87cf5043980baa22bb2daaec" },
        "reset": { "rows": 626, "digest": "94b89320f7403f9d8df1c0f8165e76c4" }
      }
    }
  }
}
```

**`verificationKey.data` is deliberately not stored.** It is a multi-kilobyte base64 blob;
committing it would make the file unreadable and produce enormous, unreviewable diffs.
The hash is a binding commitment to the key, so it is sufficient to answer the only
question this tool asks: did it change?

**Method `digest` is stored in addition to `rows`**, because a row count is a weak
fingerprint — a refactor can swap one constraint for another and leave the count
identical. The digest changes whenever the circuit changes, and it comes from
`analyzeMethods()` without a full `compile()`. That is what makes `--rows-only` a real
check rather than a rubber stamp.

## Row-count thresholds

Exact row matching is too noisy for some teams. Add a `config` block to `.vk-guard.json`
(it is preserved across `vk-guard update`):

```json
{
  "config": {
    "rowTolerance": { "default": 0, "MyContract.withdraw": 100 }
  }
}
```

Most specific wins: `"Contract.method"`, then `"Contract"`, then `"default"`. Default is
`0` (exact). A row change within tolerance passes but is still printed — a tolerance
hides a failure, not a fact.

**A tolerance never silences a verification key change.** Those are always exact, and so
are circuit digests. Because any circuit change moves the digest too, a tolerance will
not make a changed circuit pass; it suppresses the row-count finding only. That matters
most during an o1js upgrade, where you have already accepted that keys moved but still
want large proving-time regressions surfaced.

## Caching and correctness

A stale cache that produced a matching verification key would be a false pass — the worst
failure mode this tool could have. We investigated rather than assumed.

o1js's `Cache.FileSystem` is **content-addressed on the circuit**: each entry's `.header`
holds a `uniqueId` built from the circuit hash, and a read whose `uniqueId` does not match
is treated as a miss. Verified empirically against o1js 3.0.0:

| Run | Source | Cache | Verification key hash | `increment` rows |
| --- | --- | --- | --- | --- |
| 1 | original | cold | `39730952…9048` | 615 |
| 2 | one extra constraint | **same warm cache** | `22280710…3583` (differs) | 616 |
| 3 | original restored | same warm cache | `39730952…9048` (matches run 1) | 615 |

The warm cache did not serve a stale key, and the round trip was stable. So
`forceRecompile` is **not** required for correctness, and vk-guard uses the cache — a
warm run took 5s against 27s cold in that experiment.

That `uniqueId` does not encode the o1js version, though. So vk-guard namespaces its cache
directory by o1js version (`.vk-guard-cache/o1js-<version>/`), which removes the one
remaining way a stale artifact could be reused — an o1js upgrade that changed key
derivation without changing the circuit hash — while keeping the speedup.

**Determinism was verified before anything was built on it.** Compiling the same unchanged
contract in three separate processes (cold cache, warm cache, and `forceRecompile: true`)
produced an identical verification key hash every time. A comment-only and formatting-only
edit also leaves the key unmoved.

## Requirements

vk-guard compiles your TypeScript with the **real TypeScript compiler**, using your
project's `tsconfig.json`.

This is not swappable for a faster esbuild-based loader (`tsx`, `ts-node` in transpile
mode). o1js's `@method` decorator reads parameter types at runtime via
`design:paramtypes`, which only `emitDecoratorMetadata` emits — and esbuild does not
implement it. Loading contracts through esbuild fails inside `sortMethodArguments` with a
confusing `Cannot read properties of undefined (reading 'map')`.

Your `tsconfig.json` needs what o1js already requires:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false
  }
}
```

vk-guard defaults these on if your config is silent about them.

### o1js versions

Developed and verified against **o1js 3.0.0**. The peer range is `>=3.0.0 <4.0.0`.
Major o1js releases can change the compiler API, so they are enabled only after explicit
compatibility testing rather than being assumed compatible.

Note that `verificationKey.hash` is an o1js `Field`, not a string — vk-guard stores its
decimal `toString()` form, which is what you see in the snapshot.

## GitHub Action

```yaml
name: vk-guard
on: pull_request

jobs:
  vk-guard:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # only needed for comment-on-pr
    steps:
      - uses: actions/checkout@v4
      - uses: auditinfra-io/vk-guard@main
        with:
          # Builds vk-guard from this action's own checkout. Required until the
          # package is on npm; also the way to pin to an exact git ref.
          source: action
```

Once the package is published, drop the `source` input and pin a release tag
(`auditinfra-io/vk-guard@v1`) instead.

Inputs: `working-directory`, `entry`, `rows-only`, `cache-dir`, `snapshot`,
`node-version`, `version`, `source`, `install`, `install-command`, `cache`,
`comment-on-pr`, `fail-on-drift`. Outputs: `drift`, `summary`, `json-file`.

`source` selects where the tool itself comes from: `npm` (default) installs the release
named by `version`; `action` runs `npm ci`, builds, packs and installs the tarball from
the action checkout. Installing the checkout directory directly does not work — npm
links it without running `prepack`, so `dist/` is never built and no binary is created.

The Action pins its default npm package version to the version released with the Action,
so a tagged workflow cannot silently begin executing a newer package. Set `version`
explicitly when evaluating another release.

The Action caches o1js compile artifacts across runs, keyed on the o1js version and the
lockfile hash, and posts (and updates) a single pull request comment summarizing drift.

**Compiling real circuits takes minutes.** For a fast signal on every push, use
`rows-only: true` and run the full check on a schedule or before release:

```yaml
      - uses: auditinfra-io/vk-guard@main
        with:
          source: action
          rows-only: true
```

`--rows-only` still catches any circuit change via the method digests. What it cannot do
is tell you the new verification key hash.

## vk-guard guards itself

[`examples/counter`](examples/counter) is a small but real zkApp — a `SmartContract` and a
`ZkProgram` — with its verification keys and per-method row counts committed alongside it
in `examples/counter/.vk-guard.json`. CI runs `vk-guard check` against it on every pull
request, so the tool is exercised end to end against real compiled circuits, and an o1js
upgrade announces itself here first.

```bash
npm run example:check
```

## Scope

vk-guard reports **that** a verification key changed. It does not try to explain **why** —
attributing a key change to a specific line is not something it can do honestly.

It does no security analysis, no proving, no deployment, and no on-chain reads.

For soundness analysis of o1js circuits — under-constrained witnesses and similar bugs —
see **[o1js-scan](https://github.com/auditinfra-io/o1js-scan)**, a static analyzer that
runs in milliseconds with no dependencies. The two are complements: o1js-scan asks whether
your circuit is *correct*; vk-guard asks whether it *changed*.

## Project status and support

vk-guard is an independent community project and is not affiliated with or endorsed by
o1Labs. Treat a baseline update like any other security-relevant code change: review it
and keep it version-controlled.

- See [CONTRIBUTING.md](CONTRIBUTING.md) to develop and test changes.
- Report bugs and compatibility issues through GitHub Issues.
- Report suspected vulnerabilities privately using [SECURITY.md](SECURITY.md).
- User-visible changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
