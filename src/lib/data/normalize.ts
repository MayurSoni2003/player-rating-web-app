/**
 * normalize.ts — String, date, and numeric normalization for raw CSV rows.
 *
 * Rules:
 *  - Trim all strings.
 *  - Normalize team name casing to a canonical known-teams map.
 *  - Parse dates: ISO YYYY-MM-DD preferred; DD/MM/YYYY fallback (Spanish locale).
 *  - Parse integers: empty/blank string → null; "0" → 0.
 *  - Normalize age_group, position, venue to their canonical controlled vocabulary.
 *
 * This module does NOT validate — it only converts formats. Validation lives in validate.ts.
 */

import type { RawCsvRow, NormalizedRow, AgeGroup, Position, Venue } from './types';
import { VALID_AGE_GROUPS, VALID_POSITIONS, VALID_VENUES } from './types';

// ---------------------------------------------------------------------------
// Team name canonical map
// All known team names in the source, normalized to their display form.
// Keys must be lowercase-trimmed for case-insensitive lookup.
// ---------------------------------------------------------------------------
const TEAM_CANONICAL: Record<string, string> = {
  'fc barcelona': 'FC Barcelona',
  'real madrid': 'Real Madrid',
  'atletico madrid': 'Atletico Madrid',
  'getafe cf': 'Getafe CF',
  'rcd espanyol': 'RCD Espanyol',
  'girona fc': 'Girona FC',
};

/**
 * Normalize a team name to its canonical display value.
 * Falls back to trimmed original if not in the known map (preserves unknown teams).
 */
export function normalizeTeamName(raw: string): string {
  const trimmed = raw.trim();
  const key = trimmed.toLowerCase();
  return TEAM_CANONICAL[key] ?? trimmed;
}

// ---------------------------------------------------------------------------
// Player name normalization
// Some rows have names like "Samuel  Alonso" (double space) or "cesar herrera "
// Normalize whitespace: trim + collapse internal multiple spaces to one.
// Also title-case "c. herrera" style abbreviated names — preserve as-is
// (they may represent a distinct data entry and should be surfaced as warnings
// by the validation layer, not silently merged here).
// ---------------------------------------------------------------------------
export function normalizePlayerName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Date parsing
//
// Formats observed in the source:
//   ISO:      "2026-03-14"  → always unambiguous
//   DD/MM/YYYY: "11/04/2026" → Spanish locale convention
//
// Season window: 2026-03-14 to 2026-04-25.
// The DD/MM interpretation of the ambiguous dates (11/04 → Apr 11,
// 05/04 → Apr 5) falls inside this window.
// The MM/DD interpretation (Nov 4, May 4) does NOT.
//
// Returns: "YYYY-MM-DD" string, or null if unparseable.
// ---------------------------------------------------------------------------
const SEASON_START = new Date('2026-03-01');
const SEASON_END = new Date('2026-05-01');

export function parseMatchDate(raw: string): string | null {
  const trimmed = raw.trim();

  // ISO format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return trimmed;
    return null;
  }

  // DD/MM/YYYY format (Spanish locale)
  const ddmmyyyy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy] = ddmmyyyy;
    const isoAttempt = `${yyyy}-${mm}-${dd}`;
    const d = new Date(isoAttempt);
    if (!isNaN(d.getTime())) {
      // Sanity-check: must fall within known season window
      if (d >= SEASON_START && d <= SEASON_END) {
        return isoAttempt;
      }
      // Falls outside season window — return null so validator can report it
      return null;
    }
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Integer parsing
// "" / whitespace-only → null
// Valid integer string → number
// Anything else → null (validator will flag it)
// ---------------------------------------------------------------------------
export function parseNullableInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === null) return null;
  const n = Number(trimmed);
  if (Number.isInteger(n)) return n;
  return null; // non-integer — validator will catch
}

// ---------------------------------------------------------------------------
// Controlled vocabulary normalization (case-insensitive, trimmed)
// Returns the canonical value or null if unrecognised (validator will catch).
// ---------------------------------------------------------------------------
export function normalizeAgeGroup(raw: string): AgeGroup | null {
  const trimmed = raw.trim().toUpperCase() as AgeGroup;
  return VALID_AGE_GROUPS.includes(trimmed) ? trimmed : null;
}

export function normalizePosition(raw: string): Position | null {
  if (!raw || raw.trim() === '') return null;
  const trimmed = raw.trim().toUpperCase() as Position;
  return VALID_POSITIONS.includes(trimmed) ? trimmed : null;
}

export function normalizeVenue(raw: string): Venue | null {
  if (!raw || raw.trim() === '') return null;
  const lower = raw.trim().toLowerCase() as Venue;
  return VALID_VENUES.includes(lower) ? lower : null;
}

// ---------------------------------------------------------------------------
// Master row normalizer — converts one RawCsvRow → NormalizedRow
// ---------------------------------------------------------------------------
export function normalizeRow(raw: RawCsvRow): NormalizedRow {
  return {
    // Match context
    match_id: raw.match_id.trim(),
    match_date: parseMatchDate(raw.match_date) ?? raw.match_date.trim(), // preserve raw if unparseable for validator
    competition: raw.competition.trim(),
    age_group: normalizeAgeGroup(raw.age_group) as AgeGroup, // null cast; validator catches null
    home_team: normalizeTeamName(raw.home_team),
    away_team: normalizeTeamName(raw.away_team),
    team: normalizeTeamName(raw.team),
    opponent: normalizeTeamName(raw.opponent),
    venue: normalizeVenue(raw.venue),
    goals_for: parseNullableInt(raw.goals_for),
    goals_against: parseNullableInt(raw.goals_against),

    // Player/appearance
    player_name: normalizePlayerName(raw.player_name),
    position: normalizePosition(raw.position),
    minutes_played: parseNullableInt(raw.minutes_played),
    touches: parseNullableInt(raw.touches),
    passes_attempted: parseNullableInt(raw.passes_attempted),
    passes_completed: parseNullableInt(raw.passes_completed),
    progressive_passes: parseNullableInt(raw.progressive_passes),
    crosses: parseNullableInt(raw.crosses),
    dribbles_attempted: parseNullableInt(raw.dribbles_attempted),
    dribbles_completed: parseNullableInt(raw.dribbles_completed),
    shots: parseNullableInt(raw.shots),
    shots_on_target: parseNullableInt(raw.shots_on_target),
    goals: parseNullableInt(raw.goals),
    assists: parseNullableInt(raw.assists),
    duels_won: parseNullableInt(raw.duels_won),
    duels_lost: parseNullableInt(raw.duels_lost),
    aerial_duels_won: parseNullableInt(raw.aerial_duels_won),
    aerial_duels_lost: parseNullableInt(raw.aerial_duels_lost),
    tackles: parseNullableInt(raw.tackles),
    interceptions: parseNullableInt(raw.interceptions),
    recoveries: parseNullableInt(raw.recoveries),
    clearances: parseNullableInt(raw.clearances),
    fouls_committed: parseNullableInt(raw.fouls_committed),
    fouls_won: parseNullableInt(raw.fouls_won),
    yellow_cards: parseNullableInt(raw.yellow_cards),
    red_cards: parseNullableInt(raw.red_cards),
    possession_lost: parseNullableInt(raw.possession_lost),
  };
}
