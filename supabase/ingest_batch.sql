-- =============================================================================
-- ingest_batch — Atomic ingestion function for Phase 2
--
-- Wraps all three upserts (players, matches, appearances) in a single
-- PL/pgSQL function so they commit or roll back as one unit.
--
-- Run this in the Supabase SQL editor BEFORE using POST /api/ingest.
-- =============================================================================

CREATE OR REPLACE FUNCTION ingest_batch(
  p_players     jsonb,
  p_matches     jsonb,
  p_appearances jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_players_inserted     int;
  v_matches_upserted     int;
  v_appearances_upserted int;
  v_expected_appearances int;
BEGIN

  -- -------------------------------------------------------------------------
  -- Step 1: Upsert players
  -- DO NOTHING on conflict: existing player identity is never clobbered.
  -- Players are identified by (name, age_group) per Phase 1 schema.
  -- -------------------------------------------------------------------------
  INSERT INTO players (name, age_group)
  SELECT
    elem->>'name',
    elem->>'age_group'
  FROM jsonb_array_elements(p_players) AS elem
  ON CONFLICT (name, age_group) DO NOTHING;

  GET DIAGNOSTICS v_players_inserted = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- Step 2: Upsert matches
  -- match_id (text) is the natural primary key from the CSV.
  -- DO UPDATE unconditionally refreshes all fields so re-uploads are safe.
  -- -------------------------------------------------------------------------
  INSERT INTO matches (id, match_date, competition, age_group, home_team, away_team)
  SELECT
    elem->>'id',
    (elem->>'match_date')::date,
    elem->>'competition',
    elem->>'age_group',
    elem->>'home_team',
    elem->>'away_team'
  FROM jsonb_array_elements(p_matches) AS elem
  ON CONFLICT (id) DO UPDATE SET
    match_date  = EXCLUDED.match_date,
    competition = EXCLUDED.competition,
    age_group   = EXCLUDED.age_group,
    home_team   = EXCLUDED.home_team,
    away_team   = EXCLUDED.away_team;

  GET DIAGNOSTICS v_matches_upserted = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- Step 3: Upsert appearances
  -- player_id is resolved here by joining to the just-upserted players table
  -- on (player_name, age_group) — these fields are carried inside p_appearances
  -- as join keys but are NOT stored in the appearances table itself.
  --
  -- NULL handling: jsonb ->> returns SQL NULL for JSON null values.
  -- Casting NULL::int yields NULL — exactly what we want (null ≠ zero).
  -- NULLIF(..., '') guards against empty strings for text fields.
  -- -------------------------------------------------------------------------
  INSERT INTO appearances (
    player_id,          match_id,
    position,           team,               opponent,           venue,
    goals_for,          goals_against,
    minutes_played,     touches,
    passes_attempted,   passes_completed,   progressive_passes,
    crosses,            dribbles_attempted, dribbles_completed,
    shots,              shots_on_target,    goals,
    assists,            possession_lost,
    duels_won,          duels_lost,
    aerial_duels_won,   aerial_duels_lost,
    tackles,            interceptions,      recoveries,
    clearances,         fouls_committed,    fouls_won,
    yellow_cards,       red_cards
  )
  SELECT
    pl.id,
    elem->>'match_id',
    NULLIF(elem->>'position',  ''),
    elem->>'team',
    elem->>'opponent',
    NULLIF(elem->>'venue', ''),
    (elem->>'goals_for')::int,
    (elem->>'goals_against')::int,
    (elem->>'minutes_played')::int,
    (elem->>'touches')::int,
    (elem->>'passes_attempted')::int,
    (elem->>'passes_completed')::int,
    (elem->>'progressive_passes')::int,
    (elem->>'crosses')::int,
    (elem->>'dribbles_attempted')::int,
    (elem->>'dribbles_completed')::int,
    (elem->>'shots')::int,
    (elem->>'shots_on_target')::int,
    (elem->>'goals')::int,
    (elem->>'assists')::int,
    (elem->>'possession_lost')::int,
    (elem->>'duels_won')::int,
    (elem->>'duels_lost')::int,
    (elem->>'aerial_duels_won')::int,
    (elem->>'aerial_duels_lost')::int,
    (elem->>'tackles')::int,
    (elem->>'interceptions')::int,
    (elem->>'recoveries')::int,
    (elem->>'clearances')::int,
    (elem->>'fouls_committed')::int,
    (elem->>'fouls_won')::int,
    (elem->>'yellow_cards')::int,
    (elem->>'red_cards')::int
  FROM jsonb_array_elements(p_appearances) AS elem
  -- Resolve player_id from the name+age_group join keys
  JOIN players pl
    ON  pl.name      = elem->>'player_name'
    AND pl.age_group = elem->>'age_group'
  ON CONFLICT (match_id, player_id) DO UPDATE SET
    position           = EXCLUDED.position,
    team               = EXCLUDED.team,
    opponent           = EXCLUDED.opponent,
    venue              = EXCLUDED.venue,
    goals_for          = EXCLUDED.goals_for,
    goals_against      = EXCLUDED.goals_against,
    minutes_played     = EXCLUDED.minutes_played,
    touches            = EXCLUDED.touches,
    passes_attempted   = EXCLUDED.passes_attempted,
    passes_completed   = EXCLUDED.passes_completed,
    progressive_passes = EXCLUDED.progressive_passes,
    crosses            = EXCLUDED.crosses,
    dribbles_attempted = EXCLUDED.dribbles_attempted,
    dribbles_completed = EXCLUDED.dribbles_completed,
    shots              = EXCLUDED.shots,
    shots_on_target    = EXCLUDED.shots_on_target,
    goals              = EXCLUDED.goals,
    assists            = EXCLUDED.assists,
    possession_lost    = EXCLUDED.possession_lost,
    duels_won          = EXCLUDED.duels_won,
    duels_lost         = EXCLUDED.duels_lost,
    aerial_duels_won   = EXCLUDED.aerial_duels_won,
    aerial_duels_lost  = EXCLUDED.aerial_duels_lost,
    tackles            = EXCLUDED.tackles,
    interceptions      = EXCLUDED.interceptions,
    recoveries         = EXCLUDED.recoveries,
    clearances         = EXCLUDED.clearances,
    fouls_committed    = EXCLUDED.fouls_committed,
    fouls_won          = EXCLUDED.fouls_won,
    yellow_cards       = EXCLUDED.yellow_cards,
    red_cards          = EXCLUDED.red_cards;

  GET DIAGNOSTICS v_appearances_upserted = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- Guard: every appearance row must resolve to a player.
  -- If the JOIN silently dropped rows, raise an exception and roll back.
  -- -------------------------------------------------------------------------
  v_expected_appearances := jsonb_array_length(p_appearances);
  IF v_appearances_upserted < v_expected_appearances THEN
    RAISE EXCEPTION
      'Appearance resolution mismatch: expected % rows, wrote %. '
      'Some player names in the appearances batch could not be resolved '
      'to a player record. This is a pipeline bug — rolling back.',
      v_expected_appearances,
      v_appearances_upserted;
  END IF;

  -- -------------------------------------------------------------------------
  -- Return counts for the API summary response
  -- -------------------------------------------------------------------------
  RETURN jsonb_build_object(
    'players_inserted',     v_players_inserted,
    'matches_upserted',     v_matches_upserted,
    'appearances_upserted', v_appearances_upserted
  );

END;
$$;

-- Grant execution rights to the roles Supabase uses
GRANT EXECUTE ON FUNCTION ingest_batch(jsonb, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION ingest_batch(jsonb, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION ingest_batch(jsonb, jsonb, jsonb) TO anon;
