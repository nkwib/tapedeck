// tapedeck — cassette format + persistence
//
// A cassette is a single self-contained JSON file: the request key it answers,
// plus the recorded response (either a one-shot generate result or an ordered
// array of stream parts). Files are pretty-printed so they diff cleanly in PRs.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3ProviderTool,
  LanguageModelV3ResponseMetadata,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Headers,
  SharedV3ProviderMetadata,
  SharedV3Warning,
} from '@ai-sdk/provider';
import { CassetteCorruptError } from './errors.js';

/** Cassette format version. Bumped on any breaking change to the shape below. */
export const CASSETTE_VERSION = 'tapedeck@0.1.0';

/** The request as persisted in a cassette (post-redaction). */
export interface CassetteRequest {
  modelProvider: string;
  modelId: string;
  prompt: LanguageModelV3Prompt;
  tools?: Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool>;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
}

/** Response metadata as carried by a generate result (`response` field). */
export interface CassetteResponseMetadata extends LanguageModelV3ResponseMetadata {
  headers?: SharedV3Headers;
  body?: unknown;
}

/** A recorded one-shot `doGenerate` result. */
export interface GenerateCassetteResponse {
  type: 'generate';
  content: Array<LanguageModelV3Content>;
  finishReason: LanguageModelV3FinishReason;
  usage: LanguageModelV3Usage;
  providerMetadata?: SharedV3ProviderMetadata;
  warnings: Array<SharedV3Warning>;
  metadata?: CassetteResponseMetadata;
}

/** A recorded `doStream` result: the ordered stream parts as they were emitted. */
export interface StreamCassetteResponse {
  type: 'stream';
  chunks: Array<LanguageModelV3StreamPart>;
}

export type CassetteResponse = GenerateCassetteResponse | StreamCassetteResponse;

/** A complete cassette as stored on disk. */
export interface Cassette {
  version: string;
  /** Display form of the request hash, e.g. `sha256:abc123…`. */
  hash: string;
  recordedAt: string;
  request: CassetteRequest;
  response: CassetteResponse;
}

/** On-disk filename for a hash-addressed cassette. */
export function cassetteFilename(hash: string): string {
  return `${hash}.cassette.json`;
}

/** Resolve the path for a hash-addressed cassette. */
export function cassettePathForHash(dir: string, hash: string): string {
  return join(dir, cassetteFilename(hash));
}

/** Resolve the path for a name-addressed cassette (e.g. from `withCassette`). */
export function cassettePathForName(dir: string, name: string): string {
  return join(dir, name);
}

/** Persist a cassette to `path`, creating parent directories as needed. */
export async function writeCassetteFile(path: string, cassette: Cassette): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cassette, null, 2)}\n`, 'utf8');
}

/**
 * Read and validate a cassette from `path`. Returns `null` if the file does not
 * exist (a cassette miss); throws {@link CassetteCorruptError} for anything that
 * exists but is unreadable.
 */
export async function readCassetteFile(path: string): Promise<Cassette | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CassetteCorruptError({
      cassettePath: path,
      reason: `invalid JSON: ${(err as Error).message}`,
    });
  }

  return validateCassette(parsed, path);
}

function validateCassette(parsed: unknown, path: string): Cassette {
  if (parsed === null || typeof parsed !== 'object') {
    throw new CassetteCorruptError({ cassettePath: path, reason: 'not an object' });
  }
  const c = parsed as Partial<Cassette>;
  if (typeof c.version !== 'string' || !c.version.startsWith('tapedeck@')) {
    throw new CassetteCorruptError({
      cassettePath: path,
      reason: `unknown or missing version (got ${JSON.stringify(c.version)})`,
    });
  }
  if (c.response === null || typeof c.response !== 'object') {
    throw new CassetteCorruptError({ cassettePath: path, reason: 'missing response' });
  }
  const type = (c.response as CassetteResponse).type;
  if (type !== 'generate' && type !== 'stream') {
    throw new CassetteCorruptError({
      cassettePath: path,
      reason: `unknown response type ${JSON.stringify(type)}`,
    });
  }
  reviveDates(c.response as CassetteResponse);
  return c as Cassette;
}

/** JSON has no Date type; revive the response metadata timestamp on the way in. */
function reviveDates(response: CassetteResponse): void {
  if (response.type === 'generate' && response.metadata?.timestamp) {
    response.metadata.timestamp = new Date(response.metadata.timestamp as unknown as string);
  }
  if (response.type === 'stream') {
    for (const chunk of response.chunks) {
      if (chunk.type === 'response-metadata' && chunk.timestamp) {
        chunk.timestamp = new Date(chunk.timestamp as unknown as string);
      }
    }
  }
}

/** Load a hash-addressed cassette from `dir`. Returns `null` on miss. */
export function loadCassette(hash: string, dir: string): Promise<Cassette | null> {
  return readCassetteFile(cassettePathForHash(dir, hash));
}

/** Save a hash-addressed cassette into `dir`. */
export function saveCassette(hash: string, dir: string, cassette: Cassette): Promise<void> {
  return writeCassetteFile(cassettePathForHash(dir, hash), cassette);
}
