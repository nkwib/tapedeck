# Changelog

All notable changes to tapedeck are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
semantic versioning once it reaches 1.0.0.

## 0.4.0 - 2026-08-11

### Added

- **`mode: 'compare'` (drift detection).** A fourth mode that calls the live
  model *and* loads the recorded cassette, then reports how the two diverged.
  A cassette is a static fixture, and a static fixture rots silently: the
  provider retunes the model and the recorded trajectory quietly stops being
  what the model does. `compare` is the check for that.
  - Works for `doGenerate` and `doStream`, hash-addressed and named cassettes.
  - Three signals, all explainable: the tool-call trajectory (same tool names,
    same order, same inputs, compared as canonical JSON so key order is never
    drift), the unified finish reason, and text (`exact` / `normalized` /
    `different`, where normalized means identical after trimming, collapsing
    whitespace, and lowercasing). No similarity score to argue with.
  - Never writes. The cassette is left byte-identical, and the caller receives
    the live result, so `compare` is a live run with a drift check stapled on.
  - `onCompare(result)` fires once per compared call with the structured
    `CassetteCompareResult`. With no handler, the first diverging call throws
    the new `CassetteDriftError`, so drift can never pass silently; register a
    handler to own the policy (collect every report, fail at the end).
  - `tapedeck compare <script> [args...]` runs a command with
    `CASSETTE_MODE=compare` and propagates its exit code: a CI drift gate.
  - New exports: `compareCassetteResponses`, `summarizeResponse`,
    `formatCompareResult`, `CassetteDriftError`, and the report types
    (`CassetteCompareResult`, `ResponseSummary`, `ToolCallSummary`, ...).
  - Compare spans carry a `tapedeck.compare_equal` attribute.

### Changed

- **Language-model spec v4 is now typed, not merely supported at runtime.**
  `cassetteMiddleware` returned a `LanguageModelV3Middleware`, so `ai@7`
  consumers (spec v4) had to write `as unknown as LanguageModelMiddleware` at
  `wrapLanguageModel` even though the runtime path was green in the weekly
  cron. The middleware is now typed structurally (`TapedeckMiddleware`): it
  describes the fields tapedeck actually reads and stays generic in the result
  type, so one object is assignable to `ai@6`'s spec v3 middleware and to
  `ai@7`'s spec v4 middleware with no cast on either side. Same technique
  already used for the OTel tracer and the toolroute router.
  - `test/types.test-d.ts` asserts assignability to both spec surfaces (both
    provider majors are dev dependencies) and to `wrapLanguageModel` from the
    installed major. `pnpm test` now runs those assertions via
    `vitest --typecheck`, in both legs of the CI matrix.
  - `specificationVersion` stays `'v3'`: v4 hosts accept any string, v3 hosts
    accept only `'v3'`.
  - Runtime behaviour, cassette format, and hashes are untouched. No
    `CASSETTE_VERSION` bump, because nothing about the on-disk format moved:
    v1 and v2 cassettes replay byte-identically.

## 0.3.1 - 2026-08-10

### Changed

- **`ai` peer range widened to `>=6.0.0 <8`.** `ai@7` keeps the language-model
  spec v3 middleware surface tapedeck wraps: the weekly compat cron passed
  typecheck, the full suite, and the record/replay round trip against 7.0.37
  and 7.0.58, but the `<7` pin made the package uninstallable next to a fresh
  `npm i ai`. No runtime changes; cassette formats and hashes are untouched.
- CI runs the suite against the latest of each supported `ai` major (6 and 7)
  on every push and PR, instead of only the lockfile's 6.x plus the weekly
  `ai@latest` cron.

## 0.3.0 — 2026-06-10

### Added

- **Multi-interaction named cassettes.** A named cassette
  (`withCassette('checkout-flow.json', …)` or `cassetteName`) now stores
  *every* model call the test makes, keyed by request hash — so a multi-step
  agent records all its calls into one file and replays each one distinctly,
  in any order. Previously record mode overwrote the single file on every
  call and replay served the same response to all of them.
  - New v2 file shape: `{ version: "tapedeck@0.3.0", recordedAt,
    interactions: [{ hash, request, response }] }`. Generate and stream
    interactions can mix in one file.
  - Each `withCassette` run is one recording session: re-recording a test
    starts the file fresh, so stale interactions never linger. A static
    `cassetteName` without `withCassette` upserts by hash instead.
  - Legacy v1 single-interaction named cassettes still replay with their
    pre-0.3.0 serve-as-is behaviour. Hash-addressed cassettes are unchanged.
  - New exports: `MultiCassette`, `CassetteInteraction`, `CassetteFile`,
    `isMultiCassette`, `MULTI_CASSETTE_VERSION`, plus `diffCassetteFiles` /
    `formatCassetteFileDiff` (pairs interactions by hash; `tapedeck diff`
    and `tapedeck ls` understand both formats).

### Fixed

- **`withCassette` had no effect on the published package.** The two dist
  entry points (`.` and `./vitest`) are separate bundles, each with its own
  copy of the ambient-context module — so `withCassette` published into one
  `AsyncLocalStorage` while the middleware read another, silently falling
  back to `live` mode. The context registry now lives on `globalThis` under
  `Symbol.for('tapedeck.cassette-context')`, shared across bundles and the
  ESM/CJS dual-package boundary. A post-build cross-bundle smoke test
  (`pnpm smoke`, wired into CI) guards the regression.

### Changed

- `parseCassette`, `readCassetteFile`, and `loadCassette` now return the
  `CassetteFile` union (`Cassette | MultiCassette`); narrow with
  `isMultiCassette`. Secret detection on replay scans every interaction.
- Known limitation: interactions are keyed by hash, so two calls with an
  identical request in one test replay the same response; concurrent calls
  within a single recording session may race the file write (agent steps are
  sequential in practice).

## 0.2.0 — 2026-06-10

The "deferred to 0.2.0" cycle: telemetry, CLI, diff/merge tooling, and an
edge-safe core. Cassette format and hashes are unchanged — every 0.1.0
cassette replays as-is.

> **Package renamed to `@nkwib/tapedeck`** as of this release — the unscoped
> `tapedeck` name on npm belongs to an unrelated 2022 package. Update imports
> (`tapedeck` → `@nkwib/tapedeck`, `tapedeck/vitest` → `@nkwib/tapedeck/vitest`);
> the CLI bin is still `tapedeck`.

### Added

- **`tapedeck` CLI** (`npx tapedeck …`):
  - `record <script> [args...]` / `replay <script> [args...]` — run a script
    (or any command on PATH, e.g. `tapedeck record pnpm test`) with
    `CASSETTE_MODE` set.
  - `ls [dir]` — list cassettes with kind, model, and recording time.
  - `diff <a> <b>` — semantic field-level diff of two cassettes; exits 1 when
    they differ.
  - `merge <src> <dest> [--force]` — merge cassette directories; identical
    files are skipped, conflicts are reported (and fail the command unless
    `--force` overwrites them).
- **OTel span emission.** `cassetteMiddleware({ tracer })` accepts any
  OpenTelemetry-compatible tracer (`trace.getTracer('tapedeck')`) — typed
  structurally, so tapedeck still has zero runtime dependencies. Each
  record/replay emits a `tapedeck.generate` / `tapedeck.stream` span with
  mode, hash, cassette path, model, hit/miss, and chunk-count attributes;
  misses record the exception with an error status.
- **Pluggable storage.** `cassetteMiddleware({ store })` takes a
  `CassetteStore` (`read`/`write`/`list`). Ships with `fileCassetteStore()`
  (the default) and `memoryCassetteStore()` for tests and edge runtimes —
  seed it at build time or back it with KV/R2.
- **Diff/merge as a library**: `diffCassettes`, `formatCassetteDiff`,
  `mergeCassetteDirs` are exported alongside new helpers `parseCassette` and
  `serializeCassette`.
- **`toFollowRoute()` matcher** in `tapedeck/vitest` — asserts an agent's
  tool-call trajectory only makes transitions a
  [toolroute](https://github.com/nkwib/toolroute) router allows. Accepts AI
  SDK `result.steps`, `{ toolName }[]`, or bare names; the router is typed
  structurally so toolroute is not a dependency. Register with
  `expect.extend({ toFollowRoute })`.
- CI: `ci.yml` (typecheck, tests, build, CLI smoke, docs-site build) and a
  weekly `sdk-compat.yml` cron that runs the suite against `ai@latest`,
  appends a pass row to `COMPATIBILITY.md` via PR, and opens an `sdk-drift`
  issue on failure.

### Changed

- **Edge-safe core.** The library no longer imports `node:fs`, `node:path`,
  or `node:crypto` statically: hashing now uses WebCrypto
  (`crypto.subtle.digest`, identical digests as before) and the filesystem is
  loaded lazily inside the default store. The only remaining Node builtin in
  the core graph is `node:async_hooks` (`AsyncLocalStorage`), available on
  Cloudflare Workers under the `nodejs_compat` flag. See `COMPATIBILITY.md`.
- **`computeCassetteHash` is now async** (returns `Promise<string>`) as a
  consequence of the WebCrypto move. Digests are unchanged; existing
  cassettes stay valid.

## 0.1.0 — 2026-06-10

Initial public release. Treated as a pre-1.0 calling card; a 1.0.0 cut will
follow once the API has been used in anger.

- `cassetteMiddleware({ mode, cassetteDir, redact, cassetteName })` — a Vercel
  AI SDK `LanguageModelV3Middleware` that intercepts both `doGenerate` and
  `doStream`. Modes: `record` | `replay` | `live`.
- Streaming is first-class: `record` drains and captures ordered stream parts;
  `replay` re-serves them as a genuine `ReadableStream` via the SDK's own
  `simulateReadableStream`.
- Hash-addressed cassettes keyed by a stable SHA-256 of
  `{ modelProvider, modelId, prompt, toolSchemas, maxOutputTokens, temperature, topP }`.
  Tool schemas are normalized (descriptions stripped, keys sorted).
- Secret redaction at record time. Default matchers: `apiKey`, `authorization`,
  `x-api-key`, `bearer`, `token` (case-insensitive). Configurable via
  `redact: (string | RegExp)[]`. A replayed cassette that still contains a value
  a matcher would strip throws `CassetteSecretError`.
- `withCassette(name, testFn, options?)` from `@nkwib/tapedeck/vitest` — pins a test to
  a named cassette and forces `replay` for its duration via `AsyncLocalStorage`.
- Error family — `CassetteMissError`, `CassetteSecretError`,
  `CassetteCorruptError`, `CassetteModeError`, all extending `CassetteError`.
- `COMPATIBILITY.md` row stamped against `ai@6.0.0`. Zero runtime dependencies
  beyond the `ai` peer.
