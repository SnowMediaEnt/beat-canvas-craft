// Database access for the Plex member manager. Uses the service-role client:
// the plex_* tables have RLS enabled with no policies, so this server layer is
// the only thing that can touch them (tokens never reach the browser).

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Tables, TablesUpdate } from "@/integrations/supabase/types";
import type {
  EnforceResult,
  PlexEventRow,
  PlexMember,
  PlexOverview,
  PlexResellerSummary,
} from "./plex-types";

export type SettingsRow = Tables<"plex_settings">;
export type MemberRow = Tables<"plex_members">;
export type ResellerRow = Tables<"plex_resellers">;

const SETTINGS_ID = "default";

function randomKey(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getSettings(): Promise<SettingsRow> {
  const { data, error } = await supabaseAdmin
    .from("plex_settings")
    .select("*")
    .eq("id", SETTINGS_ID)
    .maybeSingle();
  if (error) throw new Error(`Failed to load Plex settings: ${error.message}`);
  if (data) return data;

  const fresh = {
    id: SETTINGS_ID,
    client_identifier: crypto.randomUUID(),
    enforce_key: randomKey(24),
  };
  const { data: created, error: insertError } = await supabaseAdmin
    .from("plex_settings")
    .upsert(fresh, { onConflict: "id" })
    .select("*")
    .single();
  if (insertError) throw new Error(`Failed to initialize Plex settings: ${insertError.message}`);
  return created;
}

export async function updateSettings(patch: TablesUpdate<"plex_settings">): Promise<SettingsRow> {
  const { data, error } = await supabaseAdmin
    .from("plex_settings")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", SETTINGS_ID)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to update Plex settings: ${error.message}`);
  return data;
}

export function toMember(row: MemberRow): PlexMember {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    plexUsername: row.plex_username,
    plexUserId: row.plex_user_id,
    sharedServerId: row.shared_server_id,
    accessType: row.access_type as PlexMember["accessType"],
    inviteStatus: row.invite_status,
    linkAccount:
      row.link_account === "link" ? "link" : row.link_account === "reseller" ? "reseller" : "owner",
    resellerId: row.reseller_id,
    deviceIds: row.device_ids,
    deviceClientIds: row.device_client_ids,
    deviceNames: row.device_names,
    libraryIds: row.library_ids,
    notes: row.notes,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    status: row.status as PlexMember["status"],
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

export async function listMemberRows(): Promise<MemberRow[]> {
  const { data, error } = await supabaseAdmin
    .from("plex_members")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to load members: ${error.message}`);
  return data;
}

export async function getMemberRow(id: string): Promise<MemberRow> {
  const { data, error } = await supabaseAdmin
    .from("plex_members")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new Error(`Member not found: ${error.message}`);
  return data;
}

export async function insertMember(
  values: Omit<Partial<MemberRow>, "id"> & { display_name: string; access_type: string },
): Promise<MemberRow> {
  const { data, error } = await supabaseAdmin
    .from("plex_members")
    .insert(values)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to save member: ${error.message}`);
  return data;
}

export async function updateMemberRow(
  id: string,
  patch: TablesUpdate<"plex_members">,
): Promise<MemberRow> {
  const { data, error } = await supabaseAdmin
    .from("plex_members")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to update member: ${error.message}`);
  return data;
}

export async function deleteMemberRow(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("plex_members").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete member: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Resellers
// ---------------------------------------------------------------------------

export function generatePortalCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  const chars = Array.from(buf, (b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

export async function listResellerRows(): Promise<ResellerRow[]> {
  const { data, error } = await supabaseAdmin
    .from("plex_resellers")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to load resellers: ${error.message}`);
  return data;
}

export async function getResellerRow(id: string): Promise<ResellerRow> {
  const { data, error } = await supabaseAdmin
    .from("plex_resellers")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new Error(`Reseller not found: ${error.message}`);
  return data;
}

export async function getResellerByPortalCode(portalCode: string): Promise<ResellerRow | null> {
  const { data, error } = await supabaseAdmin
    .from("plex_resellers")
    .select("*")
    .eq("portal_code", portalCode)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up reseller: ${error.message}`);
  return data;
}

export async function insertReseller(values: {
  name: string;
  plex_email?: string | null;
  credits?: number;
  notes?: string | null;
}): Promise<ResellerRow> {
  const { data, error } = await supabaseAdmin
    .from("plex_resellers")
    .insert({ ...values, portal_code: generatePortalCode() })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create reseller: ${error.message}`);
  return data;
}

export async function updateResellerRow(
  id: string,
  patch: TablesUpdate<"plex_resellers">,
): Promise<ResellerRow> {
  const { data, error } = await supabaseAdmin
    .from("plex_resellers")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to update reseller: ${error.message}`);
  return data;
}

export async function deleteResellerRow(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("plex_resellers").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete reseller: ${error.message}`);
}

// Atomic spend via the plex_spend_credits SQL function; returns the new
// balance, or null when the balance was insufficient (or reseller disabled).
export async function spendCredits(resellerId: string, amount: number): Promise<number | null> {
  const { data, error } = await supabaseAdmin.rpc("plex_spend_credits", {
    p_reseller_id: resellerId,
    p_amount: amount,
  });
  if (error) throw new Error(`Failed to spend credits: ${error.message}`);
  return typeof data === "number" ? data : null;
}

// Which Plex account token controls this member's devices.
export async function memberDeviceToken(settings: SettingsRow, member: MemberRow): Promise<string> {
  if (member.link_account === "reseller" && member.reseller_id) {
    const reseller = await getResellerRow(member.reseller_id);
    if (!reseller.auth_token) {
      throw new Error(`Reseller "${reseller.name}" has not connected their Plex account.`);
    }
    return reseller.auth_token;
  }
  if (member.link_account === "link" && settings.link_auth_token) return settings.link_auth_token;
  if (!settings.auth_token) throw new Error("Plex account is not connected.");
  return settings.auth_token;
}

export async function logEvent(
  action: string,
  detail: Record<string, unknown> = {},
  memberId: string | null = null,
): Promise<void> {
  const { error } = await supabaseAdmin.from("plex_events").insert({
    action,
    detail: detail as never,
    member_id: memberId,
  });
  if (error) console.error(`[plex] failed to log event ${action}: ${error.message}`);
}

export async function listEvents(limit: number): Promise<PlexEventRow[]> {
  const { data, error } = await supabaseAdmin
    .from("plex_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load events: ${error.message}`);
  return data.map((e) => ({
    id: e.id,
    memberId: e.member_id,
    action: e.action,
    detail: (e.detail ?? {}) as PlexEventRow["detail"],
    createdAt: e.created_at,
  }));
}

export function toResellerSummary(row: ResellerRow, members: MemberRow[]): PlexResellerSummary {
  const theirs = members.filter((m) => m.reseller_id === row.id);
  return {
    id: row.id,
    name: row.name,
    plexUsername: row.plex_username,
    plexEmail: row.plex_email,
    connected: Boolean(row.auth_token),
    credits: row.credits,
    status: row.status === "disabled" ? "disabled" : "active",
    portalCode: row.portal_code,
    memberCount: theirs.length,
    activeMemberCount: theirs.filter((m) => m.status === "active").length,
    createdAt: row.created_at,
  };
}

// Overview intentionally excludes all auth tokens (owner, link, reseller).
export function toOverview(
  settings: SettingsRow,
  members: MemberRow[],
  resellers: ResellerRow[],
): PlexOverview {
  const resellerNames = new Map(resellers.map((r) => [r.id, r.name]));
  return {
    connected: Boolean(settings.auth_token),
    account: settings.auth_token
      ? {
          username: settings.account_username ?? "",
          email: settings.account_email ?? "",
          plexPass: settings.plex_pass,
        }
      : null,
    linkAccount: settings.link_auth_token
      ? {
          username: settings.link_account_username ?? "",
          email: settings.link_account_email ?? "",
        }
      : null,
    server: settings.machine_identifier
      ? {
          machineIdentifier: settings.machine_identifier,
          name: settings.server_name ?? "",
          url: settings.server_url,
        }
      : null,
    removeFriendOnExpiry: settings.remove_friend_on_expiry,
    defaultLibraryIds: settings.default_library_ids,
    enforceKey: settings.enforce_key,
    lastEnforcedAt: settings.last_enforced_at,
    lastEnforceResult: (settings.last_enforce_result as EnforceResult | null) ?? null,
    members: members.map((row) => ({
      ...toMember(row),
      resellerName: row.reseller_id ? (resellerNames.get(row.reseller_id) ?? null) : null,
    })),
    resellers: resellers.map((r) => toResellerSummary(r, members)),
  };
}
