/**
 * POST /api/compute-ratings
 *
 * Triggers the Phase 3 rating engine. No request body needed.
 * Reads all appearances from Supabase, computes ratings, upserts player_ratings.
 *
 * Recomputes the full cohort on every call — incremental updates are not safe
 * because one player's normalization range affects everyone else in their cohort.
 */

import { serviceRoleClient } from '@/lib/supabase';
import { computeAndUpsertRatings } from '@/lib/ratingOrchestrator';

export const runtime = 'nodejs';

export async function POST() {
  const supabase = serviceRoleClient();
  const result = await computeAndUpsertRatings(supabase);

  if (!result.success) {
    const status = result.error?.includes('fetch') ? 500 : 400;
    return Response.json(
      {
        success: false,
        error: result.error,
        detail: result.detail,
      },
      { status },
    );
  }

  // Strip playerDetails from the HTTP response (too large; it's for the test script only)
  return Response.json({
    success: true,
    summary: result.summary,
    normalizationWarnings: result.normalizationWarnings,
  });
}
