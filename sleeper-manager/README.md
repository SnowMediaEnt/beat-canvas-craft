# Sleeper Manager

A bot that watches your Sleeper fantasy football team, works out the best
lineup each week, finds waiver pickups, and emails you what it did.

It can run in two modes:

- **Advisor** (the default, and where you should start). It emails you what to
  change. You tap the buttons in the Sleeper app.
- **Autopilot.** It logs into sleeper.com in a background browser and makes the
  changes itself.

Trades are never automated. That is a deliberate choice, not a missing feature.

---

## How it works, in plain terms

Sleeper's official API is **read-only**. It will happily tell you everything
about your league, but it has no way to change anything. There are no write
endpoints and no API key to ask for.

So the bot is in two halves:

1. **Reading** uses the official API. No password, no risk, always reliable.
   This is where all the thinking happens: projections, lineup maths, waiver
   targets.
2. **Writing** drives the actual sleeper.com website in a hidden browser,
   clicking the same things you would. This is the only way to make changes.

Half two is against Sleeper's terms of service. It is not illegal, and it is
your own account, but Sleeper would be within their rights to ban the account
if they noticed. The bot keeps its footprint small (it saves its login and
reuses it, paces its clicks, runs a handful of times a week) but the risk is
never zero. Advisor mode carries no such risk at all.

---

## Setup

### 1. Install

```bash
cd sleeper-manager
npm install
npx playwright install chromium    # only needed for autopilot mode
```

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Setting | What to put |
|---|---|
| `SLEEPER_USERNAME` | Your Sleeper **username** (not your email) |
| `SLEEPER_PASSWORD` | Only needed for autopilot. Leave blank for advisor mode |
| `ALERT_EMAIL_TO` | Where to send the reports |
| `SMTP_USER` / `SMTP_PASS` | The mailbox that sends them. Use an **app password**, not your real one |

> Sleeper's public lookup usually wants your **username**, not the email you
> log in with. If `npm run check` says the account was not found, that is the
> first thing to try. Your username is in the Sleeper app under Account.

For Yahoo mail, generate an app password at
`login.yahoo.com/account/security` → "Generate app password". For Gmail, use
`myaccount.google.com/apppasswords` and set `SMTP_HOST=smtp.gmail.com`.

### 3. Check it can see your team

```bash
npm run check
```

This touches nothing. It prints your roster, the best available lineup, and
anything worth changing. If this works, the hard part is done.

---

## Using it

```bash
npm run check          # show the team and the best lineup. Changes nothing
npm run lineup         # email the lineup changes it recommends
npm run waivers        # email the waiver pickups it recommends
npm start              # run on a schedule, forever
```

Add `--apply` to actually make changes:

```bash
npm run lineup:apply
npm run waivers:apply
```

`--apply` is refused unless you have also set `AUTO_SET_LINEUP=true` (or
`AUTO_CLAIM_WAIVERS=true`) in `.env`. Two locks, so nothing happens by accident.

### The schedule

`npm start` runs these, in your `TIMEZONE`:

| When | What |
|---|---|
| Tuesday 9am | Review the wire after waivers clear |
| Wednesday 9am | Put in waiver claims |
| Thursday 7pm | Lineup check before Thursday night |
| Saturday 6pm | Early lineup look |
| Sunday 11am | Lineup check |
| Sunday 12:45pm | Final lineup before the 1pm games lock |

---

## Before you turn autopilot on

**The click targets are guesses and need one round of correction.**

The machine that wrote this bot could not reach sleeper.com, so the selectors
in `config/selectors.json` (which tell the bot where the buttons are) were
written blind. The reading half is fully tested. The clicking half is not.

Fix it once, on a computer that can reach Sleeper:

```bash
npm run capture
```

That opens a visible browser, logs in, and prints the real selectors for every
field it needs, saving screenshots and page HTML into `./debug`. Paste the
correct values into `config/selectors.json`.

Then confirm a dry run looks sensible before flipping the switch:

```bash
npm run lineup          # no --apply. Read what it says carefully
```

If the bot cannot find something it expects, it saves a screenshot and stops.
It never clicks at random.

**Autopilot cannot work if you sign into Sleeper with Google or Apple** rather
than a password. There is no password for the bot to use. Advisor mode still
works fine.

---

## Running on your VPS

```bash
# on the server
git clone <your repo>
cd sleeper-manager
npm install
npx playwright install --with-deps chromium
cp .env.example .env
nano .env                      # fill it in
npm run check                  # confirm it works

# keep it running after you log out
npm install -g pm2
pm2 start src/scheduler.js --name sleeper
pm2 save
pm2 startup                    # run the line it prints
```

Check on it with `pm2 logs sleeper`.

---

## Settings worth knowing

| Setting | Default | What it does |
|---|---|---|
| `LINEUP_SWAP_THRESHOLD` | `1.5` | Ignore swaps worth less than this many points. Stops pointless churn |
| `MAX_WAIVER_CLAIMS` | `2` | Most claims to put in per run |
| `FAAB_MAX_BID_PCT` | `15` | Percent of remaining budget to bid on a top target |
| `AUTO_SET_LINEUP` | `false` | Autopilot for lineups |
| `AUTO_CLAIM_WAIVERS` | `false` | Autopilot for waivers |
| `HEADLESS` | `true` | Set `false` to watch the browser work while debugging |

A player ruled **Out** or on **IR** is always benched, whatever the threshold
says.

---

## Where the projections come from

The bot prefers Sleeper's own weekly projections. That endpoint is not part of
the documented API, so it may change or vanish without warning. When it does,
the bot automatically falls back to a recency-weighted average of what each
player has actually scored in your league this season, which only uses
documented endpoints.

`npm run check` always prints which source it used. The fallback is slower to
react to news, so if you see `scoring-history` for weeks on end, the
projections endpoint has probably moved and is worth a look.

---

## Tests

```bash
npm test
```

Ten tests cover the lineup optimizer and the whole read pipeline against
mocked Sleeper responses. They need no network and no credentials.
