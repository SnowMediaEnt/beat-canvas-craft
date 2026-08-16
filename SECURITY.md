# Security Review

Audit of this app (TanStack Start on Cloudflare Workers + Supabase + Remotion
Lambda) against the 20-item hardening checklist, plus the authentication and
endpoint-enforcement work layered on top.

The app is a music-visualizer tool. Projects live client-side (IndexedDB); there
is no per-user server database and no payment system. So "security" here is
mainly about **stopping anonymous abuse of your paid resources** (ElevenLabs,
Lovable AI, AWS Lambda/S3), not protecting stored user data.

---

## ⚠️ Required manual steps (do these or the app will not work / not be secure)

1. **Create your owner account in Supabase, and DISABLE public sign-ups.**
   - Supabase dashboard → Authentication → Users → *Add user* → enter your email
     and password, and enable **Auto Confirm** (so no confirmation email is
     needed). Do this for each person you want to have access.
   - Supabase dashboard → Authentication → Providers/Sign-in settings → **turn
     OFF "Allow new users to sign up."**
   - **Why this matters:** the whole point of the auth gate is that only people
     *you* authorize can trigger paid actions. If public sign-ups stay on,
     anyone can register, pass the gate, and drain your ElevenLabs / AI / render
     budget. Auth without disabling sign-ups protects almost nothing.
   - If you skip step 1 entirely, you will be redirected to `/login` with no way
     to get in.

2. **Rotate the ElevenLabs API key.** It was previously served to anyone on the
   internet, so treat it as public. Generate a new key in ElevenLabs and update
   the `ELEVENLABS_API_KEY` server env var.

3. **Confirm the Supabase server env vars are set** for the deployed worker:
   `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (used to validate sessions).
   They are already in `.env`; make sure they exist in the production
   environment too.

4. **Build and test the preview before merging.** Sign in, then verify:
   transcription, AI preset generation, uploading assets, starting a render, and
   downloading a finished render all still work while signed in — and that a
   signed-out browser is redirected to `/login`.

5. **After the app is verified working in a browser, enforce the CSP.** In
   `src/server.ts` set `CSP_ENFORCE = true` and confirm there are no CSP
   violation errors in the browser console. Optionally tighten `connect-src`
   from `https:` to your specific hosts.

6. **(Optional) Lock CORS to your domain.** Set the `ALLOWED_ORIGINS` env var to
   a comma-separated list of your origins (e.g.
   `https://your-domain.com,https://www.your-domain.com`). Left unset, the API
   routes keep the previous `*` behavior.

---

## What this pass changed

**Authentication (new):**
- `src/routes/login.tsx` — email/password sign-in page (Supabase Auth).
- `src/integrations/supabase/auth-context.tsx` — `AuthProvider`, `useAuth`, and
  `AuthGate`. The gate redirects signed-out users to `/login`; `/login` itself is
  always reachable so you cannot get trapped. It is SSR-safe (renders a neutral
  loader until the session resolves, so hydration never mismatches).
- `src/routes/__root.tsx` — wraps the app in `AuthProvider` + `AuthGate`.

**Server-side enforcement (the real boundary):**
- All seven server functions now require a valid session via
  `.middleware([requireSupabaseAuth])`: AI preset generation, AI lyric
  alignment, list renders, fresh download URL, start/progress/cancel render.
- The two secret-bearing public routes now require `Authorization: Bearer
  <token>`:
  - `GET /api/public/elevenlabs-key` (`src/integrations/supabase/require-auth.ts`
    validates the token).
  - `POST /api/public/render-upload`.
- The client callers attach the session token
  (`src/integrations/supabase/session.ts` → `getAccessToken()` used in
  `src/lib/transcribe/elevenlabs.ts` and `src/lib/render/upload.ts`).

**Transport / input hardening (earlier in this branch):**
- `src/server.ts` — HSTS + `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`, and a
  Report-Only CSP (`CSP_ENFORCE` flag).
- `src/routes/api/public/render-upload.ts` — explicit media-type allowlist; the
  stored S3 content-type comes from that map, not the client header.
- `src/lib/http/cors.ts` — env-driven CORS allowlist (`ALLOWED_ORIGINS`).

---

## Checklist status

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Add HSTS | ✅ | `applySecurityHeaders` in `src/server.ts`. |
| 2 | Add CSRF tokens | N/A | Server calls authenticate by `Authorization` header, not cookies — not CSRF-eligible. |
| 3 | Reset sessions on password change | ✅ (Supabase) | Handled by Supabase Auth now that auth is wired up. |
| 4 | Expire reset links | ✅ (Supabase) | Supabase Auth setting. |
| 5 | Prevent user enumeration | ⚠️ (Supabase) | Enable the "obscure sign-in errors" setting; and disable public sign-ups (step 1). |
| 6 | Whitelist upload types | ✅ | Allowlist in `render-upload.ts`. |
| 7 | Verify payment webhooks | N/A | No payment system. |
| 8 | Set prices server-side | N/A | No pricing/checkout. |
| 9 | Block prompt injection | ⚠️ Low risk | AI input is length-capped; output is a constrained tool schema merged as config, never executed. |
| 10 | Cap AI usage | ⚠️ Partial | Anonymous abuse now blocked (auth required). Per-user rate limiting still needs shared state — see below. |
| 11 | Limit request size | ⚠️ Partial | `render-upload` caps at 200 MB; server fns rely on platform limits. |
| 12 | Rate limit password resets | ✅ (Supabase) | Supabase Auth handles this. |
| 13 | Sanitize before storing | ⚠️ Mostly N/A | No SQL; lyrics render to `<canvas>`, not DOM HTML. |
| 14 | Lock down CORS | ✅ Available | Set `ALLOWED_ORIGINS` to enforce (step 6). |
| 15 | Disable directory listing | ✅ | Storage list policy dropped (migration `20260523004938`). |
| 16 | Remove default admin routes | N/A | None exist. |
| 17 | Lock accounts after failed logins | ✅ (Supabase) | Supabase Auth brute-force protection. |
| 18 | Log security events | ⚠️ Minimal | `console.error` only. |
| 19 | Set secure cookies | N/A | No app cookies; Supabase uses `localStorage`. |
| 20 | Restrict database permissions | ✅ | Storage writes limited to `service_role`; no app tables. |

---

## Remaining follow-ups (not done in this pass)

- **Per-user rate limiting (item 10).** Auth stops anonymous abuse, but a signed-
  in user can still call AI endpoints in a loop. Real throttling needs shared
  state across worker isolates — add a Cloudflare **KV namespace** or **Durable
  Object** binding in `wrangler.jsonc` and enforce a per-user/day quota in the
  server functions. (In-memory counters do not work reliably on Workers.)
- **`GET /api/public/render-download` is still unauthenticated.** It is triggered
  by a full-page navigation (`window.location.assign`), which cannot carry an
  auth header, so it was left open — but it is restricted to `remotionlambda-*`
  buckets and only streams render outputs whose S3 URL you already hold. To close
  it, mint a short-lived signed token as a query param and validate it. Low
  priority.
- **Move the ElevenLabs key fully server-side** before opening the app to
  untrusted end users. Requiring auth stops anonymous key theft, but a signed-in
  user's browser can still read the key. The right end state is a server-side
  transcription proxy with the key never leaving the server, then delete
  `/api/public/elevenlabs-key`.
