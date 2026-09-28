/**
 * scripts/audit-ratings-bugfix.ts
 *
 * Runs full rating recompute and audits the results:
 * 1. Recomputes all ratings via computeAndUpsertRatings().
 * 2. Checks Mateo Otero's rating, percentile, position group, and score.
 * 3. Identifies all players with any NULL positions across appearances.
 * 4. Reports new total rated/unrated counts across U15 and U17.
 */

import { createClient } from '@supabase/supabase-js';
import { computeAndUpsertRatings } from '../src/lib/ratingOrchestrator';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  console.log('='.repeat(60));
  console.log('🔍 RUNNING RATINGS RECOMPUTE & AUDIT FOR POSITION BUGFIX');
  console.log('='.repeat(60));

  // 1. Recompute ratings
  console.log('\n[1] Executing computeAndUpsertRatings()...');
  const result = await computeAndUpsertRatings(supabase);
  console.log('  Success:', result.success);
  console.log('  Summary:', JSON.stringify(result.summary, null, 2));

  // 2. Query Mateo Otero specifically
  console.log('\n[2] Checking Mateo Otero (U17)...');
  const { data: oteroPlayer } = await supabase
    .from('players')
    .select('id, name, age_group')
    .eq('name', 'Mateo Otero')
    .single();

  if (oteroPlayer) {
    const { data: oteroRating } = await supabase
      .from('player_ratings')
      .select('*')
      .eq('player_id', oteroPlayer.id)
      .single();

    const { data: oteroAppearances } = await supabase
      .from('appearances')
      .select('match_id, position, minutes_played, passes_attempted, passes_completed, duels_won, duels_lost, progressive_passes, goals, assists')
      .eq('player_id', oteroPlayer.id);

    console.log('  Player:', oteroPlayer);
    console.log('  Rating:', oteroRating);
    console.log('  Appearances:', oteroAppearances);
  } else {
    console.log('  ⚠️ Mateo Otero not found');
  }

  // 3. Query all players to find any with NULL positions on ANY appearance
  console.log('\n[3] Auditing all players with NULL positions...');
  const { data: appearancesWithNullPos } = await supabase
    .from('appearances')
    .select('player_id, match_id, position, minutes_played, players!inner(id, name, age_group)')
    .is('position', null);

  console.log(`  Found ${appearancesWithNullPos?.length ?? 0} appearance(s) with NULL position:`);
  for (const app of appearancesWithNullPos ?? []) {
    const p = (app as any).players;
    // Check all appearances for this player
    const { data: allPlayerApps } = await supabase
      .from('appearances')
      .select('match_id, position, minutes_played')
      .eq('player_id', p.id);

    const { data: pRating } = await supabase
      .from('player_ratings')
      .select('overall_score, percentile, matches_played')
      .eq('player_id', p.id)
      .single();

    console.log(`    Player: ${p.name} (${p.age_group}) [ID: ${p.id}]`);
    console.log(`    All appearances (${allPlayerApps?.length}):`, allPlayerApps);
    console.log(`    Computed rating:`, pRating);
  }

  // 4. Query total database counts
  console.log('\n[4] Database State Summary:');
  const [
    { count: totalPlayers },
    { count: totalRatings },
    { count: ratedCount },
    { count: unratedCount },
  ] = await Promise.all([
    supabase.from('players').select('*', { count: 'exact', head: true }),
    supabase.from('player_ratings').select('*', { count: 'exact', head: true }),
    supabase.from('player_ratings').select('*', { count: 'exact', head: true }).not('overall_score', 'is', null),
    supabase.from('player_ratings').select('*', { count: 'exact', head: true }).is('overall_score', null),
  ]);

  console.log(`  Total Players:        ${totalPlayers}`);
  console.log(`  Total Ratings Rows:   ${totalRatings}`);
  console.log(`  Rated Players:        ${ratedCount}`);
  console.log(`  Unrated Players:      ${unratedCount}`);

  console.log('\n' + '='.repeat(60));
  console.log('✅ AUDIT COMPLETE');
  console.log('='.repeat(60));
}

main().catch(console.error);
