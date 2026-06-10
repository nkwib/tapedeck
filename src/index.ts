// tapedeck — record/replay middleware for the Vercel AI SDK.

export { cassetteMiddleware } from './middleware.js';
export type { CassetteMiddlewareOptions, CassetteMode } from './middleware.js';

export {
  CassetteError,
  CassetteMissError,
  CassetteSecretError,
  CassetteCorruptError,
  CassetteModeError,
} from './errors.js';

export { computeCassetteHash, stableStringify, normalizeTools } from './hash.js';
export type { CassetteRequestKey } from './hash.js';

export {
  CASSETTE_VERSION,
  loadCassette,
  saveCassette,
  cassetteFilename,
} from './cassette.js';
export type {
  Cassette,
  CassetteRequest,
  CassetteResponse,
  GenerateCassetteResponse,
  StreamCassetteResponse,
} from './cassette.js';

export { REDACTED, DEFAULT_REDACT } from './redact.js';
export type { RedactMatcher } from './redact.js';
