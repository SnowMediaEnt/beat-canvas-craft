#!/usr/bin/env node
// Keeps the bot running and does the work on a schedule.
// Start it with: npm start
//
// Times are in the timezone set by TIMEZONE in your .env.
import cron from 'node-cron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';

const CLI = path.join(config.root, 'src', 'cli.js');

function runCommand(label, args) {
  console.log(`[${new Date().toISOString()}] ${label}`);
  const child = spawn(process.execPath, [CLI, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log(`[${new Date().toISOString()}] ${label} finished (exit ${code})`);
  });
}

const lineupArgs = () => (config.permissions.autoSetLineup ? ['lineup', '--apply'] : ['lineup']);
const waiverArgs = () => (config.permissions.autoClaimWaivers ? ['waivers', '--apply'] : ['waivers']);

const schedule = (expression, label, args) =>
  cron.schedule(expression, () => runCommand(label, args), { timezone: config.timezone });

// Tuesday morning, after waivers have processed: look at the wire.
schedule('0 9 * * 2', 'Tuesday waiver review', waiverArgs());

// Wednesday morning: put claims in for the coming week.
schedule('0 9 * * 3', 'Wednesday waiver claims', waiverArgs());

// Saturday evening: early look at the lineup.
schedule('0 18 * * 6', 'Saturday lineup check', lineupArgs());

// Sunday 11am ET, roughly two hours before the early games lock.
schedule('0 11 * * 0', 'Sunday morning lineup', lineupArgs());

// Sunday 12:45pm ET, the last sensible moment before the 1pm kickoffs.
schedule('45 12 * * 0', 'Sunday final lineup', lineupArgs());

// Thursday evening, for anyone starting a Thursday night player.
schedule('0 19 * * 4', 'Thursday lineup check', lineupArgs());

console.log('Sleeper manager is running.');
console.log(`  timezone:      ${config.timezone}`);
console.log(`  auto lineup:   ${config.permissions.autoSetLineup}`);
console.log(`  auto waivers:  ${config.permissions.autoClaimWaivers}`);
console.log('  trades:        never automated, by design');
console.log('\nScheduled: Tue 9am, Wed 9am, Thu 7pm, Sat 6pm, Sun 11am, Sun 12:45pm');
