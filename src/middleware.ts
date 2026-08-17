// tapedeck — record/replay middleware for the Vercel AI SDK
//
// Wraps a LanguageModel so that model calls can be recorded to a cassette and
// replayed offline. Four modes:
//   * record:   call the real model, persist request+response, return it
//   * replay:   look up a cassette by hash (or name), serve it, throw on miss
//   * compare:  call the real model *and* load the cassette, report the drift,
//               return the live result; the cassette is never written
//   * live:     passthrough; do nothing
//
// Both `doGenerate` (one-shot) and `doStream` (streaming) are intercepted.
//
// Addressing: hash-addressed cassettes are one file per request (v1 single
// format). Named cassettes (via `withCassette` / `cassetteName`) are
// multi-interaction files: every call the test makes is stored in the same
// file, keyed by request hash, so a multi-step agent records and replays each
// call distinctly.
//
// The middleware is typed structurally (see `spec.ts`) so one object satisfies
// `wrapLanguageModel` under both `ai@6` (spec v3) and `ai@7` (spec v4).

import {
  CASSETTE_VERSION,
  MULTI_CASSETTE_VERSION,
  type Cassette,
  type CassetteFile,
  type CassetteInteraction,
  type CassetteRequest,
  type CassetteResponse,
  type CassetteResponseMetadata,
  type GenerateCassetteResponse,
  type MultiCassette,
  type StreamCassetteResponse,
  cassettePathForHash,
  cassettePathForName,
  isMultiCassette,
  parseCassette,
  serializeCassette,
} from './cassette.js';
import {
  type CassetteCompareResult,
  type CompareContext,
  compareCassetteResponses,
} from './compare.js';
import { getActiveCassetteContext } from './context.js';
import {
  CassetteCorruptError,
  CassetteDriftError,
  CassetteMissError,
  CassetteModeError,
  CassetteSecretError,
} from './errors.js';
import { computeCassetteHash, requestKeyFromCall } from './hash.js';
import { DEFAULT_REDACT, findUnredacted, redact, type RedactMatcher } from './redact.js';
import type {
  SpecCallOptions,
  SpecModel,
  TapedeckMiddleware,
  WrapGenerateOptions,
  WrapStreamOptions,
} from './spec.js';
import { type CassetteStore, fileCassetteStore } from './store.js';
import { collectStreamChunks, replayStreamResult } from './stream-replay.js';
import { type TapedeckSpan, type TapedeckTracer, withSpan } from './telemetry.js';

export type CassetteMode = 'record' | 'replay' | 'live' | 'compare';

/**
 * The live `doGenerate` result, restricted to the fields tapedeck records.
 * Spec v3 and v4 agree on every one of them, which is why one view serves both.
 */
interface LiveGenerateResult {
  content: GenerateCassetteResponse['content'];
  finishReason: GenerateCassetteResponse['finishReason'];
  usage: GenerateCassetteResponse['usage'];
  providerMetadata?: GenerateCassetteResponse['providerMetadata'];
  warnings?: GenerateCassetteResponse['warnings'];
  response?: CassetteResponseMetadata;
}

/** The live `doStream` result, restricted to the fields tapedeck touches. */
interface LiveStreamResult {
  stream: ReadableStream<StreamCassetteResponse['chunks'][number]>;
  request?: unknown;
  response?: unknown;
}

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
  /**
   * Called once per call in `compare` mode with the structured drift report,
   * whether or not anything diverged.
   *
   * Registering a handler hands you the failure policy (collect the reports,
   * fail the suite at the end, annotate a PR). With no handler, the first
   * diverging call throws {@link CassetteDriftError}, so drift can never pass
   * silently.
   */
  onCompare?: (result: CassetteCompareResult) => void | Promise<void>;
}

const VALID_MODES: ReadonlySet<string> = new Set(['record', 'replay', 'live', 'compare']);

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
  onCompare: CassetteMiddlewareOptions['onCompare'];
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
    onCompare: options.onCompare,
    recordSession: ctx?.recordSession,
  };
}

/** The path a cassette lives at, given the resolved config and a request hash. */
function cassettePath(resolved: Resolved, hash: string): string {
  return resolved.cassetteName
    ? cassettePathForName(resolved.cassetteDir, resolved.cassetteName)
    : cassettePathForHash(resolved.cassetteDir, hash);
}

/**
 * Build the persisted (redacted) request block. `prompt` and `tools` are typed
 * opaquely at the middleware boundary (spec v3 and v4 disagree on their part
 * shapes) but are stored verbatim, so the cast is a naming exercise, not a
 * conversion.
 */
function buildRequest(params: SpecCallOptions, model: SpecModel): CassetteRequest {
  return {
    modelProvider: model.provider,
    modelId: model.modelId,
    prompt: params.prompt as CassetteRequest['prompt'],
    tools: params.tools as CassetteRequest['tools'],
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
 * Resolve the recorded response for `hash`, or throw the right error. Used by
 * both `replay` and `compare`. Multi-interaction cassettes match by hash;
 * legacy single-interaction named cassettes serve their one response as-is
 * (pre-0.3.0 behaviour).
 */
async function loadRecordedResponse(
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
 * Compare a live response against the recorded one and surface the report.
 * Never writes: `compare` leaves the cassette exactly as it found it.
 */
async function reportComparison(
  cfg: Resolved,
  recorded: CassetteResponse,
  live: CassetteResponse,
  context: CompareContext,
  span: TapedeckSpan | undefined,
): Promise<void> {
  const result = compareCassetteResponses(recorded, live, context);
  span?.setAttribute('tapedeck.compare_equal', result.equal);
  if (cfg.onCompare) {
    await cfg.onCompare(result);
    return;
  }
  if (!result.equal) throw new CassetteDriftError(result);
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
): TapedeckMiddleware {
  // Fail fast on a bad static mode even if no call is ever made.
  if (options.mode !== undefined) assertMode(String(options.mode));
  // One default store per middleware instance, created only if needed.
  const defaultStore = options.store ?? fileCassetteStore();

  return {
    specificationVersion: 'v3',

    async wrapGenerate<GENERATE>({
      doGenerate,
      params,
      model,
    }: WrapGenerateOptions<GENERATE>): Promise<GENERATE> {
      const cfg = resolveConfig(options, defaultStore);
      if (cfg.mode === 'live') return doGenerate();

      const hash = await computeCassetteHash(requestKeyFromCall(params, model));
      const path = cassettePath(cfg, hash);

      return withSpan(
        cfg.tracer,
        'tapedeck.generate',
        spanAttributes(cfg, model, hash, path),
        async (span) => {
          if (cfg.mode === 'replay') {
            const response = await loadRecordedResponse(cfg, hash, path, span);
            assertResponseType(response, 'generate', path);
            // The host's spec version names the concrete result type; the
            // cassette holds exactly those fields, serialized. This cast is the
            // one place the spec-agnostic boundary is paid for.
            return {
              content: response.content,
              finishReason: response.finishReason,
              usage: response.usage,
              providerMetadata: response.providerMetadata,
              warnings: response.warnings ?? [],
              response: response.metadata,
            } as unknown as GENERATE;
          }

          // record and compare both need the live call.
          const live = await doGenerate();
          const response = generateResponse(live as LiveGenerateResult);

          if (cfg.mode === 'compare') {
            const recorded = await loadRecordedResponse(cfg, hash, path, span);
            await reportComparison(cfg, recorded, response, context(model, hash, path), span);
            return live;
          }

          await persistInteraction(
            cfg,
            hash,
            redact(buildRequest(params, model), cfg.matchers),
            redact(response, cfg.matchers),
            path,
          );
          return live;
        },
      );
    },

    async wrapStream<STREAM>({
      doStream,
      params,
      model,
    }: WrapStreamOptions<STREAM>): Promise<STREAM> {
      const cfg = resolveConfig(options, defaultStore);
      if (cfg.mode === 'live') return doStream();

      const hash = await computeCassetteHash(requestKeyFromCall(params, model));
      const path = cassettePath(cfg, hash);

      return withSpan(
        cfg.tracer,
        'tapedeck.stream',
        spanAttributes(cfg, model, hash, path),
        async (span) => {
          if (cfg.mode === 'replay') {
            const response = await loadRecordedResponse(cfg, hash, path, span);
            assertResponseType(response, 'stream', path);
            span?.setAttribute('tapedeck.chunk_count', response.chunks.length);
            return replayStreamResult(response.chunks) as unknown as STREAM;
          }

          // record and compare: drain the live stream so it can be inspected,
          // then re-serve it from the buffer so the caller still gets its
          // response.
          const live = (await doStream()) as LiveStreamResult;
          const chunks = await collectStreamChunks(live.stream);
          span?.setAttribute('tapedeck.chunk_count', chunks.length);

          if (cfg.mode === 'compare') {
            const recorded = await loadRecordedResponse(cfg, hash, path, span);
            await reportComparison(
              cfg,
              recorded,
              { type: 'stream', chunks },
              context(model, hash, path),
              span,
            );
            return reserve(live, chunks) as unknown as STREAM;
          }

          const response = redact({ type: 'stream' as const, chunks }, cfg.matchers);
          await persistInteraction(
            cfg,
            hash,
            redact(buildRequest(params, model), cfg.matchers),
            response,
            path,
          );
          // Re-serve the (redacted) recorded chunks so record and replay stay identical.
          return reserve(live, response.chunks) as unknown as STREAM;
        },
      );
    },
  };
}

/** The cassette response a live generate result would have been recorded as. */
function generateResponse(live: LiveGenerateResult): GenerateCassetteResponse {
  return {
    type: 'generate',
    content: live.content,
    finishReason: live.finishReason,
    usage: live.usage,
    providerMetadata: live.providerMetadata,
    warnings: live.warnings ?? [],
    metadata: live.response,
  };
}

/** Re-serve drained chunks as a fresh stream result, keeping the live metadata. */
function reserve(
  live: LiveStreamResult,
  chunks: StreamCassetteResponse['chunks'],
): LiveStreamResult {
  return { ...replayStreamResult(chunks), request: live.request, response: live.response };
}

/** Identity of the call, as carried into a compare report. */
function context(model: SpecModel, hash: string, path: string): CompareContext {
  return {
    hash: `sha256:${hash}`,
    cassettePath: path,
    modelProvider: model.provider,
    modelId: model.modelId,
  };
}

/** The attribute set every tapedeck span starts with. */
function spanAttributes(
  cfg: Resolved,
  model: SpecModel,
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
