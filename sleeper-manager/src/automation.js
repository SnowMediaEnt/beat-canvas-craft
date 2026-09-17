// Makes the actual changes on sleeper.com by driving the website.
//
// HONEST WARNING, please read before turning AUTO_SET_LINEUP on:
// The selectors in config/selectors.json were written without access to
// sleeper.com, so the click targets below are informed guesses. Run
// `npm run capture` once on a machine that can reach Sleeper, correct the
// selectors, and confirm a dry run looks right before letting this loose.
//
// Every function here refuses to guess. If it cannot find what it expects it
// saves a screenshot and throws, rather than clicking something at random.
import {
  openBrowser, ensureLoggedIn, loadSelectors, findFirst, captureDebug, pause, saveSession,
} from './browser.js';
import { config } from './config.js';

/**
 * Applies lineup changes on the website.
 * @param {object[]} changes from diffLineup(): each has .out and .in
 */
export async function applyLineupChanges({ leagueId, changes }) {
  if (changes.length === 0) return { applied: [], failed: [] };

  const selectors = await loadSelectors();
  const { browser, context, page } = await openBrowser();
  const applied = [];
  const failed = [];

  try {
    await ensureLoggedIn(page, context, selectors);

    const url = selectors.team.urlTemplate.replace('{leagueId}', leagueId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await pause(1500, 2500);

    for (const change of changes) {
      if (!change.in || !change.out) {
        failed.push({ change, reason: 'Slot was empty on one side; needs a human.' });
        continue;
      }

      try {
        await swapPlayers(page, selectors, change.out.name, change.in.name);
        applied.push(change);
        await pause(1200, 2400);
      } catch (error) {
        const dump = await captureDebug(page, `swap-failed-${change.in.id}`);
        failed.push({ change, reason: `${error.message} (see ${dump}.png)` });
      }
    }

    // Some Sleeper views save as you go; others need an explicit save.
    const save = await findFirst(page, selectors.team.saveButton, { timeout: 3000 });
    if (save) {
      await save.click();
      await pause(1500, 2500);
    }

    await saveSession(context);
  } finally {
    await browser.close();
  }

  return { applied, failed };
}

/**
 * Swaps a bench player into the lineup in place of a starter.
 *
 * Sleeper's roster page works as a two-tap swap: tap the player coming out,
 * then tap the player going in. If that interaction has changed, this throws
 * rather than clicking blindly.
 */
async function swapPlayers(page, selectors, outName, inName) {
  const outRow = await findPlayerRow(page, selectors, outName);
  if (!outRow) throw new Error(`Could not find "${outName}" on the roster page.`);

  await outRow.click();
  await pause(600, 1200);

  const inRow = await findPlayerRow(page, selectors, inName);
  if (!inRow) throw new Error(`Could not find "${inName}" on the roster page.`);

  await inRow.click();
  await pause(800, 1500);
}

/** Finds a player's row by the name shown on screen. */
async function findPlayerRow(page, selectors, name) {
  // Last names are more reliable than full names, since Sleeper abbreviates
  // first names on narrow layouts.
  const lastName = name.split(' ').slice(-1)[0];

  for (const selector of selectors.team.playerRow) {
    const row = page.locator(selector).filter({ hasText: lastName }).first();
    if ((await row.count()) > 0 && (await row.isVisible().catch(() => false))) return row;
  }

  const fallback = page.getByText(lastName, { exact: false }).first();
  if ((await fallback.count()) > 0 && (await fallback.isVisible().catch(() => false))) {
    return fallback;
  }
  return null;
}

/**
 * Submits waiver claims. Each recommendation has .add, .drop and .bid.
 */
export async function applyWaiverClaims({ leagueId, claims }) {
  if (claims.length === 0) return { applied: [], failed: [] };

  const selectors = await loadSelectors();
  const { browser, context, page } = await openBrowser();
  const applied = [];
  const failed = [];

  try {
    await ensureLoggedIn(page, context, selectors);

    const url = selectors.waivers.urlTemplate.replace('{leagueId}', leagueId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await pause(1500, 2500);

    for (const claim of claims) {
      try {
        const search = await findFirst(page, selectors.waivers.searchInput);
        if (!search) throw new Error('Could not find the player search box.');

        await search.click();
        await search.fill('');
        await search.type(claim.add.name, { delay: 80 });
        await pause(1200, 2000);

        const claimButton = await findFirst(page, selectors.waivers.claimButton);
        if (!claimButton) throw new Error(`No claim button appeared for ${claim.add.name}.`);
        await claimButton.click();
        await pause(800, 1500);

        // Fill in a FAAB bid when the league uses one.
        const bidField = await findFirst(page, selectors.waivers.bidInput, { timeout: 3000 });
        if (bidField) {
          await bidField.fill(String(claim.bid));
          await pause(400, 800);
        }

        const confirm = await findFirst(page, selectors.waivers.confirmButton);
        if (!confirm) throw new Error('Could not find the confirm button.');
        await confirm.click();
        await pause(1500, 2500);

        applied.push(claim);
      } catch (error) {
        const dump = await captureDebug(page, `waiver-failed-${claim.add.id}`);
        failed.push({ claim, reason: `${error.message} (see ${dump}.png)` });
      }
    }

    await saveSession(context);
  } finally {
    await browser.close();
  }

  return { applied, failed };
}
