// tapedeck/vitest — test helpers.

export { withCassette } from './with-cassette.js';
export type { WithCassetteOptions } from './with-cassette.js';

// Re-export the core surface so tests can `import { ... } from '@nkwib/tapedeck/vitest'`
// without a second import from the package root.
export { cassetteMiddleware } from './middleware.js';
export type { CassetteMiddlewareOptions, CassetteMode } from './middleware.js';
