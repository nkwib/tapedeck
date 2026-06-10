// tapedeck — semantic cassette diff
//
// Cassettes are pretty-printed JSON, so `git diff` already works line-by-line.
// This module answers the better question: *which request/response fields*
// diverged between two cassettes — e.g. "the prompt changed at
// request.prompt[0].content[0].text" rather than forty lines of JSON noise.

import {
  type Cassette,
  type CassetteFile,
  type CassetteInteraction,
  isMultiCassette,
} from './cassette.js';

/** A single leaf-level divergence between two cassettes. */
export interface CassetteFieldDiff {
  /** Dotted path into the cassette, e.g. `request.prompt[0].content[0].text`. */
  path: string;
  /** Value in the first cassette (`undefined` if absent). */
  a: unknown;
  /** Value in the second cassette (`undefined` if absent). */
  b: unknown;
}

export interface CassetteDiffResult {
  /** True when the two cassettes are semantically identical (ignoring `recordedAt`). */
  equal: boolean;
  /** True when the request hashes differ — replay would treat these as different calls. */
  hashChanged: boolean;
  /** Divergences under `request.*`. */
  request: CassetteFieldDiff[];
  /** Divergences under `response.*`. */
  response: CassetteFieldDiff[];
}

/**
 * Structurally diff two cassettes. `recordedAt` is ignored — two recordings of
 * the same interaction at different times are considered equal.
 */
export function diffCassettes(a: Cassette, b: Cassette): CassetteDiffResult {
  const request: CassetteFieldDiff[] = [];
  const response: CassetteFieldDiff[] = [];
  diffValue(a.request, b.request, 'request', request);
  diffValue(a.response, b.response, 'response', response);
  const hashChanged = a.hash !== b.hash;
  return {
    equal: !hashChanged && request.length === 0 && response.length === 0,
    hashChanged,
    request,
    response,
  };
}

function diffValue(a: unknown, b: unknown, path: string, out: CassetteFieldDiff[]): void {
  if (Object.is(a, b)) return;

  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      diffValue(a[i], b[i], `${path}[${i}]`, out);
    }
    return;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      diffValue(a[key], b[key], `${path}.${key}`, out);
    }
    return;
  }

  // Leaf (or type mismatch): record the divergence.
  if (!leafEqual(a, b)) out.push({ path, a, b });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function leafEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return Object.is(a, b);
}

/** Render a diff result as human-readable text (used by `tapedeck diff`). */
export function formatCassetteDiff(diff: CassetteDiffResult): string {
  if (diff.equal) return 'Cassettes are semantically identical.';

  const lines: string[] = [];
  if (diff.hashChanged) {
    lines.push('Request hash changed — replay treats these as different calls.');
  }
  for (const section of [diff.request, diff.response]) {
    for (const { path, a, b } of section) {
      lines.push(`  ${path}`);
      lines.push(`    - ${render(a)}`);
      lines.push(`    + ${render(b)}`);
    }
  }
  return lines.join('\n');
}

function render(value: unknown): string {
  if (value === undefined) return '(absent)';
  const json = JSON.stringify(value);
  return json.length > 120 ? `${json.slice(0, 117)}…` : json;
}

// ---- multi-interaction file diff ---------------------------------------------

/** A per-interaction divergence between two cassette files, paired by hash. */
export interface CassetteInteractionDiff {
  hash: string;
  request: CassetteFieldDiff[];
  response: CassetteFieldDiff[];
}

export interface CassetteFileDiffResult {
  equal: boolean;
  /** Interaction hashes present only in the first file. */
  onlyA: string[];
  /** Interaction hashes present only in the second file. */
  onlyB: string[];
  /** Interactions present in both but with diverging content. */
  changed: CassetteInteractionDiff[];
}

function asInteractions(file: CassetteFile): CassetteInteraction[] {
  return isMultiCassette(file)
    ? file.interactions
    : [{ hash: file.hash, request: file.request, response: file.response }];
}

/**
 * Diff two cassette files of any format (single or multi-interaction),
 * pairing interactions by request hash. `recordedAt` is ignored.
 */
export function diffCassetteFiles(a: CassetteFile, b: CassetteFile): CassetteFileDiffResult {
  const byHashA = new Map(asInteractions(a).map((i) => [i.hash, i]));
  const byHashB = new Map(asInteractions(b).map((i) => [i.hash, i]));

  const onlyA = [...byHashA.keys()].filter((h) => !byHashB.has(h));
  const onlyB = [...byHashB.keys()].filter((h) => !byHashA.has(h));

  const changed: CassetteInteractionDiff[] = [];
  for (const [hash, ia] of byHashA) {
    const ib = byHashB.get(hash);
    if (!ib) continue;
    const request: CassetteFieldDiff[] = [];
    const response: CassetteFieldDiff[] = [];
    diffValue(ia.request, ib.request, 'request', request);
    diffValue(ia.response, ib.response, 'response', response);
    if (request.length > 0 || response.length > 0) changed.push({ hash, request, response });
  }

  return {
    equal: onlyA.length === 0 && onlyB.length === 0 && changed.length === 0,
    onlyA,
    onlyB,
    changed,
  };
}

/** Render a file-diff result as human-readable text (used by `tapedeck diff`). */
export function formatCassetteFileDiff(diff: CassetteFileDiffResult): string {
  if (diff.equal) return 'Cassettes are semantically identical.';

  const lines: string[] = [];
  for (const hash of diff.onlyA) lines.push(`- only in first:  ${hash}`);
  for (const hash of diff.onlyB) lines.push(`+ only in second: ${hash}`);
  for (const interaction of diff.changed) {
    lines.push(`~ ${interaction.hash}`);
    for (const { path, a, b } of [...interaction.request, ...interaction.response]) {
      lines.push(`    ${path}`);
      lines.push(`      - ${render(a)}`);
      lines.push(`      + ${render(b)}`);
    }
  }
  return lines.join('\n');
}
