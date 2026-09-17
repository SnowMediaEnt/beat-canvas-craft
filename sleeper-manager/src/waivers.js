// Suggests waiver wire pickups.
//
// The idea is simple: find free agents that lots of Sleeper managers are adding
// right now, keep only the ones who would actually improve your starting
// lineup, and pair each with the weakest droppable player on your bench.
import { getTrendingAdds } from './sleeper-api.js';
import { CANNOT_START } from './projections.js';
import { playerName } from './lineup.js';

/** Positions worth picking up at all. */
const RELEVANT = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

function positionOf(player) {
  return (player?.fantasy_positions ?? [player?.position]).filter(Boolean)[0] ?? '?';
}

export async function recommendWaivers(snapshot, { maxClaims, faabMaxBidPct }) {
  const { players, projections, ownedPlayerIds, roster, league } = snapshot;

  const trending = (await getTrendingAdds(24, 100)) ?? [];

  // Free agents only, ranked by how much Sleeper as a whole wants them.
  const candidates = [];
  for (const entry of trending) {
    const id = String(entry.player_id);
    if (ownedPlayerIds.has(id)) continue;

    const player = players[id];
    if (!player) continue;

    const position = positionOf(player);
    if (!RELEVANT.has(position)) continue;
    if (CANNOT_START.has(player.injury_status ?? '')) continue;

    candidates.push({
      id, player, position,
      name: playerName(player),
      team: player.team ?? 'FA',
      adds: entry.count ?? 0,
      points: projections.get(id),
    });
  }

  // What you already have at each position, weakest first.
  const mine = (roster.players ?? [])
    .map((playerId) => {
      const id = String(playerId);
      const player = players[id];
      if (!player) return null;
      return {
        id, player,
        name: playerName(player),
        position: positionOf(player),
        points: projections.get(id),
        starter: (roster.starters ?? []).map(String).includes(id),
      };
    })
    .filter(Boolean);

  const weakestAt = (position) =>
    mine
      .filter((entry) => entry.position === position && !entry.starter)
      .sort((a, b) => a.points - b.points)[0] ?? null;

  // How widely added is the most popular player on the wire? Used to judge
  // whether a newcomer's buzz is strong enough to gamble a bench spot on.
  const topAdds = Math.max(1, ...candidates.map((entry) => entry.adds));

  const recommendations = [];
  for (const candidate of candidates) {
    const replaces = weakestAt(candidate.position);
    const depth = mine.filter((entry) => entry.position === candidate.position).length;
    const thin = depth < 2;

    // Most players worth adding are only worth adding BECAUSE they just got a
    // new role, which means they have no scoring history to project from. So
    // when we have no number for a player, judge them on how hard the rest of
    // Sleeper is chasing them instead of writing them off as zero points.
    const speculative = !projections.has(candidate.id) || candidate.points === 0;
    const buzz = candidate.adds / topAdds;

    let reason;
    if (speculative) {
      // Only gamble on genuinely hot names, and never drop a productive player
      // to do it.
      const dropIsCold = !replaces || replaces.points < 6;
      if (buzz < 0.25 || (!thin && !dropIsCold)) continue;
      reason =
        `Added by ${candidate.adds.toLocaleString()} managers today. No scoring ` +
        `history yet, so this is a speculative pickup.`;
    } else {
      const upgrade = candidate.points - (replaces?.points ?? 0);
      if (!thin && upgrade <= 0) continue;
      reason = thin
        ? `You only have ${depth} at ${candidate.position}.`
        : `Projected ${upgrade.toFixed(1)} points better than ${replaces?.name}.`;
    }

    recommendations.push({
      add: candidate,
      drop: replaces,
      upgrade: candidate.points - (replaces?.points ?? 0),
      speculative,
      reason,
    });
  }

  recommendations.sort((a, b) => b.add.adds - a.add.adds);
  const top = recommendations.slice(0, maxClaims);

  // Work out a bid if the league uses FAAB rather than waiver priority.
  const budget = league?.settings?.waiver_budget ?? 100;
  const spent = roster?.settings?.waiver_budget_used ?? 0;
  const remaining = Math.max(0, budget - spent);

  return top.map((entry, index) => ({
    ...entry,
    // The top target gets the full share, later ones progressively less.
    bid: Math.max(1, Math.round((remaining * (faabMaxBidPct / 100)) / (index + 1))),
    faabRemaining: remaining,
  }));
}
