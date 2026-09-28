'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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

interface DatabaseCounts {
  players: number;
  matches: number;
  appearances: number;
}

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
  const router = useRouter();
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Controls
  const [search, setSearch] = useState('');
  const [ageFilter, setAgeFilter] = useState<'All' | 'U15' | 'U17'>('All');
  const [posFilter, setPosFilter] = useState<'All' | PositionGroup>('All');
  const [sortField, setSortField] = useState<SortField>('percentile');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Clear data modal state
  const [isClearModalOpen, setIsClearModalOpen] = useState(false);
  const [clearConfirmInput, setClearConfirmInput] = useState('');
  const [isClearing, setIsClearing] = useState(false);
  const [clearCounts, setClearCounts] = useState<DatabaseCounts | null>(null);
  const [clearCountsLoading, setClearCountsLoading] = useState(false);
  const [clearModalError, setClearModalError] = useState<string | null>(null);
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // ── Fetch players + ratings in ONE batched call ───────────────────────────
  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      const supabase = browserClient();

      // Fetch all players with their ratings (single query via FK join)
      const { data: playerData, error: playerErr } = await supabase
        .from('players')
        .select('id, name, age_group, player_ratings(overall_score, percentile, matches_played)');

      if (!isMounted) return;

      if (playerErr) {
        setError(`Failed to load players: ${playerErr.message}`);
        setLoading(false);
        return;
      }

      // Fetch all appearances in a single batched call to derive position_group
      const { data: appearances, error: appErr } = await supabase
        .from('appearances')
        .select('player_id, position');

      if (!isMounted) return;

      if (appErr) {
        setError(`Failed to load appearances: ${appErr.message}`);
        setLoading(false);
        return;
      }

      // Build position_group map: player_id → modal position group
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
      interface SupabasePlayerWithRatings {
        id: string;
        name: string;
        age_group: string;
        player_ratings:
          | { overall_score: number | null; percentile: number | null; matches_played: number | null }[]
          | { overall_score: number | null; percentile: number | null; matches_played: number | null }
          | null;
      }

      const rows: PlayerRow[] = ((playerData as unknown as SupabasePlayerWithRatings[]) ?? []).map((p) => {
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

      if (isMounted) {
        setPlayers(rows);
        setLoading(false);
      }
    }

    loadData();

    return () => {
      isMounted = false;
    };
  }, [reloadKey]);

  // ── Open Clear Modal & Fetch Fresh Counts ─────────────────────────────────
  const handleOpenClearModal = async () => {
    setIsClearModalOpen(true);
    setClearConfirmInput('');
    setClearModalError(null);
    setClearCountsLoading(true);

    try {
      const supabase = browserClient();
      const [
        { count: pCount },
        { count: mCount },
        { count: aCount },
      ] = await Promise.all([
        supabase.from('players').select('*', { count: 'exact', head: true }),
        supabase.from('matches').select('*', { count: 'exact', head: true }),
        supabase.from('appearances').select('*', { count: 'exact', head: true }),
      ]);

      setClearCounts({
        players: pCount ?? 0,
        matches: mCount ?? 0,
        appearances: aCount ?? 0,
      });
    } catch {
      setClearCounts({
        players: players.length,
        matches: 0,
        appearances: 0,
      });
    } finally {
      setClearCountsLoading(false);
    }
  };

  // ── Confirm Clear Data Action ─────────────────────────────────────────────
  const handleConfirmClear = async () => {
    if (clearConfirmInput !== 'DELETE' || isClearing) return;

    setIsClearing(true);
    setClearModalError(null);

    try {
      const res = await fetch('/api/clear-data', { method: 'POST' });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || data.detail || 'Failed to clear database.');
      }

      // Immediately reset local state without page refresh
      setPlayers([]);
      setIsClearModalOpen(false);
      setNotificationMessage('Database cleared — 0 players, 0 matches, 0 appearances remain.');
    } catch (err) {
      setClearModalError(err instanceof Error ? err.message : 'An error occurred while clearing data.');
    } finally {
      setIsClearing(false);
    }
  };

  // ── Escape key listener for modal ─────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isClearModalOpen && !isClearing) {
        setIsClearModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isClearModalOpen, isClearing]);

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

  // ── Filtered and sorted players ───────────────────────────────────────────
  const filteredPlayers = useMemo(() => {
    let list = players;

    // Search filter (name substring, case-insensitive)
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
          <p className="text-muted text-sm mb-4">{error}</p>
          <button
            onClick={() => {
              setLoading(true);
              setError(null);
              setReloadKey((k) => k + 1);
            }}
            className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent-hover transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 max-w-6xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-10">
      {/* ── Header ──────────────────────────────────────────── */}
      <header className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 animate-fade-in">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-1">
            Player Ratings
          </h1>
          <p className="text-muted text-sm sm:text-base">
            Youth football analytics · {players.length} players across U15 & U17
          </p>
        </div>

        {/* Action buttons: Upload CSV & Clear Data side by side */}
        <div className="flex items-center gap-2.5 self-start sm:self-auto flex-wrap">
          <Link
            href="/upload"
            id="upload-data-link"
            className="inline-flex items-center gap-2 px-4 py-2 bg-surface hover:bg-surface-hover border border-border rounded-xl text-sm font-medium transition-colors text-foreground hover:border-accent/40 shadow-sm"
          >
            <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Upload CSV
          </Link>

          <button
            type="button"
            id="clear-data-btn"
            onClick={handleOpenClearModal}
            className="inline-flex items-center gap-2 px-4 py-2 bg-danger/10 hover:bg-danger/20 border border-danger/30 text-danger rounded-xl text-sm font-medium transition-colors shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Clear Data
          </button>
        </div>
      </header>

      {/* ── Notification Banner (after clearing data or other actions) ── */}
      {notificationMessage && (
        <div className="mb-6 glass-card p-4 border border-success/30 bg-success/5 flex items-center justify-between gap-3 animate-fade-in">
          <div className="flex items-center gap-2.5">
            <svg className="w-5 h-5 text-success flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-medium text-foreground">{notificationMessage}</p>
          </div>
          <button
            onClick={() => setNotificationMessage(null)}
            className="text-muted hover:text-foreground text-xs px-2 py-1 rounded hover:bg-surface transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Empty State Handling (when database has 0 players) ── */}
      {players.length === 0 ? (
        <div className="glass-card p-10 sm:p-16 flex flex-col items-center justify-center text-center animate-fade-in">
          <div className="w-16 h-16 rounded-2xl bg-surface flex items-center justify-center mb-4 text-muted border border-border">
            <svg className="w-8 h-8 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <h2 className="text-xl font-bold mb-1">No player data yet</h2>
          <p className="text-muted text-sm max-w-sm mb-6">
            Upload a <code className="text-accent-hover text-xs bg-surface px-1.5 py-0.5 rounded">match_events.csv</code> file to populate players, matches, appearances, and compute rating percentiles.
          </p>
          <Link
            href="/upload"
            id="empty-state-upload-btn"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold shadow-lg shadow-accent/20 transition-all hover:shadow-accent/30"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Upload CSV to get started
          </Link>
        </div>
      ) : (
        <>
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
                    onClick={() => setPosFilter(pg)}
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
                    <th>Position</th>
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
                      <tr
                        key={p.id}
                        onClick={() => router.push(`/players/${p.id}`)}
                        className="cursor-pointer group hover:bg-surface-hover/80 transition-colors"
                      >
                        <td className="text-center text-muted text-xs font-mono">
                          {i + 1}
                        </td>
                        <td>
                          <span className="font-medium text-foreground group-hover:text-accent-hover transition-colors">
                            {p.name}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`badge ${p.age_group === 'U15' ? 'badge-u15' : 'badge-u17'}`}
                          >
                            {p.age_group}
                          </span>
                        </td>
                        <td>
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
        </>
      )}

      {/* ── Clear Data Confirmation Dialog / Modal ── */}
      {isClearModalOpen && (
        <div
          id="clear-data-modal-backdrop"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isClearing) {
              setIsClearModalOpen(false);
            }
          }}
        >
          <div
            id="clear-data-modal"
            className="glass-card p-6 sm:p-8 max-w-md w-full border border-danger/30 shadow-2xl animate-fade-in-scale"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-danger/15 flex items-center justify-center text-danger">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-bold text-foreground">Clear All Data</h3>
                <p className="text-xs text-danger font-medium">Destructive Action · Cannot be undone</p>
              </div>
            </div>

            {/* Modal Body: Actual Live Row Counts */}
            <div className="mb-5 text-sm text-muted leading-relaxed">
              {clearCountsLoading ? (
                <p className="italic text-xs">Querying current database counts…</p>
              ) : (
                <p>
                  This will permanently delete all{' '}
                  <strong className="text-foreground">{clearCounts?.players ?? players.length} players</strong>,{' '}
                  <strong className="text-foreground">{clearCounts?.matches ?? 0} matches</strong>, and{' '}
                  <strong className="text-foreground">{clearCounts?.appearances ?? 0} appearances</strong> currently in the database.
                </p>
              )}
            </div>

            {/* Type DELETE to confirm */}
            <div className="mb-5">
              <label htmlFor="clear-confirm-input" className="block text-xs font-semibold text-foreground/80 mb-2">
                Type <span className="font-mono text-danger font-bold">DELETE</span> to confirm:
              </label>
              <input
                id="clear-confirm-input"
                type="text"
                autoFocus
                disabled={isClearing}
                value={clearConfirmInput}
                onChange={(e) => setClearConfirmInput(e.target.value)}
                placeholder="Type DELETE"
                className="w-full px-3.5 py-2.5 rounded-xl bg-surface border border-border focus:border-danger focus:ring-1 focus:ring-danger text-sm font-mono text-foreground placeholder:text-muted/50 outline-none transition-all"
              />
            </div>

            {/* Error inside modal if clear fails */}
            {clearModalError && (
              <div className="mb-4 p-3 bg-danger/10 border border-danger/20 rounded-lg text-xs text-danger">
                {clearModalError}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                id="clear-cancel-btn"
                disabled={isClearing}
                onClick={() => setIsClearModalOpen(false)}
                className="px-4 py-2 text-sm font-medium rounded-xl border border-border hover:bg-surface-hover text-muted hover:text-foreground transition-colors disabled:opacity-50"
              >
                Cancel
              </button>

              <button
                type="button"
                id="clear-confirm-btn"
                disabled={clearConfirmInput !== 'DELETE' || isClearing}
                onClick={handleConfirmClear}
                className={`
                  px-4 py-2 text-sm font-semibold rounded-xl flex items-center gap-2 transition-all
                  ${clearConfirmInput === 'DELETE' && !isClearing
                    ? 'bg-danger hover:bg-danger/90 text-white shadow-lg shadow-danger/20'
                    : 'bg-surface text-muted/50 border border-border cursor-not-allowed'
                  }
                `}
              >
                {isClearing ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Clearing…
                  </>
                ) : (
                  'Permanently Delete Data'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
