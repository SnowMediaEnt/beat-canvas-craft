// Works out how many points each player is expected to score this week.
//
// Two sources, in order of preference:
//   1. Sleeper's own weekly projections. Accurate, but undocumented, so it may
//      stop working without warning.
//   2. The player's own scoring history in your league this season. Always
//      available, since it comes from documented endpoints, but slower to react
//      to news than a real projection.
//
// The bot stays useful either way, and every number it produces is labelled
// with the source it came from so you can see which one was used.
import { getWeeklyProjections, getMatchups } from './sleeper-api.js';

/** How much of a player's projection survives each injury designation. */
const INJURY_MULTIPLIER = {
  Questionable: 0.85,
  Doubtful: 0.25,
  Out: 0,
  IR: 0,
  PUP: 0,
  NA: 0,
  Sus: 0,
  COV: 0.5,
};

/** Designations that mean the player cannot be started at all. */
export const CANNOT_START = new Set(['Out', 'IR', 'PUP', 'NA', 'Sus']);

/**
 * Pulls Sleeper's weekly projections into a plain `player_id -> points` map.
 * Returns null when the undocumented endpoint is unavailable.
 */
async function fromSleeperProjections(season, week, scoringType) {
  const raw = await getWeeklyProjections(season, week);
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const points = new Map();
  for (const entry of raw) {
    const id = entry.player_id ?? entry.player?.player_id;
    if (!id) continue;

    const stats = entry.stats ?? {};
    // Sleeper keys projections by scoring format. Fall back through the
    // formats so a half-PPR or standard league still gets a number.
    const value =
      stats[scoringType] ?? stats.pts_ppr ?? stats.pts_half_ppr ?? stats.pts_std ?? null;

    if (typeof value === 'number' && Number.isFinite(value)) {
      points.set(String(id), value);
    }
  }
  return points.size > 0 ? points : null;
}

/**
 * Builds a fallback projection from what players have actually scored in this
 * league so far. Recent weeks count for more than early ones.
 */
async function fromScoringHistory(leagueId, currentWeek) {
  const weeks = [];
  for (let week = Math.max(1, currentWeek - 6); week < currentWeek; week += 1) {
    weeks.push(week);
  }
  if (weeks.length === 0) return new Map();

  const results = await Promise.all(
    weeks.map(async (week) => ({ week, matchups: await getMatchups(leagueId, week) })),
  );

  // weightedTotal / weightTotal gives a recency-weighted average per player.
  const totals = new Map();

  for (const { week, matchups } of results) {
    if (!Array.isArray(matchups)) continue;
    // A week two games ago counts more than one six games ago.
    const weight = 1 / (1 + (currentWeek - week) * 0.25);

    for (const matchup of matchups) {
      for (const [playerId, score] of Object.entries(matchup.players_points ?? {})) {
        if (typeof score !== 'number' || !Number.isFinite(score)) continue;
        const entry = totals.get(playerId) ?? { weighted: 0, weight: 0, games: 0 };
        entry.weighted += score * weight;
        entry.weight += weight;
        entry.games += 1;
        totals.set(playerId, entry);
      }
    }
  }

  const points = new Map();
  for (const [playerId, entry] of totals) {
    if (entry.weight > 0) points.set(playerId, entry.weighted / entry.weight);
  }
  return points;
}

/**
 * Returns { source, get(playerId), has(playerId) } for the given week.
 *
 * `get` already accounts for injury designations, so an "Out" player comes back
 * as 0 and a "Questionable" one is discounted rather than trusted at full value.
 */
export async function buildProjections({ season, week, leagueId, scoringType, players }) {
  let points = await fromSleeperProjections(season, week, scoringType);
  let source = 'sleeper-projections';

  if (!points) {
    points = await fromScoringHistory(leagueId, week);
    source = 'scoring-history';
  }

  return {
    source,
    has: (playerId) => points.has(String(playerId)),

    get(playerId) {
      const id = String(playerId);
      const base = points.get(id) ?? 0;
      const status = players[id]?.injury_status ?? null;
      if (!status) return base;
      const multiplier = INJURY_MULTIPLIER[status];
      return multiplier === undefined ? base : base * multiplier;
    },

    raw: (playerId) => points.get(String(playerId)) ?? 0,
  };
}
