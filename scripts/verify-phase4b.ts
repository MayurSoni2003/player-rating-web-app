/**
 * scripts/verify-phase4b.ts
 *
 * Comprehensive verification script for Phase 4B:
 * 1. Test GET /api/clear-data returns 405 Method Not Allowed
 * 2. Test POST /api/clear-data purges all 4 tables
 * 3. Directly query Supabase to verify all 4 tables have 0 rows
 * 4. Re-upload match_events.csv via /api/ingest & compute ratings
 * 5. Verify database counts (183 players, 13 matches, 364 appearances, ratings computed)
 * 6. Test re-uploading the same file (idempotency: 0 new players inserted)
 * 7. Test uploading a non-CSV file (rejected with 400)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BASE_URL = 'http://localhost:3000';

async function queryTableCounts() {
  const [
    { count: players },
    { count: matches },
    { count: appearances },
    { count: ratings },
  ] = await Promise.all([
    supabase.from('players').select('*', { count: 'exact', head: true }),
    supabase.from('matches').select('*', { count: 'exact', head: true }),
    supabase.from('appearances').select('*', { count: 'exact', head: true }),
    supabase.from('player_ratings').select('*', { count: 'exact', head: true }),
  ]);
  return { players: players ?? 0, matches: matches ?? 0, appearances: appearances ?? 0, ratings: ratings ?? 0 };
}

async function runVerification() {
  console.log('='.repeat(60));
  console.log('🚀 RUNNING PHASE 4B COMPREHENSIVE VERIFICATION');
  console.log('='.repeat(60));

  // ─────────────────────────────────────────────────────────────
  // STEP 1: Test GET /api/clear-data is rejected (Method Not Allowed)
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Step 1] Testing GET /api/clear-data rejection...');
  const getRes = await fetch(`${BASE_URL}/api/clear-data`, { method: 'GET' });
  const getData = await getRes.json();
  console.log(`  HTTP Status: ${getRes.status} (expected 405)`);
  console.log(`  Response:`, getData);
  if (getRes.status !== 405) {
    throw new Error(`Expected status 405 for GET /api/clear-data, got ${getRes.status}`);
  }
  console.log('  ✅ GET /api/clear-data correctly rejected with 405 Method Not Allowed');

  // ─────────────────────────────────────────────────────────────
  // STEP 2: Test POST /api/clear-data
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Step 2] Testing POST /api/clear-data execution...');
  const clearRes = await fetch(`${BASE_URL}/api/clear-data`, { method: 'POST' });
  const clearData = await clearRes.json();
  console.log(`  HTTP Status: ${clearRes.status}`);
  console.log(`  Response:`, JSON.stringify(clearData, null, 2));
  if (!clearRes.ok || !clearData.success) {
    throw new Error(`Clear data failed: ${JSON.stringify(clearData)}`);
  }
  console.log('  ✅ POST /api/clear-data returned success');

  // ─────────────────────────────────────────────────────────────
  // STEP 3: Verify all 4 tables directly in Supabase have 0 rows
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Step 3] Directly querying Supabase for table counts post-clear...');
  const emptyCounts = await queryTableCounts();
  console.log(`  players:        ${emptyCounts.players} (expected 0)`);
  console.log(`  matches:        ${emptyCounts.matches} (expected 0)`);
  console.log(`  appearances:    ${emptyCounts.appearances} (expected 0)`);
  console.log(`  player_ratings: ${emptyCounts.ratings} (expected 0)`);

  const allZero =
    emptyCounts.players === 0 &&
    emptyCounts.matches === 0 &&
    emptyCounts.appearances === 0 &&
    emptyCounts.ratings === 0;

  if (!allZero) {
    throw new Error(`Expected all tables to be 0, got ${JSON.stringify(emptyCounts)}`);
  }
  console.log('  ✅ All 4 tables verified empty (0 rows in each)');

  // ─────────────────────────────────────────────────────────────
  // STEP 4: Upload original match_events.csv via /api/ingest
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Step 4] Re-uploading match_events.csv via POST /api/ingest...');
  const csvBuffer = readFileSync(join(process.cwd(), 'match_events.csv'));
  const blob = new Blob([csvBuffer], { type: 'text/csv' });
  const formData = new FormData();
  formData.append('file', blob, 'match_events.csv');

  const ingestRes = await fetch(`${BASE_URL}/api/ingest`, {
    method: 'POST',
    body: formData,
  });
  const ingestData = await ingestRes.json();
  console.log(`  HTTP Status: ${ingestRes.status}`);
  console.log(`  Ingest Summary:`, JSON.stringify(ingestData.summary, null, 2));

  if (!ingestRes.ok || !ingestData.success) {
    throw new Error(`Ingest failed: ${JSON.stringify(ingestData)}`);
  }

  // Recompute ratings
  console.log('\n  Triggering ratings computation via POST /api/compute-ratings...');
  const ratingRes = await fetch(`${BASE_URL}/api/compute-ratings`, { method: 'POST' });
  const ratingData = await ratingRes.json();
  console.log(`  HTTP Status: ${ratingRes.status}`);
  console.log(`  Rating Summary:`, JSON.stringify(ratingData.summary, null, 2));

  if (!ratingRes.ok || !ratingData.success) {
    throw new Error(`Rating computation failed: ${JSON.stringify(ratingData)}`);
  }

  // Verify DB state after first upload
  const restoredCounts = await queryTableCounts();
  console.log('\n  Database State after Re-upload 1:');
  console.log(`  players:        ${restoredCounts.players} (expected 183)`);
  console.log(`  matches:        ${restoredCounts.matches} (expected 13)`);
  console.log(`  appearances:    ${restoredCounts.appearances} (expected 364)`);
  console.log(`  player_ratings: ${restoredCounts.ratings} (expected 183)`);

  if (
    restoredCounts.players !== 183 ||
    restoredCounts.matches !== 13 ||
    restoredCounts.appearances !== 364 ||
    restoredCounts.ratings !== 183
  ) {
    throw new Error(`Counts mismatch after re-upload 1: ${JSON.stringify(restoredCounts)}`);
  }
  console.log('  ✅ Clean initial upload verified (183 players, 13 matches, 364 appearances, 183 ratings)');

  // ─────────────────────────────────────────────────────────────
  // STEP 5: Re-upload the SAME file a second time (Idempotency test)
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Step 5] Re-uploading SAME file a second time (Idempotency test)...');
  const formData2 = new FormData();
  formData2.append('file', blob, 'match_events.csv');

  const ingestRes2 = await fetch(`${BASE_URL}/api/ingest`, {
    method: 'POST',
    body: formData2,
  });
  const ingestData2 = await ingestRes2.json();
  console.log(`  playersInserted: ${ingestData2.summary.playersInserted} (expected 0 new players)`);
  console.log(`  matchesUpserted: ${ingestData2.summary.matchesUpserted} (expected 13)`);
  console.log(`  appearancesUpserted: ${ingestData2.summary.appearancesUpserted} (expected 364)`);

  const idempotentCounts = await queryTableCounts();
  console.log('\n  Database State after Re-upload 2:');
  console.log(`  players:        ${idempotentCounts.players} (expected 183)`);
  console.log(`  matches:        ${idempotentCounts.matches} (expected 13)`);
  console.log(`  appearances:    ${idempotentCounts.appearances} (expected 364)`);

  if (
    ingestData2.summary.playersInserted !== 0 ||
    idempotentCounts.players !== 183 ||
    idempotentCounts.matches !== 13 ||
    idempotentCounts.appearances !== 364
  ) {
    throw new Error(`Idempotency check failed! ${JSON.stringify(idempotentCounts)}`);
  }
  console.log('  ✅ Idempotency holds perfectly (0 new rows created on re-upload)');

  // ─────────────────────────────────────────────────────────────
  // STEP 6: Attempt uploading non-CSV file
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Step 6] Testing non-CSV file upload rejection...');
  const invalidBlob = new Blob(['invalid json content'], { type: 'application/json' });
  const invalidForm = new FormData();
  invalidForm.append('file', invalidBlob, 'invalid_file.json');

  const invalidRes = await fetch(`${BASE_URL}/api/ingest`, {
    method: 'POST',
    body: invalidForm,
  });
  const invalidData = await invalidRes.json();
  console.log(`  HTTP Status: ${invalidRes.status} (expected 400)`);
  console.log(`  Response:`, invalidData);

  if (invalidRes.status !== 400 || invalidData.success !== false) {
    throw new Error(`Expected 400 rejection for non-CSV file, got ${invalidRes.status}`);
  }
  console.log('  ✅ Non-CSV file properly rejected with HTTP 400');

  console.log('\n' + '='.repeat(60));
  console.log('🎉 ALL PHASE 4B VERIFICATION CHECKS PASSED!');
  console.log('='.repeat(60));
}

runVerification().catch((err) => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
