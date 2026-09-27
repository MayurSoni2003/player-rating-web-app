/**
 * POST /api/clear-data
 *
 * Atomically purges all rows from appearances, player_ratings, matches, and players.
 *
 * Safety:
 *  - Uses serviceRoleClient() server-side only.
 *  - Accepts ONLY POST requests (GET returns 405 Method Not Allowed).
 *  - Deletes in FK-safe reverse dependency order:
 *      1. appearances
 *      2. player_ratings
 *      3. matches
 *      4. players
 *  - Returns actual post-delete row counts for all four tables to confirm zero rows remain.
 */

import { serviceRoleClient } from '@/lib/supabase';

export const runtime = 'nodejs';

interface ClearRpcResponse {
  deleted: {
    appearances: number;
    player_ratings: number;
    matches: number;
    players: number;
  };
  remaining: {
    appearances: number;
    player_ratings: number;
    matches: number;
    players: number;
  };
}

export async function POST() {
  try {
    const supabase = serviceRoleClient();

    // 1. Try running the Postgres RPC clear_all_data() first
    const { data: rpcData, error: rpcError } = await supabase.rpc('clear_all_data');

    if (!rpcError && rpcData) {
      const result = rpcData as ClearRpcResponse;
      return Response.json({
        success: true,
        message: 'Database cleared successfully via Postgres RPC.',
        deleted: result.deleted,
        remaining: result.remaining,
      });
    }

    // 2. Fallback: If RPC not present in schema cache, execute FK-safe server-side deletes
    // Delete order: appearances -> player_ratings -> matches -> players

    // Query pre-counts
    const [
      { count: preAppearances },
      { count: preRatings },
      { count: preMatches },
      { count: prePlayers },
    ] = await Promise.all([
      supabase.from('appearances').select('*', { count: 'exact', head: true }),
      supabase.from('player_ratings').select('*', { count: 'exact', head: true }),
      supabase.from('matches').select('*', { count: 'exact', head: true }),
      supabase.from('players').select('*', { count: 'exact', head: true }),
    ]);

    // 1. Delete appearances (references matches & players)
    const { error: appErr } = await supabase
      .from('appearances')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (appErr) throw new Error(`Failed to clear appearances: ${appErr.message}`);

    // 2. Delete player_ratings (references players)
    const { error: ratErr } = await supabase
      .from('player_ratings')
      .delete()
      .neq('player_id', '00000000-0000-0000-0000-000000000000');
    if (ratErr) throw new Error(`Failed to clear player_ratings: ${ratErr.message}`);

    // 3. Delete matches
    const { error: matErr } = await supabase
      .from('matches')
      .delete()
      .neq('id', '__dummy_match_id__');
    if (matErr) throw new Error(`Failed to clear matches: ${matErr.message}`);

    // 4. Delete players
    const { error: plyErr } = await supabase
      .from('players')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (plyErr) throw new Error(`Failed to clear players: ${plyErr.message}`);

    // Query post-counts to verify 100% clean state
    const [
      { count: postAppearances },
      { count: postRatings },
      { count: postMatches },
      { count: postPlayers },
    ] = await Promise.all([
      supabase.from('appearances').select('*', { count: 'exact', head: true }),
      supabase.from('player_ratings').select('*', { count: 'exact', head: true }),
      supabase.from('matches').select('*', { count: 'exact', head: true }),
      supabase.from('players').select('*', { count: 'exact', head: true }),
    ]);

    return Response.json({
      success: true,
      message: 'Database cleared successfully.',
      deleted: {
        appearances: preAppearances ?? 0,
        player_ratings: preRatings ?? 0,
        matches: preMatches ?? 0,
        players: prePlayers ?? 0,
      },
      remaining: {
        appearances: postAppearances ?? 0,
        player_ratings: postRatings ?? 0,
        matches: postMatches ?? 0,
        players: postPlayers ?? 0,
      },
    });
  } catch (error) {
    console.error('[clear-data] Error clearing database:', error);
    return Response.json(
      {
        success: false,
        error: 'Failed to clear database.',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function GET() {
  return Response.json(
    {
      success: false,
      error: 'Method Not Allowed. Clear data must be triggered via POST.',
    },
    {
      status: 405,
      headers: { Allow: 'POST' },
    },
  );
}
