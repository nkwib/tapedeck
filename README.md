# tapedeck

> **[📼 Docs site](https://tapedeck.pages.dev/)** · **[Quickstart](https://tapedeck.pages.dev/docs#quickstart)** · **[API reference](https://tapedeck.pages.dev/api)** · **[Before / after](https://tapedeck.pages.dev/before-after)** · **[Decisions](https://tapedeck.pages.dev/decisions)**

**Record/replay middleware for the [Vercel AI SDK](https://sdk.vercel.ai).** Wrap your model in one line. Run your agent test once against the live API — commit the cassette. Every CI run after that is deterministic, offline, free, and stream-accurate.

```bash
npm install -D @nkwib/tapedeck
```

> Requires `ai` v6 or v7 (`>=6.0.0 <8`). tapedeck operates at the `wrapLanguageModel` middleware layer, so it's provider-agnostic and stream-aware by construction: no HTTP proxy, no infra. Both language-model specs are **typed**: the same middleware drops into `wrapLanguageModel` under `ai@6` (spec v3) and `ai@7` (spec v4) with no cast.

---

## 10-second demo

```typescript
import { openai } from '@ai-sdk/openai';
import { generateText, wrapLanguageModel } from 'ai';
import { cassetteMiddleware } from '@nkwib/tapedeck';

const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: cassetteMiddleware({
    mode: process.env.CASSETTE_MODE ?? 'live', // record | replay | live
    cassetteDir: './cassettes',
    redact: ['apiKey', 'authorization', /token/i],
  }),
});

// First run with CASSETTE_MODE=record → hits the live API, writes a cassette.
// Every run after with CASSETTE_MODE=replay → offline, deterministic, free.
const { text } = await generateText({ model, prompt: 'Say hi' });
```

That's the whole integration. Switch behaviour with one env var; no other code changes.

---

## Why a middleware (and not a proxy or a mock)?

| Approach | Layer | Pros | Cons |
|----------|-------|------|------|
| **tapedeck** | SDK middleware | Provider-agnostic, stream-native, zero infra | Only works with the AI SDK |
| nock / Polly | HTTP proxy | Generic, works with any HTTP | Breaks on SSE streams, leaks auth, churns on provider wire-format changes |
| `MockLanguageModelV3` | SDK mock | Fast, no network | Hand-write every turn; collapses on SDK bumps |
| Agent VCR | MCP boundary | Records MCP interactions | Doesn't record model calls |
| Braintrust / Langfuse | Hosted eval | Rich dashboards | Requires SaaS, not CI-native |

tapedeck normalizes at the SDK's own abstraction, so a cassette survives provider wire-format changes and replays streams as real streams.

---

## Modes

| Mode | Behaviour |
|------|-----------|
| `record` | Calls the real model, serializes request + response to a cassette, returns the live result. |
| `replay` | Looks up the cassette by hash, serves it. **A miss throws** — a changed prompt or tool schema fails the test, forcing a re-record. |
| `compare` | Calls the real model *and* loads the cassette, reports how they diverged, returns the live result. Never writes. |
| `live` | Passthrough. No recording, no lookup. |

The recommended setup: `live` in development, `record` to capture a fixture once, `replay` in CI, `compare` on a schedule to catch drift.

---

## Drift detection (`mode: 'compare'`)

Cassettes are static fixtures, and a static fixture rots silently: the provider
retunes the model and the recorded trajectory quietly stops being what the model
does. `compare` is the check for that. It calls the live model, loads the
recorded cassette, and reports how the two diverged, **without rewriting the
cassette**.

```typescript
cassetteMiddleware({
  mode: 'compare',
  cassetteDir: './cassettes',
  onCompare(result) {
    if (!result.equal) reports.push(result); // fail the suite at the end
  },
});
```

Three signals, all explainable:

| Signal | What counts as drift |
|--------|----------------------|
| Tool-call trajectory | Same tool names, in the same order, with the same inputs. Inputs are compared as canonical JSON, so key order is never drift. |
| Finish reason | The unified label (`stop`, `tool-calls`, …). A changed provider-raw reason is not drift. |
| Text | `exact` (byte-identical), `normalized` (identical after trimming, collapsing whitespace, lowercasing), or `different`. |

`result.equal` is true when the trajectory and finish reason match and the text
is no worse than `normalized`: model prose is not a contract, the trajectory
is. `result.text.status` is always in the report, so a stricter policy is one
`onCompare` handler away. There is no similarity score to argue with.

**It never passes silently.** `onCompare` fires on every compared call, drift or
not. With no handler registered, the first diverging call throws
`CassetteDriftError` with the rendered report, which is the CI path:

```bash
npx tapedeck compare pnpm test   # runs with CASSETTE_MODE=compare, exits nonzero on drift
```

A cassette miss in `compare` mode is a miss, not a pass: it throws
`CassetteMissError` exactly as `replay` does.

```
tapedeck: live response drifted from the cassette.
  sha256:9f2c… (stream, openai/gpt-4o)
  cassette: ./cassettes/checkout-flow.json
  tool calls: call 2: tool 'checkout' != 'refund'
    cassette: search({"q":"shirt"}) -> checkout({"id":1})
    live:     search({"q":"shirt"}) -> refund({"id":1})
  finish reason: stop -> tool-calls
```

---

## Vitest helper

`@nkwib/tapedeck/vitest` exports `withCassette`, which pins a test to a named cassette and forces `replay` mode for its duration:

```typescript
import { describe, it, expect } from 'vitest';
import { withCassette } from '@nkwib/tapedeck/vitest';

describe('checkout agent', () => {
  it('runs the checkout flow', async () => {
    await withCassette('checkout-flow.json', async () => {
      const result = await runAgent({ prompt: 'buy a t-shirt' });
      expect(result.steps).toHaveLength(3);
    });
  });
});
```

Any `cassetteMiddleware` instance active inside the callback picks up the named cassette automatically (via an `AsyncLocalStorage` context) and tears down on exit — no global setup/teardown needed.

Named cassettes are **multi-interaction**: if the agent above makes three model calls, all three are recorded into `checkout-flow.json` keyed by request hash, and each call replays its own response — in any order. Re-recording a test starts the file fresh, so stale interactions from a previous run never linger.

---

## Streaming

Streaming is first-class. In `record` mode tapedeck drains the live stream, captures the ordered stream parts, and re-serves them so your code still receives the response. In `replay` mode the recorded parts are replayed as a genuine `ReadableStream` via the SDK's own `simulateReadableStream` — `streamText`, UI message streams, and tool-call streaming all see the same surface they would live.

```typescript
import { streamText } from 'ai';

const { textStream } = await streamText({ model, prompt: 'Tell me a story' });
for await (const delta of textStream) process.stdout.write(delta);
// Identical output whether the model is live or replayed from a cassette.
```

---

## Cassette format (v1)

Cassettes are pretty-printed JSON, keyed by a stable hash, designed to diff cleanly in PRs:

```json
{
  "version": "tapedeck@0.1.0",
  "hash": "sha256:abc123…",
  "recordedAt": "2026-06-10T12:00:00Z",
  "request": {
    "modelProvider": "openai",
    "modelId": "gpt-4o",
    "prompt": [ … ],
    "tools": [ … ],
    "temperature": 0.7
  },
  "response": {
    "type": "stream",
    "chunks": [
      { "type": "text-delta", "id": "0", "delta": "I'll" },
      { "type": "text-delta", "id": "0", "delta": " help" },
      { "type": "tool-call", "toolCallId": "call_123", "toolName": "search", "input": "{\"query\":\"t-shirts\"}" }
    ]
  }
}
```

A one-shot `generateText` produces a `"type": "generate"` response holding the recorded content array, finish reason, and usage instead of chunks.

### Multi-interaction format (v2, named cassettes)

A *named* cassette (from `withCassette` / `cassetteName`) holds every call the test makes, keyed by hash — generate and stream interactions can mix freely:

```json
{
  "version": "tapedeck@0.3.0",
  "recordedAt": "2026-06-10T12:00:00Z",
  "interactions": [
    { "hash": "sha256:abc…", "request": { … }, "response": { "type": "generate", … } },
    { "hash": "sha256:def…", "request": { … }, "response": { "type": "stream", "chunks": [ … ] } }
  ]
}
```

Legacy v1 single-interaction named cassettes still replay (served as-is, pre-0.3.0 behaviour); hash-addressed cassettes always use the single format.

### Hash algorithm

The hash is a SHA-256 of the canonicalized, sorted JSON of:

```
{ modelProvider, modelId, prompt, toolSchemas, maxOutputTokens, temperature, topP }
```

Tool schemas are normalized (descriptions stripped, keys sorted) so cosmetic doc changes don't invalidate a cassette — but a changed prompt, tool input schema, or sampling param does. That's the point: a behavioural change fails CI loudly instead of replaying stale data.

---

## CLI

The package ships a small CLI for the record/replay workflow:

```bash
npx tapedeck record ./scripts/checkout-demo.mjs   # run with CASSETTE_MODE=record
npx tapedeck replay ./scripts/checkout-demo.mjs   # run with CASSETTE_MODE=replay
npx tapedeck compare pnpm test                    # run with CASSETTE_MODE=compare (drift gate)
npx tapedeck record pnpm test                     # non-file args run as commands on PATH

npx tapedeck ls ./cassettes                       # kind, model, recordedAt per cassette
npx tapedeck diff a.cassette.json b.cassette.json # semantic field-level diff (exit 1 on difference)
npx tapedeck merge ./cassettes-from-ci ./cassettes  # merge directories; --force overwrites conflicts
```

`diff` reports *which fields* diverged (`request.prompt[0].content[0].text`)
instead of raw JSON noise, and ignores `recordedAt`. `merge` skips identical
files, copies new ones, and fails on conflicts unless `--force` is passed —
both are also available as library functions (`diffCassettes`,
`mergeCassetteDirs`).

---

## Telemetry (OpenTelemetry)

Pass any OTel-compatible tracer and every record/replay emits a span — tapedeck
types the tracer structurally, so it keeps zero runtime dependencies:

```typescript
import { trace } from '@opentelemetry/api';

cassetteMiddleware({
  mode: 'replay',
  tracer: trace.getTracer('tapedeck'),
});
```

Spans are named `tapedeck.generate` / `tapedeck.stream` and carry
`tapedeck.mode`, `tapedeck.hash`, `tapedeck.cassette_path`,
`tapedeck.model_provider`, `tapedeck.model_id`, `tapedeck.cassette_hit`, and
`tapedeck.chunk_count` (streams). A cassette miss records the exception and an
error status, so a failing CI replay is visible in your traces. No tracer → no
overhead.

---

## Storage & edge runtimes

Cassette I/O goes through a `CassetteStore` (`read`/`write`/`list`). The
default is the filesystem; pass your own for everything else:

```typescript
import { cassetteMiddleware, memoryCassetteStore } from '@nkwib/tapedeck';

// Tests / edge: bundle cassettes with the worker, no fs needed.
const store = memoryCassetteStore({
  'cassettes/abc….cassette.json': cassetteJsonText,
});

cassetteMiddleware({ mode: 'replay', store });
```

The core never touches `node:fs`, `node:path`, or `node:crypto` statically —
hashing uses WebCrypto and the file store loads `node:fs` lazily. The one
remaining Node builtin is `node:async_hooks` (for `withCassette`'s ambient
context), which Cloudflare Workers provides under the `nodejs_compat` flag.
On Workers: enable `nodejs_compat`, replay from a `memoryCassetteStore` (or a
KV/R2-backed `CassetteStore`), and record from Node. See `COMPATIBILITY.md`.

---

## Secret redaction

Redaction is key-name based and runs **at record time**, so secrets never reach disk:

- Default matchers: `apiKey`, `authorization`, `x-api-key`, `bearer`, `token` (case-insensitive).
- Configurable via `redact: (string | RegExp)[]` — strings match field/header names case-insensitively; RegExps test the raw key.
- Replaying a cassette that still contains a value a matcher would strip throws `CassetteSecretError` — a committed secret fails the build instead of leaking.

```typescript
cassetteMiddleware({
  mode: 'record',
  redact: ['apiKey', 'authorization', /secret/i],
});
```

---

## Errors

| Error | When |
|-------|------|
| `CassetteMissError` | `replay` mode, no cassette matches the hash. Message includes the hash and the path searched. |
| `CassetteSecretError` | A replayed cassette still contains unredacted secrets. Lists the offending field paths. |
| `CassetteCorruptError` | Invalid JSON, unknown version, or a malformed response shape. |
| `CassetteModeError` | An invalid mode string was supplied. |
| `CassetteDriftError` | `compare` mode, the live response diverged and no `onCompare` handler took ownership. Carries the full `result` report. |

All extend `CassetteError`, so you can catch the whole family with one `instanceof`.

---

## API reference

### `cassetteMiddleware(options?)`

Returns a `TapedeckMiddleware`, which satisfies `wrapLanguageModel` under both
supported `ai` majors. Intercepts both `doGenerate` and `doStream`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `'record' \| 'replay' \| 'compare' \| 'live'` | `'live'` | Operating mode. |
| `cassetteDir` | `string` | `'./cassettes'` | Directory cassettes are read from / written to. |
| `redact` | `(string \| RegExp)[]` | `[]` | Extra key matchers, merged with the built-in defaults. |
| `cassetteName` | `string` | — | Force a specific filename instead of hash-addressing. Mostly used internally by `withCassette`. |
| `store` | `CassetteStore` | filesystem | Storage backend (`read`/`write`/`list`). Use `memoryCassetteStore()` on edge runtimes. |
| `tracer` | `TapedeckTracer` | — | OTel-compatible tracer; emits `tapedeck.generate` / `tapedeck.stream` spans. |
| `onCompare` | `(result: CassetteCompareResult) => void \| Promise<void>` | none | `compare` mode only. Fires per call, drift or not. Registering it suppresses `CassetteDriftError` and hands you the failure policy. |

### Spec v3 and v4 typing

`ai@6` takes a spec v3 middleware; `ai@7` takes spec v4. The two are mutually
unassignable, so a middleware annotated with either concrete type forces
consumers of the other major to write `as unknown as LanguageModelMiddleware`.
tapedeck instead types the middleware boundary structurally, over the fields it
genuinely reads, and stays generic in the result type: whatever `doGenerate`
hands in is what `wrapGenerate` hands back. Nothing about a request is
interpreted, only hashed and serialized, so nothing is lost. `test/types.test-d.ts`
asserts assignability to both spec surfaces on every CI run.

### `withCassette(name, testFn, options?)`

From `@nkwib/tapedeck/vitest`. Runs `testFn` with `name` pinned and `replay` forced (override via `options.mode`). `options.cassetteDir` overrides the directory.

### Lower-level helpers (exported from `@nkwib/tapedeck`)

- `computeCassetteHash(request)` — the stable hash used for cassette identity (async, WebCrypto).
- `loadCassette(hash, dir)` / `saveCassette(hash, dir, cassette)` — direct cassette I/O.
- `parseCassette(raw, path)` / `serializeCassette(cassette)` — the on-disk codec (`CassetteFile = Cassette | MultiCassette`; narrow with `isMultiCassette`).
- `compareCassetteResponses(recorded, live, context)` / `formatCompareResult(result)`: the drift report, usable outside the middleware.
- `summarizeResponse(response)`: reduce a response to `{ text, toolCalls, finishReason }`.
- `diffCassettes(a, b)` / `formatCassetteDiff(diff)` — semantic cassette diff.
- `diffCassetteFiles(a, b)` / `formatCassetteFileDiff(diff)` — file diff pairing interactions by hash (any format).
- `mergeCassetteDirs(src, dest, options?)` — merge cassette directories.
- `fileCassetteStore()` / `memoryCassetteStore(seed?)` — storage backends.
- `stableStringify(value)`, `normalizeTools(tools)` — the canonicalization primitives.
- `CASSETTE_VERSION`, `cassetteFilename(hash)`, `REDACTED`, `DEFAULT_REDACT`.

---

## Adopting in a project

1. Wrap your model with `cassetteMiddleware`, reading `mode` from an env var.
2. Run your agent test once with `CASSETTE_MODE=record` against the live API.
3. Commit the generated `cassettes/*.cassette.json`.
4. Set `CASSETTE_MODE=replay` in CI. Tests are now offline, deterministic, and free.
5. Optionally run `npx tapedeck compare pnpm test` on a schedule (with real API keys) to catch the model drifting away from the committed fixtures.

When a prompt or tool schema changes, the hash changes, replay misses, and CI fails — re-record and commit the new cassette.

---

## ToolRoute cross-sell

If you also use [`toolroute`](https://github.com/nkwib/toolroute), pair the two: guard tool trajectories in production with ToolRoute, replay them in CI with tapedeck, and assert the trajectory with `toFollowRoute()`:

```typescript
import { expect } from 'vitest';
import { toFollowRoute, withCassette } from '@nkwib/tapedeck/vitest';

expect.extend({ toFollowRoute });

await withCassette('checkout-flow.json', async () => {
  const result = await runAgent({ prompt: 'buy a t-shirt' });
  expect(result.steps).toFollowRoute(router); // every transition legal per the router
});
```

The matcher accepts AI SDK `result.steps`, a flat `{ toolName }[]` list, or bare tool-name strings, and pinpoints the first illegal transition (`call 3 ('fetch' after 'fetch') is illegal; legal next: [summarize]`). The router argument is typed structurally (`{ adjacency, routerVersion }`), so tapedeck works with any toolroute version — and without toolroute installed at all.

---

## Build & contributing

- Zero runtime dependencies beyond the `ai` peer (`@ai-sdk/provider` is a type-only dev dependency).
- TypeScript strict, `noUncheckedIndexedAccess`.
- Dual ESM/CJS via tsup. Tests run on vitest with **no live API calls** — tapedeck tests use `MockLanguageModelV3`.

```bash
pnpm install
pnpm build      # tsup → dist (ESM + CJS + d.ts)
pnpm test       # vitest run
pnpm typecheck  # tsc --noEmit
```

## License

MIT
