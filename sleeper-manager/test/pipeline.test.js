// End-to-end check of the read path: fake Sleeper responses go in, a lineup
// plan comes out. This proves the API client, snapshot builder, projection
// fallback and optimizer all fit together, without touching the network.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SLEEPER_USERNAME = 'testmanager';
process.env.SLEEPER_LEAGUE_ID = 'league1';
process.env.LINEUP_SWAP_THRESHOLD = '1.5';
// Keep the test hermetic: never read or write the on-disk player cache.
process.env.SLEEPER_DISABLE_CACHE = '1';

const PLAYERS = {
  p_qb: { full_name: 'Test QB', fantasy_positions: ['QB'], team: 'KC' },
  p_rb1: { full_name: 'Test RB One', fantasy_positions: ['RB'], team: 'SF' },
  p_rb2: { full_name: 'Test RB Two', fantasy_positions: ['RB'], team: 'DET' },
  p_rb3: { full_name: 'Bench RB', fantasy_positions: ['RB'], team: 'GB' },
  p_wr1: { full_name: 'Test WR One', fantasy_positions: ['WR'], team: 'MIN' },
  p_wr2: { full_name: 'Test WR Two', fantasy_positions: ['WR'], team: 'CIN' },
  p_te: { full_name: 'Test TE', fantasy_positions: ['TE'], team: 'BAL' },
  p_k: { full_name: 'Test K', fantasy_positions: ['K'], team: 'DAL' },
  p_def: { first_name: 'Test', last_name: 'Defense', fantasy_positions: ['DEF'], position: 'DEF', team: 'DEN' },
  p_hurt: { full_name: 'Hurt Starter', fantasy_positions: ['WR'], team: 'LAR', injury_status: 'Out' },
  p_cold: { full_name: 'Cold Bench RB', fantasy_positions: ['RB'], team: 'CHI' },
  p_free: { full_name: 'Waiver Gem', fantasy_positions: ['RB'], team: 'NYJ' },
};

// Week 3 scores, so the history fallback has something to average.
const WEEK_SCORES = {
  p_qb: 24, p_rb1: 19, p_rb2: 12, p_rb3: 15, p_wr1: 16,
  p_wr2: 11, p_te: 9, p_k: 8, p_def: 6, p_hurt: 20, p_cold: 1.5,
};

const ROUTES = {
  '/v1/state/nfl': { season: '2026', week: 4, season_type: 'regular' },
  '/v1/user/testmanager': { user_id: 'u1', display_name: 'testmanager' },
  '/v1/user/u1/leagues/nfl/2026': [
    { league_id: 'league1', name: 'Test League', season: '2026' },
  ],
  '/v1/league/league1': {
    league_id: 'league1',
    name: 'Test League',
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN'],
    scoring_settings: { rec: 1 },
    settings: { waiver_budget: 100 },
  },
  '/v1/league/league1/rosters': [
    {
      roster_id: 1,
      owner_id: 'u1',
      players: Object.keys(PLAYERS).filter((id) => id !== 'p_free'),
      // Deliberately wrong: an Out player is starting and a good RB is benched.
      starters: ['p_qb', 'p_rb1', 'p_rb2', 'p_wr1', 'p_hurt', 'p_te', 'p_wr2', 'p_k', 'p_def'],
      settings: { wins: 2, losses: 1, waiver_budget_used: 10 },
    },
    { roster_id: 2, owner_id: 'u2', players: [], starters: [], settings: {} },
  ],
  '/v1/league/league1/users': [
    { user_id: 'u1', display_name: 'testmanager' },
    { user_id: 'u2', display_name: 'Rival' },
  ],
  '/v1/players/nfl': PLAYERS,
  '/v1/players/nfl/trending/add': [{ player_id: 'p_free', count: 45_000 }],
};

function matchupsFor(week) {
  if (week >= 4) {
    return [
      { roster_id: 1, matchup_id: 1, points: 0, players_points: {} },
      { roster_id: 2, matchup_id: 1, points: 0, players_points: {} },
    ];
  }
  return [
    { roster_id: 1, matchup_id: 1, points: 90, players_points: WEEK_SCORES },
    { roster_id: 2, matchup_id: 1, points: 85, players_points: {} },
  ];
}

// Stand in for the network. Returns 404 for the undocumented projections
// endpoint, which forces the scoring-history fallback to be exercised.
globalThis.fetch = async (url) => {
  const { pathname, searchParams } = new URL(url);
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if (pathname.startsWith('/projections/')) return json({ error: 'not found' }, 404);

  const matchup = pathname.match(/^\/v1\/league\/league1\/matchups\/(\d+)$/);
  if (matchup) return json(matchupsFor(Number(matchup[1])));

  if (pathname === '/v1/players/nfl/trending/add') return json(ROUTES[pathname]);
  if (pathname in ROUTES) return json(ROUTES[pathname]);

  void searchParams;
  return json({ error: `unmocked ${pathname}` }, 404);
};

test('builds a full snapshot and spots the broken lineup', async () => {
  const { loadSnapshot } = await import('../src/league.js');
  const { optimizeLineup, diffLineup, getStartingSlots } = await import('../src/lineup.js');

  const snapshot = await loadSnapshot();

  assert.equal(snapshot.season, '2026');
  assert.equal(snapshot.week, 4);
  assert.equal(snapshot.league.name, 'Test League');
  assert.equal(snapshot.opponent?.name, 'Rival');
  // The undocumented endpoint 404'd, so we must have fallen back.
  assert.equal(snapshot.projections.source, 'scoring-history');
  // And the fallback must actually have produced numbers.
  assert.ok(snapshot.projections.get('p_rb1') > 0, 'no projection came through');
  // The Out player must be scored at zero regardless of his history.
  assert.equal(snapshot.projections.get('p_hurt'), 0);

  const slots = getStartingSlots(snapshot.league.roster_positions);
  const optimal = optimizeLineup({
    rosterPlayerIds: snapshot.roster.players,
    rosterPositions: snapshot.league.roster_positions,
    players: snapshot.players,
    projections: snapshot.projections,
  });

  assert.ok(!optimal.starters.includes('p_hurt'), 'the Out player is still starting');
  assert.ok(optimal.starters.includes('p_rb3'), 'the strong bench RB was not promoted');

  const diff = diffLineup({
    current: snapshot.roster.starters,
    optimal: optimal.starters,
    slots,
    players: snapshot.players,
    projections: snapshot.projections,
    threshold: 1.5,
  });

  assert.ok(diff.meaningful.length > 0, 'no changes were recommended');
  assert.ok(
    diff.meaningful.some((change) => change.out?.id === 'p_hurt'),
    'benching the Out player was not recommended',
  );
});

test('recommends the trending free agent and sizes the bid', async () => {
  const { loadSnapshot } = await import('../src/league.js');
  const { recommendWaivers } = await import('../src/waivers.js');

  const snapshot = await loadSnapshot();
  const claims = await recommendWaivers(snapshot, { maxClaims: 2, faabMaxBidPct: 15 });

  assert.equal(claims.length, 1);
  assert.equal(claims[0].add.name, 'Waiver Gem');
  // $100 budget, $10 already spent, 15% of the $90 remaining.
  assert.equal(claims[0].faabRemaining, 90);
  assert.equal(claims[0].bid, 14);
  assert.equal(claims[0].drop?.name, 'Cold Bench RB');
  assert.equal(claims[0].speculative, true);
  assert.match(claims[0].reason, /speculative/);
});

test('the email report renders without a mail server configured', async () => {
  const { sendReport, lineupRows } = await import('../src/notify.js');
  const result = await sendReport({
    title: 'Test report',
    subtitle: 'Test League',
    sections: [{ heading: 'Lineup', rows: lineupRows([]) }],
  });
  assert.equal(result.sent, false);
});
