# Security Review

Audit of this app (TanStack Start on Cloudflare Workers + Supabase + Remotion
Lambda) against the 20-item hardening checklist. Status is honest about what
this codebase actually is: a **music-visualizer tool with no authentication, no
user accounts, and no payment system**. Many checklist items are written for a
full multi-user SaaS and do not map to code that exists here yet.

## The headline finding

**There is no authentication anywhere in the app.** There is no login screen, no
`signInWith*` call, no session gate on any route. `requireSupabaseAuth` exists in
`src/integrations/supabase/auth-middleware.ts` but is never used. As a result:

- `GET /api/public/elevenlabs-key` returns the **ElevenLabs API key to any
  caller on the internet**. Anyone can take it and spend your ElevenLabs balance.
- The AI server functions (`generateVisualizerFromPrompt`, `aiAlignLyrics`) and
  the Lambda render functions run with **no auth and no rate limit** — anyone can
  trigger paid AI calls and paid Lambda renders on your accounts.
- `POST /api/public/render-upload` and `GET /api/public/render-download` are
  **unauthenticated** reads/writes against your S3 bucket.

None of these can be safely closed by "adding auth" to the endpoints today,
because there is no login flow to produce a session token — gating them now would
lock out the owner too. **Building a real auth gate is prerequisite work**, and it
lines up directly with the planned "users sign in and we check their
subscription" feature. Do that first; then items 10, 14, and the key-exposure fix
below become straightforward.

## Checklist status

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Add HSTS | ✅ Added | `applySecurityHeaders` in `src/server.ts` (plus nosniff, X-Frame-Options, Referrer-Policy, COOP, Permissions-Policy, and a Report-Only CSP). |
| 2 | Add CSRF tokens | N/A | No cookie-based sessions exist. Server functions authenticate by `Authorization: Bearer` header, which is not CSRF-eligible. Revisit only if you move auth to cookies. |
| 3 | Reset sessions on password change | N/A (Supabase) | Handled by Supabase Auth once auth exists; no custom auth code to change. |
| 4 | Expire reset links | N/A (Supabase) | Supabase Auth dashboard setting, not app code. |
| 5 | Prevent user enumeration | N/A (Supabase) | Supabase Auth dashboard setting. |
| 6 | Whitelist upload types | ✅ Added | `render-upload.ts` now accepts only an explicit audio/image/video allowlist and derives the stored `content-type` from it (was: any alphanumeric extension + attacker-supplied content-type). |
| 7 | Verify payment webhooks | N/A | No payment system in this codebase. |
| 8 | Set prices server-side | N/A | No pricing/checkout in this codebase. |
| 9 | Block prompt injection | ⚠️ Low risk | AI input is length-capped via zod; output is a constrained tool-call schema that is merged as config, never executed. The real AI risk here is cost abuse (item 10), not injection. |
| 10 | Cap AI usage | ❌ Missing | No rate limiting, and the AI endpoints are unauthenticated. Needs auth + a per-user/IP limiter (Cloudflare KV or Durable Object). |
| 11 | Limit request size | ⚠️ Partial | `render-upload` caps bodies at 200 MB; server functions rely on the platform's default limits. |
| 12 | Rate limit password resets | N/A (Supabase) | Supabase Auth handles this. |
| 13 | Sanitize before storing | ⚠️ Mostly N/A | No SQL (Supabase client parameterizes). App data lives client-side (IndexedDB) and in S3. Lyrics render to `<canvas>`, not to DOM HTML, so stored-XSS surface is minimal. |
| 14 | Lock down CORS | ⚠️ Open (`*`) | The three public endpoints use `Access-Control-Allow-Origin: *`. Low value while they are unauthenticated (an attacker uses `curl`, not a browser). Tighten to your domain once auth exists. |
| 15 | Disable directory listing | ✅ In place | The broad storage `SELECT`/list policy was dropped (migration `20260523004938`). No worker directory listing. |
| 16 | Remove default admin routes | N/A | No admin routes exist. |
| 17 | Lock accounts after failed logins | N/A (Supabase) | Supabase Auth handles brute-force protection. |
| 18 | Log security events | ⚠️ Minimal | Only `console.error`. Add structured logging once there are auth events worth recording. |
| 19 | Set secure cookies | N/A | The app sets no cookies; Supabase stores its session in `localStorage`. |
| 20 | Restrict database permissions | ✅ In place | Storage writes are limited to `service_role` (migration `20260523004923`); no application tables exist yet, so no RLS gaps. |

## What was changed in this pass

Only changes that are safe without an auth system (they cannot lock out the
owner or white-screen the app):

1. **`src/server.ts`** — `applySecurityHeaders()` now sets HSTS, `X-Content-Type-Options`,
   `X-Frame-Options: DENY`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, and
   `Permissions-Policy` on every response. A Content-Security-Policy is included
   in **Report-Only** mode (flag `CSP_ENFORCE`, default `false`) so it can be
   verified in the browser before enforcing.
2. **`src/routes/api/public/render-upload.ts`** — replaced the
   "any extension" check with an explicit media-type allowlist and made the
   stored S3 `content-type` come from that map instead of the client header.

## Recommended next steps (in order)

1. **Add authentication** (Supabase Auth login). This unblocks everything below
   and is the same work the subscription/Plex feature needs.
2. **Fix the ElevenLabs key exposure.** Either require a valid session on
   `/api/public/elevenlabs-key`, or (better for multiple users) move the
   ElevenLabs call server-side and delete the endpoint. Rotate the key regardless
   — assume it is already public.
3. **Require auth on the server functions and the three `/api/public/*` routes**,
   then add per-user rate limiting (item 10).
4. **Lock CORS** to your production origin(s) (item 14).
5. **Verify the app in a browser, then flip `CSP_ENFORCE` to `true`** and tighten
   `connect-src` to the specific hosts the app calls.
