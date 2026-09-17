// Gathers everything about your team into one object the rest of the bot uses.
import {
  getNflState, getUser, getLeaguesForUser, getLeague,
  getRosters, getLeagueUsers, getMatchups, getAllPlayers,
} from './sleeper-api.js';
import { config } from './config.js';
import { buildProjections } from './projections.js';
import { playerName } from './lineup.js';

/** Works out which scoring format the league uses, for projection lookups. */
function scoringType(league) {
  const rec = league?.scoring_settings?.rec ?? 0;
  if (rec >= 1) return 'pts_ppr';
  if (rec > 0) return 'pts_half_ppr';
  return 'pts_std';
}

export async function loadSnapshot({ week: weekOverride } = {}) {
  const state = await getNflState();
  const season = state.season;
  const week = weekOverride ?? Math.max(1, state.week ?? 1);

  const user = await getUser(config.sleeper.username);

  const leagues = (await getLeaguesForUser(user.user_id, season)) ?? [];
  if (leagues.length === 0) {
    throw new Error(`No ${season} leagues found for ${user.display_name}.`);
  }

  const league = config.sleeper.leagueId
    ? leagues.find((entry) => entry.league_id === config.sleeper.leagueId)
    : leagues[0];

  if (!league) {
    throw new Error(
      `League ${config.sleeper.leagueId} is not one of your ${season} leagues. ` +
        `Found: ${leagues.map((l) => `${l.name} (${l.league_id})`).join(', ')}`,
    );
  }

  const [detail, rosters, leagueUsers, matchups, players] = await Promise.all([
    getLeague(league.league_id),
    getRosters(league.league_id),
    getLeagueUsers(league.league_id),
    getMatchups(league.league_id, week),
    getAllPlayers(),
  ]);

  const roster = (rosters ?? []).find((entry) => entry.owner_id === user.user_id);
  if (!roster) {
    throw new Error(`${user.display_name} does not own a roster in ${league.name}.`);
  }

  const projections = await buildProjections({
    season, week,
    leagueId: league.league_id,
    scoringType: scoringType(detail ?? league),
    players,
  });

  // Find this week's opponent so alerts can mention who you are playing.
  const myMatchup = (matchups ?? []).find((entry) => entry.roster_id === roster.roster_id);
  const opponentEntry = myMatchup
    ? (matchups ?? []).find(
        (entry) =>
          entry.matchup_id === myMatchup.matchup_id && entry.roster_id !== roster.roster_id,
      )
    : null;
  const opponentRoster = opponentEntry
    ? (rosters ?? []).find((entry) => entry.roster_id === opponentEntry.roster_id)
    : null;
  const opponentUser = opponentRoster
    ? (leagueUsers ?? []).find((entry) => entry.user_id === opponentRoster.owner_id)
    : null;

  // Every player already owned by somebody, so waiver logic can skip them.
  const ownedPlayerIds = new Set();
  for (const entry of rosters ?? []) {
    for (const playerId of entry.players ?? []) ownedPlayerIds.add(String(playerId));
  }

  return {
    season, week, state, user, league: detail ?? league, roster,
    rosters: rosters ?? [], leagueUsers: leagueUsers ?? [],
    matchups: matchups ?? [], players, projections, ownedPlayerIds,
    opponent: opponentUser
      ? { name: opponentUser.display_name, points: opponentEntry?.points ?? 0 }
      : null,
    describePlayer: (id) => playerName(players[String(id)]),
  };
}
