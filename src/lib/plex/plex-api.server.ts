// Server-side client for the plex.tv account API and the Plex Media Server API.
// Endpoint contracts mirror python-plexapi / Tautulli / Overseerr, the
// battle-tested consumers of these (unofficial but stable) APIs.

import { epochToIso, findAll, findFirst, parseXml } from "./plex-xml.server";

const PLEX_TV = "https://plex.tv";
const PRODUCT = "Snow Media Plex Manager";
const TIMEOUT_MS = 15000;

export class PlexApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PlexApiError";
    this.status = status;
  }
}

type PlexRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  token?: string;
  clientId: string;
  accept?: "json" | "xml";
  jsonBody?: unknown;
  formBody?: Record<string, string>;
  timeoutMs?: number;
};

function plexHeaders(opts: PlexRequestOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Plex-Client-Identifier": opts.clientId,
    "X-Plex-Product": PRODUCT,
    "X-Plex-Version": "1.0.0",
    "X-Plex-Platform": "Web",
    "X-Plex-Device": "Cloud",
    "X-Plex-Device-Name": PRODUCT,
  };
  if (opts.token) headers["X-Plex-Token"] = opts.token;
  if (opts.accept === "json") headers["Accept"] = "application/json";
  if (opts.jsonBody !== undefined) headers["Content-Type"] = "application/json";
  if (opts.formBody !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
  return headers;
}

async function plexFetch(url: string, opts: PlexRequestOptions): Promise<Response> {
  let body: string | undefined;
  if (opts.jsonBody !== undefined) body = JSON.stringify(opts.jsonBody);
  if (opts.formBody !== undefined) body = new URLSearchParams(opts.formBody).toString();

  const response = await fetch(url, {
    method: opts.method ?? "GET",
    headers: plexHeaders(opts),
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const text = await response.text();
      // plex.tv errors come as XML (<Response status="..."/>), JSON ({errors:[{message}]}),
      // or plain text — extract the human-readable part.
      const xmlStatus = text.match(/status="([^"]+)"/)?.[1];
      const jsonMessage = text.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
      detail = xmlStatus ?? jsonMessage ?? text.slice(0, 200);
    } catch {
      /* ignore body read failures */
    }
    throw new PlexApiError(
      `Plex API ${response.status}${detail ? `: ${detail}` : ""} (${opts.method ?? "GET"} ${url.split("?")[0]})`,
      response.status,
    );
  }

  return response;
}

// ---------------------------------------------------------------------------
// plex.tv account API
// ---------------------------------------------------------------------------

export type PlexTvUser = {
  id: string;
  uuid: string;
  username: string;
  email: string;
  thumb: string;
  plexPass: boolean;
};

export async function getAccount(token: string, clientId: string): Promise<PlexTvUser> {
  const res = await plexFetch(`${PLEX_TV}/api/v2/user`, { token, clientId, accept: "json" });
  const data = (await res.json()) as {
    id: number | string;
    uuid: string;
    username: string;
    email: string;
    thumb: string;
    subscription?: { active?: boolean };
  };
  return {
    id: String(data.id),
    uuid: data.uuid,
    username: data.username,
    email: data.email,
    thumb: data.thumb,
    plexPass: Boolean(data.subscription?.active),
  };
}

export type PlexPin = { id: number; code: string };

export async function createPin(clientId: string): Promise<PlexPin> {
  const res = await plexFetch(`${PLEX_TV}/api/v2/pins?strong=true`, {
    method: "POST",
    clientId,
    accept: "json",
  });
  const data = (await res.json()) as { id: number; code: string };
  return { id: data.id, code: data.code };
}

export function buildAuthUrl(clientId: string, code: string): string {
  const params = [
    `clientID=${encodeURIComponent(clientId)}`,
    `code=${encodeURIComponent(code)}`,
    `context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(PRODUCT)}`,
  ].join("&");
  return `https://app.plex.tv/auth#?${params}`;
}

export async function checkPin(pinId: number, clientId: string): Promise<string | null> {
  const res = await plexFetch(`${PLEX_TV}/api/v2/pins/${pinId}`, { clientId, accept: "json" });
  const data = (await res.json()) as { authToken: string | null };
  return data.authToken || null;
}

// Links a device showing a plex.tv/link code to the account that owns `token`.
export async function linkDeviceWithCode(
  token: string,
  clientId: string,
  code: string,
): Promise<void> {
  try {
    await plexFetch(`${PLEX_TV}/api/v2/pins/link`, {
      method: "PUT",
      token,
      clientId,
      formBody: { code: code.trim().toUpperCase() },
    });
  } catch (error) {
    if (error instanceof PlexApiError && error.status === 404) {
      throw new PlexApiError(
        "That code was not found — it may have expired. Codes are only valid for a few minutes; have them refresh the screen and read you a new one.",
        404,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Servers, libraries, sharing
// ---------------------------------------------------------------------------

export type PlexResource = {
  name: string;
  product: string;
  clientIdentifier: string;
  owned: boolean;
  publicAddress: string;
  connections: { uri: string; local: boolean; relay: boolean }[];
};

export async function getOwnedServers(token: string, clientId: string): Promise<PlexResource[]> {
  const res = await plexFetch(`${PLEX_TV}/api/v2/resources?includeHttps=1&includeRelay=1`, {
    token,
    clientId,
    accept: "json",
  });
  const data = (await res.json()) as {
    name: string;
    product: string;
    clientIdentifier: string;
    provides: string;
    owned: boolean;
    publicAddress?: string;
    connections?: { uri: string; local: boolean; relay: boolean }[];
  }[];
  return data
    .filter((r) => r.provides?.split(",").includes("server") && r.owned)
    .map((r) => ({
      name: r.name,
      product: r.product,
      clientIdentifier: r.clientIdentifier,
      owned: r.owned,
      publicAddress: r.publicAddress ?? "",
      connections: (r.connections ?? []).map((c) => ({
        uri: c.uri,
        local: Boolean(c.local),
        relay: Boolean(c.relay),
      })),
    }));
}

export type PlexSection = { id: string; key: string; title: string; type: string };

// Library sections with their plex.tv-side ids (required by the sharing API —
// these are NOT the same as the server's local section keys).
export async function getServerSections(
  token: string,
  clientId: string,
  machineIdentifier: string,
): Promise<PlexSection[]> {
  const res = await plexFetch(`${PLEX_TV}/api/servers/${machineIdentifier}`, { token, clientId });
  const doc = parseXml(await res.text());
  return findAll(doc, "Section").map((s) => ({
    id: s.attrs.id ?? "",
    key: s.attrs.key ?? "",
    title: s.attrs.title ?? "",
    type: s.attrs.type ?? "",
  }));
}

export type SharedServer = {
  id: string;
  userId: string | null;
  username: string | null;
  email: string | null;
  invitedEmail: string | null;
  accepted: boolean;
  acceptedAt: string | null;
  sectionTitles: string[];
  sectionIds: string[];
  allLibraries: boolean;
};

function parseSharedServerNode(node: {
  attrs: Record<string, string>;
  children: { tag: string; attrs: Record<string, string> }[];
}): SharedServer {
  const shared = node.children.filter((c) => c.tag === "Section" && c.attrs.shared === "1");
  return {
    id: node.attrs.id ?? "",
    userId: node.attrs.userID && node.attrs.userID !== "0" ? node.attrs.userID : null,
    username: node.attrs.username || null,
    email: node.attrs.email || null,
    invitedEmail: node.attrs.invitedEmail || null,
    accepted: Boolean(node.attrs.acceptedAt && node.attrs.acceptedAt !== "0"),
    acceptedAt: epochToIso(node.attrs.acceptedAt),
    sectionTitles: shared.map((s) => s.attrs.title ?? ""),
    sectionIds: shared.map((s) => s.attrs.id ?? ""),
    allLibraries: node.attrs.allLibraries === "1",
  };
}

// Everyone the selected server is shared with (accepted and pending invites).
export async function getSharedServers(
  token: string,
  clientId: string,
  machineIdentifier: string,
): Promise<SharedServer[]> {
  const res = await plexFetch(`${PLEX_TV}/api/servers/${machineIdentifier}/shared_servers`, {
    token,
    clientId,
  });
  const doc = parseXml(await res.text());
  return findAll(doc, "SharedServer").map((n) => parseSharedServerNode(n));
}

export type SharedUser = {
  id: string;
  username: string;
  title: string;
  email: string;
  home: boolean;
  serversByMachine: Record<string, { lastSeenAt: string | null; pending: boolean }>;
};

// All accounts with access to any of the owner's servers — the only endpoint
// that exposes lastSeenAt, which powers "when did they last watch".
export async function getSharedUsers(token: string, clientId: string): Promise<SharedUser[]> {
  const res = await plexFetch(`${PLEX_TV}/api/users`, { token, clientId });
  const doc = parseXml(await res.text());
  return findAll(doc, "User").map((u) => {
    const serversByMachine: SharedUser["serversByMachine"] = {};
    for (const s of u.children.filter((c) => c.tag === "Server")) {
      if (s.attrs.machineIdentifier) {
        serversByMachine[s.attrs.machineIdentifier] = {
          lastSeenAt: epochToIso(s.attrs.lastSeenAt),
          pending: s.attrs.pending === "1",
        };
      }
    }
    return {
      id: u.attrs.id ?? "",
      username: u.attrs.username ?? "",
      title: u.attrs.title ?? "",
      email: u.attrs.email ?? "",
      home: u.attrs.home === "1",
      serversByMachine,
    };
  });
}

export type RequestedInvite = {
  id: string;
  username: string | null;
  email: string | null;
  friendlyName: string | null;
  createdAt: string | null;
  friend: boolean;
  home: boolean;
  server: boolean;
};

// Invites this account has sent that have not been accepted yet.
export async function getRequestedInvites(
  token: string,
  clientId: string,
): Promise<RequestedInvite[]> {
  const res = await plexFetch(`${PLEX_TV}/api/invites/requested`, { token, clientId });
  const doc = parseXml(await res.text());
  return findAll(doc, "Invite").map((i) => ({
    id: i.attrs.id ?? "",
    username: i.attrs.username || null,
    email: i.attrs.email || null,
    friendlyName: i.attrs.friendlyName || null,
    createdAt: epochToIso(i.attrs.createdAt),
    friend: i.attrs.friend === "1",
    home: i.attrs.home === "1",
    server: i.attrs.server === "1",
  }));
}

// Share libraries with a Plex account (by email or username). Works for both
// existing Plex users and brand-new emails (Plex sends them a signup invite).
export async function inviteToServer(
  token: string,
  clientId: string,
  machineIdentifier: string,
  invitedEmail: string,
  librarySectionIds: string[],
): Promise<SharedServer | null> {
  const res = await plexFetch(`${PLEX_TV}/api/servers/${machineIdentifier}/shared_servers`, {
    method: "POST",
    token,
    clientId,
    jsonBody: {
      server_id: machineIdentifier,
      shared_server: {
        library_section_ids: librarySectionIds.map((id) => Number(id)),
        invited_email: invitedEmail,
      },
      sharing_settings: {},
    },
  });
  const doc = parseXml(await res.text());
  const node = findFirst(doc, "SharedServer");
  return node ? parseSharedServerNode(node) : null;
}

// Revoke a share (works for accepted shares and pending invites alike).
export async function deleteSharedServer(
  token: string,
  clientId: string,
  machineIdentifier: string,
  sharedServerId: string,
): Promise<void> {
  await plexFetch(`${PLEX_TV}/api/servers/${machineIdentifier}/shared_servers/${sharedServerId}`, {
    method: "DELETE",
    token,
    clientId,
  });
}

export async function cancelInvite(
  token: string,
  clientId: string,
  invite: RequestedInvite,
): Promise<void> {
  const flags = `friend=${invite.friend ? 1 : 0}&home=${invite.home ? 1 : 0}&server=${invite.server ? 1 : 0}`;
  await plexFetch(`${PLEX_TV}/api/invites/requested/${invite.id}?${flags}`, {
    method: "DELETE",
    token,
    clientId,
  });
}

// Remove the friendship entirely (v2 first, v1 fallback for older behavior).
export async function removeFriend(token: string, clientId: string, userId: string): Promise<void> {
  try {
    await plexFetch(`${PLEX_TV}/api/v2/friends/${userId}`, {
      method: "DELETE",
      token,
      clientId,
      accept: "json",
    });
  } catch (error) {
    if (error instanceof PlexApiError && (error.status === 404 || error.status === 405)) {
      await plexFetch(`${PLEX_TV}/api/friends/${userId}`, { method: "DELETE", token, clientId });
      return;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Devices (what the 4-digit link code actually creates)
// ---------------------------------------------------------------------------

export type PlexDevice = {
  id: string;
  name: string;
  product: string;
  platform: string;
  device: string;
  model: string;
  clientIdentifier: string;
  provides: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  publicAddress: string | null;
};

export async function getDevices(token: string, clientId: string): Promise<PlexDevice[]> {
  const res = await plexFetch(`${PLEX_TV}/devices.xml`, { token, clientId });
  const doc = parseXml(await res.text());
  return findAll(doc, "Device").map((d) => ({
    id: d.attrs.id ?? "",
    name: d.attrs.name ?? "",
    product: d.attrs.product ?? "",
    platform: d.attrs.platform ?? "",
    device: d.attrs.device ?? "",
    model: d.attrs.model ?? "",
    clientIdentifier: d.attrs.clientIdentifier ?? "",
    provides: d.attrs.provides ?? "",
    createdAt: epochToIso(d.attrs.createdAt),
    lastSeenAt: epochToIso(d.attrs.lastSeenAt),
    publicAddress: d.attrs.publicAddress || null,
  }));
}

// Deleting a device revokes its token — the remote sign-out that cuts off a
// link-code member. 404 means it is already gone; treat as success.
export async function deleteDevice(
  token: string,
  clientId: string,
  deviceId: string,
): Promise<void> {
  try {
    await plexFetch(`${PLEX_TV}/devices/${deviceId}.xml`, { method: "DELETE", token, clientId });
  } catch (error) {
    if (error instanceof PlexApiError && error.status === 404) return;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Plex Media Server (direct) — live sessions and stream termination
// ---------------------------------------------------------------------------

export type PmsSession = {
  sessionId: string | null;
  sessionKey: string | null;
  userId: string | null;
  userTitle: string | null;
  playerTitle: string | null;
  playerClientIdentifier: string | null;
  product: string | null;
  state: string | null;
  address: string | null;
  mediaTitle: string;
};

type PmsSessionMetadata = {
  sessionKey?: string;
  title?: string;
  grandparentTitle?: string;
  parentTitle?: string;
  type?: string;
  User?: { id?: number | string; title?: string };
  Player?: {
    title?: string;
    product?: string;
    state?: string;
    address?: string;
    machineIdentifier?: string;
  };
  Session?: { id?: string };
};

export async function findWorkingServerUrl(
  token: string,
  clientId: string,
  candidates: string[],
): Promise<string | null> {
  for (const base of candidates) {
    try {
      await plexFetch(`${base.replace(/\/$/, "")}/identity`, {
        token,
        clientId,
        accept: "json",
        timeoutMs: 6000,
      });
      return base.replace(/\/$/, "");
    } catch {
      /* try the next connection */
    }
  }
  return null;
}

// Order candidate URIs: public direct first, relay last (we call from the cloud,
// so LAN addresses are useless and excluded).
export function rankConnectionUris(resource: PlexResource): string[] {
  const conns = resource.connections.filter((c) => !c.local);
  return [...conns.filter((c) => !c.relay), ...conns.filter((c) => c.relay)].map((c) => c.uri);
}

export async function getSessions(
  token: string,
  clientId: string,
  serverUrl: string,
): Promise<PmsSession[]> {
  const res = await plexFetch(`${serverUrl.replace(/\/$/, "")}/status/sessions`, {
    token,
    clientId,
    accept: "json",
  });
  const data = (await res.json()) as { MediaContainer?: { Metadata?: PmsSessionMetadata[] } };
  return (data.MediaContainer?.Metadata ?? []).map((m) => {
    const parts = [m.grandparentTitle, m.parentTitle, m.title].filter(Boolean);
    return {
      sessionId: m.Session?.id ?? null,
      sessionKey: m.sessionKey ?? null,
      userId: m.User?.id != null ? String(m.User.id) : null,
      userTitle: m.User?.title ?? null,
      playerTitle: m.Player?.title ?? null,
      playerClientIdentifier: m.Player?.machineIdentifier ?? null,
      product: m.Player?.product ?? null,
      state: m.Player?.state ?? null,
      address: m.Player?.address ?? null,
      mediaTitle: parts.join(" — ") || "Unknown",
    };
  });
}

// Stream termination is a Plex Pass server feature; without it Plex returns an
// error which we surface as-is.
export async function terminateSession(
  token: string,
  clientId: string,
  serverUrl: string,
  sessionId: string,
  reason: string,
): Promise<void> {
  const params = new URLSearchParams({ sessionId, reason });
  await plexFetch(
    `${serverUrl.replace(/\/$/, "")}/status/sessions/terminate?${params.toString()}`,
    {
      token,
      clientId,
    },
  );
}
