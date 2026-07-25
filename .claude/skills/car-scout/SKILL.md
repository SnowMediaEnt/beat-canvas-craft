---
name: car-scout
description: >
  Morning car-deal scan. Searches marketplace tools (Facebook Marketplace /
  eBay via MCP) for underpriced cars near the configured locations, values
  each candidate against comparable listings, scores the resale spread,
  writes a dated report with draft outreach messages for the user to send,
  updates the seen-listings ledger, and notifies the user. Use when the user
  says "car scout", "run the car scout", "scan for car deals", "morning car
  run", or a scheduled task asks for the daily deal scan.
---

# Car Scout — daily underpriced-car scan

You are running a deal scan, not buying anything. Hard rules, no exceptions:

- **Never message sellers, never log into any account, never place offers or
  bids.** You find and draft; the user contacts sellers themselves.
- Read-only marketplace access. Be polite to the sources: sequential search
  calls, no retries beyond one, respect `maxDetailFetchesPerRun`.
- If a source is unreachable, degrade gracefully and say exactly why (see
  Troubleshooting in `car-scout/README.md`).

## Procedure

### 0. Load config

Read `car-scout/config.json` from the repo root. If any location still
contains `SET_ME`, stop and ask the user for their city/suburbs and target
searches (or take them from the invocation message), write them into the
config, then continue.

### 1. Check tooling

Confirm a marketplace search tool is available — `search_marketplace` /
`get_listing_details` (secondhand-mcp, local or hosted connector). If the
tools are missing or every call fails with a network/403 error, do not fake
results: end the run with a short status pointing at the Setup section of
`car-scout/README.md` and, if in a cloud sandbox, note that the environment's
network policy blocked facebook.com (CONNECT 403).

### 2. Search

For each entry in `searches[]` × each location in `locations[]`:
call `search_marketplace` with the entry's keywords (one call per keyword),
`marketplace: "facebook"` (plus `"ebay"` if enabled in config), the location
string, and `maxPrice`. Default `limit: 24`.

Note: the Facebook search radius is fixed at ~10 miles per location string —
that is why `locations` is a list of nearby city/suburb names; iterate them
all rather than trying to widen a single query.

### 3. Dedupe against the ledger

Load `car-scout/state/seen.jsonl` (create it if missing; one JSON object per
line: `{id, firstSeen, price, title, url}`). Skip any listing ID already in
the ledger — **except** if its price dropped ≥10% since last seen, resurface
it tagged `PRICE DROP`.

### 4. Junk filter (before any deep work)

Discard: parts-only listings ("parts", "engine only", "mechanic special"
unless config `allowSalvage`), salvage/rebuilt/flood titles (unless
`allowSalvage`), placeholder prices ($1 / $123 / $1,234), anything under
$500 (scam bait), leases/rentals/"take over payments", and listings whose
year/miles fall outside the search entry's `minYear`/`maxMiles`.

### 5. Deep-check the best candidates

Rank remaining fresh listings by apparent upside (asking price vs. your
rough sense of the model's value) and call `get_listing_details` on at most
`thresholds.maxDetailFetchesPerRun` of them. Extract: year, make, model,
trim, mileage, title status, seller name, description red flags, photo count.

### 6. Value each candidate

Follow `references/valuation.md` exactly: build a comp set (≥5 comparable
listings via wider marketplace searches and/or WebSearch of retail sites),
take the median asking price, apply the haircuts, subtract estimated
repairs, and compute **spread = adjusted market value − asking price**.
Assign the tier from the thresholds in config (🔥 hot / ✅ solid / 👀 watch).
If asking price is under ~50% of the comp median, treat it as a probable
scam or hidden-damage listing and flag it as such instead of celebrating it.

### 7. Write the report

Write `car-scout/reports/YYYY-MM-DD.md` (today's date; append a `-2` suffix
if it exists). Structure:

1. One-line summary: `N new listings scanned, M passed filters, K deals (best spread ~$X)`.
2. Summary table: tier, title, ask, est. value, spread, miles, location, link.
3. Per-deal section: listing link, price vs. estimate with the comp evidence
   (list the actual comps used, with prices and links), mileage, red flags,
   suggested opening message (from `references/outreach.md`, personalized
   with the listing's details), and a suggested max offer
   (est. value − desired margin from config).
4. A "skipped/suspicious" footnote list so the user can sanity-check the filter.

### 8. Update state

Append every fresh listing surfaced this run to `seen.jsonl`. Add a row to
the table in `car-scout/pipeline.md` for each 🔥/✅ deal with status
`surfaced`.

### 9. Notify and (cloud only) persist

- If the `PushNotification` tool is available, send one line:
  `🚗 car-scout: K deals, best $X under market — <short title>`.
- If running in a remote/cloud sandbox (ephemeral container), commit the
  changed files under `car-scout/` to the current working branch and push,
  so reports and the ledger survive the container. Locally, leave the
  working tree for the user.
- Finish by telling the user the report path and the top deal in one
  sentence each.

## Invocation variants

- "car scout for <city> under <price>" → override config for this run only.
- "car scout, deep dive <listing url or id>" → skip search; run steps 5–7
  for that one listing (full comps, red flags, draft message, max offer).
- "car scout status" → summarize pipeline.md and ledger stats; no searching.
