# Changelog

All notable changes to tapedeck are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
semantic versioning once it reaches 1.0.0.

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
- `withCassette(name, testFn, options?)` from `tapedeck/vitest` — pins a test to
  a named cassette and forces `replay` for its duration via `AsyncLocalStorage`.
- Error family — `CassetteMissError`, `CassetteSecretError`,
  `CassetteCorruptError`, `CassetteModeError`, all extending `CassetteError`.
- `COMPATIBILITY.md` row stamped against `ai@6.0.0`. Zero runtime dependencies
  beyond the `ai` peer.
