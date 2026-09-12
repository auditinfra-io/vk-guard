# Contributing to vk-guard

Thanks for helping make o1js circuit upgrades safer. Bug reports, compatibility reports,
documentation fixes, and focused pull requests are welcome.

## Development

Requirements: Node.js 20 or 22 and npm. Then run:

```bash
npm ci
npm run check
npm pack --dry-run
```

The integration tests compile real o1js circuits and can take several minutes on a cold
cache. Do not replace these with mocked compile results: detecting false passes is the
core security property of this project.

vk-guard also checks itself:

```bash
npm run example:check
```

`examples/counter` is a real zkApp — one `SmartContract` and one `ZkProgram` — whose
verification keys and row counts are committed in `examples/counter/.vk-guard.json`, and
CI runs this check on every pull request. If you change how circuits are measured, or
bump o1js, this is what will notice. When the change is intended, regenerate the baseline
with `node dist/cli.js update --root examples/counter` and commit the result, explaining
in the pull request why the keys moved.

Note that this makes the example snapshot a cross-machine determinism assertion. It
matches the approach o1js itself takes in `tests/vk-regression/`. If it ever fails on a
runner but not locally, that is a real finding about o1js determinism and worth an issue
rather than a quick baseline rewrite.

## Releasing

Releases publish to npm automatically, the same way o1js-scan does:

1. Bump the version in `package.json` and update `CHANGELOG.md`, then merge.
2. Cut a GitHub Release for tag `vX.Y.Z`.

Publishing the release runs `.github/workflows/release.yml`, which authenticates with the
`NPM_TOKEN` repository secret. Pushing a `vX.Y.Z` tag directly works too.

`NPM_TOKEN` must be an npm **Automation** token (or a granular token with "Bypass
two-factor authentication" enabled for publish). A classic read-write token without 2FA
bypass fails with `403 Two-factor authentication or granular access token with bypass 2fa
enabled is required to publish packages`.

If `NPM_TOKEN` is removed, the workflow falls back to npm Trusted Publishing over OIDC,
which needs a trusted publisher for this repo and `release.yml` registered on npmjs.com.
That is the better long-term setup — nothing long-lived to leak — but it can only be
configured for a package that already exists, which is why the token path exists at all.

There is no PyPI step here. Unlike o1js-scan, vk-guard is a Node/TypeScript package with
no Python artifact.

The workflow refuses to publish if the tag and `package.json` disagree, runs the full
suite plus `example:check` first, verifies `examples/` and `test/` stayed out of the
tarball, and moves the major alias (`v0`, later `v1`) that the Action examples pin.
`workflow_dispatch` runs everything except the publish, which is the way to validate the
pipeline before trusting it with a real release.

## Node.js support

`@types/node` is pinned to the **minimum** supported runtime (v20), not the newest.
Types for a later Node would let code that uses newer APIs typecheck cleanly and then
fail at runtime on Node 20. Raise it together with `engines` and the CI matrix, never on
its own.

vitest is pinned to v4 on purpose. vitest 5 requires Node >= 22.12, while this project
supports Node >= 20 and CI tests that floor; npm does not enforce `engines` without
`engine-strict`, so vitest 5 would install and appear to pass on Node 20 while being
unsupported there. Dependabot is configured not to offer that major. When Node 20 is
dropped deliberately, lift the pin, raise `engines`, and update the CI matrix together.

## Pull requests

- Add tests for observable behavior changes and keep snapshots deterministic.
- Preserve parseable stdout when `--json` is used; diagnostics belong on stderr.
- Update the README and CHANGELOG for user-facing changes.
- Keep pull requests narrowly scoped and explain compatibility implications.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Please
report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
