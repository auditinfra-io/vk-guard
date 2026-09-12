import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // o1js compilation dominates: a cold compile of a small contract is ~30s.
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
    // Compiles are CPU-bound and share one o1js cache directory.
    fileParallelism: false,
    pool: 'forks',
  },
});
