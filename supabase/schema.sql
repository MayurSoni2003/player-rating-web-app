-- =============================================================================
-- Player Rating App — Supabase Schema (Phase 1)
-- Run this entire file in the Supabase SQL editor.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Drop tables in reverse-dependency order if re-running (safe for dev)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS player_ratings CASCADE;
DROP TABLE IF EXISTS appearances CASCADE;
DROP TABLE IF EXISTS matches CASCADE;
DROP TABLE IF EXISTS players CASCADE;

-- =============================================================================
-- TABLE: players
--
-- Purpose: Store player identity only.
-- Age group is scoped here because the source provides no unique player ID.
-- One name (Pablo Ruiz) appears in both U15 and U17. We cannot distinguish
-- "same player moved age groups" from "two different children share a name",
-- so we scope identity to (name, age_group) — the safer default.
-- Limitation documented in README.
-- =============================================================================
CREATE TABLE players (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  age_group  text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Identity constraint: a (name, age_group) pair maps to exactly one player record
  CONSTRAINT players_name_age_group_unique UNIQUE (name, age_group)
);

COMMENT ON TABLE players IS
  'Player identity. Scoped to (name, age_group) because source data has no unique player ID. '
  'See README for stated limitations.';

COMMENT ON COLUMN players.age_group IS
  'Age group this player identity belongs to: U15 or U17. '
  'A player name appearing in both groups is treated as two separate identities.';

-- =============================================================================
-- TABLE: matches
--
-- Purpose: One row per fixture. Match-level context only.
-- The match_id from the CSV (e.g. M-1503) is used as primary key.
-- =============================================================================
CREATE TABLE matches (
  id          text        PRIMARY KEY,           -- CSV match_id, e.g. "M-1503"
  match_date  date        NOT NULL,
  competition text        NOT NULL,
  age_group   text        NOT NULL,
  home_team   text        NOT NULL,
  away_team   text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT matches_age_group_check CHECK (age_group IN ('U15', 'U17'))
);

COMMENT ON TABLE matches IS 'One row per fixture. match_id from the CSV is the primary key.';

-- =============================================================================
-- TABLE: appearances
--
-- Purpose: One player in one match (mirrors the CSV row structure).
-- Intentionally lenient constraints — the cleaning layer handles anomalies
-- and surfaces them as warnings rather than letting the DB silently reject rows.
--
-- Notably: passes_completed > passes_attempted is NOT enforced here because
-- the source CSV contains such a row and we want the pipeline to report it
-- rather than the DB silently failing.
-- =============================================================================
CREATE TABLE appearances (
  id                   uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id            uuid    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id             text    NOT NULL REFERENCES matches(id) ON DELETE CASCADE,

  -- Appearance context
  position             text,                    -- nullable: some rows missing in source
  team                 text,
  opponent             text,
  venue                text,                    -- 'home' | 'away'

  -- Match result (from this player's team perspective)
  goals_for            integer,
  goals_against        integer,

  -- Performance metrics (all nullable — missing ≠ zero)
  minutes_played       integer,
  touches              integer,
  passes_attempted     integer,
  passes_completed     integer,
  progressive_passes   integer,
  crosses              integer,
  dribbles_attempted   integer,
  dribbles_completed   integer,
  shots                integer,
  shots_on_target      integer,
  goals                integer,
  assists              integer,
  possession_lost      integer,
  duels_won            integer,
  duels_lost           integer,
  aerial_duels_won     integer,
  aerial_duels_lost    integer,
  tackles              integer,
  interceptions        integer,
  recoveries           integer,
  clearances           integer,
  fouls_committed      integer,
  fouls_won            integer,
  yellow_cards         integer,
  red_cards            integer,

  -- Deduplication: one player can appear in a match at most once
  CONSTRAINT appearances_match_player_unique UNIQUE (match_id, player_id),

  -- Non-negative constraints for counts where negativity is always erroneous
  -- (not applied to passes_completed because passes_completed > passes_attempted
  --  is a known anomaly we want the pipeline to surface, not the DB to reject)
  CONSTRAINT appearances_minutes_non_negative   CHECK (minutes_played   IS NULL OR minutes_played   >= 0),
  CONSTRAINT appearances_touches_non_negative    CHECK (touches          IS NULL OR touches          >= 0),
  CONSTRAINT appearances_goals_non_negative      CHECK (goals            IS NULL OR goals            >= 0),
  CONSTRAINT appearances_assists_non_negative    CHECK (assists          IS NULL OR assists          >= 0),
  CONSTRAINT appearances_yellow_non_negative     CHECK (yellow_cards     IS NULL OR yellow_cards     >= 0),
  CONSTRAINT appearances_red_non_negative        CHECK (red_cards        IS NULL OR red_cards        >= 0),
  CONSTRAINT appearances_shots_non_negative      CHECK (shots            IS NULL OR shots            >= 0),
  CONSTRAINT appearances_tackles_non_negative    CHECK (tackles          IS NULL OR tackles          >= 0),
  CONSTRAINT appearances_interceptions_nn        CHECK (interceptions    IS NULL OR interceptions    >= 0),
  CONSTRAINT appearances_recoveries_nn           CHECK (recoveries       IS NULL OR recoveries       >= 0),
  CONSTRAINT appearances_clearances_nn           CHECK (clearances       IS NULL OR clearances       >= 0)
);

COMMENT ON TABLE appearances IS
  'One player in one match. Mirrors the CSV row. '
  'passes_completed > passes_attempted is not enforced here — see pipeline validation layer.';

COMMENT ON COLUMN appearances.minutes_played IS
  'Minutes on the pitch. Null = missing from source. 0 = player appeared but with zero recorded minutes (anomalous; see pipeline warnings).';

COMMENT ON COLUMN appearances.position IS
  'Position played in this appearance. Nullable because at least one row in the source is missing this field.';

-- =============================================================================
-- TABLE: player_ratings
--
-- Purpose: Derived/cache table populated by Phase 2 rating computation.
-- Created in Phase 1 but left empty until Phase 2.
--
-- PRIMARY KEY is (player_id, age_group) because a player identity can
-- theoretically exist in two age groups (though in practice our players table
-- scopes identity to age_group, making player_id already unique per age group —
-- the compound PK is kept for defensive correctness and forward compatibility).
-- =============================================================================
CREATE TABLE player_ratings (
  player_id      uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  age_group      text        NOT NULL,
  overall_score  numeric(8,4),                  -- raw weighted composite score
  percentile     numeric(6,3),                  -- 0.000–100.000 within age group
  matches_played integer,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (player_id, age_group)
);

COMMENT ON TABLE player_ratings IS
  'Derived cache table. Populated by Phase 2 rating computation. '
  'Empty after Phase 1. Re-computed on each CSV ingest.';

COMMENT ON COLUMN player_ratings.percentile IS
  'Percentile rank within the same age group. 100 = highest raw score in that age group.';

-- =============================================================================
-- INDEXES
-- =============================================================================

-- appearances: most queries filter or join on player_id and match_id
CREATE INDEX idx_appearances_player_id ON appearances (player_id);
CREATE INDEX idx_appearances_match_id  ON appearances (match_id);

-- matches: age_group and date are common filter dimensions
CREATE INDEX idx_matches_age_group  ON matches (age_group);
CREATE INDEX idx_matches_match_date ON matches (match_date);

-- player_ratings: leaderboard queries sort/filter by percentile and age_group
CREATE INDEX idx_player_ratings_percentile  ON player_ratings (percentile DESC);
CREATE INDEX idx_player_ratings_age_group   ON player_ratings (age_group);

-- =============================================================================
-- Row Level Security (RLS)
-- Phase 1: Public read access; writes require service role key.
-- Tighten in production as needed.
-- =============================================================================
ALTER TABLE players        ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches         ENABLE ROW LEVEL SECURITY;
ALTER TABLE appearances     ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_ratings  ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read (needed for the public-facing UI)
CREATE POLICY "Public read players"       ON players        FOR SELECT USING (true);
CREATE POLICY "Public read matches"       ON matches        FOR SELECT USING (true);
CREATE POLICY "Public read appearances"   ON appearances    FOR SELECT USING (true);
CREATE POLICY "Public read ratings"       ON player_ratings FOR SELECT USING (true);
