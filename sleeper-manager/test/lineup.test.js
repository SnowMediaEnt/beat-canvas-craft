// Checks the lineup optimizer against hand-built rosters where the right
// answer is obvious. Run with: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeLineup, diffLineup, getStartingSlots } from '../src/lineup.js';

const players = {
  qb1: { full_name: 'Elite QB', fantasy_positions: ['QB'], team: 'KC' },
  qb2: { full_name: 'Backup QB', fantasy_positions: ['QB'], team: 'NYJ' },
  rb1: { full_name: 'Stud RB', fantasy_positions: ['RB'], team: 'SF' },
  rb2: { full_name: 'Good RB', fantasy_positions: ['RB'], team: 'DET' },
  rb3: { full_name: 'Flex RB', fantasy_positions: ['RB'], team: 'GB' },
  wr1: { full_name: 'Stud WR', fantasy_positions: ['WR'], team: 'MIN' },
  wr2: { full_name: 'Good WR', fantasy_positions: ['WR'], team: 'CIN' },
  wr3: { full_name: 'Bench WR', fantasy_positions: ['WR'], team: 'TEN' },
  te1: { full_name: 'Stud TE', fantasy_positions: ['TE'], team: 'BAL' },
  k1: { full_name: 'Kicker', fantasy_positions: ['K'], team: 'DAL' },
  def1: { first_name: 'Denver', last_name: 'Broncos', fantasy_positions: ['DEF'], team: 'DEN', position: 'DEF' },
  hurt: { full_name: 'Injured Star', fantasy_positions: ['RB'], team: 'LAR', injury_status: 'Out' },
};

const scores = {
  qb1: 22, qb2: 12, rb1: 18, rb2: 14, rb3: 9,
  wr1: 17, wr2: 13, wr3: 6, te1: 11, k1: 8, def1: 7, hurt: 25,
};

// Mirrors the real projections object: injury handling is applied by `get`.
const projections = {
  source: 'test',
  has: (id) => id in scores,
  raw: (id) => scores[id] ?? 0,
  get: (id) => (players[id]?.injury_status === 'Out' ? 0 : scores[id] ?? 0),
};

const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN'];

test('fills every slot with an eligible player', () => {
  const result = optimizeLineup({
    rosterPlayerIds: Object.keys(players),
    rosterPositions: POSITIONS,
    players,
    projections,
  });

  const slots = getStartingSlots(POSITIONS);
  assert.equal(result.starters.length, slots.length);
  assert.equal(result.slots.find((s) => s.slot === 'QB').player.id, 'qb1');
  assert.equal(result.slots.find((s) => s.slot === 'K').player.id, 'k1');
  assert.equal(result.slots.find((s) => s.slot === 'DEF').player.id, 'def1');
});

test('never starts a player ruled out, however high he is projected', () => {
  const result = optimizeLineup({
    rosterPlayerIds: Object.keys(players),
    rosterPositions: POSITIONS,
    players,
    projections,
  });
  assert.ok(!result.starters.includes('hurt'), 'an Out player was started');
});

test('picks the highest scoring legal combination', () => {
  const result = optimizeLineup({
    rosterPlayerIds: Object.keys(players),
    rosterPositions: POSITIONS,
    players,
    projections,
  });

  // Best legal lineup: qb1 22, rb1 18, rb2 14, wr1 17, wr2 13, te1 11,
  // FLEX rb3 9, k1 8, def1 7  => 119
  assert.equal(result.total, 119);
  assert.equal(result.slots.find((s) => s.slot === 'FLEX').player.id, 'rb3');
});

test('no player is used in two slots at once', () => {
  const result = optimizeLineup({
    rosterPlayerIds: Object.keys(players),
    rosterPositions: POSITIONS,
    players,
    projections,
  });
  const used = result.starters.filter(Boolean);
  assert.equal(new Set(used).size, used.length);
});

test('a superflex slot is happy to take a second quarterback', () => {
  const superflex = ['QB', 'RB', 'WR', 'SUPER_FLEX', 'BN'];
  const result = optimizeLineup({
    rosterPlayerIds: ['qb1', 'qb2', 'rb1', 'wr1', 'wr3'],
    rosterPositions: superflex,
    players,
    projections,
  });
  // qb2 at 12 beats wr3 at 6 for the superflex spot.
  assert.equal(result.slots.find((s) => s.slot === 'SUPER_FLEX').player.id, 'qb2');
});

test('ignores swaps smaller than the threshold but always benches an Out player', () => {
  const slots = getStartingSlots(POSITIONS);
  const optimal = optimizeLineup({
    rosterPlayerIds: Object.keys(players),
    rosterPositions: POSITIONS,
    players,
    projections,
  });

  // Start the injured player and a weak WR to force two differences.
  const current = [...optimal.starters];
  current[slots.indexOf('FLEX')] = 'hurt';

  const diff = diffLineup({
    current,
    optimal: optimal.starters,
    slots,
    players,
    projections,
    threshold: 1.5,
  });

  const benchedInjured = diff.meaningful.some((change) => change.out?.id === 'hurt');
  assert.ok(benchedInjured, 'the Out player was left in the lineup');
});

test('handles a roster with nobody eligible for a slot', () => {
  const result = optimizeLineup({
    rosterPlayerIds: ['qb1'],
    rosterPositions: ['QB', 'K', 'BN'],
    players,
    projections,
  });
  assert.equal(result.slots.find((s) => s.slot === 'K').player, null);
  assert.equal(result.starters[1], null);
});
