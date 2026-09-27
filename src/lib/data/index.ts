/**
 * index.ts — Barrel export for the data pipeline.
 *
 * Import from here rather than from individual files:
 *   import { cleanCsv, summarizePipelineResult } from '@/lib/data'
 */

// Types
export type {
  RawCsvRow,
  NormalizedRow,
  CleanAppearance,
  PipelineResult,
  ValidationIssue,
  ValidationSeverity,
  AgeGroup,
  Position,
  Venue,
  DbPlayer,
  DbMatch,
  DbAppearance,
} from './types';

export { VALID_AGE_GROUPS, VALID_POSITIONS, VALID_VENUES } from './types';

// Normalization utilities
export {
  normalizeTeamName,
  normalizePlayerName,
  parseMatchDate,
  parseNullableInt,
  normalizeAgeGroup,
  normalizePosition,
  normalizeVenue,
  normalizeRow,
} from './normalize';

// Validation utilities
export { validateRow, hasErrors } from './validate';

// Pipeline entry point
export { cleanCsv, summarizePipelineResult } from './clean';
