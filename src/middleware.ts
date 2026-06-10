// tapedeck — record/replay middleware for the Vercel AI SDK
//
// Wraps a LanguageModel (AI SDK v6 / spec v3) so that model calls can be recorded
// to a cassette and replayed offline. Three modes:
//   • record  — call the real model, persist request+response, return it
//   • replay  — look up a cassette by hash (or name), serve it, throw on miss
//   • live    — passthrough; do nothing
//
// Both `doGenerate` (one-shot) and `doStream` (streaming) are intercepted.
//
// Addressing: hash-addressed cassettes are one file per request (v1 single
// format). Named cassettes (via `withCassette` / `cassetteName`) are
// multi-interaction files: every call the test makes is stored in the same
// file, keyed by request hash, so a multi-step agent records and replays each
// call distinctly.

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Middleware,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import {
  CASSETTE_VERSION,
  MULTI_CASSETTE_VERSION,
  type Cassette,
  type CassetteFile,
  type CassetteInteraction,
  type CassetteRequest,
  type CassetteResponse,
  type MultiCassette,
  cassettePathForHash,
  cassettePathForName,
  isMultiCassette,
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
   * Force a specific cassette filename instead of hash-addressed lookup. The
   * named file is multi-interaction: every call records/replays its own entry,
   * keyed by request hash. Mostly used internally by `withCassette`; can be set
   * directly for fixed fixtures.
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
  /** Active recording session (one per `withCassette` run), if any. */
  recordSession: { written: boolean } | undefined;
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
    recordSession: ctx?.recordSession,
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
function assertNoSecrets(file: CassetteFile, matchers: RedactMatcher[], path: string): void {
  const leaks = isMultiCassette(file)
    ? file.interactions.flatMap((interaction, i) => [
        ...findUnredacted(interaction.request, matchers).map(
          (p) => `interactions[${i}].request.${p}`,
        ),
        ...findUnredacted(interaction.response, matchers).map(
          (p) => `interactions[${i}].response.${p}`,
        ),
      ])
    : [
        ...findUnredacted(file.request, matchers).map((p) => `request.${p}`),
        ...findUnredacted(file.response, matchers).map((p) => `response.${p}`),
      ];
  if (leaks.length > 0) {
    throw new CassetteSecretError({ paths: leaks, cassettePath: path });
  }
}

/** Read a cassette file through the store; `null` is a miss, bad content throws. */
async function readThroughStore(store: CassetteStore, path: string): Promise<CassetteFile | null> {
  const raw = await store.read(path);
  return raw === null ? null : parseCassette(raw, path);
}

/**
 * Resolve the recorded response for `hash` in replay mode, or throw the right
 * error. Multi-interaction cassettes match by hash; legacy single-interaction
 * named cassettes serve their one response as-is (pre-0.3.0 behaviour).
 */
async function loadForReplay(
  cfg: Resolved,
  hash: string,
  path: string,
  span: TapedeckSpan | undefined,
): Promise<CassetteResponse> {
  const file = await readThroughStore(cfg.store, path);
  if (!file) {
    span?.setAttribute('tapedeck.cassette_hit', false);
    throw new CassetteMissError({ hash, cassetteDir: cfg.cassetteDir, cassettePath: path });
  }
  assertNoSecrets(file, cfg.matchers, path);

  if (!isMultiCassette(file)) {
    span?.setAttribute('tapedeck.cassette_hit', true);
    return file.response;
  }

  const interaction = file.interactions.find((i) => i.hash === `sha256:${hash}`);
  span?.setAttribute('tapedeck.cassette_hit', interaction !== undefined);
  if (!interaction) {
    throw new CassetteMissError({ hash, cassetteDir: cfg.cassetteDir, cassettePath: path });
  }
  return interaction.response;
}

/** Throw when the recorded response kind doesn't match the intercepted call. */
function assertResponseType<T extends CassetteResponse['type']>(
  response: CassetteResponse,
  expected: T,
  path: string,
): asserts response is Extract<CassetteResponse, { type: T }> {
  if (response.type !== expected) {
    throw new CassetteCorruptError({
      cassettePath: path,
      reason: `expected a '${expected}' cassette but found '${response.type}'`,
    });
  }
}

/**
 * Persist a recorded interaction. Hash-addressed cassettes are single files;
 * named cassettes are multi-interaction files upserted by hash. The first
 * write of a recording session starts the named file fresh, so re-recording a
 * test never leaves stale interactions behind.
 */
async function persistInteraction(
  cfg: Resolved,
  hash: string,
  request: CassetteRequest,
  response: CassetteResponse,
  path: string,
): Promise<void> {
  const recordedAt = new Date().toISOString();

  if (!cfg.cassetteName) {
    const cassette: Cassette = {
      version: CASSETTE_VERSION,
      hash: `sha256:${hash}`,
      recordedAt,
      request,
      response,
    };
    await cfg.store.write(path, serializeCassette(cassette));
    return;
  }

  const interaction: CassetteInteraction = { hash: `sha256:${hash}`, request, response };
  const startFresh = cfg.recordSession !== undefined && !cfg.recordSession.written;
  const existing = startFresh ? null : await readThroughStore(cfg.store, path);

  const interactions: CassetteInteraction[] = existing
    ? isMultiCassette(existing)
      ? [...existing.interactions]
      : [{ hash: existing.hash, request: existing.request, response: existing.response }]
    : [];

  const at = interactions.findIndex((i) => i.hash === interaction.hash);
  if (at >= 0) interactions[at] = interaction;
  else interactions.push(interaction);

  const file: MultiCassette = { version: MULTI_CASSETTE_VERSION, recordedAt, interactions };
  await cfg.store.write(path, serializeCassette(file));
  if (cfg.recordSession) cfg.recordSession.written = true;
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
            const response = await loadForReplay(cfg, hash, path, span);
            assertResponseType(response, 'generate', path);
            return {
              content: response.content,
              finishReason: response.finishReason,
              usage: response.usage,
              providerMetadata: response.providerMetadata,
              warnings: response.warnings ?? [],
              response: response.metadata,
            };
          }

          // record
          const result = await doGenerate();
          await persistInteraction(
            cfg,
            hash,
            redact(buildRequest(params, model), cfg.matchers),
            redact(
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
            path,
          );
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
            const response = await loadForReplay(cfg, hash, path, span);
            assertResponseType(response, 'stream', path);
            span?.setAttribute('tapedeck.chunk_count', response.chunks.length);
            return replayStreamResult(response.chunks);
          }

          // record: drain the live stream, persist it, then re-serve from the buffer
          // so the caller still receives the response it would have gotten live.
          const result = await doStream();
          const chunks = await collectStreamChunks(result.stream);
          const response = redact({ type: 'stream' as const, chunks }, cfg.matchers);
          await persistInteraction(
            cfg,
            hash,
            redact(buildRequest(params, model), cfg.matchers),
            response,
            path,
          );
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
