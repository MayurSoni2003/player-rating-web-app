/**
 * ratingOrchestrator.ts — Reads from Supabase, runs the Phase 3 rating pipeline,
 * and upserts results back into player_ratings.
 *
 * Separated from the pure functions in rating.ts so both the API route
 * (src/app/api/compute-ratings/route.ts) and the test script
 * (scripts/test-ratings.ts) can call the same logic without code duplication.
 *
 * IMPORTANT: Always recomputes the full cohort from scratch on each call.
 * One player's normalization range affects everyone else's score in their
 * (age_group × position_group) cohort — incremental updates are not safe.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgeGroup } from './data/types';
import {
  getPositionGroup,
  computeAppearanceMetrics,
  aggregatePlayer,
  normalizeCohort,
  computeRawScore,
  computePercentile,
  type AppearanceInput,
  type PositionGroup,
  type PlayerForNorm,
  type PlayerScore,
  type NormalizationWarning,
  type NormalizedMetrics,
} from './rating';

// ---------------------------------------------------------------------------
// Types for Supabase query results
// ---------------------------------------------------------------------------
interface DbAppearanceRow {
  player_id: string;
  match_id: string;
  position: string | null;
  minutes_played: number | null;
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
  passes_attempted: number | null;
  passes_completed: number | null;
  duels_won: number | null;
  duels_lost: number | null;
  dribbles_attempted: number | null;
  dribbles_completed: number | null;
  players: {
    name: string;
    age_group: AgeGroup;
  };
}

interface DbPlayerRow {
  id: string;
  name: string;
  age_group: AgeGroup;
}

// ---------------------------------------------------------------------------
// Player data during pipeline execution
// ---------------------------------------------------------------------------
interface PlayerPipelineData {
  player_id: string;
  player_name: string;
  age_group: AgeGroup;
  position_group: PositionGroup | null;
  aggregates: ReturnType<typeof aggregatePlayer> | null;
  total_appearances: number;   // all appearances (including ineligible)
  eligible_appearances: number;
  ineligible_reason: string | null;
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------
export interface RatingPipelineResult {
  success: boolean;
  error?: string;
  detail?: string;
  summary?: {
    totalPlayers: number;
    rated: number;
    unrated: number;
    byAgeGroup: {
      U15: { rated: number; unrated: number };
      U17: { rated: number; unrated: number };
    };
    normalizationWarnings: number;
  };
  normalizationWarnings?: NormalizationWarning[];
  // For test script: individual player details
  playerDetails?: Map<string, {
    player_id: string;
    name: string;
    age_group: AgeGroup;
    position_group: PositionGroup | null;
    eligible_appearances: number;
    aggregates: ReturnType<typeof aggregatePlayer> | null;
    normalized: NormalizedMetrics | null;
    raw_score: number | null;
    percentile: number | null;
    ineligible_reason: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Helper: determine position group from a list of positions
// Uses the modal (most common) non-null position group.
// ---------------------------------------------------------------------------
function resolvePositionGroup(positions: (string | null)[]): PositionGroup | null {
  const counts = new Map<PositionGroup, number>();
  for (const pos of positions) {
    const group = getPositionGroup(pos);
    if (group) counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ---------------------------------------------------------------------------
// Main orchestration function
// ---------------------------------------------------------------------------
export async function computeAndUpsertRatings(
  supabase: SupabaseClient,
): Promise<RatingPipelineResult> {

  // ── Step 1: Fetch all appearances with player info ──────────────────────
  const { data: rawRows, error: fetchError } = await supabase
    .from('appearances')
    .select(`
      player_id, match_id, position, minutes_played,
      goals, assists, shots_on_target, progressive_passes,
      tackles, interceptions, clearances, recoveries,
      yellow_cards, red_cards,
      passes_attempted, passes_completed,
      duels_won, duels_lost,
      dribbles_attempted, dribbles_completed,
      players!inner(name, age_group)
    `);

  if (fetchError || !rawRows) {
    return { success: false, error: 'Failed to fetch appearances', detail: fetchError?.message };
  }

  const appearances = rawRows as unknown as DbAppearanceRow[];

  // ── Step 2: Fetch all players (includes those with 0 appearances) ───────
  const { data: allPlayers, error: playersError } = await supabase
    .from('players')
    .select('id, name, age_group');

  if (playersError || !allPlayers) {
    return { success: false, error: 'Failed to fetch players', detail: playersError?.message };
  }

  const playerRows = allPlayers as DbPlayerRow[];

  // Build a lookup: player_id → { name, age_group }
  const playerLookup = new Map(playerRows.map((p) => [p.id, p]));

  // ── Step 3: Group appearances by player ─────────────────────────────────
  // Track: ALL appearances (for matches_played), ELIGIBLE appearances (for rating)
  interface PlayerGrouped {
    ageGroup: AgeGroup;
    name: string;
    allPositions: (string | null)[];  // from all appearances
    eligibleInputs: AppearanceInput[]; // minutes > 0
    totalAppearances: number;
  }

  const byPlayer = new Map<string, PlayerGrouped>();

  for (const row of appearances) {
    const pid = row.player_id;
    if (!byPlayer.has(pid)) {
      byPlayer.set(pid, {
        ageGroup: row.players.age_group,
        name: row.players.name,
        allPositions: [],
        eligibleInputs: [],
        totalAppearances: 0,
      });
    }
    const g = byPlayer.get(pid)!;
    g.totalAppearances++;
    g.allPositions.push(row.position);

    // Eligibility: minutes_played must be non-null and > 0
    if (row.minutes_played !== null && row.minutes_played > 0) {
      g.eligibleInputs.push({
        player_id: pid,
        match_id: row.match_id,
        position: row.position,
        minutes_played: row.minutes_played,
        goals: row.goals,
        assists: row.assists,
        shots_on_target: row.shots_on_target,
        progressive_passes: row.progressive_passes,
        tackles: row.tackles,
        interceptions: row.interceptions,
        clearances: row.clearances,
        recoveries: row.recoveries,
        yellow_cards: row.yellow_cards,
        red_cards: row.red_cards,
        passes_attempted: row.passes_attempted,
        passes_completed: row.passes_completed,
        duels_won: row.duels_won,
        duels_lost: row.duels_lost,
        dribbles_attempted: row.dribbles_attempted,
        dribbles_completed: row.dribbles_completed,
      });
    }
  }

  // ── Step 4: Compute per-player pipeline data ─────────────────────────────
  const pipelineMap = new Map<string, PlayerPipelineData>();

  for (const [pid, g] of byPlayer) {
    // Position group: determined from eligible appearances' positions only.
    //
    // IMPORTANT ELIGIBILITY RULE (per spec §1 + Mateo Otero example):
    // If ANY eligible appearance has a null/unknown position, the player is
    // excluded from rating entirely. We cannot safely assign a position group
    // for a player whose classification is ambiguous across appearances.
    // Mateo Otero (M-1707 null, M-1704 CM) is the canonical example —
    // the spec explicitly requires him to be unrated.
    const eligiblePositions = g.eligibleInputs.map((i) => i.position);
    const hasAnyNullPosition = eligiblePositions.some((p) => getPositionGroup(p) === null);
    const positionGroup = hasAnyNullPosition ? null : resolvePositionGroup(eligiblePositions);

    // Ineligibility checks (per spec §1)
    let ineligibleReason: string | null = null;
    if (g.eligibleInputs.length === 0) {
      ineligibleReason = 'No eligible appearances (all minutes are null or 0)';
    } else if (hasAnyNullPosition) {
      ineligibleReason = 'Cannot assign position group: at least one eligible appearance has null/unknown position (e.g. Mateo Otero M-1707)';
    } else if (positionGroup === null) {
      ineligibleReason = 'Cannot assign position group (all eligible appearances have null/unknown position)';
    }

    // Per-appearance metrics → aggregate
    let agg = null;
    if (ineligibleReason === null) {
      const perAppMetrics = g.eligibleInputs
        .map(computeAppearanceMetrics)
        .filter((m): m is NonNullable<ReturnType<typeof computeAppearanceMetrics>> => m !== null);
      agg = aggregatePlayer(perAppMetrics);
    }

    pipelineMap.set(pid, {
      player_id: pid,
      player_name: g.name,
      age_group: g.ageGroup,
      position_group: positionGroup,
      aggregates: agg,
      total_appearances: g.totalAppearances,
      eligible_appearances: g.eligibleInputs.length,
      ineligible_reason: ineligibleReason,
    });
  }

  // ── Step 5: Group eligible players by (age_group × position_group) ──────
  const cohortMap = new Map<string, PlayerForNorm[]>();

  for (const [pid, data] of pipelineMap) {
    if (data.position_group === null || data.aggregates === null) continue;
    const key = `${data.age_group}::${data.position_group}`;
    const arr = cohortMap.get(key) ?? [];
    arr.push({ player_id: pid, aggregates: data.aggregates });
    cohortMap.set(key, arr);
  }

  // ── Step 6: Min-max normalize each cohort ───────────────────────────────
  const normWarnings: NormalizationWarning[] = [];
  const normalizedMap = new Map<string, NormalizedMetrics>();

  for (const [key, cohortPlayers] of cohortMap) {
    const [ageGroup, posGroup] = key.split('::') as [AgeGroup, PositionGroup];
    const cohortNorm = normalizeCohort(cohortPlayers, posGroup, ageGroup, normWarnings);
    for (const [pid, norm] of cohortNorm) {
      normalizedMap.set(pid, norm);
    }
  }

  // ── Step 7: Compute raw scores ───────────────────────────────────────────
  const playerScores: PlayerScore[] = [];

  for (const [pid, data] of pipelineMap) {
    if (data.position_group === null || data.aggregates === null) continue;
    const normalized = normalizedMap.get(pid);
    if (!normalized) continue;
    const rawScore = computeRawScore(normalized, data.aggregates, data.position_group);
    if (rawScore === null) continue;
    playerScores.push({ player_id: pid, age_group: data.age_group, raw_score: rawScore });
  }

  // ── Step 8: Compute percentiles ─────────────────────────────────────────
  const percentileMap = computePercentile(playerScores);

  // ── Step 9: Build upsert rows ────────────────────────────────────────────
  // All players get a row (rated → with scores; unrated → null scores).
  // This lets the UI distinguish "not rated" from "not in table".
  const now = new Date().toISOString();
  const scoreByPid = new Map(playerScores.map((s) => [s.player_id, s.raw_score]));

  const upsertRows: Array<{
    player_id: string;
    age_group: string;
    overall_score: number | null;
    percentile: number | null;
    matches_played: number | null;
    updated_at: string;
  }> = [];

  const playersWithAppearances = new Set(byPlayer.keys());

  // Players who have appearances (rated or unrated)
  for (const [pid, data] of pipelineMap) {
    const rawScore = scoreByPid.get(pid) ?? null;
    upsertRows.push({
      player_id: pid,
      age_group: data.age_group,
      overall_score: rawScore,
      percentile: rawScore !== null ? (percentileMap.get(pid) ?? null) : null,
      matches_played: data.total_appearances,
      updated_at: now,
    });
  }

  // Players with no appearances at all (edge case — shouldn't exist in current data)
  for (const p of playerRows) {
    if (!playersWithAppearances.has(p.id)) {
      upsertRows.push({
        player_id: p.id,
        age_group: p.age_group,
        overall_score: null,
        percentile: null,
        matches_played: 0,
        updated_at: now,
      });
    }
  }

  // ── Step 10: Upsert to player_ratings ───────────────────────────────────
  const { error: upsertError } = await supabase
    .from('player_ratings')
    .upsert(upsertRows, { onConflict: 'player_id,age_group' });

  if (upsertError) {
    return {
      success: false,
      error: 'Failed to upsert player_ratings',
      detail: upsertError.message,
    };
  }

  // ── Step 11: Build summary ───────────────────────────────────────────────
  const ratedPids = new Set(playerScores.map((s) => s.player_id));
  const ratedCount = ratedPids.size;
  const unratedCount = upsertRows.length - ratedCount;

  const u15Rated = playerScores.filter((s) => s.age_group === 'U15').length;
  const u17Rated = playerScores.filter((s) => s.age_group === 'U17').length;
  const u15Unrated = upsertRows.filter(
    (r) => r.age_group === 'U15' && r.overall_score === null,
  ).length;
  const u17Unrated = upsertRows.filter(
    (r) => r.age_group === 'U17' && r.overall_score === null,
  ).length;

  // Build per-player details map for the test script (keyed by player_id)
  const playerDetails = new Map(
    [...pipelineMap.entries()].map(([pid, data]) => {
      const rawScore = scoreByPid.get(pid) ?? null;
      return [
        pid,
        {
          player_id: pid,
          name: data.player_name,
          age_group: data.age_group,
          position_group: data.position_group,
          eligible_appearances: data.eligible_appearances,
          aggregates: data.aggregates,
          normalized: normalizedMap.get(pid) ?? null,
          raw_score: rawScore,
          percentile: rawScore !== null ? (percentileMap.get(pid) ?? null) : null,
          ineligible_reason: data.ineligible_reason,
        },
      ] as [string, RatingPipelineResult['playerDetails'] extends Map<string, infer V> ? V : never];
    }),
  ) as RatingPipelineResult['playerDetails'];

  return {
    success: true,
    summary: {
      totalPlayers: upsertRows.length,
      rated: ratedCount,
      unrated: unratedCount,
      byAgeGroup: {
        U15: { rated: u15Rated, unrated: u15Unrated },
        U17: { rated: u17Rated, unrated: u17Unrated },
      },
      normalizationWarnings: normWarnings.length,
    },
    normalizationWarnings: normWarnings,
    playerDetails,
  };
}
