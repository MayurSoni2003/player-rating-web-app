/**
 * POST /api/ingest
 *
 * Accepts a CSV file via multipart/form-data (field name: "file").
 * Runs the Phase 1 cleaning pipeline, then atomically upserts into Supabase
 * via the ingest_batch() Postgres function.
 *
 * Error taxonomy:
 *  400 — file/request problems, CSV parse errors, validation errors
 *  500 — database failures
 *
 * The service-role key never appears in any response.
 * This route is server-side only (runtime = 'nodejs').
 */

import type { NextRequest } from 'next/server';
import { cleanCsv } from '@/lib/data/clean';
import { serviceRoleClient } from '@/lib/supabase';
import type { CleanAppearance } from '@/lib/data/types';

// Force Node.js runtime — the Supabase client is not Edge-compatible.
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Types for the ingest_batch RPC response
// ---------------------------------------------------------------------------
interface IngestBatchResult {
  players_inserted: number;
  matches_upserted: number;
  appearances_upserted: number;
}

// ---------------------------------------------------------------------------
// Helpers to build the three payload arrays from clean rows
// ---------------------------------------------------------------------------

function buildPlayersPayload(cleanRows: CleanAppearance[]) {
  const seen = new Set<string>();
  const players: Array<{ name: string; age_group: string }> = [];
  for (const row of cleanRows) {
    const key = `${row.player_name}||${row.age_group}`;
    if (!seen.has(key)) {
      seen.add(key);
      players.push({ name: row.player_name, age_group: row.age_group });
    }
  }
  return players;
}

function buildMatchesPayload(cleanRows: CleanAppearance[]) {
  const seen = new Set<string>();
  const matches: Array<{
    id: string;
    match_date: string;
    competition: string;
    age_group: string;
    home_team: string;
    away_team: string;
  }> = [];
  for (const row of cleanRows) {
    if (!seen.has(row.match_id)) {
      seen.add(row.match_id);
      matches.push({
        id: row.match_id,
        match_date: row.match_date,
        competition: row.competition,
        age_group: row.age_group,
        home_team: row.home_team,
        away_team: row.away_team,
      });
    }
  }
  return matches;
}

function buildAppearancesPayload(cleanRows: CleanAppearance[]) {
  // Include player_name + age_group as join keys for the PG function.
  // These fields are NOT stored in the appearances table — they are used
  // inside ingest_batch() to resolve player_id via JOIN players.
  return cleanRows.map((row) => ({
    // Join keys (used inside PG function, not stored)
    player_name: row.player_name,
    age_group: row.age_group,

    // Stored fields
    match_id: row.match_id,
    position: row.position,
    team: row.team,
    opponent: row.opponent,
    venue: row.venue,
    goals_for: row.goals_for,
    goals_against: row.goals_against,
    minutes_played: row.minutes_played,
    touches: row.touches,
    passes_attempted: row.passes_attempted,
    passes_completed: row.passes_completed,
    progressive_passes: row.progressive_passes,
    crosses: row.crosses,
    dribbles_attempted: row.dribbles_attempted,
    dribbles_completed: row.dribbles_completed,
    shots: row.shots,
    shots_on_target: row.shots_on_target,
    goals: row.goals,
    assists: row.assists,
    possession_lost: row.possession_lost,
    duels_won: row.duels_won,
    duels_lost: row.duels_lost,
    aerial_duels_won: row.aerial_duels_won,
    aerial_duels_lost: row.aerial_duels_lost,
    tackles: row.tackles,
    interceptions: row.interceptions,
    recoveries: row.recoveries,
    clearances: row.clearances,
    fouls_committed: row.fouls_committed,
    fouls_won: row.fouls_won,
    yellow_cards: row.yellow_cards,
    red_cards: row.red_cards,
  }));
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  // ---- A. Parse multipart/form-data ----
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json(
      { success: false, error: 'Request must be multipart/form-data with a "file" field.' },
      { status: 400 },
    );
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return Response.json(
      { success: false, error: 'No file provided. Upload a CSV with field name "file".' },
      { status: 400 },
    );
  }

  // Basic type check — the CSV file may come with various MIME types across OS/browser combos
  const isLikelyCsv =
    file.name.toLowerCase().endsWith('.csv') ||
    file.type.includes('csv') ||
    file.type.includes('text/plain') ||
    file.type === 'application/octet-stream';

  if (!isLikelyCsv) {
    return Response.json(
      { success: false, error: `File must be a CSV. Received MIME type: "${file.type}".` },
      { status: 400 },
    );
  }

  // ---- B. Read file content ----
  let csvText: string;
  try {
    csvText = await file.text();
  } catch {
    return Response.json(
      { success: false, error: 'Could not read the uploaded file.' },
      { status: 400 },
    );
  }

  if (!csvText.trim()) {
    return Response.json({ success: false, error: 'The uploaded file is empty.' }, { status: 400 });
  }

  // ---- C. Run Phase 1 pipeline ----
  let pipelineResult;
  try {
    pipelineResult = cleanCsv(csvText);
  } catch (e) {
    return Response.json(
      {
        success: false,
        error: `CSV structure error: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 400 },
    );
  }

  const errors = pipelineResult.issues.filter((i) => i.severity === 'error');
  const warnings = pipelineResult.issues.filter((i) => i.severity === 'warning');

  // ---- D. Reject if fatal validation errors ----
  if (errors.length > 0) {
    return Response.json(
      {
        success: false,
        error: 'Validation failed: CSV contains errors that prevent safe ingestion.',
        summary: {
          sourceRows: pipelineResult.totalInputRows,
          cleanRows: pipelineResult.cleanRows.length,
          duplicatesRemoved: pipelineResult.duplicatesRemoved,
          errors: errors.slice(0, 30),
          warnings: warnings.slice(0, 30),
        },
      },
      { status: 400 },
    );
  }

  if (pipelineResult.cleanRows.length === 0) {
    return Response.json(
      { success: false, error: 'No valid rows found after cleaning the CSV.' },
      { status: 400 },
    );
  }

  // ---- E. Build payloads ----
  const cleanRows = pipelineResult.cleanRows;
  const players = buildPlayersPayload(cleanRows);
  const matches = buildMatchesPayload(cleanRows);
  const appearances = buildAppearancesPayload(cleanRows);

  // ---- F. Atomic upsert via ingest_batch() RPC ----
  const supabase = serviceRoleClient();

  let dbResult: IngestBatchResult;
  try {
    const { data, error: dbError } = await supabase.rpc('ingest_batch', {
      p_players: players,
      p_matches: matches,
      p_appearances: appearances,
    });

    if (dbError) {
      console.error('[ingest] Supabase RPC error:', dbError);
      return Response.json(
        {
          success: false,
          error: 'Database ingestion failed.',
          // Surface the message but not full internal details
          detail: dbError.message,
        },
        { status: 500 },
      );
    }

    dbResult = data as IngestBatchResult;
  } catch (e) {
    console.error('[ingest] Unexpected DB error:', e);
    return Response.json(
      { success: false, error: 'An unexpected database error occurred.' },
      { status: 500 },
    );
  }

  // ---- G. Return success summary ----
  return Response.json({
    success: true,
    summary: {
      sourceRows: pipelineResult.totalInputRows,
      cleanRows: cleanRows.length,
      duplicatesRemoved: pipelineResult.duplicatesRemoved,
      uniquePlayers: players.length,
      uniqueMatches: matches.length,
      // Counts returned by the Postgres function:
      playersInserted: dbResult.players_inserted,   // new rows only (DO NOTHING on conflict)
      matchesUpserted: dbResult.matches_upserted,   // inserts + updates
      appearancesUpserted: dbResult.appearances_upserted, // inserts + updates
    },
    warnings: warnings.map((w) => ({
      rowIndex: w.rowIndex,
      matchId: w.matchId,
      playerName: w.playerName,
      field: w.field,
      message: w.message,
    })),
  });
}
