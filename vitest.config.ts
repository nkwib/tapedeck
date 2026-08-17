import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // `*.test-d.ts` files assert that the middleware composes with
    // `wrapLanguageModel` under whichever `ai` major is installed, so `pnpm
    // test` proves the typing in both legs of the CI matrix.
    typecheck: {
      enabled: true,
      include: ['test/**/*.test-d.ts'],
      tsconfig: './tsconfig.typecheck.json',
    },
  },
});
