// Server-side auth check for the plain file-route handlers under
// src/routes/api/public/*. These routes are NOT TanStack server functions, so
// the `attachSupabaseAuth` client middleware does not apply to them — the
// client must send `Authorization: Bearer <access_token>` explicitly, and this
// helper validates it.
//
// Returns a discriminated result instead of throwing so each handler can return
// a proper CORS-tagged Response on failure.
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; status: number; message: string };

export async function requireBearerAuth(request: Request): Promise<AuthResult> {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    console.error("[require-auth] Supabase env vars are not configured");
    return { ok: false, status: 500, message: "Authentication is not configured" };
  }

  const authHeader = request.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, message: "Authentication required" };
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return { ok: false, status: 401, message: "Authentication required" };
  }

  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data, error } = await supabase.auth.getClaims(token);
    if (error || !data?.claims?.sub) {
      return { ok: false, status: 401, message: "Invalid or expired session" };
    }
    return { ok: true, userId: String(data.claims.sub) };
  } catch (err) {
    console.error("[require-auth] token validation failed", err);
    return { ok: false, status: 401, message: "Invalid or expired session" };
  }
}
