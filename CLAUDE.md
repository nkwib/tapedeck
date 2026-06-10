# tapedeck — Record/Replay Middleware for Vercel AI SDK

## Purpose

Wrap your AI SDK model in one line. Run your agent test once against the live API — commit the cassette. Every CI run after that is deterministic, offline, free, and stream-accurate.

## Architecture

- **Layer:** `wrapLanguageModel` middleware — not HTTP proxy, not MCP boundary.
- **Why this layer:** Provider-agnostic (normalizes at SDK abstraction), stream-aware by construction, no proxy/infra.
- **Modes:** `record` | `replay` | `live`
- **Cassette format:** Normalized JSON keyed by semantic hash of (model, messages, tool schemas, params).
- **Streaming:** Recorded as chunk arrays, replayed as real streams via SDK stream utilities.
- **Secrets:** Redacted at record time via configurable matchers.
- **Strictness:** `miss=throw` in CI — a changed prompt or tool schema fails the test, forcing a re-record.

## Core API

```typescript
import { wrapLanguageModel } from 'ai';
import { cassetteMiddleware } from 'tapedeck';

const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: cassetteMiddleware({
    mode: process.env.CASSETTE_MODE ?? 'live', // record | replay | live
    cassetteDir: './cassettes',
    redact: ['apiKey', 'authorization', /token/i],
  }),
});
```

## Vitest Helper

```typescript
import { withCassette } from 'tapedeck/vitest';
import { describe, it, expect } from 'vitest';

describe('my agent', () => {
  it('runs the checkout flow', async () => {
    await withCassette('checkout-flow.json', async () => {
      const result = await runAgent({ prompt: 'buy a t-shirt' });
      expect(result.steps).toHaveLength(3);
    });
  });
});
```

## Cassette Format (v1)

```json
{
  "version": "tapedeck@0.1.0",
  "hash": "sha256:abc123...",
  "recordedAt": "2026-06-10T12:00:00Z",
  "request": {
    "model": "gpt-4o",
    "messages": [...],
    "tools": [...],
    "temperature": 0.7
  },
  "response": {
    "type": "stream",
    "chunks": [
      { "type": "text-delta", "text": "I'll" },
      { "type": "text-delta", "text": " help" },
      { "type": "tool-call", "toolCallId": "call_123", "toolName": "search", "args": {"query": "t-shirts"} }
    ],
    "usage": { "promptTokens": 42, "completionTokens": 15 }
  }
}
```

## Hash Algorithm

Stable hash of: `{modelProvider, modelId, messages, toolSchemas, maxTokens, temperature, topP}` — any change to these must trigger a cassette miss. Tool schemas are normalized (sorted keys, no descriptions).

## Secret Redaction

- Default redacts: `apiKey`, `authorization`, `x-api-key`, `bearer`, `token` (case-insensitive header names and body fields).
- Configurable via `redact: string[] | RegExp[]`.
- Redaction happens at record time; replay uses the redacted cassette.
- A cassette with unredacted secrets fails `replay` mode with `CassetteSecretError`.

## Error Types

- `CassetteMissError` — replay mode, no matching cassette found. Message includes the hash and suggestions.
- `CassetteSecretError` — unredacted secrets detected in cassette.
- `CassetteCorruptError` — invalid JSON, wrong version, or malformed chunks.
- `CassetteModeError` — invalid mode string.

## Comparison with Alternatives

| Approach | Layer | Pros | Cons |
|----------|-------|------|------|
| **tapedeck** | SDK middleware | Provider-agnostic, stream-native, zero infra | Only works with AI SDK |
| nock / Polly | HTTP proxy | Generic, works with any HTTP | Breaks on SSE streams, auth hygiene, provider wire format changes |
| MockLanguageModelV2 | SDK mock | Fast, no network | Hand-write every turn; collapses on SDK bumps |
| Agent VCR | MCP boundary | Records MCP interactions | Doesn't record model calls |
| Braintrust / Langfuse | Hosted eval | Rich dashboards | Requires SaaS, not CI-native |

## ToolRoute Cross-Sell

`tapedeck/vitest` exports `toFollowRoute()` matcher when `toolroute` is installed:

```typescript
import { toFollowRoute } from 'tapedeck/vitest';
expect(result.steps).toFollowRoute(router);
```

This pairs the two packages: guard in production with ToolRoute, replay in CI with tapedeck, assert trajectories with both.

## Build Rules

- Zero runtime dependencies except `ai` peer.
- TypeScript strict, `noUncheckedIndexedAccess: true`.
- Tests: vitest, no live API calls in CI (self-hosting: tapedeck tests use tapedeck).
- Package: dual ESM/CJS, tsup.

## Milestone 0.1.0 — shipped

1. `cassetteMiddleware` for `doGenerate` **and** `doStream` — record/replay/live modes.
2. Streaming: record chunk arrays, replay as real streams.
3. `withCassette()` vitest helper.
4. Secret redaction.
5. README with 10-second demo, comparison table.
6. Publish to npm.

## Milestone 0.2.0 — shipped

- OTel span emission: structural `tracer` option (`src/telemetry.ts`), zero deps.
- `npx tapedeck record|replay|ls|diff|merge` CLI (`src/cli.ts`, bin → `dist/cli.js`).
- Cassette diff / merge: `diffCassettes` (`src/diff.ts`), `mergeCassetteDirs` (`src/merge.ts`).
- Edge-safe core: pluggable `CassetteStore` (`src/store.ts`, file + memory),
  WebCrypto hashing (`computeCassetteHash` is async), no static `node:fs`/`node:path`/`node:crypto`.
  Only `node:async_hooks` remains (Workers `nodejs_compat`). tsup `removeNodeProtocol: false`
  keeps `node:` prefixes in the bundle.

## Deferred to 0.3.0

- Deployed Cloudflare Workers smoke test in CI (edge support is designed-for, not CI-verified).
- Multi-interaction named cassettes: a `withCassette` test whose agent makes
  several model calls currently overwrites the single named file in record mode
  and serves the same response to every call in replay. Needs a v2 format that
  stores an array of interactions keyed by hash.
- `toFollowRoute()` ToolRoute matcher in `tapedeck/vitest`.
- Adopt in PRCompass.
