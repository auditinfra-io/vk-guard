import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The 0.4.1 release failed at `npm ci` because release.yml installed
// npm@latest (by then npm 12) while CI ran setup-node's npm 10, which accepted
// a lockfile npm 12 rejects. CI was green on the exact commit that failed to
// publish. Both workflows now pin the same npm; this keeps them pinned
// together, and keeps the release from floating back to @latest.

function npmPins(path: string): string[] {
  const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  return [...text.matchAll(/npm install --global npm@(\S+)/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

describe('release npm', () => {
  it('is pinned to an exact version in the release workflow', () => {
    const pins = npmPins('.github/workflows/release.yml');
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is the same npm that CI installs', () => {
    const release = npmPins('.github/workflows/release.yml');
    const ci = npmPins('.github/workflows/ci.yml');
    expect(ci).toEqual(release);
  });
});
