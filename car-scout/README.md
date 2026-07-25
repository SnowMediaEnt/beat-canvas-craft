# Car Scout

An agent-driven deal finder for used cars, inspired by the "vibe coders are
looting Carvana" pipeline — minus the parts that get your Facebook account
banned. It searches marketplaces every morning, values candidates against
real comps, scores the **resale spread**, and hands you a report with
ready-to-send opening messages. **You** do the messaging, inspecting, and
buying.

What it deliberately does **not** do: auto-message sellers, log into your
Facebook account, or scrape KBB. Automated seller outreach is both a fast
path to an account ban (Meta's ToS prohibit automated access) and a bot
impersonating you to real people. Drafts-you-send gets the same result five
seconds slower.

## How it works

```
config.json ──▶ search_marketplace (FB Marketplace / eBay via secondhand-mcp)
                     │  dedupe vs state/seen.jsonl, junk-filter
                     ▼
              get_listing_details on the best ~10
                     │  comp search (wider net + retail sites) → median, haircuts
                     ▼
        reports/YYYY-MM-DD.md  ← tiers (🔥 ✅ 👀), comp evidence,
        pipeline.md              draft openers, suggested max offer
        + push notification
```

The brain is the Claude Code skill at `.claude/skills/car-scout/` —
run it by telling Claude **"run the car scout"** (or `/car-scout`).

## Setup

### Path A — your computer (recommended, zero keys)

1. Install [Claude Code](https://claude.com/claude-code) and open this repo
   (or any folder you copy `car-scout/` + `.claude/` + `.mcp.json` into).
2. The repo's `.mcp.json` already wires up
   [`secondhand-mcp`](https://github.com/jlsookiki/secondhand-mcp) via
   `npx` — approve it when prompted. Facebook Marketplace search needs no
   login, no keys, no browser.
3. Edit `config.json`: your locations (several nearby city/suburb names —
   each search covers a fixed ~10-mile radius per name) and your searches.
4. Say: `run the car scout`.

Optional: eBay comps — free developer keys at developer.ebay.com, set
`EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` in your environment.

### Path B — claude.ai / cloud, no computer needed

Connect the hosted version ([secondhandmcp.com](https://secondhandmcp.com))
as a connector on claude.ai, then run the skill from a Claude Code web
session of this repo. Their infra makes the marketplace requests, so the
sandbox network policy doesn't matter.

### Path C — this repo's cloud environment directly

The `.mcp.json` here already routes the MCP server through the sandbox
proxy (`SMARTPROXY_URL`), but cloud environments block `facebook.com` by
default — searches fail with `CONNECT 403`. To use Path C, allow
`facebook.com` (or "all domains") in the environment's network access
settings at claude.ai/code. eBay and NHTSA calls have the same constraint.

## Scheduling the morning run

- **Cloud:** in a Claude Code web session of this repo, say
  *"every morning at 8am, run the car scout and push-notify me the top
  deals"* — Claude creates a Routine that runs the skill on schedule.
  (Needs Path B or C working first.)
- **Local (macOS/Linux):** cron the headless CLI —
  `0 8 * * * cd /path/to/repo && claude -p "run the car scout" >> car-scout/cron.log 2>&1`

## The legal fine print (read once, it's short)

- Buying a car cheap for **yourself**: always fine — this is the tool's
  sweet spot.
- **Flipping**: legal in your own name up to your state's unlicensed-sale
  cap (commonly ~3–6 titled sales/year — check your DMV). Title every car
  you sell; "title jumping" is illegal everywhere. Sales tax + title fees
  come out of your spread.
- **Finder's fee from the seller** ("I'll bring you a buyer for $1k"):
  that's brokering, a licensed activity in most states. Charging the
  *buyer* for a car-finding service is the lower-risk variant. Details in
  `.claude/skills/car-scout/references/outreach.md`. Not legal advice.
- The marketplace search itself uses unofficial endpoints (no login). It
  can break when Facebook changes their frontend, and heavy use from one IP
  can get rate-limited — the skill is deliberately gentle. The
  higher-risk cousin ([jdcodes1/facebook-marketplace-mcp](https://github.com/jdcodes1/facebook-marketplace-mcp),
  which reuses your logged-in Chrome session) is **not** wired up here on
  purpose; it puts your personal account on the line.

## Files

| Path | What |
|------|------|
| `.claude/skills/car-scout/SKILL.md` | The scan procedure the agent follows |
| `.claude/skills/car-scout/references/valuation.md` | Comp method, haircuts, red flags |
| `.claude/skills/car-scout/references/outreach.md` | Message templates + legal/safety notes |
| `.mcp.json` (repo root) | Marketplace MCP server wiring |
| `car-scout/config.json` | Your locations, searches, thresholds |
| `car-scout/reports/` | Dated scan reports land here |
| `car-scout/state/seen.jsonl` | Ledger of already-surfaced listings |
| `car-scout/pipeline.md` | Your deal tracker, surfaced → sold |

## Troubleshooting

- **"Could not find location"** — the location resolver call failed. In a
  sandbox this almost always means the network policy blocked facebook.com
  (see Path C); locally, try a bigger nearby city's name.
- **"Unexpected response structure / doc_id"** — Facebook shipped a
  frontend change; update the server (`npx -y secondhand-mcp@latest`) or
  wait for the package to catch up.
- **Everything rate-limited** — you ran it too often. Once or twice a day
  is the intended cadence.
