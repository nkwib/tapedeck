// tapedeck — secret redaction
//
// Redaction is key-name based: any object key (or HTTP header name) that matches
// a configured matcher has its value replaced with `REDACTED`. This mirrors how
// secrets actually surface in AI SDK requests/responses — `apiKey`,
// `authorization`, bearer tokens, etc. live under well-known keys.

/** Placeholder written in place of a redacted value. */
export const REDACTED = '[REDACTED]';

/** Default key matchers applied even when the caller passes none. */
export const DEFAULT_REDACT: Array<string | RegExp> = [
  'apiKey',
  'authorization',
  'x-api-key',
  'bearer',
  'token',
];

export type RedactMatcher = string | RegExp;

/** Returns true if `key` matches any matcher (strings compared case-insensitively). */
function keyMatches(key: string, matchers: RedactMatcher[]): boolean {
  const lower = key.toLowerCase();
  for (const matcher of matchers) {
    if (typeof matcher === 'string') {
      if (lower === matcher.toLowerCase()) return true;
    } else if (matcher.test(key)) {
      return true;
    }
  }
  return false;
}

/**
 * Deep-clone `value`, replacing any matched key's value with {@link REDACTED}.
 * Pure: never mutates the input.
 */
export function redact<T>(value: T, matchers: RedactMatcher[]): T {
  return redactInner(value, matchers) as T;
}

function redactInner(value: unknown, matchers: RedactMatcher[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, matchers));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = keyMatches(key, matchers) ? REDACTED : redactInner(val, matchers);
    }
    return out;
  }
  return value;
}

/**
 * Walk `value` and collect dotted paths where a matched key still holds a
 * non-empty, non-redacted string — i.e. a secret that escaped redaction. Used at
 * replay time to fail loudly on a leaky cassette.
 */
export function findUnredacted(value: unknown, matchers: RedactMatcher[]): string[] {
  const found: string[] = [];
  walk(value, matchers, '', found);
  return found;
}

function walk(
  value: unknown,
  matchers: RedactMatcher[],
  path: string,
  found: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, matchers, `${path}[${i}]`, found));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (
        keyMatches(key, matchers) &&
        typeof val === 'string' &&
        val.length > 0 &&
        val !== REDACTED
      ) {
        found.push(childPath);
      }
      walk(val, matchers, childPath, found);
    }
  }
}
