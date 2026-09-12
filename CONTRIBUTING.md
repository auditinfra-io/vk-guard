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

## Pull requests

- Add tests for observable behavior changes and keep snapshots deterministic.
- Preserve parseable stdout when `--json` is used; diagnostics belong on stderr.
- Update the README and CHANGELOG for user-facing changes.
- Keep pull requests narrowly scoped and explain compatibility implications.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Please
report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
