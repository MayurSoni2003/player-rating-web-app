/**
 * scripts/test-ratings.ts
 *
 * Phase 3 verification & regression test script.
 * Runs the full rating pipeline directly against Supabase,
 * verifies database state integrity, executes regression tests for
 * name-collision prevention (Pablo Ruiz U15 vs U17), and prints spot-checks.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/test-ratings.ts
 */

import { createClient } from '@supabase/supabase-js';
import { computeAndUpsertRatings, type RatingPipelineResult } from '../src/lib/ratingOrchestrator';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing env vars. Run: npx tsx --env-file=.env.local scripts/test-ratings.ts');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(v: number | null | undefined, decimals = 4): string {
  if (v === null || v === undefined) return 'null';
  return v.toFixed(decimals);
}

type PlayerDetail = NonNullable<RatingPipelineResult['playerDetails']> extends Map<string, infer V> ? V : never;

function printPlayer(label: string, detail: PlayerDetail | undefined) {
  if (!detail) {
    console.log(`\n  ${label}: NOT FOUND in pipeline`);
    return;
  }
  console.log(`\n  ┌── ${label} (${detail.age_group}) [ID: ${detail.player_id}]`);
  console.log(`  │   Position group:       ${detail.position_group ?? 'null (UNRATED)'}`);
  console.log(`  │   Eligible appearances: ${detail.eligible_appearances}`);
  console.log(`  │   Raw score:            ${fmt(detail.raw_score)}`);
  console.log(`  │   Percentile:           ${detail.percentile !== null ? `${fmt(detail.percentile, 1)}th` : 'null (UNRATED)'}`);
  if (detail.ineligible_reason) {
    console.log(`  │   ⚠  Unrated reason:   ${detail.ineligible_reason}`);
  }
  if (detail.aggregates) {
    const a = detail.aggregates;
    console.log('  │   --- Key aggregates ---');
    console.log(`  │   pass_completion_pct:         ${fmt(a.pass_completion_pct)}`);
    console.log(`  │   duel_win_pct:                ${fmt(a.duel_win_pct)}`);
    console.log(`  │   goals_assists_per90:         ${fmt(a.goals_assists_per90)}`);
    console.log(`  │   tackles_interceptions_per90: ${fmt(a.tackles_interceptions_per90)}`);
    console.log(`  │   progressive_passes_per90:    ${fmt(a.progressive_passes_per90)}`);
    console.log(`  │   yellow_cards_per90:          ${fmt(a.yellow_cards_per90)}`);
    console.log(`  │   red_cards_per90:             ${fmt(a.red_cards_per90)}`);
  }
  if (detail.normalized) {
    const entries = Object.entries(detail.normalized)
      .map(([k, v]) => `${k}: ${fmt(v as number, 3)}`)
      .join(', ');
    console.log('  │   --- Normalized metrics ---');
    console.log(`  │   ${entries}`);
  }
  console.log('  └──');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n🚀 PHASE 3: RATING ENGINE & REGRESSION AUDIT');
  console.log('═'.repeat(60));

  console.log('\n▶  Running full rating pipeline from scratch...');
  const result = await computeAndUpsertRatings(supabase);

  if (!result.success) {
    console.error(`\n❌ Pipeline failed: ${result.error}`);
    if (result.detail) console.error(`   Detail: ${result.detail}`);
    process.exit(1);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const s = result.summary!;
  console.log('\n📊 Rating Summary:');
  console.log(`  Total players processed:  ${s.totalPlayers}`);
  console.log(`  Rated:                    ${s.rated}`);
  console.log(`  Unrated (null/not-rated): ${s.unrated}`);
  console.log(`  U15 → rated: ${s.byAgeGroup.U15.rated}, unrated: ${s.byAgeGroup.U15.unrated}`);
  console.log(`  U17 → rated: ${s.byAgeGroup.U17.rated}, unrated: ${s.byAgeGroup.U17.unrated}`);
  console.log(`  Normalization warnings:   ${s.normalizationWarnings}`);

  if (result.normalizationWarnings && result.normalizationWarnings.length > 0) {
    console.log('\n⚠  Normalization warnings (degenerate cohorts):');
    for (const w of result.normalizationWarnings) {
      console.log(`   [${w.ageGroup} ${w.posGroup}] ${w.metric}: ${w.reason}`);
    }
  }

  // ── Database Integrity Audit ──────────────────────────────────────────────
  console.log('\n\n📋 Re-Audit: player_ratings table integrity');
  console.log('='.repeat(60));

  const { count: totalPlayersCount } = await supabase
    .from('players')
    .select('*', { count: 'exact', head: true });

  const { data: allRatings, count: ratingsRowCount } = await supabase
    .from('player_ratings')
    .select('player_id, age_group, overall_score, percentile, matches_played', { count: 'exact' });

  const distinctPlayerIds = new Set(allRatings?.map((r) => r.player_id) ?? []);
  const nullScores = allRatings?.filter((r) => r.overall_score === null) ?? [];
  const ratedScores = allRatings?.filter((r) => r.overall_score !== null) ?? [];

  console.log(`  Total rows in players:               ${totalPlayersCount}`);
  console.log(`  Total rows in player_ratings:        ${ratingsRowCount}`);
  console.log(`  Distinct player_ids in ratings:      ${distinctPlayerIds.size}`);
  console.log(`  Rated rows (overall_score != null):  ${ratedScores.length}`);
  console.log(`  Unrated rows (overall_score == null): ${nullScores.length}`);

  const countsMatch = ratingsRowCount === distinctPlayerIds.size;
  console.log(`  Integrity check (COUNT(*) == COUNT(DISTINCT player_id)): ${countsMatch ? '✅ MATCH' : '❌ MISMATCH'}`);
  if (!countsMatch) {
    console.error('❌ FATAL: player_ratings contains duplicate player_ids!');
    process.exit(1);
  }

  // ── Regression Test: Pablo Ruiz Identity Separation ──────────────────────
  console.log('\n\n🧪 REGRESSION TEST: Pablo Ruiz Duplicate Name Identity');
  console.log('='.repeat(60));

  const { data: pabloPlayers, error: pabloErr } = await supabase
    .from('players')
    .select('id, name, age_group')
    .eq('name', 'Pablo Ruiz')
    .order('age_group', { ascending: true });

  if (pabloErr || !pabloPlayers || pabloPlayers.length !== 2) {
    console.error(`❌ REGRESSION FAILED: Expected 2 players named 'Pablo Ruiz', found ${pabloPlayers?.length ?? 0}`);
    process.exit(1);
  }

  const pabloU15Player = pabloPlayers.find((p) => p.age_group === 'U15')!;
  const pabloU17Player = pabloPlayers.find((p) => p.age_group === 'U17')!;

  const { data: pabloU15Rating } = await supabase
    .from('player_ratings')
    .select('*')
    .eq('player_id', pabloU15Player.id)
    .single();

  const { data: pabloU17Rating } = await supabase
    .from('player_ratings')
    .select('*')
    .eq('player_id', pabloU17Player.id)
    .single();

  console.log('  1. Fetching both Pablo Ruiz player_ids:');
  console.log(`     - U15 ID: ${pabloU15Player.id}`);
  console.log(`     - U17 ID: ${pabloU17Player.id}`);

  // Assertion 1: Both exist in player_ratings
  if (!pabloU15Rating || !pabloU17Rating) {
    console.error('❌ REGRESSION FAILED: One or both Pablo Ruiz players missing from player_ratings table!');
    process.exit(1);
  }
  console.log('  2. Assert both have rows in player_ratings: ✅ PASS');

  // Assertion 2: Both have non-null overall_score and percentile
  const u15HasScore = pabloU15Rating.overall_score !== null && pabloU15Rating.percentile !== null;
  const u17HasScore = pabloU17Rating.overall_score !== null && pabloU17Rating.percentile !== null;

  if (!u15HasScore || !u17HasScore) {
    console.error(`❌ REGRESSION FAILED: Scores are null! U15: ${pabloU15Rating.overall_score}, U17: ${pabloU17Rating.overall_score}`);
    process.exit(1);
  }
  console.log('  3. Assert both have non-null scores: ✅ PASS');

  // Assertion 3: overall_score and percentile are different
  const scoresDifferent = pabloU15Rating.overall_score !== pabloU17Rating.overall_score;
  const percentilesDifferent = pabloU15Rating.percentile !== pabloU17Rating.percentile;

  if (!scoresDifferent || !percentilesDifferent) {
    console.error('❌ REGRESSION FAILED: Pablo Ruiz scores or percentiles accidentally identical!');
    process.exit(1);
  }
  console.log('  4. Assert scores & percentiles are DIFFERENT: ✅ PASS');

  // Side-by-side print
  console.log('\n  📊 Side-by-Side Comparison:');
  console.log('  ┌────────────────────────┬────────────────────────┬────────────────────────┐');
  console.log('  │ Field                  │ Pablo Ruiz (U15)       │ Pablo Ruiz (U17)       │');
  console.log('  ├────────────────────────┼────────────────────────┼────────────────────────┤');
  console.log(`  │ Player ID              │ ${pabloU15Player.id.padEnd(22)} │ ${pabloU17Player.id.padEnd(22)} │`);
  console.log(`  │ Age Group              │ ${'U15'.padEnd(22)} │ ${'U17'.padEnd(22)} │`);
  console.log(`  │ Matches Played         │ ${String(pabloU15Rating.matches_played).padEnd(22)} │ ${String(pabloU17Rating.matches_played).padEnd(22)} │`);
  console.log(`  │ Overall Score          │ ${fmt(pabloU15Rating.overall_score).padEnd(22)} │ ${fmt(pabloU17Rating.overall_score).padEnd(22)} │`);
  console.log(`  │ Percentile             │ ${(fmt(pabloU15Rating.percentile, 1) + 'th').padEnd(22)} │ ${(fmt(pabloU17Rating.percentile, 1) + 'th').padEnd(22)} │`);
  console.log('  └────────────────────────┴────────────────────────┴────────────────────────┘');
  console.log('  🎉 Pablo Ruiz duplicate name regression test PASSED!');

  // ── Spot-checks (Phase 3 §11 required players) ───────────────────────────
  console.log('\n\n🔍 Spot-checks (Phase 3 §11 required players)');
  console.log('='.repeat(60));

  const details = result.playerDetails!;

  // Helper: find by player_id from details map
  const findByName = (name: string, ageGroup?: string): PlayerDetail | undefined => {
    for (const [, v] of details) {
      if (v.name === name && (!ageGroup || v.age_group === ageGroup)) return v;
    }
    return undefined;
  };

  // 1. Cesar Herrera
  printPlayer('Cesar Herrera', findByName('Cesar Herrera'));

  // 2. Pablo Ruiz U15 & U17
  printPlayer('Pablo Ruiz (U15)', details.get(pabloU15Player.id));
  printPlayer('Pablo Ruiz (U17)', details.get(pabloU17Player.id));

  // 3. Mateo Otero — should be UNRATED (position was null in an eligible appearance)
  const mateo = findByName('Mateo Otero');
  printPlayer('Mateo Otero (should be UNRATED)', mateo);

  if (mateo?.player_id) {
    const { data: mateoRating } = await supabase
      .from('player_ratings')
      .select('overall_score, percentile, matches_played')
      .eq('player_id', mateo.player_id)
      .single();

    if (mateoRating) {
      const scoreOk = mateoRating.overall_score === null;
      const pctOk = mateoRating.percentile === null;
      console.log('\n  Mateo Otero in player_ratings:');
      console.log(`    overall_score  = ${mateoRating.overall_score}  ${scoreOk ? '✅ null (not rated)' : '❌ should be null'}`);
      console.log(`    percentile     = ${mateoRating.percentile}  ${pctOk ? '✅ null (not rated)' : '❌ should be null'}`);
      console.log(`    matches_played = ${mateoRating.matches_played}`);
    }
  }

  // ── Top 5 per age group ────────────────────────────────────────────────────
  console.log('\n\n🏆 Top 5 players by percentile');
  console.log('='.repeat(60));

  for (const ag of ['U15', 'U17'] as const) {
    const { data: top } = await supabase
      .from('player_ratings')
      .select('player_id, overall_score, percentile, matches_played, players!inner(name, age_group)')
      .eq('age_group', ag)
      .not('percentile', 'is', null)
      .order('percentile', { ascending: false })
      .limit(5);

    console.log(`\n  ${ag}:`);
    if (top && top.length > 0) {
      for (const r of top) {
        const p = r.players as unknown as { name: string; age_group: string };
        console.log(
          `    ${p.name.padEnd(22)}  score=${Number(r.overall_score).toFixed(4)}  pct=${Number(r.percentile).toFixed(1)}th  apps=${r.matches_played}`,
        );
      }
    } else {
      console.log('    (no rated players)');
    }
  }

  console.log('\n✨ Phase 3 test and audit complete.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
