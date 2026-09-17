// Decides the best starting lineup from the players on your roster.
//
// The problem is an assignment problem: each starting slot must be filled by
// one eligible player, each player can fill at most one slot, and we want the
// highest total projected points. Rosters are small, so a greedy first pass
// followed by repeated swap improvements reliably lands on the best answer.
import { CANNOT_START } from './projections.js';

/** Which real positions may fill each slot type in a Sleeper roster. */
const SLOT_ELIGIBILITY = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  WRRB_WRT: ['RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
  DL: ['DL'],
  LB: ['LB'],
  DB: ['DB'],
};

/** Slots that are not part of the starting lineup. */
const NON_STARTING = new Set(['BN', 'IR', 'TAXI']);

export const getStartingSlots = (rosterPositions = []) =>
  rosterPositions.filter((slot) => !NON_STARTING.has(slot));

function isEligible(slot, player) {
  const allowed = SLOT_ELIGIBILITY[slot];
  if (!allowed) return false;
  const positions = player.fantasy_positions ?? (player.position ? [player.position] : []);
  return positions.some((position) => allowed.includes(position));
}

/**
 * Builds the optimal lineup.
 *
 * @returns {{ starters: (string|null)[], slots: object[], bench: object[], total: number }}
 *   `starters` is in the exact slot order Sleeper expects.
 */
export function optimizeLineup({ rosterPlayerIds, rosterPositions, players, projections }) {
  const slots = getStartingSlots(rosterPositions);

  // Everyone on the roster we actually know about and who is allowed to play.
  const pool = [];
  for (const playerId of rosterPlayerIds ?? []) {
    const id = String(playerId);
    const player = players[id];
    if (!player) continue;

    const status = player.injury_status ?? null;
    pool.push({
      id,
      player,
      name: playerName(player),
      position: (player.fantasy_positions ?? [player.position]).filter(Boolean)[0] ?? '?',
      team: player.team ?? 'FA',
      status,
      benched: CANNOT_START.has(status ?? ''),
      points: projections.get(id),
    });
  }

  const available = pool.filter((entry) => !entry.benched);

  // Fill the most restrictive slots first. A slot that only three players can
  // fill must be settled before a FLEX that twelve players could fill.
  const order = slots
    .map((slot, index) => ({
      slot,
      index,
      candidates: available.filter((entry) => isEligible(slot, entry.player)).length,
    }))
    .sort((a, b) => a.candidates - b.candidates);

  const assigned = new Array(slots.length).fill(null);
  const used = new Set();

  for (const { slot, index } of order) {
    const best = available
      .filter((entry) => !used.has(entry.id) && isEligible(slot, entry.player))
      .sort((a, b) => b.points - a.points)[0];
    if (best) {
      assigned[index] = best;
      used.add(best.id);
    }
  }

  // Improvement pass. Try every swap that keeps the lineup legal and take any
  // that scores higher, until nothing improves. This fixes the cases where the
  // greedy pass spent a player on the wrong slot.
  let improved = true;
  let guard = 0;
  while (improved && guard < 100) {
    improved = false;
    guard += 1;

    for (let i = 0; i < slots.length; i += 1) {
      // Swapping a starter for someone on the bench.
      for (const candidate of available) {
        if (used.has(candidate.id)) continue;
        if (!isEligible(slots[i], candidate.player)) continue;
        const current = assigned[i];
        if (current && current.points >= candidate.points) continue;

        if (current) used.delete(current.id);
        assigned[i] = candidate;
        used.add(candidate.id);
        improved = true;
      }

      // Moving a starter to a different slot so a stronger bench player can
      // take this one. A plain swap between two starters never changes the
      // total on its own, so this is the move that actually gains points.
      for (let j = 0; j < slots.length; j += 1) {
        if (i === j) continue;
        const occupant = assigned[i];
        if (!occupant || !isEligible(slots[j], occupant.player)) continue;

        const displaced = assigned[j];
        if (displaced && displaced.points >= occupant.points) continue;

        // Who could fill slot i once the occupant moves out of it?
        const replacement = available
          .filter(
            (entry) =>
              entry.id !== occupant.id &&
              (!used.has(entry.id) || entry.id === displaced?.id) &&
              isEligible(slots[i], entry.player),
          )
          .sort((a, b) => b.points - a.points)[0];

        const before = occupant.points + (displaced?.points ?? 0);
        const after = occupant.points + (replacement?.points ?? 0);
        if (after <= before + 1e-9) continue;

        assigned[j] = occupant;
        assigned[i] = replacement ?? null;
        used.delete(displaced?.id);
        if (replacement) used.add(replacement.id);
        improved = true;
      }
    }
  }

  const bench = pool
    .filter((entry) => !used.has(entry.id))
    .sort((a, b) => b.points - a.points);

  return {
    starters: assigned.map((entry) => entry?.id ?? null),
    slots: slots.map((slot, index) => ({ slot, player: assigned[index] })),
    bench,
    total: assigned.reduce((sum, entry) => sum + (entry?.points ?? 0), 0),
  };
}

/**
 * Compares the lineup you currently have against the optimal one and returns
 * only the changes worth making.
 */
export function diffLineup({ current, optimal, slots, players, projections, threshold }) {
  const changes = [];

  for (let index = 0; index < optimal.length; index += 1) {
    const currentId = current?.[index] ? String(current[index]) : null;
    const optimalId = optimal[index] ? String(optimal[index]) : null;
    if (currentId === optimalId) continue;

    const gain = (optimalId ? projections.get(optimalId) : 0) -
      (currentId ? projections.get(currentId) : 0);

    changes.push({
      slot: slots[index],
      slotIndex: index,
      out: currentId ? describe(currentId, players, projections) : null,
      in: optimalId ? describe(optimalId, players, projections) : null,
      gain,
    });
  }

  const meaningful = changes.filter((change) => {
    // Always act when a starter literally cannot play, whatever the maths says.
    const outStatus = change.out?.status ?? null;
    if (outStatus && CANNOT_START.has(outStatus)) return true;
    return change.gain >= threshold;
  });

  return {
    all: changes,
    meaningful,
    projectedGain: meaningful.reduce((sum, change) => sum + Math.max(0, change.gain), 0),
  };
}

function describe(playerId, players, projections) {
  const player = players[playerId] ?? {};
  return {
    id: playerId,
    name: playerName(player),
    position: (player.fantasy_positions ?? [player.position]).filter(Boolean)[0] ?? '?',
    team: player.team ?? 'FA',
    status: player.injury_status ?? null,
    points: projections.get(playerId),
  };
}

export function playerName(player) {
  if (!player) return 'Unknown player';
  if (player.position === 'DEF') {
    return `${player.first_name ?? ''} ${player.last_name ?? ''}`.trim() || player.team || 'Defense';
  }
  return (
    player.full_name ??
    `${player.first_name ?? ''} ${player.last_name ?? ''}`.trim() ??
    player.player_id
  );
}
