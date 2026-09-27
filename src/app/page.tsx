'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { browserClient } from '@/lib/supabase';
import { getPositionGroup, ALL_POSITION_GROUPS, type PositionGroup } from '@/lib/positionGroup';

// ─── Types ──────────────────────────────────────────────────────────────────
interface PlayerRow {
  id: string;
  name: string;
  age_group: string;
  /** Modal (most common) position from appearances — derived client-side */
  position_group: PositionGroup | null;
  percentile: number | null;
  overall_score: number | null;
  matches_played: number | null;
}

type SortField = 'percentile' | 'name' | 'matches_played';
type SortDir = 'asc' | 'desc';

// ─── Helpers ────────────────────────────────────────────────────────────────

function percentileClass(pct: number): string {
  if (pct >= 90) return 'percentile-elite';
  if (pct >= 70) return 'percentile-high';
  if (pct >= 40) return 'percentile-mid';
  return 'percentile-low';
}

function percentileLabel(pct: number | null): string {
  if (pct === null) return 'Not rated';
  return `${pct.toFixed(1)}`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function PlayersListPage() {
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Controls
  const [search, setSearch] = useState('');
  const [ageFilter, setAgeFilter] = useState<'All' | 'U15' | 'U17'>('All');
  const [posFilter, setPosFilter] = useState<'All' | PositionGroup>('All');
  const [sortField, setSortField] = useState<SortField>('percentile');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // ── Fetch players + ratings in ONE batched call ───────────────────────────
  useEffect(() => {
    async function fetchData() {
      const supabase = browserClient();

      // Fetch all players with their ratings (single query via FK join)
      const { data: playerData, error: playerErr } = await supabase
        .from('players')
        .select('id, name, age_group, player_ratings(overall_score, percentile, matches_played)');

      if (playerErr) {
        setError(`Failed to load players: ${playerErr.message}`);
        setLoading(false);
        return;
      }

      // Fetch all appearances in a single batched call to derive position_group
      const { data: appearances, error: appErr } = await supabase
        .from('appearances')
        .select('player_id, position');

      if (appErr) {
        setError(`Failed to load appearances: ${appErr.message}`);
        setLoading(false);
        return;
      }

      // Build position_group map: player_id → modal position group
      // (same logic as ratingOrchestrator.ts — modal of non-null position groups)
      const posMap = new Map<string, Map<PositionGroup, number>>();
      for (const app of appearances ?? []) {
        const group = getPositionGroup(app.position);
        if (!group) continue;
        if (!posMap.has(app.player_id)) posMap.set(app.player_id, new Map());
        const counts = posMap.get(app.player_id)!;
        counts.set(group, (counts.get(group) ?? 0) + 1);
      }

      const resolvePositionGroup = (pid: string): PositionGroup | null => {
        const counts = posMap.get(pid);
        if (!counts || counts.size === 0) return null;
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      };

      // Merge into PlayerRow[]
      const rows: PlayerRow[] = (playerData ?? []).map((p: any) => {
        // player_ratings is an array (1:many FK) — take first element
        const rating = Array.isArray(p.player_ratings)
          ? p.player_ratings[0]
          : p.player_ratings;
        return {
          id: p.id,
          name: p.name,
          age_group: p.age_group,
          position_group: resolvePositionGroup(p.id),
          percentile: rating?.percentile ?? null,
          overall_score: rating?.overall_score ?? null,
          matches_played: rating?.matches_played ?? null,
        };
      });

      setPlayers(rows);
      setLoading(false);
    }

    fetchData();
  }, []);

  // ── Sort handler ──────────────────────────────────────────────────────────
  const handleSort = useCallback(
    (field: SortField) => {
      if (field === sortField) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortField(field);
        setSortDir(field === 'name' ? 'asc' : 'desc');
      }
    },
    [sortField],
  );

  // ── Filtered + sorted list ────────────────────────────────────────────────
  const filteredPlayers = useMemo(() => {
    let list = players;

    // Search — case-insensitive substring match on name
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }

    // Age group filter
    if (ageFilter !== 'All') {
      list = list.filter((p) => p.age_group === ageFilter);
    }

    // Position group filter
    if (posFilter !== 'All') {
      list = list.filter((p) => p.position_group === posFilter);
    }

    // Sort — with the key rule:
    // Unrated players (percentile = null) ALWAYS sort to the BOTTOM
    // regardless of sort direction or column. A null percentile is
    // neither "lower" nor "higher" than a number — it represents
    // insufficient data, not a rank of zero.
    list = [...list].sort((a, b) => {
      // Unrated players always go to the bottom
      const aUnrated = a.percentile === null;
      const bUnrated = b.percentile === null;
      if (aUnrated && !bUnrated) return 1;
      if (!aUnrated && bUnrated) return -1;
      if (aUnrated && bUnrated) {
        // Both unrated — secondary sort by name ascending
        return a.name.localeCompare(b.name);
      }

      let cmp = 0;
      switch (sortField) {
        case 'percentile':
          cmp = (a.percentile ?? 0) - (b.percentile ?? 0);
          break;
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'matches_played':
          cmp = (a.matches_played ?? 0) - (b.matches_played ?? 0);
          break;
      }

      return sortDir === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [players, search, ageFilter, posFilter, sortField, sortDir]);

  // ── Sort indicator ────────────────────────────────────────────────────────
  const sortIcon = (field: SortField) => {
    if (sortField !== field) return '↕';
    return sortDir === 'asc' ? '↑' : '↓';
  };

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-muted text-sm">Loading players…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="glass-card p-6 max-w-md text-center">
          <p className="text-danger font-medium mb-2">Error</p>
          <p className="text-muted text-sm">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 max-w-6xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-10">
      {/* ── Header ──────────────────────────────────────────── */}
      <header className="mb-8 animate-fade-in">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-1">
          Player Ratings
        </h1>
        <p className="text-muted text-sm sm:text-base">
          Youth football analytics · {players.length} players across U15 & U17
        </p>
      </header>

      {/* ── Controls ────────────────────────────────────────── */}
      <div
        className="flex flex-col gap-3 mb-6 animate-fade-in"
        style={{ animationDelay: '0.05s' }}
      >
        {/* Search */}
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            id="search-players"
            type="text"
            className="search-input"
            placeholder="Search players by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap gap-2">
          {/* Age group */}
          <div className="flex gap-1.5">
            {(['All', 'U15', 'U17'] as const).map((ag) => (
              <button
                key={ag}
                id={`filter-age-${ag.toLowerCase()}`}
                className={`filter-btn ${ageFilter === ag ? 'active' : ''}`}
                onClick={() => setAgeFilter(ag)}
              >
                {ag}
              </button>
            ))}
          </div>

          <div className="w-px bg-border-subtle mx-1 hidden sm:block" />

          {/* Position group */}
          <div className="flex gap-1.5 flex-wrap">
            {(['All', ...ALL_POSITION_GROUPS] as const).map((pg) => (
              <button
                key={pg}
                id={`filter-pos-${pg.toLowerCase()}`}
                className={`filter-btn ${posFilter === pg ? 'active' : ''}`}
                onClick={() => setPosFilter(pg as any)}
              >
                {pg}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Results count ───────────────────────────────────── */}
      <p className="text-xs text-muted mb-3">
        Showing {filteredPlayers.length} of {players.length} players
      </p>

      {/* ── Table ───────────────────────────────────────────── */}
      <div
        className="glass-card overflow-hidden animate-fade-in"
        style={{ animationDelay: '0.1s' }}
      >
        <div className="table-scroll">
          <table className="data-table" id="players-table">
            <thead>
              <tr>
                <th className="w-8 text-center">#</th>
                <th
                  className={`sort-header ${sortField === 'name' ? 'active' : ''}`}
                  onClick={() => handleSort('name')}
                >
                  Player {sortIcon('name')}
                </th>
                <th>Age</th>
                <th className="hidden sm:table-cell">Position</th>
                <th
                  className={`sort-header text-right ${sortField === 'percentile' ? 'active' : ''}`}
                  onClick={() => handleSort('percentile')}
                >
                  Percentile {sortIcon('percentile')}
                </th>
                <th
                  className={`sort-header text-right ${sortField === 'matches_played' ? 'active' : ''}`}
                  onClick={() => handleSort('matches_played')}
                >
                  Appearances {sortIcon('matches_played')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredPlayers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-muted">
                    No players match your filters.
                  </td>
                </tr>
              ) : (
                filteredPlayers.map((p, i) => (
                  <tr key={p.id}>
                    <td className="text-center text-muted text-xs font-mono">
                      {i + 1}
                    </td>
                    <td>
                      <Link
                        href={`/players/${p.id}`}
                        className="font-medium hover:text-accent-hover transition-colors"
                      >
                        {p.name}
                      </Link>
                      {/* Show position on mobile where the column is hidden */}
                      {p.position_group && (
                        <span className="sm:hidden ml-2 badge badge-position text-[0.65rem]">
                          {p.position_group}
                        </span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge ${p.age_group === 'U15' ? 'badge-u15' : 'badge-u17'}`}
                      >
                        {p.age_group}
                      </span>
                    </td>
                    <td className="hidden sm:table-cell">
                      {p.position_group ? (
                        <span className="badge badge-position">
                          {p.position_group}
                        </span>
                      ) : (
                        <span className="text-muted text-xs">—</span>
                      )}
                    </td>
                    <td className="text-center font-mono">
                      {p.percentile !== null ? (
                        <span className={percentileClass(p.percentile)}>
                          {percentileLabel(p.percentile)}
                          <span className="text-xs text-muted ml-0.5">th</span>
                        </span>
                      ) : (
                        <span className="badge badge-not-rated text-[0.65rem]">
                          Not rated
                        </span>
                      )}
                    </td>
                    <td className="text-center font-mono text-muted">
                      {p.matches_played ?? 0}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
