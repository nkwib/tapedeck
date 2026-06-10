# Compatibility

tapedeck operates at the Vercel AI SDK's `wrapLanguageModel` middleware layer
(language-model spec **v3**). The structural ceiling on the project's lifetime
is that spec's request/response shape — so this file is the public, dated record
of what tapedeck is tested against.

## Tested versions

| SDK (`ai`) | Date tested | tapedeck | Status | Notes |
|------------|-------------|----------|--------|-------|
| 6.0.0      | 2026-06-10  | 0.1.0    | ✅ pass | Launch row. Model spec v3: `doGenerate` returns `content[]`; `doStream` yields `text-delta` / `tool-call` parts. |

## Pinned peer range

```json
{ "peerDependencies": { "ai": ">=6.0.0 <7" } }
```

Bumping the SDK major requires a tapedeck major. The cassette `version` field
(`tapedeck@<pkg>`) and the recorded `modelProvider` / `modelId` make a format
boundary loud at replay time.

## What "pass" means

A row is `✅ pass` when:

1. `pnpm typecheck` succeeds against the SDK version.
2. `pnpm test` is green (the suite uses `MockLanguageModelV3` — no live API calls).
3. A round-trip holds: a cassette recorded under `record` replays byte-identical
   stream parts under `replay`, and a changed prompt/tool schema misses.

A row is `⚠️ partial` when the suite passes but a known shape change required a
documented workaround (linked in Notes).

A row is `❌ fail` when the suite breaks against a new SDK version.
