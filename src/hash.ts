// tapedeck — stable request hashing
//
// A cassette is keyed by a deterministic hash of the semantically meaningful
// parts of a request. Any change to model, messages, tool schemas, or sampling
// params produces a different hash → a cassette miss → a forced re-record. This
// is what makes a changed prompt fail CI instead of silently replaying stale data.

import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3ProviderTool,
} from '@ai-sdk/provider';
import type { SpecCallOptions, SpecModel } from './spec.js';

/** The subset of a request that determines cassette identity. */
export interface CassetteRequestKey {
  modelProvider: string;
  modelId: string;
  prompt: LanguageModelV3Prompt;
  tools?: Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool>;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
}

/** Deterministic JSON: object keys are emitted in sorted order at every level. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Normalize tools for hashing: descriptions are irrelevant to behaviour and
 * churn frequently, so they're stripped recursively. Key order is handled later
 * by {@link stableStringify}.
 */
export function normalizeTools(
  tools: CassetteRequestKey['tools'],
): unknown {
  if (!tools) return undefined;
  return tools.map((tool) => stripDescriptions(tool));
}

function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripDescriptions);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'description') continue;
      out[key] = stripDescriptions(val);
    }
    return out;
  }
  return value;
}

/**
 * Compute the stable cassette hash for a request. Returns the bare hex digest;
 * callers prefix it with `sha256:` for the cassette's display field and append
 * `.cassette.json` for the on-disk name.
 *
 * Uses WebCrypto (`crypto.subtle`), available in Node ≥18, Cloudflare Workers,
 * and browsers — so the core has no `node:crypto` dependency. Digests are
 * identical to the previous `node:crypto` implementation; existing cassettes
 * stay valid.
 */
export async function computeCassetteHash(request: CassetteRequestKey): Promise<string> {
  const canonical = {
    modelProvider: request.modelProvider,
    modelId: request.modelId,
    prompt: request.prompt,
    tools: normalizeTools(request.tools),
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature,
    topP: request.topP,
  };
  const bytes = new TextEncoder().encode(stableStringify(canonical));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build a {@link CassetteRequestKey} from live call options + model identity.
 * `prompt` and `tools` are opaque at the middleware boundary (spec v3 and v4
 * disagree on their part shapes) but are hashed verbatim either way.
 */
export function requestKeyFromCall(
  params: SpecCallOptions,
  model: SpecModel,
): CassetteRequestKey {
  return {
    modelProvider: model.provider,
    modelId: model.modelId,
    prompt: params.prompt as CassetteRequestKey['prompt'],
    tools: params.tools as CassetteRequestKey['tools'],
    maxOutputTokens: params.maxOutputTokens,
    temperature: params.temperature,
    topP: params.topP,
  };
}
