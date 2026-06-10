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
  MULTI_CASSETTE_VERSION,
  loadCassette,
  saveCassette,
  cassetteFilename,
  parseCassette,
  serializeCassette,
  isMultiCassette,
} from './cassette.js';
export type {
  Cassette,
  CassetteFile,
  CassetteInteraction,
  CassetteRequest,
  CassetteResponse,
  GenerateCassetteResponse,
  MultiCassette,
  StreamCassetteResponse,
} from './cassette.js';

export { REDACTED, DEFAULT_REDACT } from './redact.js';
export type { RedactMatcher } from './redact.js';

export { fileCassetteStore, memoryCassetteStore } from './store.js';
export type { CassetteStore } from './store.js';

export { withSpan, SPAN_STATUS_OK, SPAN_STATUS_ERROR } from './telemetry.js';
export type { TapedeckTracer, TapedeckSpan, TapedeckAttributeValue } from './telemetry.js';

export {
  diffCassettes,
  formatCassetteDiff,
  diffCassetteFiles,
  formatCassetteFileDiff,
} from './diff.js';
export type {
  CassetteDiffResult,
  CassetteFieldDiff,
  CassetteFileDiffResult,
  CassetteInteractionDiff,
} from './diff.js';

export { mergeCassetteDirs } from './merge.js';
export type { MergeCassettesOptions, MergeCassettesResult } from './merge.js';
