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

## Pull requests

- Add tests for observable behavior changes and keep snapshots deterministic.
- Preserve parseable stdout when `--json` is used; diagnostics belong on stderr.
- Update the README and CHANGELOG for user-facing changes.
- Keep pull requests narrowly scoped and explain compatibility implications.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Please
report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
