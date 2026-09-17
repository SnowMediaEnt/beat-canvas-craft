#!/usr/bin/env node
// Run this ONCE on a machine that can reach sleeper.com:  npm run capture
//
// It logs in, saves screenshots and page HTML into ./debug, and prints the
// most likely selectors for every field the bot needs. Paste the ones that
// look right into config/selectors.json.
//
// This exists because the machine that wrote this bot could not reach
// sleeper.com, so the shipped selectors are guesses.
import { openBrowser, ensureLoggedIn, loadSelectors, captureDebug, pause } from './browser.js';
import { config, requireConfig } from './config.js';
import { loadSnapshot } from './league.js';

async function describeCandidates(page, label, description) {
  const found = await page.evaluate((desc) => {
    const results = [];
    const seen = new Set();

    for (const element of document.querySelectorAll(desc.query)) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const parts = [];
      if (element.id) parts.push(`#${element.id}`);
      if (element.name) parts.push(`[name='${element.name}']`);
      if (element.type) parts.push(`${element.tagName.toLowerCase()}[type='${element.type}']`);
      if (element.placeholder) parts.push(`[placeholder='${element.placeholder}']`);
      for (const cls of String(element.className || '').split(/\s+/).filter(Boolean).slice(0, 2)) {
        parts.push(`.${cls}`);
      }

      const text = (element.textContent || '').trim().slice(0, 40);
      const key = parts.join('') + text;
      if (seen.has(key) || parts.length === 0) continue;
      seen.add(key);
      results.push({ selectors: parts, text });
    }
    return results.slice(0, 12);
  }, description);

  console.log(`\n  ${label}`);
  if (found.length === 0) {
    console.log('    nothing found');
    return;
  }
  for (const entry of found) {
    console.log(`    ${entry.selectors.join('  ')}${entry.text ? `   "${entry.text}"` : ''}`);
  }
}

async function main() {
  requireConfig('read', 'write');
  const selectors = await loadSelectors();

  console.log('Looking up your league through the public API first...');
  const snapshot = await loadSnapshot();
  console.log(`  League: ${snapshot.league.name} (${snapshot.league.league_id})`);
  console.log(`  Team:   ${snapshot.user.display_name}`);

  // Always show the browser during capture so you can see what is happening.
  const { browser, context, page } = await openBrowser({ headless: false });

  try {
    console.log('\nOpening the login page...');
    await page.goto(selectors.login.url, { waitUntil: 'domcontentloaded' });
    await pause(2000, 3000);

    await describeCandidates(page, 'LOGIN - text and email inputs', {
      query: "input[type='text'], input[type='email'], input:not([type])",
    });
    await describeCandidates(page, 'LOGIN - password inputs', {
      query: "input[type='password']",
    });
    await describeCandidates(page, 'LOGIN - buttons', { query: 'button, [role=button]' });
    console.log(`\n  saved: ${await captureDebug(page, 'login-page')}.png`);

    console.log('\nLogging in...');
    await ensureLoggedIn(page, context, selectors);
    console.log('  logged in');

    const teamUrl = selectors.team.urlTemplate.replace('{leagueId}', snapshot.league.league_id);
    console.log(`\nOpening your team page: ${teamUrl}`);
    await page.goto(teamUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await pause(3000, 4000);

    await describeCandidates(page, 'TEAM - likely player rows', {
      query: "[class*='player'], [class*='roster'], [class*='slot']",
    });
    await describeCandidates(page, 'TEAM - buttons', { query: 'button, [role=button]' });
    console.log(`\n  saved: ${await captureDebug(page, 'team-page')}.png`);

    console.log(
      '\nDone. Screenshots and HTML are in ./debug.\n' +
        'Update config/selectors.json with the selectors above, then run:\n' +
        '  npm run lineup        (shows what it would change, changes nothing)\n',
    );
    console.log('Leaving the browser open for 60 seconds so you can look around.');
    await page.waitForTimeout(60_000);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`\nCapture failed: ${error.message}`);
  process.exit(1);
});
