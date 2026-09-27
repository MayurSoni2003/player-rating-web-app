/**
 * clean.ts — Master pipeline: parse CSV → normalize → validate → deduplicate → report.
 *
 * Entry point: cleanCsv(csvText: string) → PipelineResult
 *
 * Pipeline stages:
 *  1. Parse raw CSV with PapaParse (header row → object keys).
 *  2. Normalize each row (strings, dates, numbers, controlled vocab).
 *  3. Validate each normalized row — collect issues; rows with ERROR severity are excluded.
 *  4. Deduplicate using match_id + normalized player_name (before DB insertion).
 *  5. Return CleanAppearance[] + issues + counts.
 *
 * Explicit deduplication key: `${match_id}:${normalized_player_name}`
 * The DB UNIQUE(match_id, player_id) constraint is the final safety net,
 * but we surface duplicates here so the caller can report them clearly.
 */

import Papa from 'papaparse';
import type {
  RawCsvRow,
  NormalizedRow,
  CleanAppearance,
  PipelineResult,
  ValidationIssue,
} from './types';
import { normalizeRow } from './normalize';
import { validateRow, hasErrors } from './validate';

// ---------------------------------------------------------------------------
// Required CSV columns — used for header validation
// ---------------------------------------------------------------------------
const REQUIRED_COLUMNS: Array<keyof RawCsvRow> = [
  'match_id',
  'match_date',
  'competition',
  'age_group',
  'home_team',
  'away_team',
  'team',
  'opponent',
  'venue',
  'goals_for',
  'goals_against',
  'player_name',
  'position',
  'minutes_played',
  'touches',
  'passes_attempted',
  'passes_completed',
  'progressive_passes',
  'crosses',
  'dribbles_attempted',
  'dribbles_completed',
  'shots',
  'shots_on_target',
  'goals',
  'assists',
  'duels_won',
  'duels_lost',
  'aerial_duels_won',
  'aerial_duels_lost',
  'tackles',
  'interceptions',
  'recoveries',
  'clearances',
  'fouls_committed',
  'fouls_won',
  'yellow_cards',
  'red_cards',
  'possession_lost',
];

// ---------------------------------------------------------------------------
// Validate the header row — throws if required columns are missing
// ---------------------------------------------------------------------------
function validateHeaders(columns: string[]): void {
  const columnSet = new Set(columns);
  const missing = REQUIRED_COLUMNS.filter((c) => !columnSet.has(c));
  if (missing.length > 0) {
    throw new Error(
      `CSV is missing required columns: ${missing.join(', ')}. ` +
        'Please upload a valid match_events.csv file.',
    );
  }
}

// ---------------------------------------------------------------------------
// Build the deduplication key for an appearance
// Uses normalized player name (already trimmed + collapsed whitespace).
// ---------------------------------------------------------------------------
function buildDedupKey(normalized: NormalizedRow): string {
  return `${normalized.match_id}:${normalized.player_name.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export function cleanCsv(csvText: string): PipelineResult {
  // ---- Stage 1: Parse CSV ----
  const parseResult = Papa.parse<RawCsvRow>(csvText, {
    header: true,
    skipEmptyLines: true,
    // Do NOT dynamicTyping — we want raw strings so we control parsing precisely
    dynamicTyping: false,
  });

  if (parseResult.errors.length > 0) {
    // Surface PapaParse structural errors as pipeline errors
    const papaIssues: ValidationIssue[] = parseResult.errors.map((e, idx) => ({
      severity: 'error' as const,
      rowIndex: e.row ?? idx,
      matchId: '?',
      playerName: '?',
      field: 'csv_structure',
      message: `CSV parse error: ${e.message} (type: ${e.type})`,
    }));
    return {
      cleanRows: [],
      issues: papaIssues,
      duplicatesRemoved: 0,
      totalInputRows: 0,
    };
  }

  const rawRows = parseResult.data;
  const totalInputRows = rawRows.length;

  // Validate headers
  if (rawRows.length > 0) {
    validateHeaders(Object.keys(rawRows[0]));
  }

  const allIssues: ValidationIssue[] = [];
  const normalized: Array<{ row: NormalizedRow; rowIndex: number }> = [];

  // ---- Stage 2 & 3: Normalize + Validate ----
  rawRows.forEach((raw, idx) => {
    const rowIndex = idx + 1; // 1-based
    const norm = normalizeRow(raw);
    const rowIssues = validateRow(norm, rowIndex);
    allIssues.push(...rowIssues);

    if (!hasErrors(rowIssues)) {
      normalized.push({ row: norm, rowIndex });
    }
  });

  // ---- Stage 4: Deduplicate ----
  const seen = new Map<string, number>(); // key → rowIndex of first seen
  let duplicatesRemoved = 0;
  const deduplicated: CleanAppearance[] = [];

  for (const { row, rowIndex } of normalized) {
    const key = buildDedupKey(row);
    if (seen.has(key)) {
      duplicatesRemoved++;
      allIssues.push({
        severity: 'warning',
        rowIndex,
        matchId: row.match_id,
        playerName: row.player_name,
        field: 'deduplication',
        message:
          `Duplicate appearance for player "${row.player_name}" in match "${row.match_id}". ` +
          `First seen at row ${seen.get(key)}. This row is removed; only the first occurrence is kept.`,
      });
    } else {
      seen.set(key, rowIndex);
      deduplicated.push({
        ...row,
        dedupKey: key,
      });
    }
  }

  return {
    cleanRows: deduplicated,
    issues: allIssues,
    duplicatesRemoved,
    totalInputRows,
  };
}

// ---------------------------------------------------------------------------
// Summary helpers (useful for API responses and logging)
// ---------------------------------------------------------------------------
export function summarizePipelineResult(result: PipelineResult): {
  totalInputRows: number;
  cleanRows: number;
  errorRows: number;
  duplicatesRemoved: number;
  warnings: number;
  errors: number;
} {
  const errors = result.issues.filter((i) => i.severity === 'error').length;
  const warnings = result.issues.filter((i) => i.severity === 'warning').length;
  const errorRows = result.totalInputRows - result.duplicatesRemoved - result.cleanRows.length;

  return {
    totalInputRows: result.totalInputRows,
    cleanRows: result.cleanRows.length,
    errorRows,
    duplicatesRemoved: result.duplicatesRemoved,
    warnings,
    errors,
  };
}
