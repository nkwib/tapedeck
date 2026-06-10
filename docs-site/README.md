# tapedeck docs site

The marketing + docs site for [tapedeck](../), a SvelteKit static site
(adapter-static + MDsveX) deployed to Cloudflare at **https://tapedeck.pages.dev/**.

It is a **standalone project** — intentionally *not* part of the root tapedeck
pnpm workspace. It has its own `pnpm-workspace.yaml` (used only to scope settings
and approve the esbuild build script) and its own lockfile.

## Develop

```bash
cd docs-site
pnpm install
pnpm dev          # http://localhost:5173 — runs sync-content first
```

## Build

```bash
pnpm build        # → ./build (fully prerendered static output)
pnpm preview      # serve ./build locally
```

`prebuild`/`predev` run `scripts/sync-content.mjs`, which snapshots the repo-root
`CHANGELOG.md`, `COMPATIBILITY.md`, and `README.md` into `src/lib/generated/`.

Prerendering uses strict link checking — a link to a missing `#anchor` fails the
build. Headings that are link targets use explicit `id` attributes (MDsveX does
not auto-generate heading ids).

## Deploy

```bash
pnpm build
npx wrangler deploy    # config in wrangler.toml (project name: tapedeck)
```

Or point a Cloudflare Pages project named `tapedeck` at this directory with build
command `pnpm build` and output directory `build`.

## Social card

`static/og.svg` is the source; `pnpm build:og` rasterises it to `static/og.png`.
