'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { browserClient } from '@/lib/supabase';
import { getPositionGroup, type PositionGroup } from '@/lib/positionGroup';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PlayerInfo {
  id: string;
  name: string;
  age_group: string;
}

interface PlayerRating {
  overall_score: number | null;
  percentile: number | null;
  matches_played: number | null;
}

interface AppearanceRow {
  id: string;
  match_id: string;
  position: string | null;
  team: string | null;
  opponent: string | null;
  venue: string | null;
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
  possession_lost: number | null;
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
  matches: {
    match_date: string;
    competition: string;
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function percentileClass(pct: number): string {
  if (pct >= 90) return 'percentile-elite';
  if (pct >= 70) return 'percentile-high';
  if (pct >= 40) return 'percentile-mid';
  return 'percentile-low';
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

/** Check if an appearance is ineligible for rating (minutes null or 0) */
function isIneligible(app: AppearanceRow): boolean {
  return app.minutes_played === null || app.minutes_played === 0;
}

/**
 * Derive why a player is unrated:
 *  - every appearance has position IS NULL / unknown → "No valid position recorded for this player."
 *  - every appearance has minutes_played IS NULL or = 0 → "No appearances met the minimum playing time threshold."
 */
function deriveUnratedReason(appearances: AppearanceRow[]): string {
  if (appearances.length === 0) {
    return 'No appearances recorded for this player.';
  }
  const hasAnyValidPosition = appearances.some((a) => getPositionGroup(a.position) !== null);
  if (!hasAnyValidPosition) {
    return 'No valid position recorded for this player.';
  }
  const allIneligible = appearances.every(
    (a) => a.minutes_played === null || a.minutes_played === 0,
  );
  if (allIneligible) {
    return 'No appearances met the minimum playing time threshold.';
  }
  return 'Insufficient data to compute a rating.';
}

/**
 * Determine the modal position group for a player from their appearances.
 * Reuses the same logic as ratingOrchestrator.ts.
 */
function resolvePositionGroup(appearances: AppearanceRow[]): PositionGroup | null {
  const counts = new Map<PositionGroup, number>();
  for (const app of appearances) {
    const group = getPositionGroup(app.position);
    if (group) counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Headline stats per position group.
 * Shows the 3-4 most meaningful metrics for that position
 * beyond the common date/opponent/venue/minutes/goals/assists columns.
 */
function getHeadlineStatKeys(posGroup: PositionGroup | null): { key: keyof AppearanceRow; label: string }[] {
  switch (posGroup) {
    case 'GK':
      return [
        { key: 'recoveries', label: 'Rec' },
        { key: 'clearances', label: 'Clr' },
        { key: 'passes_completed', label: 'Pass' },
      ];
    case 'Defender':
      return [
        { key: 'tackles', label: 'Tkl' },
        { key: 'interceptions', label: 'Int' },
        { key: 'clearances', label: 'Clr' },
      ];
    case 'Midfielder':
      return [
        { key: 'progressive_passes', label: 'Prog' },
        { key: 'passes_completed', label: 'Pass' },
        { key: 'duels_won', label: 'Duels' },
      ];
    case 'Attacker':
      return [
        { key: 'shots_on_target', label: 'SoT' },
        { key: 'dribbles_completed', label: 'Drib' },
        { key: 'duels_won', label: 'Duels' },
      ];
    default:
      return [
        { key: 'tackles', label: 'Tkl' },
        { key: 'passes_completed', label: 'Pass' },
      ];
  }
}

/** Full raw stats in display order for the expanded view */
const FULL_STAT_LABELS: { key: keyof AppearanceRow; label: string }[] = [
  { key: 'touches', label: 'Touches' },
  { key: 'passes_attempted', label: 'Passes Att.' },
  { key: 'passes_completed', label: 'Passes Comp.' },
  { key: 'progressive_passes', label: 'Progressive Passes' },
  { key: 'crosses', label: 'Crosses' },
  { key: 'dribbles_attempted', label: 'Dribbles Att.' },
  { key: 'dribbles_completed', label: 'Dribbles Comp.' },
  { key: 'shots', label: 'Shots' },
  { key: 'shots_on_target', label: 'Shots on Target' },
  { key: 'goals', label: 'Goals' },
  { key: 'assists', label: 'Assists' },
  { key: 'duels_won', label: 'Duels Won' },
  { key: 'duels_lost', label: 'Duels Lost' },
  { key: 'aerial_duels_won', label: 'Aerial Duels Won' },
  { key: 'aerial_duels_lost', label: 'Aerial Duels Lost' },
  { key: 'tackles', label: 'Tackles' },
  { key: 'interceptions', label: 'Interceptions' },
  { key: 'recoveries', label: 'Recoveries' },
  { key: 'clearances', label: 'Clearances' },
  { key: 'fouls_committed', label: 'Fouls Committed' },
  { key: 'fouls_won', label: 'Fouls Won' },
  { key: 'yellow_cards', label: 'Yellow Cards' },
  { key: 'red_cards', label: 'Red Cards' },
  { key: 'possession_lost', label: 'Possession Lost' },
];

// ─── Component ──────────────────────────────────────────────────────────────

export default function PlayerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [player, setPlayer] = useState<PlayerInfo | null>(null);
  const [rating, setRating] = useState<PlayerRating | null>(null);
  const [appearances, setAppearances] = useState<AppearanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  useEffect(() => {
    async function fetchData() {
      const supabase = browserClient();

      // 1. Fetch player
      const { data: playerData, error: playerErr } = await supabase
        .from('players')
        .select('id, name, age_group')
        .eq('id', id)
        .single();

      if (playerErr || !playerData) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setPlayer(playerData);

      // 2. Fetch rating
      const { data: ratingData } = await supabase
        .from('player_ratings')
        .select('overall_score, percentile, matches_played')
        .eq('player_id', id)
        .single();

      setRating(ratingData ?? { overall_score: null, percentile: null, matches_played: null });

      // 3. Fetch appearances joined with matches for match_date and competition
      const { data: appData } = await supabase
        .from('appearances')
        .select(`
          id, match_id, position, team, opponent, venue,
          goals_for, goals_against, minutes_played,
          touches, passes_attempted, passes_completed, progressive_passes,
          crosses, dribbles_attempted, dribbles_completed,
          shots, shots_on_target, goals, assists, possession_lost,
          duels_won, duels_lost, aerial_duels_won, aerial_duels_lost,
          tackles, interceptions, recoveries, clearances,
          fouls_committed, fouls_won, yellow_cards, red_cards,
          matches!inner(match_date, competition)
        `)
        .eq('player_id', id)
        .order('match_id');

      // Sort by match_date (from the joined matches table)
      const sorted = (appData as unknown as AppearanceRow[] ?? []).sort((a, b) => {
        const dateA = a.matches?.match_date ?? '';
        const dateB = b.matches?.match_date ?? '';
        return dateA.localeCompare(dateB);
      });

      setAppearances(sorted);
      setLoading(false);
    }

    fetchData();
  }, [id]);

  const toggleRow = (appId: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(appId)) next.delete(appId);
      else next.add(appId);
      return next;
    });
  };

  // Derived values
  const posGroup = resolvePositionGroup(appearances);
  const headlineStats = getHeadlineStatKeys(posGroup);
  const isUnrated = rating?.overall_score === null;
  const unratedReason = isUnrated ? deriveUnratedReason(appearances) : null;

  // ── Loading ──
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-muted text-sm">Loading player…</p>
        </div>
      </div>
    );
  }

  // ── Not found ──
  if (notFound || !player) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="glass-card p-8 max-w-md text-center">
          <p className="text-xl font-bold mb-2">Player not found</p>
          <p className="text-muted text-sm mb-6">
            The player you&apos;re looking for doesn&apos;t exist.
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors text-sm font-medium"
          >
            ← Back to all players
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 max-w-6xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-10">
      {/* ── Back link ───────────────────────────────────────── */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-muted hover:text-foreground transition-colors text-sm mb-6"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 19l-7-7 7-7"
          />
        </svg>
        All players
      </Link>

      {/* ── Header Card ─────────────────────────────────────── */}
      <div className="glass-card p-6 sm:p-8 mb-6 animate-fade-in">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
              {player.name}
            </h1>
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`badge ${player.age_group === 'U15' ? 'badge-u15' : 'badge-u17'}`}
              >
                {player.age_group}
              </span>
              {posGroup && (
                <span className="badge badge-position">{posGroup}</span>
              )}
              {!posGroup && (
                <span className="text-xs text-muted">No position</span>
              )}
            </div>
          </div>

          {/* Rating display */}
          <div className="flex gap-4 sm:gap-6">
            {isUnrated ? (
              <div className="text-center sm:text-right">
                <span className="badge badge-not-rated text-sm px-4 py-1.5">
                  Not Rated
                </span>
              </div>
            ) : (
              <>
                <div className="stat-card text-center min-w-[80px]">
                  <div className="stat-label">Percentile</div>
                  <div
                    className={`stat-value ${percentileClass(rating?.percentile ?? 0)}`}
                  >
                    {rating?.percentile?.toFixed(1)}
                    <span className="text-sm text-muted font-normal ml-0.5">
                      th
                    </span>
                  </div>
                </div>
                <div className="stat-card text-center min-w-[80px]">
                  <div className="stat-label">Score</div>
                  <div className="stat-value text-foreground">
                    {rating?.overall_score?.toFixed(2)}
                  </div>
                </div>
                <div className="stat-card text-center min-w-[80px]">
                  <div className="stat-label">Apps</div>
                  <div className="stat-value text-foreground">
                    {rating?.matches_played ?? 0}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Unrated reason */}
        {isUnrated && unratedReason && (
          <div className="mt-4 p-3 bg-danger/5 border border-danger/15 rounded-lg">
            <p className="text-sm text-danger/80">
              <span className="font-medium">Why not rated:</span>{' '}
              {unratedReason}
            </p>
          </div>
        )}
      </div>

      {/* ── Match History ───────────────────────────────────── */}
      <div
        className="glass-card overflow-hidden animate-fade-in"
        style={{ animationDelay: '0.1s' }}
      >
        <div className="px-6 py-4 border-b border-border-subtle">
          <h2 className="text-lg font-semibold">Match History</h2>
          <p className="text-xs text-muted mt-0.5">
            {appearances.length} appearance{appearances.length !== 1 ? 's' : ''}
          </p>
        </div>

        {appearances.length === 0 ? (
          <div className="p-8 text-center text-muted text-sm">
            No appearances recorded.
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table" id="match-history-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Opponent</th>
                  <th className="hidden sm:table-cell">Venue</th>
                  <th className="text-right">Min</th>
                  <th className="text-right">Pos</th>
                  <th className="text-right">G</th>
                  <th className="text-right">A</th>
                  {headlineStats.map((s) => (
                    <th key={s.key} className="text-right hidden md:table-cell">
                      {s.label}
                    </th>
                  ))}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {appearances.map((app) => {
                  const ineligible = isIneligible(app);
                  const expanded = expandedRows.has(app.id);
                  return (
                    <AppearanceTableRow
                      key={app.id}
                      app={app}
                      ineligible={ineligible}
                      expanded={expanded}
                      headlineStats={headlineStats}
                      onToggle={() => toggleRow(app.id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Appearance Row Sub-component ────────────────────────────────────────────

function AppearanceTableRow({
  app,
  ineligible,
  expanded,
  headlineStats,
  onToggle,
}: {
  app: AppearanceRow;
  ineligible: boolean;
  expanded: boolean;
  headlineStats: { key: keyof AppearanceRow; label: string }[];
  onToggle: () => void;
}) {
  const statVal = (key: keyof AppearanceRow) => {
    const v = app[key];
    return v !== null && v !== undefined ? String(v) : '—';
  };

  // Count all headline columns + the hidden ones for colSpan
  const totalCols = 7 + headlineStats.length + 1; // date, opp, venue, min, pos, G, A + headlines + expand btn

  return (
    <>
      <tr className={ineligible ? 'row-ineligible' : ''}>
        <td className="whitespace-nowrap text-sm">
          {formatDate(app.matches.match_date)}
        </td>
        <td className="font-medium text-sm">
          <span>{app.opponent ?? '—'}</span>
          {app.goals_for !== null && app.goals_against !== null && (
            <span className="text-muted text-xs ml-1.5">
              ({app.goals_for}–{app.goals_against})
            </span>
          )}
          {ineligible && (
            <span className="block text-[0.65rem] text-danger/70 mt-0.5">
              Not counted toward rating
            </span>
          )}
        </td>
        <td className="hidden sm:table-cell text-muted text-xs capitalize">
          {app.venue ?? '—'}
        </td>
        <td className="text-right font-mono text-sm">
          {app.minutes_played ?? '—'}
        </td>
        <td className="text-right text-xs text-muted">
          {app.position ?? '—'}
        </td>
        <td className="text-right font-mono text-sm">{statVal('goals')}</td>
        <td className="text-right font-mono text-sm">{statVal('assists')}</td>
        {headlineStats.map((s) => (
          <td
            key={s.key}
            className="text-right font-mono text-sm hidden md:table-cell"
          >
            {statVal(s.key)}
          </td>
        ))}
        <td className="text-center">
          <button
            onClick={onToggle}
            className="p-1 rounded hover:bg-surface-hover transition-colors text-muted hover:text-foreground"
            aria-label={expanded ? 'Hide full stats' : 'View full stats'}
            title={expanded ? 'Hide full stats' : 'View full stats'}
          >
            <svg
              className={`w-4 h-4 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        </td>
      </tr>

      {/* Expanded raw stats row */}
      {expanded && (
        <tr>
          <td colSpan={totalCols} className="!p-0">
            <div className="p-4 bg-background/50 animate-fade-in-scale">
              <p className="text-xs text-muted font-medium mb-3 uppercase tracking-wide">
                Full Match Stats — {app.match_id}
              </p>
              <div className="stats-grid">
                {FULL_STAT_LABELS.map((s) => {
                  const v = app[s.key];
                  return (
                    <div key={s.key} className="stat-chip">
                      <span className="stat-chip-label">{s.label}</span>
                      <span className="stat-chip-value">
                        {v !== null && v !== undefined ? String(v) : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
