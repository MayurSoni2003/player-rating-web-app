/**
 * validate.ts — Row-level validation for normalized CSV rows.
 *
 * Distinction:
 *   ERROR   → row cannot be safely represented in the DB (missing required field,
 *             invalid controlled vocabulary that normalization could not resolve).
 *   WARNING → row CAN be inserted but contains suspicious/anomalous source data
 *             that should be visible to the operator.
 *
 * Validation does NOT modify values — it reports issues only.
 * Missing optional statistics → preserved as null (not an error).
 */

import type { NormalizedRow, ValidationIssue, ValidationSeverity } from './types';
import { VALID_AGE_GROUPS, VALID_POSITIONS, VALID_VENUES } from './types';

// ---------------------------------------------------------------------------
// Helper to build an issue object
// ---------------------------------------------------------------------------
function issue(
  severity: ValidationSeverity,
  rowIndex: number,
  row: Pick<NormalizedRow, 'match_id' | 'player_name'>,
  field: string,
  message: string,
): ValidationIssue {
  return {
    severity,
    rowIndex,
    matchId: row.match_id,
    playerName: row.player_name,
    field,
    message,
  };
}

// ---------------------------------------------------------------------------
// ISO date regex for post-normalization check
// ---------------------------------------------------------------------------
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Validate a single normalized row.
// Returns an array of ValidationIssue (may be empty if the row is clean).
// ---------------------------------------------------------------------------
export function validateRow(row: NormalizedRow, rowIndex: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ------ Required string fields ------

  if (!row.match_id) {
    issues.push(issue('error', rowIndex, row, 'match_id', 'match_id is required but missing'));
  }

  if (!row.player_name) {
    issues.push(issue('error', rowIndex, row, 'player_name', 'player_name is required but missing'));
  }

  if (!row.competition) {
    issues.push(issue('warning', rowIndex, row, 'competition', 'competition is missing'));
  }

  // ------ Match date ------

  if (!row.match_date || !ISO_DATE_RE.test(row.match_date)) {
    issues.push(
      issue(
        'error',
        rowIndex,
        row,
        'match_date',
        `match_date "${row.match_date}" could not be parsed to a valid ISO date. ` +
          'Only YYYY-MM-DD and DD/MM/YYYY within the 2026 season window are accepted.',
      ),
    );
  }

  // ------ Age group ------

  if (!row.age_group || !VALID_AGE_GROUPS.includes(row.age_group)) {
    issues.push(
      issue(
        'error',
        rowIndex,
        row,
        'age_group',
        `age_group "${row.age_group}" is not valid. Expected: ${VALID_AGE_GROUPS.join(', ')}.`,
      ),
    );
  }

  // ------ Position (optional, but must be valid if present) ------

  if (row.position !== null && !VALID_POSITIONS.includes(row.position)) {
    issues.push(
      issue(
        'error',
        rowIndex,
        row,
        'position',
        `position "${row.position}" is not in the known set: ${VALID_POSITIONS.join(', ')}.`,
      ),
    );
  }

  if (row.position === null) {
    issues.push(
      issue('warning', rowIndex, row, 'position', 'position is missing; row will be inserted with null position'),
    );
  }

  // ------ Venue (optional, but must be valid if present) ------

  if (row.venue !== null && !VALID_VENUES.includes(row.venue)) {
    issues.push(
      issue(
        'warning',
        rowIndex,
        row,
        'venue',
        `venue "${row.venue}" is not "home" or "away"; stored as null.`,
      ),
    );
  }

  // ------ Non-negative count checks (warnings, not errors — we preserve the value) ------

  const nonNegativeFields: Array<keyof NormalizedRow> = [
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
    'goals_for',
    'goals_against',
  ];

  for (const field of nonNegativeFields) {
    const val = row[field];
    if (typeof val === 'number' && val < 0) {
      issues.push(
        issue(
          'warning',
          rowIndex,
          row,
          field as string,
          `${field} is negative (${val}); value preserved but suspicious.`,
        ),
      );
    }
  }

  // ------ Anomalous relationship: passes_completed > passes_attempted ------
  // Do NOT fix — only report. The DB does not enforce this constraint intentionally.
  if (
    row.passes_completed !== null &&
    row.passes_attempted !== null &&
    row.passes_completed > row.passes_attempted
  ) {
    issues.push(
      issue(
        'warning',
        rowIndex,
        row,
        'passes_completed',
        `passes_completed (${row.passes_completed}) > passes_attempted (${row.passes_attempted}). ` +
          'This is anomalous source data; value preserved as-is.',
      ),
    );
  }

  // ------ Anomalous relationship: shots_on_target > shots ------
  if (
    row.shots_on_target !== null &&
    row.shots !== null &&
    row.shots_on_target > row.shots
  ) {
    issues.push(
      issue(
        'warning',
        rowIndex,
        row,
        'shots_on_target',
        `shots_on_target (${row.shots_on_target}) > shots (${row.shots}). Anomalous source data; preserved.`,
      ),
    );
  }

  // ------ Anomalous: minutes_played = 0 but other stats are non-zero ------
  if (row.minutes_played === 0) {
    const nonZeroStats = [
      row.touches,
      row.passes_attempted,
      row.goals,
      row.assists,
      row.duels_won,
    ].some((v) => v !== null && v > 0);

    if (nonZeroStats) {
      issues.push(
        issue(
          'warning',
          rowIndex,
          row,
          'minutes_played',
          'minutes_played is 0 but other statistics are non-zero. Rating logic will exclude this row from per-90 calculations.',
        ),
      );
    }
  }

  // ------ Missing minutes_played (not just zero) ------
  if (row.minutes_played === null) {
    issues.push(
      issue(
        'warning',
        rowIndex,
        row,
        'minutes_played',
        'minutes_played is missing (null); row will be inserted but excluded from per-90 rating calculations.',
      ),
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Determine if a row has any ERROR-severity issues (unsafe to insert)
// ---------------------------------------------------------------------------
export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
