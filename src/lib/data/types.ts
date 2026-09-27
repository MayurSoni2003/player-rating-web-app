/**
 * types.ts — Canonical TypeScript types for the player-rating data pipeline.
 *
 * Layers:
 *  1. RawCsvRow        — raw string fields exactly as parsed from CSV (all strings)
 *  2. NormalizedRow    — after string normalization (trimmed, casing fixed, dates parsed)
 *  3. CleanAppearance  — after validation; ready for DB insertion
 */

// ---------------------------------------------------------------------------
// 1. Raw CSV row (all strings — PapaParse output before any conversion)
// ---------------------------------------------------------------------------
export interface RawCsvRow {
  match_id: string;
  match_date: string;
  competition: string;
  age_group: string;
  home_team: string;
  away_team: string;
  team: string;
  opponent: string;
  venue: string;
  goals_for: string;
  goals_against: string;
  player_name: string;
  position: string;
  minutes_played: string;
  touches: string;
  passes_attempted: string;
  passes_completed: string;
  progressive_passes: string;
  crosses: string;
  dribbles_attempted: string;
  dribbles_completed: string;
  shots: string;
  shots_on_target: string;
  goals: string;
  assists: string;
  duels_won: string;
  duels_lost: string;
  aerial_duels_won: string;
  aerial_duels_lost: string;
  tackles: string;
  interceptions: string;
  recoveries: string;
  clearances: string;
  fouls_committed: string;
  fouls_won: string;
  yellow_cards: string;
  red_cards: string;
  possession_lost: string;
}

// ---------------------------------------------------------------------------
// 2. Valid controlled-vocabulary values
// ---------------------------------------------------------------------------
export const VALID_AGE_GROUPS = ['U15', 'U17'] as const;
export type AgeGroup = (typeof VALID_AGE_GROUPS)[number];

export const VALID_POSITIONS = ['GK', 'CB', 'FB', 'CM', 'W', 'ST'] as const;
export type Position = (typeof VALID_POSITIONS)[number];

export const VALID_VENUES = ['home', 'away'] as const;
export type Venue = (typeof VALID_VENUES)[number];

// ---------------------------------------------------------------------------
// 3. Normalized row — strings cleaned, numbers parsed, dates as ISO strings
// ---------------------------------------------------------------------------
export interface NormalizedRow {
  // Match context
  match_id: string;
  match_date: string; // ISO date string: "YYYY-MM-DD"
  competition: string;
  age_group: AgeGroup;
  home_team: string;
  away_team: string;
  team: string;
  opponent: string;
  venue: Venue | null;
  goals_for: number | null;
  goals_against: number | null;

  // Player/appearance
  player_name: string;
  position: Position | null;
  minutes_played: number | null;
  touches: number | null;
  passes_attempted: number | null;
  passes_completed: number | null;
  progressive_passes: number | null;
  crosses: number | null;
  dribbles_attempted: number | null;
  dribbles_completed: number | null;
  shots: number | null;
  shots_on_target: number | null;
  goals: number | null;
  assists: number | null;
  duels_won: number | null;
  duels_lost: number | null;
  aerial_duels_won: number | null;
  aerial_duels_lost: number | null;
  tackles: number | null;
  interceptions: number | null;
  recoveries: number | null;
  clearances: number | null;
  fouls_committed: number | null;
  fouls_won: number | null;
  yellow_cards: number | null;
  red_cards: number | null;
  possession_lost: number | null;
}

// ---------------------------------------------------------------------------
// 4. Clean appearance — validated and ready for Supabase insertion
//    Errors are surfaced in the pipeline result rather than throwing.
// ---------------------------------------------------------------------------
export interface CleanAppearance extends NormalizedRow {
  /** Deduplication key used before DB insertion */
  dedupKey: string; // `${match_id}:${player_name_normalized}`
}

// ---------------------------------------------------------------------------
// 5. Pipeline result
// ---------------------------------------------------------------------------
export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  rowIndex: number; // 1-based (matches CSV line numbers after header)
  matchId: string;
  playerName: string;
  field: string;
  message: string;
}

export interface PipelineResult {
  /** Rows that passed validation and are safe to insert */
  cleanRows: CleanAppearance[];
  /** Validation warnings/errors, without stopping insertion of clean rows */
  issues: ValidationIssue[];
  /** Count of exact duplicate appearances removed before returning cleanRows */
  duplicatesRemoved: number;
  /** Total input rows (excluding header) */
  totalInputRows: number;
}

// ---------------------------------------------------------------------------
// 6. DB insert shapes (match what Supabase tables expect)
// ---------------------------------------------------------------------------
export interface DbPlayer {
  name: string;
  age_group: AgeGroup;
}

export interface DbMatch {
  id: string;
  match_date: string;
  competition: string;
  age_group: AgeGroup;
  home_team: string;
  away_team: string;
}

export interface DbAppearance {
  player_id: string; // uuid — resolved after player upsert
  match_id: string;
  position: Position | null;
  team: string;
  opponent: string;
  venue: Venue | null;
  goals_for: number | null;
  goals_against: number | null;
  minutes_played: number | null;
  touches: number | null;
  passes_attempted: number | null;
  passes_completed: number | null;
  progressive_passes: number | null;
  crosses: number | null;
  dribbles_attempted: number | null;
  dribbles_completed: number | null;
  shots: number | null;
  shots_on_target: number | null;
  goals: number | null;
  assists: number | null;
  duels_won: number | null;
  duels_lost: number | null;
  aerial_duels_won: number | null;
  aerial_duels_lost: number | null;
  tackles: number | null;
  interceptions: number | null;
  recoveries: number | null;
  clearances: number | null;
  fouls_committed: number | null;
  fouls_won: number | null;
  yellow_cards: number | null;
  red_cards: number | null;
  possession_lost: number | null;
}
