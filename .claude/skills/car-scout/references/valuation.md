# Valuation method — comps, haircuts, spread

KBB has no public API, so we estimate market value the way real deal tools
do: from comparable listings. Asking prices overstate sale prices, so we
haircut them. Be conservative — an "amazing deal" that evaporates under a
10% haircut was never a deal.

## 1. Identify the vehicle

From title + description + photos caption: year, make, model, trim,
mileage, transmission, title status. If a VIN is visible, decode it free via
NHTSA vPIC (`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/{VIN}?format=json`)
to confirm trim/engine — never guess trim upward.

## 2. Build the comp set (≥5 comps or don't score)

Comparable = same model, year ±1, mileage ±30%, same body style. Sources in
order of preference:

1. `search_marketplace` for the same model across **all** configured
   locations plus one nearby metro — different city strings widen the fixed
   ~10-mile radius.
2. eBay Motors results if the eBay source is enabled (national market —
   note shipping distorts low-end comps).
3. WebSearch for current retail asking prices, e.g.
   `"2014 honda accord ex" 90000 miles price site:cars.com OR site:autotrader.com`,
   and read 3–5 results. Retail (dealer) asks run ~10–15% above private
   party; tag comps as `private` or `retail`.

Record every comp used (price, miles, source, link) — they go in the report
as evidence and in the draft message as negotiation ammunition.

## 3. Compute value and spread

```
comp_median   = median of comp asking prices (drop the single highest and lowest if n ≥ 7)
retail_adjust = comp_median × 0.88 if comps are mostly retail, × 0.95 if mostly private-party asks
repairs       = itemized from description/photos (tires ~$600, brakes ~$400,
                windshield ~$400, body panel ~$500, "needs nothing" from a
                private seller still gets a $300 unknowns buffer;
                check-engine light or "runs rough" = $1,000 buffer minimum)
est_value     = retail_adjust − repairs
spread        = est_value − asking_price
```

Tiers (thresholds come from `car-scout/config.json`):

- 🔥 **hot** — spread ≥ `hotSpreadUsd` and no title red flags
- ✅ **solid** — spread ≥ `minSpreadUsd`
- 👀 **watch** — spread just under `minSpreadUsd` but low miles / one owner /
  fresh listing (< 24h) worth monitoring for a price drop

Suggested max offer in the report: `est_value − minSpreadUsd` (keeps the
user's margin even if they pay their ceiling).

## 4. Red flags (always list them; they cap the tier)

- **Title:** salvage / rebuilt / flood / "title in transit" / lien /
  "lost title" / seller's name not on title (curbstoner or worse). No clean
  title in hand → never above 👀.
- **Scam patterns:** price < 50% of comp median, stock photos, brand-new
  seller profile, "message my husband at…", deposit requested, car "at a
  shipping company". Flag as ⚠️ suspected scam, do not tier.
- **Mechanical:** check-engine light, "needs a little TLC", transmission
  slipping ("shifts hard"), overheating, mismatched paint panels.
- **Market:** listing stale > 3 weeks (why hasn't it sold?), dealer posing
  as private seller (same phone across listings).

## 5. What we deliberately do not do

No scraping of KBB/Carfax (ToS-protected; and the user should pull a paid
Carfax/AutoCheck by VIN before any purchase anyway — say so in the report
for 🔥 deals).
