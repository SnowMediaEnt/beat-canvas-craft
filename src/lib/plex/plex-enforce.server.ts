// The enforcement engine — the piece Plex itself doesn't have. Finds members
// whose paid time has run out and actually cuts their access:
//   invite members  -> revoke the library share (and optionally unfriend)
//   link_code members -> delete their devices, which revokes those tokens
// Then it kills any in-flight streams (Plex Pass feature, best effort) and
// records everything in the audit log.
//
// Triggered from: the dashboard (manual + while-open interval), the public
// /api/public/plex-enforce endpoint (external cron pinger), and the Cloudflare
// cron schedule in wrangler.jsonc.

import {
  cancelInvite,
  deleteDevice,
  deleteSharedServer,
  getDevices,
  getRequestedInvites,
  getSessions,
  getSharedServers,
  getSharedUsers,
  removeFriend,
  terminateSession,
  type RequestedInvite,
  type SharedServer,
} from "./plex-api.server";
import {
  getSettings,
  listMemberRows,
  logEvent,
  toMember,
  updateMemberRow,
  updateSettings,
  type MemberRow,
  type SettingsRow,
} from "./plex-store.server";
import type { EnforceResult } from "./plex-types";

const DEFAULT_KICK_REASON = "Your access period has ended. Contact Snow Media to renew.";

function tokenForMember(settings: SettingsRow, member: MemberRow): string {
  if (member.link_account === "link" && settings.link_auth_token) return settings.link_auth_token;
  return settings.auth_token as string;
}

function matchShare(member: MemberRow, shares: SharedServer[]): SharedServer | undefined {
  return shares.find(
    (s) =>
      (member.shared_server_id && s.id === member.shared_server_id) ||
      (member.plex_user_id && s.userId === member.plex_user_id) ||
      (member.email &&
        (s.email?.toLowerCase() === member.email.toLowerCase() ||
          s.invitedEmail?.toLowerCase() === member.email.toLowerCase())) ||
      (member.plex_username && s.username?.toLowerCase() === member.plex_username.toLowerCase()),
  );
}

function matchInvite(member: MemberRow, invites: RequestedInvite[]): RequestedInvite | undefined {
  return invites.find(
    (i) =>
      (member.email && i.email?.toLowerCase() === member.email.toLowerCase()) ||
      (member.plex_username && i.username?.toLowerCase() === member.plex_username.toLowerCase()),
  );
}

// Removes a member's access right now. Shared between expiry enforcement and
// the dashboard's "remove now" action. Returns the list of actions performed.
export async function removeMemberAccess(
  settings: SettingsRow,
  member: MemberRow,
  context?: { shares?: SharedServer[]; invites?: RequestedInvite[] },
): Promise<string[]> {
  const token = settings.auth_token;
  if (!token) throw new Error("Plex account is not connected.");
  const clientId = settings.client_identifier;
  const actions: string[] = [];

  if (member.access_type === "invite") {
    if (!settings.machine_identifier) throw new Error("No Plex server selected in settings.");
    const shares =
      context?.shares ??
      (await getSharedServers(token, clientId, settings.machine_identifier).catch(() => []));
    const share = matchShare(member, shares);
    if (share) {
      await deleteSharedServer(token, clientId, settings.machine_identifier, share.id);
      actions.push(`revoked library share (${share.username ?? share.invitedEmail ?? share.id})`);
    }
    const invites =
      context?.invites ?? (await getRequestedInvites(token, clientId).catch(() => []));
    const invite = matchInvite(member, invites);
    if (invite) {
      await cancelInvite(token, clientId, invite).catch(() => undefined);
      actions.push("cancelled pending invite");
    }
    if (settings.remove_friend_on_expiry && member.plex_user_id) {
      try {
        await removeFriend(token, clientId, member.plex_user_id);
        actions.push("removed friend");
      } catch {
        actions.push("friend removal failed (share already revoked)");
      }
    }
  } else {
    const deviceToken = tokenForMember(settings, member);
    for (let i = 0; i < member.device_ids.length; i++) {
      await deleteDevice(deviceToken, clientId, member.device_ids[i]);
      actions.push(`signed out device ${member.device_names[i] ?? member.device_ids[i]}`);
    }
    if (member.device_ids.length === 0) {
      actions.push("no devices recorded — nothing to sign out");
    }
  }

  // Best effort: kick any stream the member has running right now.
  if (settings.server_url) {
    try {
      const sessions = await getSessions(token, clientId, settings.server_url);
      const mine = sessions.filter(
        (s) =>
          (member.plex_user_id && s.userId === member.plex_user_id) ||
          (s.playerClientIdentifier && member.device_client_ids.includes(s.playerClientIdentifier)),
      );
      for (const session of mine) {
        if (session.sessionId) {
          await terminateSession(
            token,
            clientId,
            settings.server_url,
            session.sessionId,
            DEFAULT_KICK_REASON,
          );
          actions.push(`killed active stream on ${session.playerTitle ?? "device"}`);
        }
      }
    } catch {
      /* stream kill requires Plex Pass and a reachable server; skip quietly */
    }
  }

  return actions;
}

export async function runEnforcement(trigger: string): Promise<EnforceResult> {
  const ranAt = new Date().toISOString();
  const result: EnforceResult = {
    ranAt,
    trigger,
    skipped: null,
    checked: 0,
    removed: [],
    errors: [],
  };

  let settings: SettingsRow;
  try {
    settings = await getSettings();
  } catch (error) {
    result.skipped = `settings unavailable: ${error instanceof Error ? error.message : String(error)}`;
    return result;
  }

  if (!settings.auth_token) {
    result.skipped = "not_connected";
    return result;
  }

  const members = await listMemberRows();
  const active = members.filter((m) => m.status === "active");
  const now = Date.now();
  const expired = active.filter((m) => m.expires_at && new Date(m.expires_at).getTime() <= now);
  result.checked = active.length;

  // Fetch shared state once for the whole run.
  const clientId = settings.client_identifier;
  const shares = settings.machine_identifier
    ? await getSharedServers(settings.auth_token, clientId, settings.machine_identifier).catch(
        () => [],
      )
    : [];
  const invites =
    expired.length > 0
      ? await getRequestedInvites(settings.auth_token, clientId).catch(() => [])
      : [];

  for (const member of expired) {
    try {
      const actions = await removeMemberAccess(settings, member, { shares, invites });
      await updateMemberRow(member.id, { status: "expired" });
      await logEvent("auto_removed", { trigger, actions, expiresAt: member.expires_at }, member.id);
      result.removed.push({ memberId: member.id, name: member.display_name, actions });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({ memberId: member.id, message });
      await logEvent("enforce_error", { trigger, message }, member.id);
    }
  }

  // Refresh last-seen + invite acceptance for members still active.
  try {
    const users = await getSharedUsers(settings.auth_token, clientId);
    for (const member of active) {
      if (result.removed.some((r) => r.memberId === member.id)) continue;
      const user = users.find(
        (u) =>
          (member.plex_user_id && u.id === member.plex_user_id) ||
          (member.plex_username &&
            u.username.toLowerCase() === member.plex_username.toLowerCase()) ||
          (member.email && u.email.toLowerCase() === member.email.toLowerCase()),
      );
      if (!user) continue;
      const serverInfo = settings.machine_identifier
        ? user.serversByMachine[settings.machine_identifier]
        : undefined;
      const patch: Record<string, unknown> = {};
      if (!member.plex_user_id && user.id) {
        patch.plex_user_id = user.id;
        patch.plex_username = user.username || member.plex_username;
      }
      if (serverInfo?.lastSeenAt && serverInfo.lastSeenAt !== member.last_seen_at) {
        patch.last_seen_at = serverInfo.lastSeenAt;
      }
      if (
        member.access_type === "invite" &&
        member.invite_status === "pending" &&
        serverInfo &&
        !serverInfo.pending
      ) {
        patch.invite_status = "accepted";
      }
      if (Object.keys(patch).length > 0) {
        await updateMemberRow(member.id, patch as never);
      }
    }
  } catch {
    /* monitoring refresh is non-critical */
  }

  // Link-code members have no plex.tv user of their own, so their "last seen"
  // comes from device activity instead.
  try {
    const linkMembers = active.filter(
      (m) =>
        m.access_type === "link_code" &&
        m.device_ids.length > 0 &&
        !result.removed.some((r) => r.memberId === m.id),
    );
    if (linkMembers.length > 0) {
      const deviceSeen = new Map<string, string>();
      const accounts = [
        ...new Set(linkMembers.map((m) => (m.link_account === "link" ? "link" : "owner"))),
      ];
      for (const account of accounts) {
        const token =
          account === "link" && settings.link_auth_token
            ? settings.link_auth_token
            : settings.auth_token;
        const devices = await getDevices(token, clientId).catch(() => []);
        for (const d of devices) {
          if (d.lastSeenAt) deviceSeen.set(`${account}:${d.id}`, d.lastSeenAt);
        }
      }
      for (const member of linkMembers) {
        const account = member.link_account === "link" ? "link" : "owner";
        const seen = member.device_ids
          .map((id) => deviceSeen.get(`${account}:${id}`))
          .filter((v): v is string => Boolean(v))
          .sort()
          .pop();
        if (seen && seen !== member.last_seen_at) {
          await updateMemberRow(member.id, { last_seen_at: seen });
        }
      }
    }
  } catch {
    /* monitoring refresh is non-critical */
  }

  await updateSettings({
    last_enforced_at: ranAt,
    last_enforce_result: result as never,
  });
  if (result.removed.length > 0 || result.errors.length > 0) {
    await logEvent("enforcement_run", {
      trigger,
      removed: result.removed.length,
      errors: result.errors.length,
    });
  }

  return result;
}

export { toMember };
export type { MemberRow, SettingsRow };
