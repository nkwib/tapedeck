# Compatibility

tapedeck operates at the Vercel AI SDK's `wrapLanguageModel` middleware layer
(language-model spec **v3**). The structural ceiling on the project's lifetime
is that spec's request/response shape — so this file is the public, dated record
of what tapedeck is tested against.

## Tested versions

| SDK (`ai`) | Date tested | tapedeck | Status | Notes |
|------------|-------------|----------|--------|-------|
| 6.0.0      | 2026-06-10  | 0.2.0    | ✅ pass | Same spec surface as the launch row. Hash digests and cassette format unchanged — 0.1.0 cassettes replay as-is. |
| 6.0.0      | 2026-06-10  | 0.1.0    | ✅ pass | Launch row. Model spec v3: `doGenerate` returns `content[]`; `doStream` yields `text-delta` / `tool-call` parts. |

## Pinned peer range

```json
{ "peerDependencies": { "ai": ">=6.0.0 <7" } }
```

Bumping the SDK major requires a tapedeck major. The cassette `version` field
(`tapedeck@<pkg>`) and the recorded `modelProvider` / `modelId` make a format
boundary loud at replay time.

## Edge runtimes (Cloudflare Workers, etc.)

As of 0.2.0 the core import graph is edge-safe:

- **Hashing** uses WebCrypto (`crypto.subtle.digest`) — available in Node ≥18,
  Workers, and browsers. No `node:crypto`.
- **Storage** goes through the `CassetteStore` interface. The default
  filesystem store imports `node:fs` *lazily, on first use* — pass
  `memoryCassetteStore()` (or a KV/R2-backed store) and `node:fs` is never
  loaded. No `node:path` anywhere.
- The one static Node builtin left is `node:async_hooks`
  (`AsyncLocalStorage`, used by `withCassette`'s ambient context). Cloudflare
  Workers provides it under the
  [`nodejs_compat`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
  compatibility flag.

Verified by inspection of the built bundle (the test suite asserts a full
record→replay round trip against `memoryCassetteStore` with no filesystem).
A deployed-Worker smoke test is still TODO — treat Workers support as
*designed-for, not yet CI-verified*.

The CLI (`tapedeck record|replay|ls|diff|merge`) is Node-only by design.

## What "pass" means

A row is `✅ pass` when:

1. `pnpm typecheck` succeeds against the SDK version.
2. `pnpm test` is green (the suite uses `MockLanguageModelV3` — no live API calls).
3. A round-trip holds: a cassette recorded under `record` replays byte-identical
   stream parts under `replay`, and a changed prompt/tool schema misses.

A row is `⚠️ partial` when the suite passes but a known shape change required a
documented workaround (linked in Notes).

A row is `❌ fail` when the suite breaks against a new SDK version.
