// tapedeck: behavioural comparison of a live response against a cassette
//
// `tapedeck diff` answers "which JSON fields differ between two cassettes".
// This module answers the question `mode: 'compare'` is for: *did the model's
// behaviour drift away from the fixture we froze?* A cassette is a static
// fixture, and a static fixture rots silently: the provider retunes the model
// and the recorded trajectory stops being what the model actually does.
//
// Three signals, deliberately boring and explainable:
//   * tool-call trajectory: same tool names in the same order with the same
//     inputs. This is the behavioural contract of an agent.
//   * finish reason:       the unified label (`stop`, `tool-calls`, ...).
//   * text:                exact / normalized (whitespace + case) / different.
//
// No similarity score, no embedding distance: a reviewer must be able to read
// the report and say "yes, that is drift" without trusting a number.

import type { CassetteResponse } from './cassette.js';
import { stableStringify } from './hash.js';

/** How far the live text drifted from the recorded text. */
export type TextDivergence =
  /** Byte-identical. */
  | 'exact'
  /** Identical after trimming, collapsing whitespace, and lowercasing. */
  | 'normalized'
  /** Different beyond that. */
  | 'different';

/** One tool call, reduced to the parts that define an agent's trajectory. */
export interface ToolCallSummary {
  toolName: string;
  /**
   * Tool input as canonical JSON (keys sorted), so key order never reads as
   * drift. Falls back to the raw string when the input is not JSON.
   */
  input: string;
}

/** The behavioural shape of a response: everything compare looks at, nothing else. */
export interface ResponseSummary {
  kind: 'generate' | 'stream';
  /** All assistant text, concatenated in emission order. */
  text: string;
  /** Tool calls in emission order. */
  toolCalls: ToolCallSummary[];
  /** Unified finish reason label, or `null` when the response carries none. */
  finishReason: string | null;
}

export interface CompareTextResult {
  status: TextDivergence;
  recorded: string;
  live: string;
}

export interface CompareToolCalls {
  /** True when both trajectories have the same names, order, and inputs. */
  equal: boolean;
  recorded: ToolCallSummary[];
  live: ToolCallSummary[];
  /** Index of the first divergent call, or `null` when the trajectories match. */
  divergedAt: number | null;
  /** Why they diverged, e.g. `call 2: tool 'fetch' != 'search'`. */
  reason: string | null;
}

export interface CompareFinishReason {
  equal: boolean;
  recorded: string | null;
  live: string | null;
}

/** Identity of the call being compared, carried through into the report. */
export interface CompareContext {
  /** Display form of the request hash, e.g. `sha256:abc123…`. */
  hash: string;
  /** File the recorded response was read from. */
  cassettePath: string;
  modelProvider: string;
  modelId: string;
}

/** The structured, reviewable result of one live-vs-cassette comparison. */
export interface CassetteCompareResult extends CompareContext {
  /**
   * True when nothing tapedeck treats as drift diverged: same tool trajectory,
   * same finish reason, and text no worse than `normalized`. Text that differs
   * only in whitespace or case is not drift: model prose is not a contract,
   * the trajectory is. `text.status` is always reported so a stricter policy is
   * one `onCompare` handler away.
   */
  equal: boolean;
  /** `generate` when both sides are one-shot results, `stream` when both are streams. */
  kind: 'generate' | 'stream';
  /** True when the cassette holds one kind and the live call produced the other. */
  kindChanged: boolean;
  text: CompareTextResult;
  toolCalls: CompareToolCalls;
  finishReason: CompareFinishReason;
}

/** Reduce a recorded or live response to the parts compare looks at. */
export function summarizeResponse(response: CassetteResponse): ResponseSummary {
  if (response.type === 'generate') {
    const summary: ResponseSummary = {
      kind: 'generate',
      text: '',
      toolCalls: [],
      finishReason: finishReasonLabel(response.finishReason),
    };
    for (const part of response.content) {
      if (part.type === 'text') summary.text += part.text;
      else if (part.type === 'tool-call') summary.toolCalls.push(toolCallSummary(part));
    }
    return summary;
  }

  const summary: ResponseSummary = {
    kind: 'stream',
    text: '',
    toolCalls: [],
    finishReason: null,
  };
  for (const chunk of response.chunks) {
    if (chunk.type === 'text-delta') summary.text += chunk.delta;
    else if (chunk.type === 'tool-call') summary.toolCalls.push(toolCallSummary(chunk));
    else if (chunk.type === 'finish') summary.finishReason = finishReasonLabel(chunk.finishReason);
  }
  return summary;
}

/**
 * Compare a live response against the recorded one. Pure: it reads both
 * responses and returns a report. Cassettes are never touched.
 */
export function compareCassetteResponses(
  recorded: CassetteResponse,
  live: CassetteResponse,
  context: CompareContext,
): CassetteCompareResult {
  const a = summarizeResponse(recorded);
  const b = summarizeResponse(live);

  const text = compareText(a.text, b.text);
  const toolCalls = compareToolCalls(a.toolCalls, b.toolCalls);
  const finishReason = {
    equal: a.finishReason === b.finishReason,
    recorded: a.finishReason,
    live: b.finishReason,
  };
  const kindChanged = a.kind !== b.kind;

  return {
    ...context,
    equal:
      !kindChanged && toolCalls.equal && finishReason.equal && text.status !== 'different',
    kind: b.kind,
    kindChanged,
    text,
    toolCalls,
    finishReason,
  };
}

function compareText(recorded: string, live: string): CompareTextResult {
  const status: TextDivergence =
    recorded === live ? 'exact' : normalize(recorded) === normalize(live) ? 'normalized' : 'different';
  return { status, recorded, live };
}

/** Trim, collapse runs of whitespace, lowercase. Nothing cleverer. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function compareToolCalls(
  recorded: ToolCallSummary[],
  live: ToolCallSummary[],
): CompareToolCalls {
  const len = Math.max(recorded.length, live.length);
  for (let i = 0; i < len; i++) {
    const a = recorded[i];
    const b = live[i];
    if (!a) return diverged(recorded, live, i, `call ${i + 1}: live called '${b?.toolName}', cassette stopped`);
    if (!b) return diverged(recorded, live, i, `call ${i + 1}: cassette called '${a.toolName}', live stopped`);
    if (a.toolName !== b.toolName) {
      return diverged(recorded, live, i, `call ${i + 1}: tool '${a.toolName}' != '${b.toolName}'`);
    }
    if (a.input !== b.input) {
      return diverged(recorded, live, i, `call ${i + 1} ('${a.toolName}'): input changed`);
    }
  }
  return { equal: true, recorded, live, divergedAt: null, reason: null };
}

function diverged(
  recorded: ToolCallSummary[],
  live: ToolCallSummary[],
  at: number,
  reason: string,
): CompareToolCalls {
  return { equal: false, recorded, live, divergedAt: at, reason };
}

function toolCallSummary(call: { toolName: string; input: string }): ToolCallSummary {
  return { toolName: call.toolName, input: canonicalInput(call.input) };
}

/** Tool inputs arrive as a JSON string; canonicalize so key order is not drift. */
function canonicalInput(input: string): string {
  try {
    return stableStringify(JSON.parse(input));
  } catch {
    return input;
  }
}

/**
 * The unified finish reason label. Spec v3/v4 carry `{ unified, raw }`; older
 * recordings carry a bare string. Both reduce to the same label.
 */
function finishReasonLabel(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && 'unified' in value) {
    const unified = (value as { unified?: unknown }).unified;
    if (typeof unified === 'string') return unified;
  }
  return null;
}

/** Render a compare result as human-readable text (used by the drift error). */
export function formatCompareResult(result: CassetteCompareResult): string {
  const head = `${result.hash} (${result.kind}, ${result.modelProvider}/${result.modelId})\n  cassette: ${result.cassettePath}`;
  if (result.equal) return `No drift: live response matches the cassette.\n  ${head}`;

  const lines = [head];
  if (result.kindChanged) {
    lines.push(`  kind: cassette holds a '${result.kind === 'stream' ? 'generate' : 'stream'}' response, live produced '${result.kind}'`);
  }
  if (!result.toolCalls.equal) {
    lines.push(`  tool calls: ${result.toolCalls.reason}`);
    lines.push(`    cassette: ${renderTrajectory(result.toolCalls.recorded)}`);
    lines.push(`    live:     ${renderTrajectory(result.toolCalls.live)}`);
  }
  if (!result.finishReason.equal) {
    lines.push(`  finish reason: ${result.finishReason.recorded} -> ${result.finishReason.live}`);
  }
  if (result.text.status !== 'exact') {
    lines.push(`  text: ${result.text.status}`);
    // Quoted, so trailing whitespace and newlines are visible in the report.
    lines.push(`    cassette: ${clip(JSON.stringify(result.text.recorded))}`);
    lines.push(`    live:     ${clip(JSON.stringify(result.text.live))}`);
  }
  return lines.join('\n');
}

function renderTrajectory(calls: ToolCallSummary[]): string {
  return calls.length === 0
    ? '(none)'
    : calls.map((call) => `${call.toolName}(${clip(call.input, 60)})`).join(' -> ');
}

function clip(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
