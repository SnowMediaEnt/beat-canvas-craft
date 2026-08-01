import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  buildAuthUrl,
  cancelInvite,
  checkPin,
  createPin,
  deleteDevice,
  deleteSharedServer,
  describeDevice,
  findWorkingServerUrl,
  getAccount,
  getDevices,
  getOwnedServers,
  getRequestedInvites,
  getServerSections,
  getSessions,
  getSharedServers,
  getSharedUsers,
  inviteToServer,
  linkAndDetectDevices,
  rankConnectionUris,
  terminateSession,
  PlexApiError,
} from "./plex-api.server";
import { removeMemberAccess, runEnforcement } from "./plex-enforce.server";
import {
  deleteMemberRow,
  deleteResellerRow,
  getMemberRow,
  getResellerRow,
  getSettings,
  insertMember,
  insertReseller,
  listEvents,
  listMemberRows,
  listResellerRows,
  logEvent,
  memberDeviceToken,
  toMember,
  toOverview,
  toResellerSummary,
  updateMemberRow,
  updateResellerRow,
  updateSettings,
  type SettingsRow,
} from "./plex-store.server";
import { resolveExpiry, type DurationInput } from "./plex-types";

// Same owner-gate approach as the Lambda render functions: a single admin
// access code, overridable via env, checked on every call.
const PLEX_ADMIN_CODE = process.env.PLEX_ADMIN_CODE || "2650562";

function assertAccess(code: string) {
  if (code !== PLEX_ADMIN_CODE) {
    throw new Error("Invalid access code.");
  }
}

function requireToken(settings: SettingsRow): string {
  if (!settings.auth_token) throw new Error("Connect your Plex account in Settings first.");
  return settings.auth_token;
}

function requireServer(settings: SettingsRow): string {
  if (!settings.machine_identifier) throw new Error("Select your Plex server in Settings first.");
  return settings.machine_identifier;
}

const durationSchema = z.object({
  days: z.number().positive().optional(),
  expiresAt: z.string().optional(),
  never: z.boolean().optional(),
});

const baseSchema = z.object({ accessCode: z.string() });

// ---------------------------------------------------------------------------
// Overview / settings
// ---------------------------------------------------------------------------

export const plexGetOverview = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const members = await listMemberRows();
    const resellers = await listResellerRows();
    return toOverview(settings, members, resellers);
  });

export const plexStartSignIn = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ target: z.enum(["owner", "link"]) }).parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const pin = await createPin(settings.client_identifier);
    return {
      pinId: pin.id,
      code: pin.code,
      authUrl: buildAuthUrl(settings.client_identifier, pin.code),
    };
  });

export const plexCompleteSignIn = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema.extend({ pinId: z.number(), target: z.enum(["owner", "link"]) }).parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const token = await checkPin(data.pinId, settings.client_identifier);
    if (!token) return { pending: true as const };
    const account = await getAccount(token, settings.client_identifier);
    if (data.target === "owner") {
      await updateSettings({
        auth_token: token,
        account_username: account.username,
        account_email: account.email,
        plex_pass: account.plexPass,
      });
    } else {
      await updateSettings({
        link_auth_token: token,
        link_account_username: account.username,
        link_account_email: account.email,
      });
    }
    await logEvent("account_connected", { target: data.target, username: account.username });
    return { pending: false as const, username: account.username, email: account.email };
  });

export const plexSaveToken = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema.extend({ token: z.string().min(8), target: z.enum(["owner", "link"]) }).parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const token = data.token.trim();
    const account = await getAccount(token, settings.client_identifier);
    if (data.target === "owner") {
      await updateSettings({
        auth_token: token,
        account_username: account.username,
        account_email: account.email,
        plex_pass: account.plexPass,
      });
    } else {
      await updateSettings({
        link_auth_token: token,
        link_account_username: account.username,
        link_account_email: account.email,
      });
    }
    await logEvent("account_connected", {
      target: data.target,
      username: account.username,
      via: "token",
    });
    return { username: account.username, email: account.email, plexPass: account.plexPass };
  });

export const plexDisconnect = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ target: z.enum(["owner", "link"]) }).parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    if (data.target === "owner") {
      await updateSettings({
        auth_token: null,
        account_username: null,
        account_email: null,
        plex_pass: false,
      });
    } else {
      await updateSettings({
        link_auth_token: null,
        link_account_username: null,
        link_account_email: null,
      });
    }
    await logEvent("account_disconnected", { target: data.target });
    return { ok: true };
  });

export const plexListServers = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const token = requireToken(settings);
    const servers = await getOwnedServers(token, settings.client_identifier);
    return servers.map((s) => ({
      name: s.name,
      machineIdentifier: s.clientIdentifier,
      product: s.product,
      publicAddress: s.publicAddress,
      owned: s.owned,
      connections: s.connections,
    }));
  });

export const plexSelectServer = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema.extend({ machineIdentifier: z.string(), name: z.string() }).parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const token = requireToken(settings);
    const servers = await getOwnedServers(token, settings.client_identifier);
    const server = servers.find((s) => s.clientIdentifier === data.machineIdentifier);
    const url = server
      ? await findWorkingServerUrl(token, settings.client_identifier, rankConnectionUris(server))
      : null;
    await updateSettings({
      machine_identifier: data.machineIdentifier,
      server_name: data.name,
      server_url: url,
    });
    await logEvent("server_selected", {
      name: data.name,
      machineIdentifier: data.machineIdentifier,
      url,
    });
    return { url };
  });

export const plexUpdateSettings = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema
      .extend({
        removeFriendOnExpiry: z.boolean().optional(),
        serverUrl: z.string().nullable().optional(),
        defaultLibraryIds: z.array(z.string()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const patch: Record<string, unknown> = {};
    if (data.removeFriendOnExpiry !== undefined)
      patch.remove_friend_on_expiry = data.removeFriendOnExpiry;
    if (data.serverUrl !== undefined)
      patch.server_url = data.serverUrl?.trim() ? data.serverUrl.trim() : null;
    if (data.defaultLibraryIds !== undefined) patch.default_library_ids = data.defaultLibraryIds;
    await updateSettings(patch as never);
    return { ok: true };
  });

export const plexGetLibraries = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const token = requireToken(settings);
    const machineId = requireServer(settings);
    return getServerSections(token, settings.client_identifier, machineId);
  });

// ---------------------------------------------------------------------------
// Live view of who has access on plex.tv (shares + pending invites)
// ---------------------------------------------------------------------------

export const plexGetServerAccess = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const token = requireToken(settings);
    const machineId = requireServer(settings);
    const clientId = settings.client_identifier;

    const [shares, users, invites] = await Promise.all([
      getSharedServers(token, clientId, machineId),
      getSharedUsers(token, clientId).catch(() => []),
      getRequestedInvites(token, clientId).catch(() => []),
    ]);

    const shareRows = shares.map((s) => {
      const user = users.find(
        (u) => (s.userId && u.id === s.userId) || (s.username && u.username === s.username),
      );
      return {
        sharedServerId: s.id,
        userId: s.userId,
        username: s.username,
        email: s.email ?? s.invitedEmail,
        invitedEmail: s.invitedEmail,
        accepted: s.accepted,
        lastSeenAt: user?.serversByMachine[machineId]?.lastSeenAt ?? null,
        libraryTitles: s.sectionTitles,
        allLibraries: s.allLibraries,
      };
    });

    const pendingInvites = invites.map((i) => ({
      inviteId: i.id,
      username: i.username,
      email: i.email,
      friendlyName: i.friendlyName,
      createdAt: i.createdAt,
      friend: i.friend,
      home: i.home,
      server: i.server,
    }));

    return { shares: shareRows, pendingInvites };
  });

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const plexInviteMember = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema
      .extend({
        name: z.string().min(1),
        email: z.string().min(3),
        libraryIds: z.array(z.string()),
        duration: durationSchema,
        notes: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const token = requireToken(settings);
    const machineId = requireServer(settings);
    const libraryIds = data.libraryIds.length > 0 ? data.libraryIds : settings.default_library_ids;
    if (libraryIds.length === 0) {
      throw new Error("Pick at least one library to share (or set defaults in Settings).");
    }

    const share = await inviteToServer(
      token,
      settings.client_identifier,
      machineId,
      data.email.trim(),
      libraryIds,
    );
    const expiresAt = resolveExpiry(data.duration as DurationInput);
    const row = await insertMember({
      display_name: data.name.trim(),
      email: data.email.trim(),
      plex_username: share?.username ?? null,
      plex_user_id: share?.userId ?? null,
      shared_server_id: share?.id ?? null,
      access_type: "invite",
      invite_status: share?.accepted ? "accepted" : "pending",
      library_ids: libraryIds,
      notes: data.notes?.trim() || null,
      expires_at: expiresAt,
    });
    await logEvent(
      "invited",
      { email: data.email, libraries: libraryIds.length, expiresAt },
      row.id,
    );
    return toMember(row);
  });

// Start managing someone who already has access (added long ago, or invited
// outside this tool).
export const plexImportShare = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema
      .extend({
        name: z.string().min(1),
        sharedServerId: z.string().optional(),
        userId: z.string().nullable().optional(),
        username: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        duration: durationSchema,
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    await getSettings();
    const expiresAt = resolveExpiry(data.duration as DurationInput);
    const row = await insertMember({
      display_name: data.name.trim(),
      email: data.email ?? null,
      plex_username: data.username ?? null,
      plex_user_id: data.userId ?? null,
      shared_server_id: data.sharedServerId ?? null,
      access_type: "invite",
      invite_status: "accepted",
      expires_at: expiresAt,
    });
    await logEvent("imported", { username: data.username, email: data.email, expiresAt }, row.id);
    return toMember(row);
  });

export const plexLinkCode = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema
      .extend({
        name: z.string().min(1),
        code: z.string().min(4).max(6),
        duration: durationSchema,
        notes: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    requireToken(settings);
    const useLinkAccount = Boolean(settings.link_auth_token);
    const token = useLinkAccount
      ? (settings.link_auth_token as string)
      : (settings.auth_token as string);
    const clientId = settings.client_identifier;

    const newDevices = await linkAndDetectDevices(token, clientId, data.code);

    const expiresAt = resolveExpiry(data.duration as DurationInput);
    const row = await insertMember({
      display_name: data.name.trim(),
      access_type: "link_code",
      link_account: useLinkAccount ? "link" : "owner",
      device_ids: newDevices.map((d) => d.id),
      device_client_ids: newDevices.map((d) => d.clientIdentifier),
      device_names: newDevices.map(describeDevice),
      notes: data.notes?.trim() || null,
      expires_at: expiresAt,
    });
    await logEvent(
      "linked_device",
      {
        code: data.code.toUpperCase(),
        account: useLinkAccount ? "link" : "owner",
        devices: newDevices.map((d) => d.name || d.product),
        expiresAt,
      },
      row.id,
    );
    return {
      member: toMember(row),
      devicesFound: newDevices.length,
      account: useLinkAccount ? ("link" as const) : ("owner" as const),
    };
  });

// Re-scan for a link-code member's device when it didn't show up immediately.
export const plexScanForNewDevices = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ memberId: z.string() }).parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    requireToken(settings);
    const member = await getMemberRow(data.memberId);
    const token = await memberDeviceToken(settings, member);
    const members = await listMemberRows();
    const claimed = new Set(members.flatMap((m) => m.device_ids));
    const devices = await getDevices(token, settings.client_identifier);
    const windowStart = new Date(member.created_at).getTime() - 2 * 60 * 1000;
    const candidates = devices.filter(
      (d) =>
        !claimed.has(d.id) &&
        !d.provides.includes("server") &&
        d.createdAt !== null &&
        new Date(d.createdAt).getTime() >= windowStart,
    );
    if (candidates.length === 1) {
      const d = candidates[0];
      const row = await updateMemberRow(member.id, {
        device_ids: [...member.device_ids, d.id],
        device_client_ids: [...member.device_client_ids, d.clientIdentifier],
        device_names: [...member.device_names, describeDevice(d)],
      });
      return { attached: true, member: toMember(row), candidates: [] };
    }
    return {
      attached: false,
      member: toMember(member),
      candidates: candidates.map((d) => ({
        id: d.id,
        name: d.name || d.product,
        product: d.product,
        platform: d.platform,
        createdAt: d.createdAt,
      })),
    };
  });

export const plexRenewMember = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema.extend({ memberId: z.string(), duration: durationSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const member = await getMemberRow(data.memberId);
    const duration = data.duration as DurationInput;

    // Extend from the current expiry when it is still in the future, from now otherwise.
    const base =
      member.expires_at && new Date(member.expires_at).getTime() > Date.now()
        ? new Date(member.expires_at)
        : new Date();
    const expiresAt = duration.days ? resolveExpiry(duration, base) : resolveExpiry(duration);

    let reinvited = false;
    let message: string | null = null;
    if (member.status !== "active") {
      if (member.access_type === "invite" && member.email) {
        const token = requireToken(settings);
        const machineId = requireServer(settings);
        const libraryIds =
          member.library_ids.length > 0 ? member.library_ids : settings.default_library_ids;
        if (libraryIds.length === 0)
          throw new Error("No libraries recorded for this member and no defaults set.");
        const share = await inviteToServer(
          token,
          settings.client_identifier,
          machineId,
          member.email,
          libraryIds,
        );
        await updateMemberRow(member.id, {
          shared_server_id: share?.id ?? null,
          plex_user_id: share?.userId ?? member.plex_user_id,
          invite_status: share?.accepted ? "accepted" : "pending",
        });
        reinvited = true;
      } else if (member.access_type === "link_code") {
        message =
          "Member reactivated. Their old device sign-ins were revoked, so link their device again with a fresh 4-digit code (Add member → Link a device).";
      }
    }

    const row = await updateMemberRow(member.id, { status: "active", expires_at: expiresAt });
    await logEvent("renewed", { expiresAt, reinvited }, member.id);
    return { member: toMember(row), reinvited, message };
  });

export const plexUpdateMember = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema
      .extend({
        memberId: z.string(),
        name: z.string().min(1).optional(),
        notes: z.string().nullable().optional(),
        duration: durationSchema.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.display_name = data.name.trim();
    if (data.notes !== undefined) patch.notes = data.notes?.trim() || null;
    if (data.duration !== undefined)
      patch.expires_at = resolveExpiry(data.duration as DurationInput);
    const row = await updateMemberRow(data.memberId, patch as never);
    return toMember(row);
  });

export const plexRemoveMemberNow = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ memberId: z.string() }).parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    requireToken(settings);
    const member = await getMemberRow(data.memberId);
    const actions = await removeMemberAccess(settings, member);
    const row = await updateMemberRow(member.id, { status: "removed" });
    await logEvent("removed_manually", { actions }, member.id);
    return { member: toMember(row), actions };
  });

export const plexForgetMember = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ memberId: z.string() }).parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const member = await getMemberRow(data.memberId);
    await deleteMemberRow(data.memberId);
    await logEvent("forgotten", { name: member.display_name });
    return { ok: true };
  });

export const plexCancelPendingInvite = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ inviteId: z.string() }).parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const token = requireToken(settings);
    const invites = await getRequestedInvites(token, settings.client_identifier);
    const invite = invites.find((i) => i.id === data.inviteId);
    if (!invite) throw new Error("Invite not found — it may already be accepted or cancelled.");
    await cancelInvite(token, settings.client_identifier, invite);
    await logEvent("invite_cancelled", { email: invite.email, username: invite.username });
    return { ok: true };
  });

export const plexRevokeShare = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ sharedServerId: z.string() }).parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const token = requireToken(settings);
    const machineId = requireServer(settings);
    await deleteSharedServer(token, settings.client_identifier, machineId, data.sharedServerId);
    await logEvent("share_revoked", { sharedServerId: data.sharedServerId });
    return { ok: true };
  });

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export const plexListDevices = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    requireToken(settings);
    const clientId = settings.client_identifier;
    const members = await listMemberRows();
    const byDeviceId = new Map<string, { id: string; name: string; account: string }>();
    for (const m of members) {
      for (const id of m.device_ids)
        byDeviceId.set(`${m.link_account}:${id}`, {
          id: m.id,
          name: m.display_name,
          account: m.link_account,
        });
    }

    const accounts: { account: "owner" | "link"; token: string }[] = [
      { account: "owner", token: settings.auth_token as string },
    ];
    if (settings.link_auth_token)
      accounts.push({ account: "link", token: settings.link_auth_token });

    const rows = [];
    for (const acct of accounts) {
      const devices = await getDevices(acct.token, clientId).catch(() => []);
      for (const d of devices) {
        const owner = byDeviceId.get(`${acct.account}:${d.id}`);
        rows.push({
          id: d.id,
          name: d.name || d.product,
          product: d.product,
          platform: d.platform,
          device: d.device,
          model: d.model,
          clientIdentifier: d.clientIdentifier,
          providesServer: d.provides.includes("server"),
          createdAt: d.createdAt,
          lastSeenAt: d.lastSeenAt,
          publicAddress: d.publicAddress,
          account: acct.account,
          memberId: owner?.id ?? null,
          memberName: owner?.name ?? null,
        });
      }
    }
    return rows;
  });

export const plexDeleteDevice = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema.extend({ deviceId: z.string(), account: z.enum(["owner", "link"]) }).parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    requireToken(settings);
    const token =
      data.account === "link" && settings.link_auth_token
        ? settings.link_auth_token
        : (settings.auth_token as string);
    await deleteDevice(token, settings.client_identifier, data.deviceId);
    await logEvent("device_signed_out", { deviceId: data.deviceId, account: data.account });
    return { ok: true };
  });

export const plexAssignDevice = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema
      .extend({
        memberId: z.string(),
        deviceId: z.string(),
        deviceClientIdentifier: z.string(),
        deviceName: z.string(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const member = await getMemberRow(data.memberId);
    if (member.device_ids.includes(data.deviceId)) return toMember(member);
    const row = await updateMemberRow(member.id, {
      device_ids: [...member.device_ids, data.deviceId],
      device_client_ids: [...member.device_client_ids, data.deviceClientIdentifier],
      device_names: [...member.device_names, data.deviceName],
    });
    await logEvent(
      "device_assigned",
      { deviceId: data.deviceId, deviceName: data.deviceName },
      member.id,
    );
    return toMember(row);
  });

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const plexGetSessions = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const token = requireToken(settings);
    if (!settings.server_url) {
      throw new Error(
        "No reachable server URL. Re-select your server or set a server URL in Settings.",
      );
    }
    const sessions = await getSessions(token, settings.client_identifier, settings.server_url);
    const members = await listMemberRows();
    return sessions.map((s) => {
      const member = members.find(
        (m) =>
          (s.userId && m.plex_user_id === s.userId) ||
          (s.playerClientIdentifier && m.device_client_ids.includes(s.playerClientIdentifier)),
      );
      return { ...s, memberId: member?.id ?? null, memberName: member?.display_name ?? null };
    });
  });

export const plexKillSession = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema.extend({ sessionId: z.string(), reason: z.string() }).parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const settings = await getSettings();
    const token = requireToken(settings);
    if (!settings.server_url) throw new Error("No server URL configured.");
    try {
      await terminateSession(
        token,
        settings.client_identifier,
        settings.server_url,
        data.sessionId,
        data.reason,
      );
    } catch (error) {
      if (error instanceof PlexApiError && (error.status === 401 || error.status === 403)) {
        throw new Error(
          "Plex refused the termination — killing streams requires an active Plex Pass on the server owner account.",
        );
      }
      throw error;
    }
    await logEvent("session_killed", { sessionId: data.sessionId, reason: data.reason });
    return { ok: true };
  });

// ---------------------------------------------------------------------------
// Enforcement + activity
// ---------------------------------------------------------------------------

export const plexEnforceNow = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    return runEnforcement("manual");
  });

export const plexGetEvents = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema.extend({ limit: z.number().min(1).max(200).optional() }).parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    return listEvents(data.limit ?? 100);
  });

// ---------------------------------------------------------------------------
// Resellers (owner-only management)
// ---------------------------------------------------------------------------

async function resellerSummary(resellerId: string) {
  const reseller = await getResellerRow(resellerId);
  const members = await listMemberRows();
  return toResellerSummary(reseller, members);
}

export const plexCreateReseller = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema
      .extend({
        name: z.string().min(1),
        plexEmail: z.string().optional(),
        credits: z.number().int().min(0).optional(),
        notes: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const reseller = await insertReseller({
      name: data.name.trim(),
      plex_email: data.plexEmail?.trim() || null,
      credits: data.credits ?? 0,
      notes: data.notes?.trim() || null,
    });
    await logEvent("reseller_created", { name: reseller.name, credits: reseller.credits });
    return resellerSummary(reseller.id);
  });

export const plexUpdateReseller = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema
      .extend({
        resellerId: z.string(),
        name: z.string().min(1).optional(),
        notes: z.string().nullable().optional(),
        status: z.enum(["active", "disabled"]).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.notes !== undefined) patch.notes = data.notes?.trim() || null;
    if (data.status !== undefined) patch.status = data.status;
    await updateResellerRow(data.resellerId, patch as never);
    return resellerSummary(data.resellerId);
  });

// Add (or, with a negative amount, deduct) credits from the owner side.
export const plexAdjustCredits = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema.extend({ resellerId: z.string(), delta: z.number().int() }).parse(input),
  )
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const reseller = await getResellerRow(data.resellerId);
    const next = Math.max(0, reseller.credits + data.delta);
    await updateResellerRow(data.resellerId, { credits: next });
    await logEvent("credits_adjusted", { name: reseller.name, delta: data.delta, balance: next });
    return resellerSummary(data.resellerId);
  });

export const plexRegenResellerCode = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ resellerId: z.string() }).parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const { generatePortalCode } = await import("./plex-store.server");
    await updateResellerRow(data.resellerId, { portal_code: generatePortalCode() });
    await logEvent("reseller_code_reset", {}, null);
    return resellerSummary(data.resellerId);
  });

export const plexDeleteReseller = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ resellerId: z.string() }).parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const members = await listMemberRows();
    const theirs = members.filter((m) => m.reseller_id === data.resellerId);
    if (theirs.length > 0) {
      throw new Error(
        `This reseller still has ${theirs.length} customer(s). Remove or reassign them before deleting the reseller.`,
      );
    }
    const reseller = await getResellerRow(data.resellerId);
    await deleteResellerRow(data.resellerId);
    await logEvent("reseller_deleted", { name: reseller.name });
    return { ok: true };
  });

// Owner listing of a reseller's customers (read-only convenience).
export const plexGetResellerMembers = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ resellerId: z.string() }).parse(input))
  .handler(async ({ data }) => {
    assertAccess(data.accessCode);
    const members = await listMemberRows();
    return members.filter((m) => m.reseller_id === data.resellerId).map(toMember);
  });
