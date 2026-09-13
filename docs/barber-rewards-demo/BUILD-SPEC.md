# Barber Rewards — Demo Build Spec

This document is the **verbatim build prompt** sent to Lovable to create the barber
loyalty demo in a single pass. It is kept here so the build is reproducible and so
the layout can be reviewed/edited before re-running.

## Live project

- **Lovable project:** "Sharp Rewards" — `a71b9a1b-6b51-481c-9f50-45af36874336`
- **Editor:** https://lovable.dev/projects/a71b9a1b-6b51-481c-9f50-45af36874336
- **Preview:** https://id-preview--a71b9a1b-6b51-481c-9f50-45af36874336.lovable.app
- **Demo logins** (seeded by `ensureDemoData()`, no signup needed):
  - Customer — `demo.client@example.com` / `demo1234`
  - Barber/owner — `demo.barber@example.com` / `demo1234`

`shop_name` is a deliberately generic placeholder (`The Barber Shop`) editable from
`/admin/settings`, so it can be changed to a real shop name live during a demo.

See `DEMO-SCRIPT.md` for the walkthrough to use when showing a barber.

### Verified after the build

Checked directly against the project's Postgres, not taken on trust:

- **Seed data is real:** 3 barbers, 8 services, 8 rewards, 2 promotions, 9 profiles,
  36 visits, 53 visit line items, 38 ledger rows, 10 appointments, 3 cut notes,
  1 referral, 1 broadcast, 3 gallery rows.
- **Demo accounts exist with the right shape:** `demo.client@example.com` is Marcus
  Reed (740 pts, 6 visits, member code `620392`, one pending `HDWAXR` → Free
  Line-Up, 2 upcoming appointments). `demo.barber@example.com` is Vince Carrera and
  holds the **owner** role, so `/admin/staff` is reachable in the demo.
- **Every client filter has a hit:** Ray Okonkwo 1,240 pts / 9 visits (one cut from
  the milestone), Dev Patel last seen ~7 weeks ago (Lapsed), Jonah Brooks 0 pts /
  0 visits (New), plus four mid-range clients.
- **No double-crediting:** 36 visits ↔ 36 `earn` ledger rows, and zero visits with
  anything other than exactly one earn row.
- **Codes can't be double-spent:** unique constraint on `redemptions.code`.
- **RLS holds where it matters:** `points_ledger` has *only* a SELECT policy
  (`user_id = auth.uid() OR is_staff(auth.uid())`) — no INSERT/UPDATE/DELETE for
  `authenticated`, so a customer cannot mint points. `client_notes` is
  `is_staff(auth.uid())` for all commands, so the barber's private notes about a
  client are invisible to that client. RLS enabled on both.

**Not verified:** the rendered frontend. This sandbox's proxy returns 403 on the
CONNECT tunnel to `lovable.app`, so the preview could not be loaded to confirm the
pages paint and the QR camera works. Open the preview URL to confirm.

### Build notes

Lovable's build queue was backed up roughly 20 minutes before this job started; a
`create_project` call that hits the MCP client's 60s timeout reports
`agentFinished: true` while having built nothing, so **verify by listing project
files, not by trusting that flag.** The first pass stopped after the customer
screens, the migration, the seeder, and `/admin/checkout`; the eight remaining
admin routes were completed in a second message.

- **Source of inspiration:** `cigarette-mart-rewards` / "Smoke Shop Perks"
  (Lovable project `3cf3dbf8-d852-464b-aab2-f0369065331e`)
- **Relationship:** brand-new, fully separate Lovable project. No shared database,
  no shared code, no shared users.
- **Purpose:** a working demo to show one interested barber, and reusable as a
  pitch for other barbers. No real name, branding, or domain yet — `shop_name` is
  a generic editable placeholder.

## What changed vs. the smoke shop app

| Smoke Shop Perks | Barber Rewards |
| --- | --- |
| Earn by photographing a receipt | Earn by barber scanning your code at the chair |
| AI OCR + receipt review queue | Removed entirely — no queue, no OCR |
| 21+ date-of-birth gate (tobacco compliance) | Removed. Birthday collected only for a birthday reward |
| Points per dollar spent | Points per **service performed** (with per-dollar as a fallback) |
| — | Appointments / booking |
| — | Service menu tied to point values |
| — | Barber profiles + "our work" gallery |
| — | Visit-count punch card ("every 10th cut free") |
| — | Lapsed-client win-back list |
| Raffles, referrals, promotions, broadcasts | Kept (referrals, promotions, broadcasts). Raffles dropped from v1 |

---

## The prompt (sent verbatim)

Build a complete, production-quality mobile-first loyalty & rewards PWA for a
barbershop. Build **all** of it in this one turn — do not ask me to approve a plan
first, do not stop partway to check in. This is a polished demo that will be shown
to real barbers, so finish every screen and seed it with realistic data.

### Product in one line

A customer gets a haircut, the barber scans the customer's code, points land
instantly, and the customer redeems those points for free cuts, discounts, and
shop perks.

### Critical: this must demo well with zero setup

The single most important requirement: **anyone opening the app must be able to
explore both sides immediately, without creating an account.**

- The public landing page (`/`) is a short, handsome pitch page for the app with
  two large buttons: **"Enter as a Customer"** and **"Enter as the Barber."**
  Each signs into a pre-seeded demo account and lands on the right home screen.
- Show the demo credentials in small text under the buttons as well, plus a normal
  "Sign in / Sign up" link for real accounts.
- Once inside, a small persistent **"Demo" pill** in the header lets you jump
  straight between the customer view and the barber view (sign out of one demo
  account, into the other, land on that side's home). This is how the barber will
  be shown both perspectives, so make it smooth and obvious.
- Seeding must be **idempotent** and run from a server function using the
  service-role key: `ensureDemoData()`. Call it automatically when the landing page
  loads (fire-and-forget, and awaited before a demo sign-in click resolves) so the
  app is never empty. Create the two demo auth users with
  `supabase.auth.admin.createUser({ email, password, email_confirm: true })` —
  do **not** try to INSERT into `auth.users` directly from SQL.
  - Customer demo: `demo.client@example.com` / `demo1234`
  - Barber/owner demo: `demo.barber@example.com` / `demo1234`

### Stack

Lovable Cloud (Supabase) for auth, Postgres, and storage. TanStack Start with file
routes, `createServerFn` for all privileged writes, shadcn/ui, Tailwind. Installable
PWA (`manifest.webmanifest` + icons, no service worker). QR scanning with the
`qr-scanner` package; QR rendering with `qrcode`.

### Design system

Classic barbershop heritage, but premium and modern — think a high-end shop, not a
novelty. Dark warm charcoal with a **brass/gold** accent and warm cream text.
Condensed uppercase display headings (barbershop signage feel) over a clean sans
body. Use a thin brass hairline or a subtle barber-pole stripe as an accent detail,
sparingly — never as a big candy-striped banner.

Define these as CSS variables in `src/styles.css` and drive everything from them
(no hardcoded colors in components):

```
--background: oklch(0.13 0.008 60)     --foreground: oklch(0.95 0.008 85)
--card: oklch(0.17 0.010 60)           --card-foreground: oklch(0.95 0.008 85)
--primary: oklch(0.76 0.120 85)        --primary-foreground: oklch(0.15 0.020 60)
--secondary: oklch(0.23 0.015 60)      --muted: oklch(0.21 0.012 60)
--muted-foreground: oklch(0.66 0.015 80)
--accent: oklch(0.27 0.030 80)         --border: oklch(0.26 0.012 60)
--input: oklch(0.23 0.012 60)          --ring: oklch(0.76 0.120 85)
--success: oklch(0.70 0.150 150)       --warning: oklch(0.78 0.150 80)
--destructive: oklch(0.60 0.200 25)
--radius: 0.625rem
--gradient-brass: linear-gradient(135deg, oklch(0.84 0.10 92), oklch(0.68 0.13 68))
--shadow-glow: 0 10px 40px -12px oklch(0.76 0.12 85 / 0.35)
```

Expose `gradient-brass` and `shadow-glow` as Tailwind utilities. Dark theme only.
Customers get a bottom tab bar; the barber gets a top nav / sidebar.

### Schema — one migration

Follow these conventions exactly: explicit `GRANT`s to `authenticated` and
`service_role`, `ENABLE ROW LEVEL SECURITY` on every table, and `SECURITY DEFINER`
+ `SET search_path = public` on every helper function.

Enums: `app_role` (`customer` | `barber` | `owner`), `ledger_type`
(`earn` | `redeem` | `refund` | `adjust`), `redemption_status`
(`pending` | `fulfilled` | `expired`), `appointment_status`
(`requested` | `confirmed` | `completed` | `cancelled` | `no_show`),
`reward_kind` (`service` | `product` | `perk`).

Tables:

- `profiles` — `id` → `auth.users`, `display_name`, `email`, `phone`,
  `member_code` TEXT UNIQUE (6 digits, auto-generated on signup),
  `birth_month` INT, `birth_day` INT (nullable; **no age gate** — this is only for
  the birthday reward), `preferred_barber_id`, `created_at`.
- `user_roles` — `(user_id, role)` unique. Helpers `has_role(uuid, app_role)`,
  `is_staff(uuid)` (barber or owner), `is_owner(uuid)`.
- `settings` — singleton `id = 1` CHECK: `shop_name` default `'The Barber Shop'`,
  `tagline`, `address`, `phone`, `hours` JSONB, `points_per_dollar` NUMERIC
  default 0 (0 = award by service only), `visit_milestone_count` INT default 10,
  `milestone_reward_points` INT default 1000, `birthday_reward_points` INT
  default 250, `referrer_points` INT default 300, `referee_points` INT default 150,
  `redemption_expiry_days` INT default 30, `lapsed_after_days` INT default 35.
- `barbers` — standalone so the demo can show a full team without every barber
  having a login: `id`, `user_id` UUID NULL → `auth.users`, `name`, `bio`,
  `avatar_path`, `specialties` TEXT[], `instagram`, `active`, `sort_order`.
- `services` — `name`, `description`, `price` NUMERIC, `duration_minutes` INT,
  `points_award` INT, `active`, `sort_order`.
- `visits` — the receipt replacement: `id`, `customer_id`, `barber_id`,
  `total_amount` NUMERIC, `points_awarded` INT, `multiplier` NUMERIC default 1,
  `note`, `created_by`, `created_at`.
- `visit_services` — line items: `visit_id`, `service_id`, `price`, `points`.
- `points_ledger` — **the only source of truth for a balance**: `user_id`, `type`,
  `amount` INT signed, `reference_type`, `reference_id`, `note`, `created_by`,
  `created_at`. Customers may `SELECT` their own rows and can **never** INSERT;
  every write goes through a `SECURITY DEFINER` function or the service role.
  Add `user_balance(uuid) RETURNS INT` = `COALESCE(SUM(amount),0)`.
- `rewards` — `name`, `description`, `kind` (`reward_kind`), `image_path`,
  `point_cost` INT CHECK > 0, `stock` INT, `active`.
- `redemptions` — `user_id`, `reward_id`, `code` TEXT UNIQUE (6-char base32,
  ambiguous characters excluded, generated server-side), `point_cost`, `status`,
  `expires_at`, `fulfilled_by`, `fulfilled_at`.
- `promotions` — `title`, `description`, `starts_at`, `ends_at`,
  `multiplier` NUMERIC CHECK >= 1, `weekday` INT NULL (0–6, for recurring
  day-of-week promos like double-point Tuesdays), `active`.
- `appointments` — `customer_id`, `barber_id`, `service_id`, `starts_at`,
  `duration_minutes`, `status`, `note`, `created_at`.
- `client_notes` — staff-only cut preferences, separate table because RLS is
  row-level not column-level: `customer_id` UNIQUE, `body`, `updated_by`,
  `updated_at`. Readable/writable by staff only, **never** by the customer.
- `referrals` — `referrer_id`, `referred_id`, `code`, `status`, `rewarded_at`.
- `broadcasts` — `title`, `body`, `starts_at`, `ends_at`, `active`.
- `gallery` — `image_path`, `caption`, `barber_id`, `sort_order`.

RLS shape: customers read only their own `profiles` / `points_ledger` / `visits` /
`redemptions` / `appointments`; staff (`is_staff`) read and manage all of them;
`services` / `rewards` / `promotions` / `barbers` / `gallery` / `broadcasts` /
`settings` are readable by all authenticated users and writable only by staff;
role grants and `settings` writes are owner-only. Storage buckets: `avatars`
(public), `rewards` (public), `gallery` (public) — staff-write, all-read.

Signup trigger `handle_new_user()`: create the profile, generate a unique 6-digit
`member_code`, and assign a role — the very first account becomes `owner`, everyone
after is `customer`. There is **no** date-of-birth requirement and no age check.

### Server functions / RPCs

All privileged logic server-side, all validated with zod:

- `staffFindMember(member_code)` → customer summary: name, code, balance, visit
  count, visits until the next milestone, last visit date, active redemptions.
- `recordVisit({ member_code, barber_id, service_ids[], note })` → creates the
  `visit` + `visit_services`, sums `points_award` across the chosen services,
  applies the best active promotion multiplier (including a `weekday` match against
  today), writes one `earn` row to `points_ledger`, and — if this visit hits
  `visit_milestone_count` — writes a second bonus row and returns a
  `milestoneHit` flag so the UI can celebrate it.
- `redeemReward({ reward_id })` → checks the balance and stock, writes the `redeem`
  ledger row, generates the code, sets `expires_at`.
- `fulfillRedemption({ code })` → staff-only; validates, marks fulfilled, rejects
  expired or already-used codes with a clear message.
- `adjustPoints({ user_id, amount, note })` → staff-only manual correction.
- `bookAppointment` / `updateAppointmentStatus` / `cancelAppointment`.
- `awardBirthdayPoints()` and `expireStaleRedemptions()` — idempotent, safe to call
  repeatedly; call them opportunistically on staff dashboard load.
- `ensureDemoData()` — the idempotent seeder described above.
- CRUD functions for services, rewards, promotions, barbers, broadcasts, gallery,
  settings, and staff roles.

### Customer screens (bottom tab bar: Home · Card · Rewards · Book · More)

- **`/` Home** — big points balance; a **punch-card progress bar** ("2 cuts until
  your free haircut") driven by `visit_milestone_count`; next upcoming appointment
  card with a "Rebook my usual" one-tap action; active promotions; any live
  broadcast as a dismissible banner; recent activity list.
- **`/card` My Card** — the screen the customer holds up at the chair. Large QR
  plus the 6-digit member code in big type. The QR encodes
  `<origin>/admin/checkout?m=<member_code>` so the barber can scan it with the
  in-app scanner *or* a plain phone camera. Make it bright and high-contrast so it
  scans off a dim phone screen.
- **`/rewards`** — catalog grouped by `kind` (Services / Products / Perks), each
  card showing the point cost, whether it is affordable, and a redeem confirmation
  dialog. Redeeming shows the code immediately.
- **`/my-codes`** — active redemption codes as QR + text with expiry countdowns;
  past/used codes below.
- **`/book`** — pick barber → service → day → time slot, then confirm. Generate
  slots from the shop `hours` and service duration, and hide slots already taken.
- **`/appointments`** — upcoming (with cancel) and past.
- **`/history`** — combined visit history and points ledger:
  "Jun 14 — Skin Fade + Beard Trim · +180 pts."
- **`/refer`** — the customer's referral code and a share link with native share
  and copy-to-clipboard, explaining both sides get points on the friend's first cut.
- **`/shop`** — hours, address with a map link, phone/text buttons, barber profile
  cards, and the "Our Work" gallery grid.
- **`/profile`** — name, phone, birthday, preferred barber, password change.

### Barber screens (top nav)

- **`/admin` Today** — today's appointments as a timeline, plus tiles for visits
  today/this week, points issued, rewards redeemed, and new members. A prominent
  **"Check out a client"** button. Owner-only section with simple charts for visits
  and redemptions over time.
- **`/admin/checkout`** — **the core screen, and the one to make excellent.** Two
  tabs:
  1. **Award points** — find the member by camera QR scan or by typing the 6-digit
     code (also accept a full pasted URL and pull the code out of it). Auto-load
     the member if the URL already carries `?m=`. Then show the client with their
     balance and visit count, a tappable multi-select grid of services with
     running point and dollar totals, an optional note, and one confirm button.
     The success state is a big satisfying "+180 points" card showing the new
     balance, any promo multiplier applied, and a milestone celebration when they
     have earned a free cut.
  2. **Redeem a code** — enter or scan a reward code, see what it is and who owns
     it, then mark it fulfilled.
- **`/admin/appointments`** — day and week views; confirm, complete, no-show,
  reschedule, cancel; plus walk-in creation.
- **`/admin/clients`** — searchable list with balance, visit count, and last visit.
  Filter chips for **Lapsed** (no visit in `lapsed_after_days`), **Near a reward**,
  and **New**. Client detail shows visit history, points ledger, staff-only cut
  notes (`client_notes`), and a manual points adjustment with a required note.
- **`/admin/services`** — the menu: name, price, duration, points awarded, active,
  drag-free `sort_order` field.
- **`/admin/rewards`** — CRUD including `kind`, point cost, stock, image.
- **`/admin/promotions`** — CRUD including date ranges, multiplier, and recurring
  weekday promos.
- **`/admin/messages`** — compose broadcasts with a date window; customers see them
  as a banner on Home.
- **`/admin/settings`** — shop name, tagline, address, phone, hours editor, and all
  the point-economy numbers. Also manage barber profiles and the gallery here.
  Make `shop_name` obviously easy to change — it will be edited live during a demo.
- **`/admin/staff`** — owner only: grant or revoke the barber role, link a barber
  profile to a login.

### Seed data (realistic, clearly fictional)

**Services:** Haircut $35 / 45min / 100pts · Skin Fade $40 / 45min / 120pts ·
Beard Trim & Shape $20 / 20min / 60pts · Hot Towel Shave $35 / 30min / 100pts ·
Line-Up (Edge-Up) $15 / 15min / 40pts · Kids Cut, 12 & under $25 / 30min / 70pts ·
Cut + Beard Combo $50 / 60min / 150pts · Gray Blending $25 / 30min / 70pts.

**Rewards:** Free Line-Up 300 (service) · $10 Off Any Cut 500 (service) ·
Free Beard Trim 600 (service) · Hot Towel Shave Upgrade 450 (service) ·
Free Haircut 1000 (service) · Styling Product of Choice 700 (product) ·
Skip-the-Line Priority Booking 400 (perk) · Bring-a-Kid Free Cut 800 (perk).

**Barbers:** three fictional profiles with bios and specialties — a master barber
and owner (fades, beard sculpting), one focused on tapers and kids' cuts, one on
classic cuts and hot towel shaves. Avatars are initials in a brass circle; no
photos needed.

**Promotions:** "Slow Tuesday — Double Points" (recurring `weekday`, 2×) and
"Welcome Back — 1.5× Points This Month."

**Customers:** about eight, including the demo customer. Vary them deliberately so
every screen and filter has something in it: one with ~1,240 points and 9 visits
(one cut from the milestone), one lapsed with a last visit ~7 weeks ago, one brand
new with 0 points, a couple mid-range, and one with an active unredeemed reward
code. Give them 20–30 visits spread over the past few months with plausible service
mixes so history, charts, and the ledger all look real. Add cut notes on a few
clients ("#2 on the sides, skin taper, scissors on top"). Add a handful of
appointments today and over the coming week, and one pending referral.

Make the **demo customer** interesting: ~740 points, 6 visits, one active reward
code, an appointment two days out, and a full visit history.

**Gallery:** generate at most **4** images total (one landing-page hero and three
"Our Work" tiles). Do not generate more than that. Barber avatars stay as initials.

### Explicitly out of scope

No receipt photos, no OCR, no receipt review queue. No age or date-of-birth gate.
No real payment processing — service prices are for display and point math only.
No raffles. No SMS provider — build the "text this client" action as a `sms:` link.
No email provider wiring; keep email as a no-op stub with a TODO.

### Finish quality

Loading skeletons, empty states with a helpful next action, toast feedback on every
mutation, per-route page titles, `robots.txt`, and a `sitemap.xml`. Every screen must
look right on a phone first and hold up on a desktop. Verify the app builds and the
core loop actually works end to end: demo customer opens `/card` → barber opens
`/admin/checkout` and enters that member code → picks two services → points are
awarded → the customer's Home balance and `/history` both reflect it → the customer
redeems a reward → the barber fulfills that code.
