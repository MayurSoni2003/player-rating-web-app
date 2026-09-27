/**
 * scripts/test-ingest.ts
 *
 * Phase 2 verification script.
 * Runs the Phase 1 pipeline + ingest_batch RPC directly (no HTTP server needed).
 * Then queries Supabase for all counts required by the Phase 2 spec.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/test-ingest.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { cleanCsv, summarizePipelineResult } from '../src/lib/data';

// ---------------------------------------------------------------------------
// Bootstrap env (tsx --env-file handles this, but guard for safety)
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  console.error('Run with: npx tsx --env-file=.env.local scripts/test-ingest.ts');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type PlayerRow = { name: string; age_group: string };
type MatchRow = { id: string; match_date: string; competition: string; age_group: string; home_team: string; away_team: string };

function buildPlayers(cleanRows: ReturnType<typeof cleanCsv>['cleanRows']): PlayerRow[] {
  const seen = new Set<string>();
  const out: PlayerRow[] = [];
  for (const r of cleanRows) {
    const k = `${r.player_name}||${r.age_group}`;
    if (!seen.has(k)) { seen.add(k); out.push({ name: r.player_name, age_group: r.age_group }); }
  }
  return out;
}

function buildMatches(cleanRows: ReturnType<typeof cleanCsv>['cleanRows']): MatchRow[] {
  const seen = new Set<string>();
  const out: MatchRow[] = [];
  for (const r of cleanRows) {
    if (!seen.has(r.match_id)) {
      seen.add(r.match_id);
      out.push({ id: r.match_id, match_date: r.match_date, competition: r.competition, age_group: r.age_group, home_team: r.home_team, away_team: r.away_team });
    }
  }
  return out;
}

function buildAppearances(cleanRows: ReturnType<typeof cleanCsv>['cleanRows']) {
  return cleanRows.map((r) => ({
    player_name: r.player_name, age_group: r.age_group,
    match_id: r.match_id, position: r.position, team: r.team, opponent: r.opponent, venue: r.venue,
    goals_for: r.goals_for, goals_against: r.goals_against, minutes_played: r.minutes_played,
    touches: r.touches, passes_attempted: r.passes_attempted, passes_completed: r.passes_completed,
    progressive_passes: r.progressive_passes, crosses: r.crosses, dribbles_attempted: r.dribbles_attempted,
    dribbles_completed: r.dribbles_completed, shots: r.shots, shots_on_target: r.shots_on_target,
    goals: r.goals, assists: r.assists, possession_lost: r.possession_lost,
    duels_won: r.duels_won, duels_lost: r.duels_lost, aerial_duels_won: r.aerial_duels_won,
    aerial_duels_lost: r.aerial_duels_lost, tackles: r.tackles, interceptions: r.interceptions,
    recoveries: r.recoveries, clearances: r.clearances, fouls_committed: r.fouls_committed,
    fouls_won: r.fouls_won, yellow_cards: r.yellow_cards, red_cards: r.red_cards,
  }));
}

async function runIngest(label: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('='.repeat(60));

  // 1. Read & clean CSV
  const csvPath = join(process.cwd(), 'match_events.csv');
  const csvText = readFileSync(csvPath, 'utf8');
  const result = cleanCsv(csvText);
  const summary = summarizePipelineResult(result);

  if (label.includes('1')) {
    console.log('\n📋 Phase 1 Pipeline:');
    console.log(`  Source rows:        ${summary.totalInputRows}`);
    console.log(`  Clean rows:         ${summary.cleanRows}`);
    console.log(`  Duplicates removed: ${summary.duplicatesRemoved}`);
    console.log(`  Errors:             ${summary.errors}`);
    console.log(`  Warnings:           ${summary.warnings}`);

    const errors = result.issues.filter(i => i.severity === 'error');
    if (errors.length) {
      console.log('\n  ❌ Errors:');
      errors.forEach(e => console.log(`    [row ${e.rowIndex}] ${e.playerName} | ${e.field}: ${e.message}`));
    }
  }

  // 2. Build payloads
  const players = buildPlayers(result.cleanRows);
  const matches = buildMatches(result.cleanRows);
  const appearances = buildAppearances(result.cleanRows);

  // 3. Call ingest_batch RPC
  const { data, error } = await supabase.rpc('ingest_batch', {
    p_players: players,
    p_matches: matches,
    p_appearances: appearances,
  });

  if (error) {
    console.error('\n❌ RPC Error:', error.message);
    return null;
  }

  console.log('\n✅ Ingest RPC returned:');
  console.log(`  players_inserted:     ${data.players_inserted}`);
  console.log(`  matches_upserted:     ${data.matches_upserted}`);
  console.log(`  appearances_upserted: ${data.appearances_upserted}`);

  return data;
}

async function queryDbCounts() {
  console.log('\n📊 Querying database counts...');

  const [
    { count: totalPlayers },
    { count: u15Players },
    { count: u17Players },
    { count: totalMatches },
    { count: totalAppearances },
    { count: nullPosition },
    { count: nullMinutes },
    { count: ratingsCount },
  ] = await Promise.all([
    supabase.from('players').select('*', { count: 'exact', head: true }),
    supabase.from('players').select('*', { count: 'exact', head: true }).eq('age_group', 'U15'),
    supabase.from('players').select('*', { count: 'exact', head: true }).eq('age_group', 'U17'),
    supabase.from('matches').select('*', { count: 'exact', head: true }),
    supabase.from('appearances').select('*', { count: 'exact', head: true }),
    supabase.from('appearances').select('*', { count: 'exact', head: true }).is('position', null),
    supabase.from('appearances').select('*', { count: 'exact', head: true }).is('minutes_played', null),
    supabase.from('player_ratings').select('*', { count: 'exact', head: true }),
  ]);

  return { totalPlayers, u15Players, u17Players, totalMatches, totalAppearances, nullPosition, nullMinutes, ratingsCount };
}

async function printCounts(counts: Awaited<ReturnType<typeof queryDbCounts>>, label: string) {
  const { totalPlayers, u15Players, u17Players, totalMatches, totalAppearances, nullPosition, nullMinutes, ratingsCount } = counts;

  console.log(`\n📊 Database State — ${label}:`);
  console.log(`  Players total:        ${totalPlayers}  ${totalPlayers === 183 ? '✅ (expected 183)' : `⚠️  (expected 183, got ${totalPlayers})`}`);
  console.log(`  Players U15:          ${u15Players}  ${u15Players === 91 ? '✅' : `⚠️  (expected 91)`}`);
  console.log(`  Players U17:          ${u17Players}  ${u17Players === 92 ? '✅' : `⚠️  (expected 92)`}`);
  console.log(`  Matches:              ${totalMatches}`);
  console.log(`  Appearances:          ${totalAppearances}`);
  console.log(`  NULL position rows:   ${nullPosition}`);
  console.log(`  NULL minutes rows:    ${nullMinutes}`);
  console.log(`  player_ratings rows:  ${ratingsCount}  ${ratingsCount === 0 ? '✅ (correctly empty)' : '❌ (should be 0)'}`);
}

async function runDataQualityChecks() {
  console.log('\n\n🔍 Data Quality Checks');
  console.log('='.repeat(60));

  // Check 1: Aitor Cordero M-1703 — only one appearance
  const { data: corderoMatches } = await supabase
    .from('appearances')
    .select('*, players!inner(name, age_group)')
    .eq('match_id', 'M-1703')
    .eq('players.name', 'Aitor Cordero');
  
  console.log(`\nAitor Cordero / M-1703 appearances: ${corderoMatches?.length ?? 'error'} ${corderoMatches?.length === 1 ? '✅' : '❌ (expected 1)'}`);

  // Check 2: Atletico Madrid canonical spelling (team field, no lowercase)
  const { count: atleticoLower } = await supabase
    .from('appearances')
    .select('*', { count: 'exact', head: true })
    .eq('team', 'atletico madrid');
  
  console.log(`Atletico Madrid lowercase rows: ${atleticoLower} ${atleticoLower === 0 ? '✅ (all canonicalized)' : '❌ (some still lowercase)'}`);

  // Check 3: Real Madrid trailing whitespace
  const { count: realMadridTrailing } = await supabase
    .from('appearances')
    .select('*', { count: 'exact', head: true })
    .eq('team', 'Real Madrid ');
  
  console.log(`"Real Madrid " (trailing space) rows: ${realMadridTrailing} ${realMadridTrailing === 0 ? '✅' : '❌'}`);

  // Check 4: DD/MM/YYYY dates stored correctly (M-1705 should be 2026-04-11)
  const { data: m1705 } = await supabase.from('matches').select('id, match_date').eq('id', 'M-1705').single();
  console.log(`M-1705 (DD/MM/YYYY) date: ${m1705?.match_date} ${m1705?.match_date === '2026-04-11' ? '✅' : '⚠️'}`);

  // Check 5: passes_completed > passes_attempted row preserved (Arnau Fuster M-1701: passes_completed=69, attempted=65)
  const { data: anomalyRow } = await supabase
    .from('appearances')
    .select('passes_attempted, passes_completed, players!inner(name), match_id')
    .eq('match_id', 'M-1701')
    .eq('players.name', 'Arnau Fuster')
    .single();
  
  if (anomalyRow) {
    const isAnomaly = (anomalyRow.passes_completed ?? 0) > (anomalyRow.passes_attempted ?? 0);
    console.log(`Arnau Fuster M-1701 passes_completed(${anomalyRow.passes_completed}) > passes_attempted(${anomalyRow.passes_attempted}): ${isAnomaly ? '✅ preserved' : '❌'}`);
  }

  // Check 6: Nil Andrade M-1701 — minutes_played=0 stored as 0 not null
  const { data: nilRow } = await supabase
    .from('appearances')
    .select('minutes_played, players!inner(name), match_id')
    .eq('match_id', 'M-1701')
    .eq('players.name', 'Nil Andrade')
    .single();
  
  if (nilRow) {
    console.log(`Nil Andrade M-1701 minutes_played=0: ${nilRow.minutes_played === 0 ? '✅ (stored as 0)' : `❌ (got ${nilRow.minutes_played})`}`);
  }

  // Check 7: Hugo Andrade M-1506 — missing minutes, should be NULL
  const { data: hugoRow } = await supabase
    .from('appearances')
    .select('minutes_played, players!inner(name), match_id')
    .eq('match_id', 'M-1506')
    .eq('players.name', 'Hugo Andrade')
    .single();
  
  if (hugoRow) {
    console.log(`Hugo Andrade M-1506 missing minutes: ${hugoRow.minutes_played === null ? '✅ (NULL)' : `❌ (got ${hugoRow.minutes_played})`}`);
  }

  // Check 8: Cesar Herrera — title-cased versions merge into one player
  const { data: cesarPlayers } = await supabase
    .from('players')
    .select('name, age_group')
    .ilike('name', '%herrera%')
    .order('name');
  
  console.log(`\nHerrera players (expect "Cesar Herrera" + "C. Herrera"):`);
  cesarPlayers?.forEach(p => console.log(`  • "${p.name}" (${p.age_group})`));

  // Count appearances for Cesar Herrera
  const { data: cesarAppearances } = await supabase
    .from('appearances')
    .select('*, players!inner(name)')
    .eq('players.name', 'Cesar Herrera');
  console.log(`  Cesar Herrera appearances: ${cesarAppearances?.length ?? 0}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n🚀 PHASE 2: CSV INGESTION TEST');
  console.log('═'.repeat(60));

  // TEST 1: First upload
  await runIngest('TEST 1: First Upload');
  const counts1 = await queryDbCounts();
  await printCounts(counts1, 'After Upload 1');

  // TEST 2: Re-upload (idempotency)
  await runIngest('TEST 2: Re-Upload (idempotency check)');
  const counts2 = await queryDbCounts();
  await printCounts(counts2, 'After Upload 2');

  // Idempotency comparison
  console.log('\n🔁 Idempotency Check:');
  const fields: Array<keyof typeof counts1> = ['totalPlayers', 'totalMatches', 'totalAppearances'];
  let allGood = true;
  for (const f of fields) {
    const same = counts1[f] === counts2[f];
    if (!same) allGood = false;
    console.log(`  ${f}: ${counts1[f]} → ${counts2[f]} ${same ? '✅ unchanged' : '❌ CHANGED'}`);
  }
  console.log(allGood ? '\n  ✅ All counts unchanged — idempotent' : '\n  ❌ Counts changed — NOT idempotent');

  // TEST 3: Data quality checks
  await runDataQualityChecks();

  console.log('\n\n✨ Phase 2 test complete.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
