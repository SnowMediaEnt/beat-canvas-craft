#!/usr/bin/env node
// The bot's command line.
//
//   npm run check           what your team looks like right now
//   npm run lineup          what it would change, without changing anything
//   npm run lineup:apply    actually set the lineup on sleeper.com
//   npm run waivers         waiver pickups it recommends
//   npm run waivers:apply   actually put those claims in
//
// Nothing changes your team unless you pass --apply. That is deliberate.
import { config, requireConfig } from './config.js';
import { loadSnapshot } from './league.js';
import { optimizeLineup, diffLineup, getStartingSlots } from './lineup.js';
import { recommendWaivers } from './waivers.js';
import { applyLineupChanges, applyWaiverClaims } from './automation.js';
import { sendReport, lineupRows, waiverRows, points } from './notify.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'check';
const apply = args.includes('--apply');
const quiet = args.includes('--quiet');

const log = (...parts) => {
  if (!quiet) console.log(...parts);
};

/** Builds the lineup plan. Shared by `lineup` and the scheduler. */
async function planLineup(snapshot) {
  const slots = getStartingSlots(snapshot.league.roster_positions ?? []);

  const optimal = optimizeLineup({
    rosterPlayerIds: snapshot.roster.players,
    rosterPositions: snapshot.league.roster_positions ?? [],
    players: snapshot.players,
    projections: snapshot.projections,
  });

  const diff = diffLineup({
    current: snapshot.roster.starters,
    optimal: optimal.starters,
    slots,
    players: snapshot.players,
    projections: snapshot.projections,
    threshold: config.strategy.swapThreshold,
  });

  return { slots, optimal, diff };
}

async function commandCheck() {
  requireConfig('read');
  const snapshot = await loadSnapshot();
  const { optimal, diff } = await planLineup(snapshot);

  log(`\n${snapshot.league.name} — week ${snapshot.week}, ${snapshot.season}`);
  log(`Team: ${snapshot.user.display_name}`);
  log(
    `Record: ${snapshot.roster.settings?.wins ?? 0}-${snapshot.roster.settings?.losses ?? 0}` +
      (snapshot.opponent ? `   ·   This week vs ${snapshot.opponent.name}` : ''),
  );
  log(`Projections from: ${snapshot.projections.source}\n`);

  log('Best available lineup:');
  for (const { slot, player } of optimal.slots) {
    const label = player
      ? `${player.name} (${player.position} ${player.team})${player.status ? ` [${player.status}]` : ''}`
      : '— empty —';
    log(`  ${slot.padEnd(11)} ${points(player?.points).padStart(6)}   ${label}`);
  }
  log(`  ${''.padEnd(11)} ${points(optimal.total).padStart(6)}   TOTAL\n`);

  if (diff.meaningful.length === 0) {
    log('Your lineup is already the best one available. Nothing to change.');
  } else {
    log(`${diff.meaningful.length} change(s) worth making, worth ${points(diff.projectedGain)} points:`);
    for (const row of lineupRows(diff.meaningful)) log(`  ${row.label} — ${row.value}`);
  }

  return { snapshot, optimal, diff };
}

async function commandLineup() {
  const { snapshot, diff } = await commandCheck();

  const sections = [
    {
      heading: `Week ${snapshot.week} lineup`,
      note: apply ? 'These changes were applied.' : 'Suggested only. Nothing was changed.',
      rows: lineupRows(diff.meaningful),
    },
  ];

  if (apply && diff.meaningful.length > 0) {
    if (!config.permissions.autoSetLineup) {
      throw new Error(
        'AUTO_SET_LINEUP is false in your .env, so --apply is refused.\n' +
          'Set it to true once you are happy with what the bot suggests.',
      );
    }
    requireConfig('write');

    log('\nApplying changes on sleeper.com...');
    const result = await applyLineupChanges({
      leagueId: snapshot.league.league_id,
      changes: diff.meaningful,
    });

    log(`  applied: ${result.applied.length}, failed: ${result.failed.length}`);
    sections[0].rows = lineupRows(result.applied);
    if (result.failed.length > 0) {
      sections.push({
        heading: 'Could not be changed automatically',
        note: 'Do these by hand in the Sleeper app.',
        rows: result.failed.map((entry) => ({
          label: `${entry.change.slot}: ${entry.change.in?.name ?? '?'}`,
          value: entry.reason,
        })),
      });
    }
  }

  await sendReport({
    title: `Sleeper: week ${snapshot.week} lineup${apply ? ' updated' : ' suggestions'}`,
    subtitle: `${snapshot.league.name}${snapshot.opponent ? ` · vs ${snapshot.opponent.name}` : ''}`,
    sections,
  });
}

async function commandWaivers() {
  requireConfig('read');
  const snapshot = await loadSnapshot();

  const claims = await recommendWaivers(snapshot, {
    maxClaims: config.strategy.maxWaiverClaims,
    faabMaxBidPct: config.strategy.faabMaxBidPct,
  });

  log(`\nWaiver targets for week ${snapshot.week}:`);
  if (claims.length === 0) log('  Nothing on the wire worth adding.');
  for (const row of waiverRows(claims)) log(`  ${row.label} — ${row.value}`);

  const sections = [
    {
      heading: 'Waiver claims',
      note: apply ? 'These claims were submitted.' : 'Suggested only. Nothing was submitted.',
      rows: waiverRows(claims),
    },
  ];

  if (apply && claims.length > 0) {
    if (!config.permissions.autoClaimWaivers) {
      throw new Error('AUTO_CLAIM_WAIVERS is false in your .env, so --apply is refused.');
    }
    requireConfig('write');

    log('\nSubmitting claims on sleeper.com...');
    const result = await applyWaiverClaims({
      leagueId: snapshot.league.league_id,
      claims,
    });
    log(`  submitted: ${result.applied.length}, failed: ${result.failed.length}`);
    sections[0].rows = waiverRows(result.applied);
    if (result.failed.length > 0) {
      sections.push({
        heading: 'Could not be claimed automatically',
        rows: result.failed.map((entry) => ({
          label: entry.claim.add.name,
          value: entry.reason,
        })),
      });
    }
  }

  await sendReport({
    title: `Sleeper: week ${snapshot.week} waiver ${apply ? 'claims' : 'targets'}`,
    subtitle: snapshot.league.name,
    sections,
  });
}

const COMMANDS = { check: commandCheck, lineup: commandLineup, waivers: commandWaivers };

const run = COMMANDS[command];
if (!run) {
  console.error(`Unknown command "${command}". Try: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(1);
}

run().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
