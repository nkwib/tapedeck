import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/vitest.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    target: 'node18',
    // Keep `node:`-prefixed builtin imports verbatim. Edge runtimes (Cloudflare
    // Workers `nodejs_compat`) only provide builtins under the `node:` scheme.
    removeNodeProtocol: false,
  },
  {
    // The CLI ships ESM-only (the package is `type: module`); its shebang is
    // preserved from the source entry.
    entry: ['src/cli.ts'],
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: false,
    target: 'node18',
    removeNodeProtocol: false,
  },
]);
