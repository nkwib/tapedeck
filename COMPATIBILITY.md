# Compatibility

tapedeck operates at the Vercel AI SDK's `wrapLanguageModel` middleware layer.
The structural ceiling on the project's lifetime is that layer's
request/response shape, so this file is the public, dated record of what
tapedeck is tested against.

## Language-model spec versions

**Both spec versions are typed as of 0.4.0**, not just supported at runtime.
`ai@6` takes a spec v3 middleware and `ai@7` takes spec v4; the two concrete
types are mutually unassignable, so before 0.4.0 an `ai@7` consumer had to
write `as unknown as LanguageModelMiddleware` at the call site.
`cassetteMiddleware` now returns a structurally typed `TapedeckMiddleware`:
it declares only the fields tapedeck reads (`prompt`, `tools`, sampling params,
`provider`, `modelId`) and stays generic in the result type, so one object is
assignable to both. `specificationVersion` stays `'v3'` because v4 hosts accept
any string while v3 hosts accept only `'v3'`.

Both provider majors are dev dependencies (`@ai-sdk/provider` for v3,
`@ai-sdk/provider-v4` for v4), and `test/types.test-d.ts` asserts assignability
to both spec surfaces plus to `wrapLanguageModel` from whichever `ai` major the
CI matrix leg installed. A spec v5 would show up as a red type test, not as a
silent consumer-side cast.

## Tested versions

| SDK (`ai`) | Date tested | tapedeck | Status | Notes |
|------------|-------------|----------|--------|-------|
| 6.0.0      | 2026-06-10  | 0.3.0    | ✅ pass | Multi-interaction named cassettes (v2 format); v1 cassettes replay as-is. |
| 6.0.0      | 2026-06-10  | 0.2.0    | ✅ pass | Same spec surface as the launch row. Hash digests and cassette format unchanged — 0.1.0 cassettes replay as-is. |
| 6.0.0      | 2026-06-10  | 0.1.0    | ✅ pass | Launch row. Model spec v3: `doGenerate` returns `content[]`; `doStream` yields `text-delta` / `tool-call` parts. |
| 7.0.37 | 2026-07-27 | 0.3.0 | ✅ pass | Weekly cron. |
| 7.0.58 | 2026-08-03 | 0.3.0 | ✅ pass | Weekly cron; peer range widened to `<8` in 0.3.1. |
| 6.0.256 | 2026-08-11 | 0.4.0 | ✅ pass | Spec v3 typed via `TapedeckMiddleware`; type tests green. |
| 7.0.58 | 2026-08-11 | 0.4.0 | ✅ pass | Spec v4 typed via `TapedeckMiddleware`; the `as unknown as` cast at `wrapLanguageModel` is gone. |
| 7.0.85 | 2026-08-31 | 0.4.0 | ✅ pass | Weekly cron. |

## Pinned peer range

```json
{ "peerDependencies": { "ai": ">=6.0.0 <8" } }
```

A new SDK major joins the peer range only after the weekly cron proves it
green (`ai@7` passed at 7.0.37 and 7.0.58, so 0.3.1 widened the pin to `<8`).
What forces a tapedeck major is a language-model *spec* shape change deep
enough to break the fields tapedeck reads, not an SDK major that renumbers the
spec. The cassette `version` field
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

The CLI (`tapedeck record|replay|compare|ls|diff|merge`) is Node-only by design.

## What "pass" means

A row is `✅ pass` when:

1. `pnpm typecheck` succeeds against the SDK version.
2. `pnpm test` is green (the suite uses `MockLanguageModelV3`, no live API
   calls), including the `*.test-d.ts` type assertions.
3. A round-trip holds: a cassette recorded under `record` replays byte-identical
   stream parts under `replay`, and a changed prompt/tool schema misses.

A row is `⚠️ partial` when the suite passes but a known shape change required a
documented workaround (linked in Notes).

A row is `❌ fail` when the suite breaks against a new SDK version.
