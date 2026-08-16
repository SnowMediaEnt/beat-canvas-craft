import { supabase } from "./client";

// Client-side helper: returns the current access token (or null when signed
// out). Used to attach `Authorization: Bearer <token>` to the plain fetch()
// calls that hit the /api/public/* routes, which are not TanStack server
// functions and therefore do not get the token attached automatically.
export async function getAccessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}
