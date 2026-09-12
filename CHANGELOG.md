# Changelog

All notable changes to this project will be documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Contract and method names that collide with `Object.prototype` members (`toString`,
  `constructor`, `valueOf`, `__proto__`) are no longer resolved through the prototype
  chain when comparing against a snapshot. Previously such a contract was treated as
  present-but-blank, its verification key comparison was skipped, and the run reported no
  drift — a false pass. Row tolerances could be inherited the same way.

### Added

- `examples/counter`, a real zkApp (one `SmartContract` and one `ZkProgram`) with its
  verification keys and row counts committed, checked by CI on every pull request via
  `npm run example:check`. This is also the first end-to-end coverage of the `ZkProgram`
  discovery and measurement path.
- `source` input on the GitHub Action, selecting whether vk-guard is installed from npm
  or built from the action's own checkout. The latter makes the Action usable before the
  package is published, and lets consumers pin to a git ref.

### Changed

- Dependabot no longer opens automated major-version PRs for `typescript` (a runtime
  dependency: vk-guard drives the compiler API) or for the four actions used by
  `action.yml` (published product surface). `o1js` is excluded from the grouped
  development-dependency PRs for the same reason.
- README no longer implies the package is installable from npm; it documents the git and
  `source: action` routes until the first release.

## [0.1.0] - 2026-09-12

- Initial release with verification-key, method-digest, and constraint-row snapshots.
- Added full and rows-only checks, TypeScript project discovery, stable snapshots, and a
  composite GitHub Action.

[Unreleased]: https://github.com/auditinfra-io/vk-guard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/auditinfra-io/vk-guard/releases/tag/v0.1.0
