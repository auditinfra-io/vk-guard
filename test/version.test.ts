import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VK_GUARD_VERSION } from '../src/index.js';

const packageVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

describe('release version', () => {
  it('uses package.json for the library and built CLI', () => {
    expect(VK_GUARD_VERSION).toBe(packageVersion);
    expect(
      execFileSync(process.execPath, ['dist/cli.js', '--version'], { encoding: 'utf8' }).trim()
    ).toBe(packageVersion);
  });
});
