// Shared browser plumbing for anything that has to act on sleeper.com.
//
// Sleeper's public API is read-only, so the only way to actually change a
// lineup is to drive the website the same way a person would. That is what
// this file sets up.
//
// Two habits here keep the traffic looking ordinary and reduce the chance of
// the account being flagged:
//   * the login session is saved to disk and reused, so the bot logs in once
//     every few weeks rather than several times a day
//   * actions are paced with small random pauses instead of firing instantly
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from './config.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export const pause = (min = 400, max = 1200) =>
  new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

/** Tries each selector in turn and returns the first one present on the page. */
export async function findFirst(page, candidates, { timeout = 8000 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of list) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
        return locator;
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

/** Saves a screenshot and the page HTML so a failure can be diagnosed later. */
export async function captureDebug(page, label) {
  await fs.mkdir(config.debugDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(config.debugDir, `${stamp}-${label}`);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  await fs.writeFile(`${base}.html`, await page.content().catch(() => '')).catch(() => {});
  return base;
}

export async function loadSelectors() {
  const file = path.join(config.root, 'config', 'selectors.json');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/**
 * Opens a browser, restoring a saved login session when one exists.
 * Always close the returned `browser` when finished.
 */
export async function openBrowser({ headless = config.headless } = {}) {
  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  let storageState;
  try {
    await fs.access(config.authStatePath);
    storageState = config.authStatePath;
  } catch {
    storageState = undefined;
  }

  const context = await browser.newContext({
    storageState,
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: config.timezone,
  });

  // Hide the flag that marks the browser as automated.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return { browser, context, page: await context.newPage() };
}

export async function saveSession(context) {
  await fs.mkdir(path.dirname(config.authStatePath), { recursive: true });
  await context.storageState({ path: config.authStatePath });
}

/**
 * Makes sure we are logged in, reusing the saved session when possible.
 * Throws with a clear message when the credentials or selectors are wrong.
 */
export async function ensureLoggedIn(page, context, selectors) {
  const { login } = selectors;

  await page.goto(login.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await pause();

  // A restored session usually lands us straight past the login form.
  if (await findFirst(page, login.successIndicator, { timeout: 4000 })) {
    return { reusedSession: true };
  }

  const emailField = await findFirst(page, login.emailInput);
  const passwordField = await findFirst(page, login.passwordInput);

  if (!emailField || !passwordField) {
    const dump = await captureDebug(page, 'login-form-not-found');
    throw new Error(
      'Could not find the login form on sleeper.com.\n' +
        `The page was saved to ${dump}.html so the selectors can be corrected.\n` +
        'Run `npm run capture` and update config/selectors.json.',
    );
  }

  // Type rather than paste, at a human-ish speed.
  await emailField.click();
  await emailField.fill('');
  await emailField.type(config.sleeper.username, { delay: 60 + Math.random() * 60 });
  await pause(200, 600);

  await passwordField.click();
  await passwordField.fill('');
  await passwordField.type(config.sleeper.password, { delay: 60 + Math.random() * 60 });
  await pause(300, 900);

  const submit = await findFirst(page, login.submitButton);
  if (submit) await submit.click();
  else await passwordField.press('Enter');

  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await pause(1000, 2000);

  if (await findFirst(page, login.successIndicator, { timeout: 12_000 })) {
    await saveSession(context);
    return { reusedSession: false };
  }

  const error = await findFirst(page, login.errorMessage, { timeout: 2000 });
  const message = error ? await error.textContent().catch(() => null) : null;
  const dump = await captureDebug(page, 'login-failed');

  throw new Error(
    `Login to Sleeper failed${message ? `: ${message.trim()}` : '.'}\n` +
      `Screenshot saved to ${dump}.png.\n` +
      'Common causes: wrong password, a two-factor prompt, or the login page ' +
      'having changed. If you sign in with Google or Apple rather than a ' +
      'password, this bot cannot log in for you.',
  );
}
