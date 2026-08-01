// Shared types for the Plex member manager (safe for client import — no secrets).

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type PlexAccountInfo = {
  username: string;
  email: string;
  plexPass: boolean;
};

export type PlexLinkAccountInfo = {
  username: string;
  email: string;
};

export type PlexServerSummary = {
  machineIdentifier: string;
  name: string;
  url: string | null;
};

export type PlexResourceOption = {
  name: string;
  machineIdentifier: string;
  product: string;
  publicAddress: string;
  owned: boolean;
  connections: { uri: string; local: boolean; relay: boolean }[];
};

export type PlexLibrarySection = {
  id: string;
  key: string;
  title: string;
  type: string;
};

export type MemberStatus = "active" | "expired" | "removed";
export type MemberAccessType = "invite" | "link_code";

export type PlexMember = {
  id: string;
  displayName: string;
  email: string | null;
  plexUsername: string | null;
  plexUserId: string | null;
  sharedServerId: string | null;
  accessType: MemberAccessType;
  inviteStatus: string | null;
  linkAccount: "owner" | "link" | "reseller";
  resellerId: string | null;
  resellerName?: string | null;
  deviceIds: string[];
  deviceClientIds: string[];
  deviceNames: string[];
  libraryIds: string[];
  notes: string | null;
  startsAt: string;
  expiresAt: string | null;
  status: MemberStatus;
  lastSeenAt: string | null;
  createdAt: string;
};

// 1 credit = 30 days of access for one customer.
export const CREDIT_DAYS = 30;
export const CREDIT_PACKAGES = [
  { months: 1, credits: 1, label: "1 month" },
  { months: 3, credits: 3, label: "3 months" },
  { months: 6, credits: 6, label: "6 months" },
  { months: 12, credits: 12, label: "12 months" },
] as const;

export type PlexResellerSummary = {
  id: string;
  name: string;
  plexUsername: string | null;
  plexEmail: string | null;
  connected: boolean;
  credits: number;
  status: "active" | "disabled";
  portalCode: string;
  memberCount: number;
  activeMemberCount: number;
  createdAt: string;
};

export type ResellerPortalData = {
  resellerName: string;
  credits: number;
  connected: boolean;
  plexUsername: string | null;
  members: PlexMember[];
};

export type PlexShareRow = {
  sharedServerId: string;
  userId: string | null;
  username: string | null;
  email: string | null;
  invitedEmail: string | null;
  accepted: boolean;
  lastSeenAt: string | null;
  libraryTitles: string[];
  allLibraries: boolean;
};

export type PlexPendingInvite = {
  inviteId: string;
  username: string | null;
  email: string | null;
  friendlyName: string | null;
  createdAt: string | null;
  friend: boolean;
  home: boolean;
  server: boolean;
};

export type PlexDeviceRow = {
  id: string;
  name: string;
  product: string;
  platform: string;
  device: string;
  model: string;
  clientIdentifier: string;
  providesServer: boolean;
  createdAt: string | null;
  lastSeenAt: string | null;
  publicAddress: string | null;
  account: "owner" | "link";
  memberId: string | null;
  memberName: string | null;
};

export type PlexSessionRow = {
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
  memberId: string | null;
  memberName: string | null;
};

export type PlexEventRow = {
  id: string;
  memberId: string | null;
  action: string;
  detail: Record<string, JsonValue>;
  createdAt: string;
};

export type EnforceResult = {
  ranAt: string;
  trigger: string;
  skipped: string | null;
  checked: number;
  removed: { memberId: string; name: string; actions: string[] }[];
  errors: { memberId: string | null; message: string }[];
};

export type PlexOverview = {
  connected: boolean;
  account: PlexAccountInfo | null;
  linkAccount: PlexLinkAccountInfo | null;
  server: PlexServerSummary | null;
  removeFriendOnExpiry: boolean;
  defaultLibraryIds: string[];
  enforceKey: string;
  lastEnforcedAt: string | null;
  lastEnforceResult: EnforceResult | null;
  members: PlexMember[];
  resellers: PlexResellerSummary[];
};

// Payload for choosing how long a member's access lasts.
export type DurationInput = {
  days?: number;
  expiresAt?: string;
  never?: boolean;
};

export function resolveExpiry(duration: DurationInput, from?: Date): string | null {
  if (duration.never) return null;
  if (duration.expiresAt) return new Date(duration.expiresAt).toISOString();
  if (duration.days && duration.days > 0) {
    const base = from ?? new Date();
    return new Date(base.getTime() + duration.days * 24 * 60 * 60 * 1000).toISOString();
  }
  return null;
}
