// tapedeck: the language-model spec surface, typed structurally
//
// The AI SDK ships a new middleware spec with each major: `ai@6` takes a spec
// v3 middleware, `ai@7` takes spec v4. The two are mutually unassignable
// (prompts, content parts, and stream parts all gained variants in v4), so a
// middleware annotated with either concrete type forces consumers of the other
// major to write `as unknown as LanguageModelMiddleware` at `wrapLanguageModel`.
//
// tapedeck does not interpret a request: it hashes it, serializes it, and hands
// the response straight back. So the middleware boundary is typed over the
// fields tapedeck genuinely reads, and stays generic in the result types
// (whatever `doGenerate` hands in is what `wrapGenerate` hands back). One
// object then satisfies `wrapLanguageModel` under both majors with no cast on
// either side. Same technique as the OTel tracer and the toolroute router:
// describe the shape, don't import the version.

/** Model identity as tapedeck records it. Spec v3 and v4 models both satisfy it. */
export interface SpecModel {
  readonly provider: string;
  readonly modelId: string;
}

/**
 * The call options tapedeck reads. `prompt` and `tools` are opaque here on
 * purpose: they are hashed and serialized verbatim, and their spec v3 and v4
 * shapes differ. Spec v3 and v4 call options both satisfy this.
 */
export interface SpecCallOptions {
  prompt: unknown;
  tools?: unknown;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
}

/** What the host hands `wrapGenerate`. `GENERATE` is the host's result type. */
export interface WrapGenerateOptions<GENERATE> {
  doGenerate: () => PromiseLike<GENERATE>;
  doStream: () => PromiseLike<unknown>;
  params: SpecCallOptions;
  model: SpecModel;
}

/** What the host hands `wrapStream`. `STREAM` is the host's result type. */
export interface WrapStreamOptions<STREAM> {
  doGenerate: () => PromiseLike<unknown>;
  doStream: () => PromiseLike<STREAM>;
  params: SpecCallOptions;
  model: SpecModel;
}

/**
 * A language-model middleware as tapedeck implements it: `wrapGenerate` and
 * `wrapStream` are generic in the result type, so they compose with any spec
 * version whose result shape they are handed.
 *
 * Assignable to `LanguageModelV3Middleware` (`ai@6`) and to `ai@7`'s relaxed
 * `LanguageModelMiddleware` (spec v4 shapes, `specificationVersion` widened to
 * `string`). `specificationVersion` stays `'v3'` because v3 is the older, still
 * accepted tag: v4 hosts take any string, v3 hosts take only `'v3'`.
 */
export interface TapedeckMiddleware {
  readonly specificationVersion: 'v3';
  wrapGenerate: <GENERATE>(options: WrapGenerateOptions<GENERATE>) => Promise<GENERATE>;
  wrapStream: <STREAM>(options: WrapStreamOptions<STREAM>) => Promise<STREAM>;
}
