/**
 * rating.ts — Phase 3 rating engine (pure functions, no external dependencies).
 *
 * Pipeline:
 *   AppearanceInput[]  per player
 *     → computeAppearanceMetrics()   per-90 scaling + rate stats per appearance
 *     → aggregatePlayer()            mean over non-null observations
 *     → normalizeCohort()            min-max within (age_group × position_group)
 *     → computeRawScore()            weighted sum + card penalty
 *     → computePercentile()          rank within age_group
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DESIGN CHOICES (stated explicitly per Phase 3 §11 point 4)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. MINUTES FLOOR — 20 minutes
 *    Per-90 scaling uses max(minutes_played, 20) as the denominator.
 *    Without this cap, a 5-minute substitute who wins one duel generates
 *    18 duels/90 — a statistically meaningless spike from a tiny sample.
 *    The floor damps such spikes while still crediting short appearances.
 *    This is a stated editorial choice; the actual minutes value is
 *    preserved in storage and shown on the player detail page unchanged.
 *
 * 2. WEIGHTS — equal 1.0 except the position's most defining metric gets 1.5×
 *    GK: pass_completion_pct → 1.5 (goalkeepers are judged on ball-playing skill)
 *    Defender: tackles+interceptions → 1.5 (ball-winning is the defensive core)
 *    Midfielder: pass_completion_pct → 1.5 (accuracy defines the engine room)
 *    Attacker: goals+assists → 1.5 (direct goal contribution is paramount)
 *    These are editorial judgment calls, not statistically tuned coefficients.
 *    They are documented here and in the README as such.
 *
 * 3. WHY MIN-MAX OVER Z-SCORE
 *    Min-max maps every cohort into [0, 1], keeping the weighted sum
 *    bounded and interpretable. Z-scores can produce large negatives for
 *    outliers, which interact poorly with the additive card penalty and
 *    produce unpredictable score ranges. With a small dataset (~15–40
 *    players per position group), z-score also amplifies distributional
 *    assumptions that this data cannot support. Min-max makes no
 *    distributional assumptions and is appropriate for small, bounded cohorts.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { AgeGroup } from './data/types';

// ---------------------------------------------------------------------------
// Position groups
// ---------------------------------------------------------------------------
export type PositionGroup = 'GK' | 'Defender' | 'Midfielder' | 'Attacker';

const POSITION_TO_GROUP: Record<string, PositionGroup> = {
  GK: 'GK',
  CB: 'Defender',
  FB: 'Defender',
  CM: 'Midfielder',
  W: 'Midfielder',
  ST: 'Attacker',
};

export function getPositionGroup(position: string | null): PositionGroup | null {
  if (!position) return null;
  return POSITION_TO_GROUP[position] ?? null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum minutes denominator used when scaling to per-90.
 * Prevents per-90 spikes from very short cameo appearances.
 * See module-level design note #1.
 */
export const MINUTES_FLOOR = 20;

// ---------------------------------------------------------------------------
// Input shape (what the orchestrator feeds from the DB)
// ---------------------------------------------------------------------------
export interface AppearanceInput {
  player_id: string;
  match_id: string;
  position: string | null;
  minutes_played: number | null;
  // Count metrics
  goals: number | null;
  assists: number | null;
  shots_on_target: number | null;
  progressive_passes: number | null;
  tackles: number | null;
  interceptions: number | null;
  clearances: number | null;
  recoveries: number | null;
  yellow_cards: number | null;
  red_cards: number | null;
  // Rate metric inputs
  passes_attempted: number | null;
  passes_completed: number | null;
  duels_won: number | null;
  duels_lost: number | null;
  dribbles_attempted: number | null;
  dribbles_completed: number | null;
}

// ---------------------------------------------------------------------------
// Per-appearance computed metrics
// ---------------------------------------------------------------------------
export interface AppearanceMetrics {
  // Per-90 count metrics
  goals_per90: number | null;
  assists_per90: number | null;
  shots_on_target_per90: number | null;
  progressive_passes_per90: number | null;
  tackles_per90: number | null;
  interceptions_per90: number | null;
  clearances_per90: number | null;
  recoveries_per90: number | null;
  yellow_cards_per90: number | null;
  red_cards_per90: number | null;
  // Compound per-90 (summed per appearance before aggregation, not post-aggregation)
  tackles_interceptions_per90: number | null; // tackles_per90 + interceptions_per90
  goals_assists_per90: number | null;          // goals_per90 + assists_per90
  // Rate stats — NOT per-90 scaled (already a rate)
  pass_completion_pct: number | null;    // passes_completed / passes_attempted
  duel_win_pct: number | null;           // duels_won / (duels_won + duels_lost)
  dribble_success_pct: number | null;    // dribbles_completed / dribbles_attempted
}

export type MetricKey = keyof AppearanceMetrics;

// ---------------------------------------------------------------------------
// scaleToPer90 — exported per spec §11
// ---------------------------------------------------------------------------

/**
 * Scale a count metric to per-90 minutes.
 * Applies the MINUTES_FLOOR cap (see design note #1).
 * Returns null if value is null.
 */
export function scaleToPer90(value: number | null, minutesPlayed: number): number | null {
  if (value === null) return null;
  const effective = Math.max(minutesPlayed, MINUTES_FLOOR);
  return (value / effective) * 90;
}

// ---------------------------------------------------------------------------
// computeAppearanceMetrics — exported per spec §11
// ---------------------------------------------------------------------------

/**
 * Compute per-appearance metrics for a single appearance row.
 *
 * Returns null for ineligible appearances (minutes_played null or 0).
 * These are excluded from the rating computation but preserved in storage.
 *
 * Rate metrics:
 *  - Computed as successes / attempts for this appearance.
 *  - If attempts = 0 (or null), the metric is null for this appearance
 *    (excluded from that player's average for that metric, not the whole appearance).
 *
 * Compound per-90 metrics:
 *  - Computed as the sum of their components for this appearance.
 *  - Null if either component is null for this appearance.
 */
export function computeAppearanceMetrics(row: AppearanceInput): AppearanceMetrics | null {
  if (row.minutes_played === null || row.minutes_played === 0) return null;

  const mp = row.minutes_played;
  const s90 = (v: number | null) => scaleToPer90(v, mp);

  // Rate stats — null if attempts = 0 (prevent 0/0; per-spec §3)
  const passComp =
    row.passes_attempted !== null && row.passes_attempted > 0
      ? (row.passes_completed ?? 0) / row.passes_attempted
      : null;

  const totalDuels = (row.duels_won ?? 0) + (row.duels_lost ?? 0);
  const duelWin = totalDuels > 0 ? (row.duels_won ?? 0) / totalDuels : null;

  const dribbleSucc =
    row.dribbles_attempted !== null && row.dribbles_attempted > 0
      ? (row.dribbles_completed ?? 0) / row.dribbles_attempted
      : null;

  // Individual per-90 components
  const tacklesP90 = s90(row.tackles);
  const interceptionsP90 = s90(row.interceptions);
  const goalsP90 = s90(row.goals);
  const assistsP90 = s90(row.assists);

  // Compound per-90: null if either component is null (not a partial sum)
  const tacklesIntP90 =
    tacklesP90 !== null && interceptionsP90 !== null ? tacklesP90 + interceptionsP90 : null;
  const goalsAssistsP90 =
    goalsP90 !== null && assistsP90 !== null ? goalsP90 + assistsP90 : null;

  return {
    goals_per90: goalsP90,
    assists_per90: assistsP90,
    shots_on_target_per90: s90(row.shots_on_target),
    progressive_passes_per90: s90(row.progressive_passes),
    tackles_per90: tacklesP90,
    interceptions_per90: interceptionsP90,
    clearances_per90: s90(row.clearances),
    recoveries_per90: s90(row.recoveries),
    yellow_cards_per90: s90(row.yellow_cards),
    red_cards_per90: s90(row.red_cards),
    tackles_interceptions_per90: tacklesIntP90,
    goals_assists_per90: goalsAssistsP90,
    pass_completion_pct: passComp,
    duel_win_pct: duelWin,
    dribble_success_pct: dribbleSucc,
  };
}

// ---------------------------------------------------------------------------
// aggregatePlayer — exported per spec §11
// ---------------------------------------------------------------------------

export type PlayerAggregates = AppearanceMetrics & { eligible_appearances: number };

const ALL_METRIC_KEYS: MetricKey[] = [
  'goals_per90', 'assists_per90', 'shots_on_target_per90',
  'progressive_passes_per90', 'tackles_per90', 'interceptions_per90',
  'clearances_per90', 'recoveries_per90', 'yellow_cards_per90', 'red_cards_per90',
  'tackles_interceptions_per90', 'goals_assists_per90',
  'pass_completion_pct', 'duel_win_pct', 'dribble_success_pct',
];

function meanOf(metrics: AppearanceMetrics[], key: MetricKey): number | null {
  const values = metrics.map((m) => m[key]).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate per-appearance metrics into a single player-level value.
 *
 * Uses simple mean (not weighted by minutes — the per-90 scaling already
 * accounts for playing time; weighting again would double-count it).
 *
 * Null observations are excluded from BOTH numerator and denominator.
 * A player with pass_completion of 80%, null, 90% → average = 85%, not 56.7%.
 */
export function aggregatePlayer(metrics: AppearanceMetrics[]): PlayerAggregates {
  const result = {} as AppearanceMetrics;
  for (const k of ALL_METRIC_KEYS) {
    result[k] = meanOf(metrics, k);
  }
  return { ...result, eligible_appearances: metrics.length };
}

// ---------------------------------------------------------------------------
// Position group metric definitions (weights)
// ---------------------------------------------------------------------------
export interface MetricSpec {
  key: MetricKey;
  weight: number; // 1.5 for most defining metric, 1.0 for others
}

/**
 * Returns the ordered list of metrics and their weights for each position group.
 * Card penalty is NOT listed here — it is applied after the weighted sum.
 * See design note #2 for weight rationale.
 */
export function getPositionMetrics(posGroup: PositionGroup): MetricSpec[] {
  switch (posGroup) {
    case 'GK':
      return [
        { key: 'recoveries_per90',        weight: 1.0 },
        { key: 'clearances_per90',        weight: 1.0 },
        { key: 'pass_completion_pct',     weight: 1.5 }, // most defining for GK
      ];
    case 'Defender':
      return [
        { key: 'tackles_interceptions_per90', weight: 1.5 }, // most defining
        { key: 'duel_win_pct',            weight: 1.0 },
        { key: 'clearances_per90',        weight: 1.0 },
        { key: 'pass_completion_pct',     weight: 1.0 },
      ];
    case 'Midfielder':
      return [
        { key: 'progressive_passes_per90', weight: 1.0 },
        { key: 'pass_completion_pct',      weight: 1.5 }, // most defining
        { key: 'duel_win_pct',             weight: 1.0 },
        { key: 'goals_assists_per90',      weight: 1.0 },
      ];
    case 'Attacker':
      return [
        { key: 'goals_assists_per90',     weight: 1.5 }, // most defining
        { key: 'shots_on_target_per90',   weight: 1.0 },
        { key: 'dribble_success_pct',     weight: 1.0 },
        { key: 'duel_win_pct',            weight: 1.0 },
      ];
  }
}

// ---------------------------------------------------------------------------
// normalizeCohort — exported per spec §11
// ---------------------------------------------------------------------------

export interface PlayerForNorm {
  player_id: string;
  aggregates: PlayerAggregates;
}

export type NormalizedMetrics = Partial<Record<MetricKey, number>>;

export interface NormalizationWarning {
  posGroup: PositionGroup;
  ageGroup: AgeGroup;
  metric: MetricKey;
  reason: string;
}

/**
 * Min-max normalize position-group metrics within a cohort.
 *
 * For each metric:
 *  - Collects non-null aggregate values across cohort players.
 *  - If max === min (degenerate cohort), sets 0.5 for all players + logs warning.
 *  - Players with null aggregate for a metric get no entry → excluded from raw score.
 *  - Normalization range is computed only over players with non-null values (not entire cohort).
 *
 * Returns: Map<player_id, NormalizedMetrics>
 */
export function normalizeCohort(
  players: PlayerForNorm[],
  posGroup: PositionGroup,
  ageGroup: AgeGroup,
  warnings: NormalizationWarning[],
): Map<string, NormalizedMetrics> {
  const result = new Map<string, NormalizedMetrics>(
    players.map((p) => [p.player_id, {}] as [string, NormalizedMetrics]),
  );

  for (const { key } of getPositionMetrics(posGroup)) {
    // Collect non-null values with their player ids
    const entries = players
      .map((p) => ({ id: p.player_id, val: p.aggregates[key] as number | null }))
      .filter((e): e is { id: string; val: number } => e.val !== null);

    if (entries.length === 0) continue; // No data for this metric in cohort — skip entirely

    const vals = entries.map((e) => e.val);
    const min = Math.min(...vals);
    const max = Math.max(...vals);

    if (max === min) {
      warnings.push({
        posGroup,
        ageGroup,
        metric: key,
        reason: `All ${entries.length} players share identical value (${min.toFixed(4)}) — normalized = 0.5`,
      });
      for (const { id } of entries) {
        result.get(id)![key] = 0.5;
      }
    } else {
      for (const { id, val } of entries) {
        result.get(id)![key] = (val - min) / (max - min);
      }
      // Players not in entries (null aggregate) → no entry → excluded from score
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// applyCardPenalty — exported per spec §11
// ---------------------------------------------------------------------------

/**
 * Card penalty applied AFTER the weighted normalized sum.
 * Formula: -(yellow_cards_per90 × 0.5 + red_cards_per90 × 2.0)
 *
 * NOT min-max normalized — it is always a direct deduction so it can
 * never be "normalized away" by a cohort with universally bad discipline.
 *
 * Null card data is treated as 0 (no card data → no penalty).
 * This is a deliberate choice: penalizing a player for hypothetical cards
 * they have no evidence of would be unfair.
 */
export function applyCardPenalty(aggregates: PlayerAggregates): number {
  const yp90 = aggregates.yellow_cards_per90 ?? 0;
  const rp90 = aggregates.red_cards_per90 ?? 0;
  return -(yp90 * 0.5 + rp90 * 2.0);
}

// ---------------------------------------------------------------------------
// computeRawScore — exported per spec §11
// ---------------------------------------------------------------------------

/**
 * raw_score = Σ(normalized_metric × weight) + card_penalty
 *
 * Metrics with no normalized value (null aggregate → not in NormalizedMetrics map)
 * are skipped. This means data gaps reduce the score rather than being imputed.
 *
 * Returns null if no normalized metric is available (player has no usable data).
 */
export function computeRawScore(
  normalized: NormalizedMetrics,
  aggregates: PlayerAggregates,
  posGroup: PositionGroup,
): number | null {
  let sum = 0;
  let hasAny = false;

  for (const { key, weight } of getPositionMetrics(posGroup)) {
    const normVal = normalized[key];
    if (normVal !== undefined) {
      sum += normVal * weight;
      hasAny = true;
    }
  }

  if (!hasAny) return null;

  return sum + applyCardPenalty(aggregates);
}

// ---------------------------------------------------------------------------
// computePercentile — exported per spec §11
// ---------------------------------------------------------------------------

export interface PlayerScore {
  player_id: string;
  age_group: AgeGroup;
  raw_score: number;
}

/**
 * Compute percentile rank within each age_group (across ALL position groups).
 *
 * Formula: (rated players in same age_group with STRICTLY LOWER score) /
 *          (total rated players in age_group − 1) × 100
 *
 * Rounded to 1 decimal place.
 * Edge case: single player in age_group → percentile = 100.
 *
 * Unrated players (no score) are excluded from percentile computation
 * and do not affect other players' ranks.
 */
export function computePercentile(players: PlayerScore[]): Map<string, number> {
  const result = new Map<string, number>();

  // Group by age_group
  const byAge = new Map<AgeGroup, PlayerScore[]>();
  for (const p of players) {
    const group = byAge.get(p.age_group) ?? [];
    group.push(p);
    byAge.set(p.age_group, group);
  }

  for (const [, group] of byAge) {
    const n = group.length;
    for (const p of group) {
      if (n === 1) {
        result.set(p.player_id, 100);
      } else {
        const strictlyLower = group.filter((q) => q.raw_score < p.raw_score).length;
        const pct = Math.round((strictlyLower / (n - 1)) * 100 * 10) / 10;
        result.set(p.player_id, pct);
      }
    }
  }

  return result;
}
