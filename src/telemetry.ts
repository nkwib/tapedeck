// tapedeck — telemetry (OpenTelemetry-compatible span emission)
//
// tapedeck has zero runtime dependencies, so it does not import
// `@opentelemetry/api`. Instead the middleware accepts a `tracer` whose shape is
// a structural subset of the OTel `Tracer` interface — pass the real thing
// (`trace.getTracer('tapedeck')`) and it just works; pass nothing and tracing
// is a no-op.

/** Attribute values tapedeck emits. Matches OTel's primitive attribute types. */
export type TapedeckAttributeValue = string | number | boolean;

/** Mirrors OTel `SpanStatusCode.OK` / `SpanStatusCode.ERROR`. */
export const SPAN_STATUS_OK = 1;
export const SPAN_STATUS_ERROR = 2;

/** Structural subset of an OTel `Span`. */
export interface TapedeckSpan {
  setAttribute(key: string, value: TapedeckAttributeValue): unknown;
  recordException?(exception: unknown): unknown;
  setStatus?(status: { code: number; message?: string }): unknown;
  end(): void;
}

/** Structural subset of an OTel `Tracer`. */
export interface TapedeckTracer {
  startSpan(name: string): TapedeckSpan;
}

/**
 * Run `fn` inside a span (if a tracer is configured). Sets `attributes` up
 * front, marks OK/ERROR status, records exceptions, and always ends the span.
 * With no tracer this is a plain call — zero overhead on the hot path.
 */
export async function withSpan<T>(
  tracer: TapedeckTracer | undefined,
  name: string,
  attributes: Record<string, TapedeckAttributeValue>,
  fn: (span?: TapedeckSpan) => Promise<T>,
): Promise<T> {
  if (!tracer) return fn();

  const span = tracer.startSpan(name);
  for (const [key, value] of Object.entries(attributes)) {
    span.setAttribute(key, value);
  }
  try {
    const result = await fn(span);
    span.setStatus?.({ code: SPAN_STATUS_OK });
    return result;
  } catch (err) {
    span.recordException?.(err);
    span.setStatus?.({
      code: SPAN_STATUS_ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    span.end();
  }
}
