# Changelog

All notable changes to tapedeck are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
semantic versioning once it reaches 1.0.0.

## 0.2.0 — 2026-06-10

The "deferred to 0.2.0" cycle: telemetry, CLI, diff/merge tooling, and an
edge-safe core. Cassette format and hashes are unchanged — every 0.1.0
cassette replays as-is.

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
