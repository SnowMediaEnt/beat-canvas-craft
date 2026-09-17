// Read-only client for Sleeper's public API.
//
// Nothing here needs a password or an API key, and nothing here can change
// your team. Every endpoint below is documented at https://docs.sleeper.com.
// Making actual roster moves happens in automation.js instead.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const BASE = 'https://api.sleeper.app/v1';

// Sleeper asks for under 1000 calls per minute. We are nowhere near that, but
// a small delay between calls keeps the traffic pattern unremarkable.
const POLITE_DELAY_MS = 120;
let lastCallAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, { retries = 3 } = {}) {
  const since = Date.now() - lastCallAt;
  if (since < POLITE_DELAY_MS) await sleep(POLITE_DELAY_MS - since);

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      lastCallAt = Date.now();

      if (response.status === 404) return null;
      if (response.status === 429) {
        // Rate limited. Back off hard before trying again.
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!response.ok) {
        throw new Error(`Sleeper returned ${response.status} for ${url}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`Could not reach Sleeper at ${url}: ${lastError?.message}`);
}

/** Current NFL season and week, straight from Sleeper. */
export const getNflState = () => getJson(`${BASE}/state/nfl`);

/** Looks up an account by username. Sleeper also accepts the login email. */
export async function getUser(usernameOrEmail) {
  const user = await getJson(`${BASE}/user/${encodeURIComponent(usernameOrEmail)}`);
  if (!user) {
    throw new Error(
      `Sleeper has no account matching "${usernameOrEmail}". ` +
        'Note that the public lookup usually wants your username, not your email.',
    );
  }
  return user;
}

export const getLeaguesForUser = (userId, season) =>
  getJson(`${BASE}/user/${userId}/leagues/nfl/${season}`);

export const getLeague = (leagueId) => getJson(`${BASE}/league/${leagueId}`);
export const getRosters = (leagueId) => getJson(`${BASE}/league/${leagueId}/rosters`);
export const getLeagueUsers = (leagueId) => getJson(`${BASE}/league/${leagueId}/users`);
export const getMatchups = (leagueId, week) =>
  getJson(`${BASE}/league/${leagueId}/matchups/${week}`);
export const getTransactions = (leagueId, week) =>
  getJson(`${BASE}/league/${leagueId}/transactions/${week}`);

/** Players most added across all of Sleeper in the last `lookbackHours`. */
export const getTrendingAdds = (lookbackHours = 24, limit = 50) =>
  getJson(`${BASE}/players/nfl/trending/add?lookback_hours=${lookbackHours}&limit=${limit}`);

export const getTrendingDrops = (lookbackHours = 24, limit = 50) =>
  getJson(`${BASE}/players/nfl/trending/drop?lookback_hours=${lookbackHours}&limit=${limit}`);

/**
 * The full NFL player database. This response is roughly 5 MB, so Sleeper asks
 * that it be fetched at most once a day. We cache it on disk and reuse it.
 */
export async function getAllPlayers({ maxAgeHours = 24 } = {}) {
  // Tests and one-off debugging set this to bypass the cache entirely.
  if (process.env.SLEEPER_DISABLE_CACHE === '1') {
    return getJson(`${BASE}/players/nfl`);
  }

  const cachePath = path.join(config.cacheDir, 'players-nfl.json');

  try {
    const stat = await fs.stat(cachePath);
    const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000;
    if (ageHours < maxAgeHours) {
      return JSON.parse(await fs.readFile(cachePath, 'utf8'));
    }
  } catch {
    // No cache yet, or it is unreadable. Fall through and fetch.
  }

  const players = await getJson(`${BASE}/players/nfl`);
  await fs.mkdir(config.cacheDir, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(players));
  return players;
}

/**
 * Weekly point projections.
 *
 * IMPORTANT: this endpoint is NOT part of Sleeper's documented API. It is what
 * the Sleeper app itself calls, and it can change or disappear without notice.
 * Callers must handle it returning null. projections.js falls back to scoring
 * history when this fails, so the bot keeps working either way.
 */
export async function getWeeklyProjections(season, week, seasonType = 'regular') {
  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const query = positions.map((p) => `position[]=${p}`).join('&');
  const url =
    `https://api.sleeper.app/projections/nfl/${season}/${week}` +
    `?season_type=${seasonType}&order_by=pts_ppr&${query}`;

  try {
    return await getJson(url, { retries: 1 });
  } catch {
    return null;
  }
}
