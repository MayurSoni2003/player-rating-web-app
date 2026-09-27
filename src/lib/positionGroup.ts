/**
 * positionGroup.ts — Shared position-to-group mapping.
 *
 * Reuses the EXACT mapping from src/lib/rating.ts (Phase 3).
 * Imported by the frontend to derive position_group from
 * appearance.position without duplicating the constant.
 *
 * If this mapping changes, it must be kept in sync with rating.ts.
 */

export type PositionGroup = 'GK' | 'Defender' | 'Midfielder' | 'Attacker';

const POSITION_TO_GROUP: Record<string, PositionGroup> = {
  GK: 'GK',
  CB: 'Defender',
  FB: 'Defender',
  CM: 'Midfielder',
  W: 'Midfielder',
  ST: 'Attacker',
};

/**
 * Derive the position group from a raw position string.
 * Returns null if position is null/undefined or unrecognised.
 */
export function getPositionGroup(position: string | null | undefined): PositionGroup | null {
  if (!position) return null;
  return POSITION_TO_GROUP[position] ?? null;
}

/** All valid position groups, in display order. */
export const ALL_POSITION_GROUPS: PositionGroup[] = ['GK', 'Defender', 'Midfielder', 'Attacker'];
