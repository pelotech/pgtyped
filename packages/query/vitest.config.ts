import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // jest's globals were available without importing them; keep that so the
    // test files did not have to change during the migration.
    globals: true,
    // Matches the format the committed .snap files were written in.
    snapshotFormat: {
      escapeString: true,
      printBasicPrototype: true,
    },
  },
});
