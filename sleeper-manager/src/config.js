// Loads settings from the .env file and fails loudly when something required
// is missing, so problems show up at startup instead of halfway through a run.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got "${raw}".`);
  }
  return parsed;
}

export const config = {
  root: ROOT,
  authStatePath: path.join(ROOT, '.auth', 'sleeper-session.json'),
  cacheDir: path.join(ROOT, '.cache'),
  debugDir: path.join(ROOT, 'debug'),

  sleeper: {
    username: process.env.SLEEPER_USERNAME?.trim() ?? '',
    password: process.env.SLEEPER_PASSWORD ?? '',
    leagueId: process.env.SLEEPER_LEAGUE_ID?.trim() || null,
  },

  permissions: {
    autoSetLineup: bool('AUTO_SET_LINEUP', false),
    autoClaimWaivers: bool('AUTO_CLAIM_WAIVERS', false),
    // Deliberately ignored everywhere. Trades stay a human decision.
    autoTrades: false,
  },

  strategy: {
    swapThreshold: num('LINEUP_SWAP_THRESHOLD', 1.5),
    maxWaiverClaims: num('MAX_WAIVER_CLAIMS', 2),
    faabMaxBidPct: num('FAAB_MAX_BID_PCT', 15),
  },

  email: {
    to: process.env.ALERT_EMAIL_TO?.trim() ?? '',
    host: process.env.SMTP_HOST?.trim() ?? '',
    port: num('SMTP_PORT', 465),
    secure: bool('SMTP_SECURE', true),
    user: process.env.SMTP_USER?.trim() ?? '',
    pass: process.env.SMTP_PASS ?? '',
  },

  headless: bool('HEADLESS', true),
  timezone: process.env.TIMEZONE?.trim() || 'America/New_York',
};

/**
 * Checks that the settings needed for a given job are present.
 * `needs` can include 'read', 'write' and 'email'.
 */
export function requireConfig(...needs) {
  const missing = [];

  if (needs.includes('read') && !config.sleeper.username) {
    missing.push('SLEEPER_USERNAME');
  }
  if (needs.includes('write') && !config.sleeper.password) {
    missing.push('SLEEPER_PASSWORD');
  }
  if (needs.includes('email')) {
    for (const [key, value] of Object.entries({
      ALERT_EMAIL_TO: config.email.to,
      SMTP_HOST: config.email.host,
      SMTP_USER: config.email.user,
      SMTP_PASS: config.email.pass,
    })) {
      if (!value) missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required settings in .env: ${missing.join(', ')}.\n` +
        'Copy .env.example to .env and fill those in.',
    );
  }
}

export const emailConfigured = () =>
  Boolean(config.email.to && config.email.host && config.email.user && config.email.pass);
