// Type-level tests: a tapedeck middleware must drop into `wrapLanguageModel`
// under both supported `ai` majors with no cast at the call site.
//
// `ai@6` takes a spec v3 middleware; `ai@7` takes spec v4 with
// `specificationVersion` relaxed to any string. Both spec packages are dev
// dependencies (`@ai-sdk/provider` is v3, `@ai-sdk/provider-v4` is the v4
// alias), so the two spec assertions hold in either leg of the CI matrix,
// while the `wrapLanguageModel` assertions exercise whichever major is
// installed.

import { wrapLanguageModel } from 'ai';
import type { LanguageModelV3Middleware } from '@ai-sdk/provider';
import type { LanguageModelV4Middleware } from '@ai-sdk/provider-v4';
import { describe, expectTypeOf, it } from 'vitest';
import type { CassetteCompareResult } from '../src/compare.js';
import { cassetteMiddleware, type CassetteMode } from '../src/middleware.js';

/** The middleware type of whichever `ai` major is installed. */
type InstalledMiddleware = Parameters<typeof wrapLanguageModel>[0]['middleware'];

/**
 * `ai@7`'s `LanguageModelMiddleware`, spelled out: the spec v4 middleware with
 * `specificationVersion` widened to any string.
 */
type SpecV4Middleware = Omit<LanguageModelV4Middleware, 'specificationVersion'> & {
  readonly specificationVersion?: string;
};

declare const model: Parameters<typeof wrapLanguageModel>[0]['model'];
declare const middleware: ReturnType<typeof cassetteMiddleware>;

describe('cassetteMiddleware composes with both language-model specs', () => {
  it('satisfies the spec v3 middleware surface (ai@6)', () => {
    expectTypeOf(middleware).toExtend<LanguageModelV3Middleware>();
  });

  it('satisfies the spec v4 middleware surface (ai@7)', () => {
    expectTypeOf(middleware).toExtend<SpecV4Middleware>();
  });

  it('satisfies the installed major, which is what the call site needs', () => {
    expectTypeOf(middleware).toExtend<InstalledMiddleware>();
    expectTypeOf(wrapLanguageModel).toBeCallableWith({ model, middleware });
    expectTypeOf(wrapLanguageModel).toBeCallableWith({ model, middleware: [middleware] });
  });

  it('is why the middleware is not annotated LanguageModelV3Middleware', () => {
    // The regression this guards: annotating the concrete v3 type is exactly
    // what forced `as unknown as LanguageModelMiddleware` on ai@7 consumers.
    expectTypeOf<LanguageModelV3Middleware>().not.toExtend<SpecV4Middleware>();
  });
});

describe('compare surface', () => {
  it('adds compare to the mode union', () => {
    expectTypeOf<CassetteMode>().toEqualTypeOf<'record' | 'replay' | 'live' | 'compare'>();
  });

  it('hands onCompare the structured report', () => {
    expectTypeOf(cassetteMiddleware)
      .parameter(0)
      .exclude<undefined>()
      .toHaveProperty('onCompare')
      .exclude<undefined>()
      .parameter(0)
      .toEqualTypeOf<CassetteCompareResult>();
  });
});
