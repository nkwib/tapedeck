// tapedeck — record/replay middleware for the Vercel AI SDK
//
// Wraps a LanguageModel (AI SDK v6 / spec v3) so that model calls can be recorded
// to a cassette and replayed offline. Three modes:
//   • record  — call the real model, persist request+response, return it
//   • replay  — look up a cassette by hash (or name), serve it, throw on miss
//   • live    — passthrough; do nothing
//
// Both `doGenerate` (one-shot) and `doStream` (streaming) are intercepted.

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Middleware,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import {
  CASSETTE_VERSION,
  type Cassette,
  type CassetteRequest,
  cassettePathForHash,
  cassettePathForName,
  readCassetteFile,
  writeCassetteFile,
} from './cassette.js';
import { getActiveCassetteContext } from './context.js';
import {
  CassetteCorruptError,
  CassetteMissError,
  CassetteModeError,
  CassetteSecretError,
} from './errors.js';
import { computeCassetteHash, requestKeyFromCall } from './hash.js';
import { DEFAULT_REDACT, findUnredacted, redact, type RedactMatcher } from './redact.js';
import { collectStreamChunks, replayStreamResult } from './stream-replay.js';

export type CassetteMode = 'record' | 'replay' | 'live';

export interface CassetteMiddlewareOptions {
  /** Operating mode. Defaults to `'live'` (passthrough). */
  mode?: CassetteMode | string;
  /** Directory cassettes are read from / written to. Defaults to `'./cassettes'`. */
  cassetteDir?: string;
  /**
   * Key matchers whose values are redacted at record time. Strings match field /
   * header names case-insensitively; RegExps are tested against the raw key.
   * Combined with a built-in default set.
   */
  redact?: RedactMatcher[];
  /**
   * Force a specific cassette filename instead of hash-addressed lookup. Mostly
   * used internally by `withCassette`; can be set directly for fixed fixtures.
   */
  cassetteName?: string;
}

const VALID_MODES: ReadonlySet<string> = new Set(['record', 'replay', 'live']);

function assertMode(mode: string): asserts mode is CassetteMode {
  if (!VALID_MODES.has(mode)) throw new CassetteModeError(mode);
}

/** Effective per-call config after folding in the ambient `withCassette` context. */
interface Resolved {
  mode: CassetteMode;
  cassetteDir: string;
  cassetteName: string | undefined;
  matchers: RedactMatcher[];
}

function resolveConfig(options: CassetteMiddlewareOptions): Resolved {
  const ctx = getActiveCassetteContext();
  const mode = String(ctx?.mode ?? options.mode ?? 'live');
  assertMode(mode);
  return {
    mode,
    cassetteDir: ctx?.cassetteDir ?? options.cassetteDir ?? './cassettes',
    cassetteName: ctx?.cassetteName ?? options.cassetteName,
    matchers: [...DEFAULT_REDACT, ...(options.redact ?? [])],
  };
}

/** The path a cassette lives at, given the resolved config and a request hash. */
function cassettePath(resolved: Resolved, hash: string): string {
  return resolved.cassetteName
    ? cassettePathForName(resolved.cassetteDir, resolved.cassetteName)
    : cassettePathForHash(resolved.cassetteDir, hash);
}

/** Build the persisted (redacted) request block. */
function buildRequest(params: LanguageModelV3CallOptions, model: LanguageModelV3): CassetteRequest {
  return {
    modelProvider: model.provider,
    modelId: model.modelId,
    prompt: params.prompt,
    tools: params.tools,
    maxOutputTokens: params.maxOutputTokens,
    temperature: params.temperature,
    topP: params.topP,
  };
}

/** Throw if a replayed cassette still carries values the matchers would strip. */
function assertNoSecrets(cassette: Cassette, matchers: RedactMatcher[], path: string): void {
  const leaks = [
    ...findUnredacted(cassette.request, matchers).map((p) => `request.${p}`),
    ...findUnredacted(cassette.response, matchers).map((p) => `response.${p}`),
  ];
  if (leaks.length > 0) {
    throw new CassetteSecretError({ paths: leaks, cassettePath: path });
  }
}

/**
 * Create record/replay middleware. Wrap your model once and switch behaviour via
 * `mode` (typically driven by an env var) — no other code changes required.
 *
 * @example
 * const model = wrapLanguageModel({
 *   model: openai('gpt-4o'),
 *   middleware: cassetteMiddleware({ mode: process.env.CASSETTE_MODE ?? 'live' }),
 * });
 */
export function cassetteMiddleware(
  options: CassetteMiddlewareOptions = {},
): LanguageModelV3Middleware {
  // Fail fast on a bad static mode even if no call is ever made.
  if (options.mode !== undefined) assertMode(String(options.mode));

  return {
    specificationVersion: 'v3',

    async wrapGenerate({ doGenerate, params, model }) {
      const cfg = resolveConfig(options);
      if (cfg.mode === 'live') return doGenerate();

      const key = requestKeyFromCall(params, model);
      const hash = computeCassetteHash(key);
      const path = cassettePath(cfg, hash);

      if (cfg.mode === 'replay') {
        const cassette = await readCassetteFile(path);
        if (!cassette) {
          throw new CassetteMissError({ hash, cassetteDir: cfg.cassetteDir, cassettePath: path });
        }
        assertNoSecrets(cassette, cfg.matchers, path);
        if (cassette.response.type !== 'generate') {
          throw new CassetteCorruptError({
            cassettePath: path,
            reason: `expected a 'generate' cassette but found '${cassette.response.type}'`,
          });
        }
        const r = cassette.response;
        return {
          content: r.content,
          finishReason: r.finishReason,
          usage: r.usage,
          providerMetadata: r.providerMetadata,
          warnings: r.warnings ?? [],
          response: r.metadata,
        };
      }

      // record
      const result = await doGenerate();
      const cassette: Cassette = {
        version: CASSETTE_VERSION,
        hash: `sha256:${hash}`,
        recordedAt: new Date().toISOString(),
        request: redact(buildRequest(params, model), cfg.matchers),
        response: redact(
          {
            type: 'generate' as const,
            content: result.content,
            finishReason: result.finishReason,
            usage: result.usage,
            providerMetadata: result.providerMetadata,
            warnings: result.warnings ?? [],
            metadata: result.response,
          },
          cfg.matchers,
        ),
      };
      await writeCassetteFile(path, cassette);
      return result;
    },

    async wrapStream({ doStream, params, model }) {
      const cfg = resolveConfig(options);
      if (cfg.mode === 'live') return doStream();

      const key = requestKeyFromCall(params, model);
      const hash = computeCassetteHash(key);
      const path = cassettePath(cfg, hash);

      if (cfg.mode === 'replay') {
        const cassette = await readCassetteFile(path);
        if (!cassette) {
          throw new CassetteMissError({ hash, cassetteDir: cfg.cassetteDir, cassettePath: path });
        }
        assertNoSecrets(cassette, cfg.matchers, path);
        if (cassette.response.type !== 'stream') {
          throw new CassetteCorruptError({
            cassettePath: path,
            reason: `expected a 'stream' cassette but found '${cassette.response.type}'`,
          });
        }
        return replayStreamResult(cassette.response.chunks);
      }

      // record: drain the live stream, persist it, then re-serve from the buffer
      // so the caller still receives the response it would have gotten live.
      const result = await doStream();
      const chunks = await collectStreamChunks(result.stream);
      const response = redact({ type: 'stream' as const, chunks }, cfg.matchers);
      const cassette: Cassette = {
        version: CASSETTE_VERSION,
        hash: `sha256:${hash}`,
        recordedAt: new Date().toISOString(),
        request: redact(buildRequest(params, model), cfg.matchers),
        response,
      };
      await writeCassetteFile(path, cassette);
      // Replay the (redacted) recorded chunks so record and replay stay identical.
      return {
        ...replayStreamResult(response.chunks),
        request: result.request,
        response: result.response,
      };
    },
  };
}
