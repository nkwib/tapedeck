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
  parseCassette,
  serializeCassette,
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
import { type CassetteStore, fileCassetteStore } from './store.js';
import { collectStreamChunks, replayStreamResult } from './stream-replay.js';
import { type TapedeckSpan, type TapedeckTracer, withSpan } from './telemetry.js';

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
  /**
   * Storage backend for cassettes. Defaults to the filesystem. Pass a
   * `memoryCassetteStore()` (or a KV-backed implementation) on edge runtimes
   * where there is no filesystem.
   */
  store?: CassetteStore;
  /**
   * An OpenTelemetry-compatible tracer (e.g. `trace.getTracer('tapedeck')`).
   * When set, every record/replay operation emits a `tapedeck.generate` or
   * `tapedeck.stream` span with mode, hash, and cassette-path attributes.
   * Misses record the exception and an error status. Omit for zero overhead.
   */
  tracer?: TapedeckTracer;
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
  store: CassetteStore;
  tracer: TapedeckTracer | undefined;
}

function resolveConfig(options: CassetteMiddlewareOptions, defaultStore: CassetteStore): Resolved {
  const ctx = getActiveCassetteContext();
  const mode = String(ctx?.mode ?? options.mode ?? 'live');
  assertMode(mode);
  return {
    mode,
    cassetteDir: ctx?.cassetteDir ?? options.cassetteDir ?? './cassettes',
    cassetteName: ctx?.cassetteName ?? options.cassetteName,
    matchers: [...DEFAULT_REDACT, ...(options.redact ?? [])],
    store: options.store ?? defaultStore,
    tracer: options.tracer,
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

/** Read a cassette through the store; `null` is a miss, bad content throws. */
async function readThroughStore(store: CassetteStore, path: string): Promise<Cassette | null> {
  const raw = await store.read(path);
  return raw === null ? null : parseCassette(raw, path);
}

/** Load + validate a replay cassette or throw the right error. */
async function loadForReplay(
  cfg: Resolved,
  hash: string,
  path: string,
  span: TapedeckSpan | undefined,
): Promise<Cassette> {
  const cassette = await readThroughStore(cfg.store, path);
  span?.setAttribute('tapedeck.cassette_hit', cassette !== null);
  if (!cassette) {
    throw new CassetteMissError({ hash, cassetteDir: cfg.cassetteDir, cassettePath: path });
  }
  assertNoSecrets(cassette, cfg.matchers, path);
  return cassette;
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
  // One default store per middleware instance, created only if needed.
  const defaultStore = options.store ?? fileCassetteStore();

  return {
    specificationVersion: 'v3',

    async wrapGenerate({ doGenerate, params, model }) {
      const cfg = resolveConfig(options, defaultStore);
      if (cfg.mode === 'live') return doGenerate();

      const key = requestKeyFromCall(params, model);
      const hash = await computeCassetteHash(key);
      const path = cassettePath(cfg, hash);

      return withSpan(
        cfg.tracer,
        'tapedeck.generate',
        spanAttributes(cfg, model, hash, path),
        async (span): Promise<LanguageModelV3GenerateResult> => {
          if (cfg.mode === 'replay') {
            const cassette = await loadForReplay(cfg, hash, path, span);
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
          await cfg.store.write(path, serializeCassette(cassette));
          return result;
        },
      );
    },

    async wrapStream({ doStream, params, model }) {
      const cfg = resolveConfig(options, defaultStore);
      if (cfg.mode === 'live') return doStream();

      const key = requestKeyFromCall(params, model);
      const hash = await computeCassetteHash(key);
      const path = cassettePath(cfg, hash);

      return withSpan(
        cfg.tracer,
        'tapedeck.stream',
        spanAttributes(cfg, model, hash, path),
        async (span): Promise<LanguageModelV3StreamResult> => {
          if (cfg.mode === 'replay') {
            const cassette = await loadForReplay(cfg, hash, path, span);
            if (cassette.response.type !== 'stream') {
              throw new CassetteCorruptError({
                cassettePath: path,
                reason: `expected a 'stream' cassette but found '${cassette.response.type}'`,
              });
            }
            span?.setAttribute('tapedeck.chunk_count', cassette.response.chunks.length);
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
          await cfg.store.write(path, serializeCassette(cassette));
          span?.setAttribute('tapedeck.chunk_count', chunks.length);
          // Replay the (redacted) recorded chunks so record and replay stay identical.
          return {
            ...replayStreamResult(response.chunks),
            request: result.request,
            response: result.response,
          };
        },
      );
    },
  };
}

/** The attribute set every tapedeck span starts with. */
function spanAttributes(
  cfg: Resolved,
  model: { provider: string; modelId: string },
  hash: string,
  path: string,
): Record<string, string> {
  return {
    'tapedeck.mode': cfg.mode,
    'tapedeck.hash': `sha256:${hash}`,
    'tapedeck.cassette_path': path,
    'tapedeck.model_provider': model.provider,
    'tapedeck.model_id': model.modelId,
  };
}
