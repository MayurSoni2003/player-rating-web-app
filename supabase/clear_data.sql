-- =============================================================================
-- clear_all_data — Atomic data purge function for Phase 4B
--
-- Purges all data across appearances, player_ratings, matches, and players
-- in FK-safe reverse dependency order.
--
-- Run this in the Supabase SQL editor.
-- =============================================================================

CREATE OR REPLACE FUNCTION clear_all_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_appearances_deleted int;
  v_ratings_deleted     int;
  v_matches_deleted     int;
  v_players_deleted     int;
  v_appearances_rem     int;
  v_ratings_rem         int;
  v_matches_rem         int;
  v_players_rem         int;
BEGIN
  -- 1. appearances (references players and matches)
  DELETE FROM appearances;
  GET DIAGNOSTICS v_appearances_deleted = ROW_COUNT;

  -- 2. player_ratings (references players)
  DELETE FROM player_ratings;
  GET DIAGNOSTICS v_ratings_deleted = ROW_COUNT;

  -- 3. matches
  DELETE FROM matches;
  GET DIAGNOSTICS v_matches_deleted = ROW_COUNT;

  -- 4. players
  DELETE FROM players;
  GET DIAGNOSTICS v_players_deleted = ROW_COUNT;

  -- Count remaining rows to verify complete purge
  SELECT count(*) INTO v_appearances_rem FROM appearances;
  SELECT count(*) INTO v_ratings_rem FROM player_ratings;
  SELECT count(*) INTO v_matches_rem FROM matches;
  SELECT count(*) INTO v_players_rem FROM players;

  RETURN jsonb_build_object(
    'deleted', jsonb_build_object(
      'appearances', v_appearances_deleted,
      'player_ratings', v_ratings_deleted,
      'matches', v_matches_deleted,
      'players', v_players_deleted
    ),
    'remaining', jsonb_build_object(
      'appearances', v_appearances_rem,
      'player_ratings', v_ratings_rem,
      'matches', v_matches_rem,
      'players', v_players_rem
    )
  );
END;
$$;
