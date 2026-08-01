// Reseller portal server functions. Gated by the reseller's own portal_code
// (NOT the owner admin code). Every function resolves the reseller from that
// code and scopes all reads/writes to reseller_id — a reseller can only ever
// see and touch their own customers, never the owner's or another reseller's.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  buildAuthUrl,
  checkPin,
  createPin,
  describeDevice,
  getAccount,
  getDevices,
  linkAndDetectDevices,
  PlexApiError,
} from "./plex-api.server";
import { removeMemberAccess } from "./plex-enforce.server";
import {
  getResellerByPortalCode,
  getSettings,
  insertMember,
  listMemberRows,
  logEvent,
  spendCredits,
  toMember,
  updateMemberRow,
  updateResellerRow,
  type MemberRow,
  type ResellerRow,
} from "./plex-store.server";
import { CREDIT_DAYS, type ResellerPortalData } from "./plex-types";

const baseSchema = z.object({ portalCode: z.string().min(4) });

async function requireReseller(portalCode: string): Promise<ResellerRow> {
  const reseller = await getResellerByPortalCode(portalCode.trim());
  if (!reseller) throw new Error("Invalid portal code.");
  if (reseller.status === "disabled") {
    throw new Error("This reseller account has been disabled. Contact the administrator.");
  }
  return reseller;
}

async function myMembers(resellerId: string): Promise<MemberRow[]> {
  const all = await listMemberRows();
  return all.filter((m) => m.reseller_id === resellerId);
}

// Load a member and confirm it belongs to this reseller (authorization guard).
async function myMember(resellerId: string, memberId: string): Promise<MemberRow> {
  const member = (await myMembers(resellerId)).find((m) => m.id === memberId);
  if (!member) throw new Error("Customer not found.");
  return member;
}

function portalData(reseller: ResellerRow, members: MemberRow[]): ResellerPortalData {
  return {
    resellerName: reseller.name,
    credits: reseller.credits,
    connected: Boolean(reseller.auth_token),
    plexUsername: reseller.plex_username,
    members: members.map(toMember),
  };
}

export const resellerGetPortal = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.parse(input))
  .handler(async ({ data }): Promise<ResellerPortalData> => {
    const reseller = await requireReseller(data.portalCode);
    return portalData(reseller, await myMembers(reseller.id));
  });

// --- Reseller connects their own Plex account (device sign-in target) --------

export const resellerStartSignIn = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.parse(input))
  .handler(async ({ data }) => {
    await requireReseller(data.portalCode);
    const settings = await getSettings();
    const pin = await createPin(settings.client_identifier);
    return { pinId: pin.id, authUrl: buildAuthUrl(settings.client_identifier, pin.code) };
  });

export const resellerCompleteSignIn = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ pinId: z.number() }).parse(input))
  .handler(async ({ data }) => {
    const reseller = await requireReseller(data.portalCode);
    const settings = await getSettings();
    const token = await checkPin(data.pinId, settings.client_identifier);
    if (!token) return { pending: true as const };
    const account = await getAccount(token, settings.client_identifier);
    await updateResellerRow(reseller.id, {
      auth_token: token,
      plex_username: account.username,
      plex_email: account.email,
    });
    await logEvent("reseller_connected", { name: reseller.name, username: account.username });
    return { pending: false as const, username: account.username };
  });

export const resellerSaveToken = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ token: z.string().min(8) }).parse(input))
  .handler(async ({ data }) => {
    const reseller = await requireReseller(data.portalCode);
    const settings = await getSettings();
    const account = await getAccount(data.token.trim(), settings.client_identifier);
    await updateResellerRow(reseller.id, {
      auth_token: data.token.trim(),
      plex_username: account.username,
      plex_email: account.email,
    });
    await logEvent("reseller_connected", {
      name: reseller.name,
      username: account.username,
      via: "token",
    });
    return { username: account.username };
  });

// --- Add a customer with a 4-digit code (spends credits) --------------------

const monthsSchema = z.number().int().min(1).max(24);

export const resellerLinkCode = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema
      .extend({
        name: z.string().min(1),
        code: z.string().min(4).max(6),
        months: monthsSchema,
        notes: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const reseller = await requireReseller(data.portalCode);
    if (!reseller.auth_token) {
      throw new Error("Connect your Plex account first (top of the page).");
    }
    const cost = data.months; // 1 credit per month
    if (reseller.credits < cost) {
      throw new Error(
        `Not enough credits: this needs ${cost}, you have ${reseller.credits}. Contact the administrator to top up.`,
      );
    }
    const settings = await getSettings();
    const clientId = settings.client_identifier;

    // Link and detect the device BEFORE spending credits, so a failed/expired
    // code never costs the reseller anything.
    const newDevices = await linkAndDetectDevices(reseller.auth_token, clientId, data.code);

    const spent = await spendCredits(reseller.id, cost);
    if (spent === null) {
      throw new Error(
        "Credit deduction failed — your balance may have changed. Nothing was charged twice; try again.",
      );
    }

    const expiresAt = new Date(
      Date.now() + data.months * CREDIT_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const row = await insertMember({
      display_name: data.name.trim(),
      access_type: "link_code",
      link_account: "reseller",
      reseller_id: reseller.id,
      device_ids: newDevices.map((d) => d.id),
      device_client_ids: newDevices.map((d) => d.clientIdentifier),
      device_names: newDevices.map(describeDevice),
      notes: data.notes?.trim() || null,
      expires_at: expiresAt,
    });
    await logEvent(
      "reseller_linked_device",
      {
        reseller: reseller.name,
        months: data.months,
        cost,
        balance: spent,
        devices: newDevices.map((d) => d.name || d.product),
        expiresAt,
      },
      row.id,
    );
    return { member: toMember(row), devicesFound: newDevices.length, creditsLeft: spent };
  });

// Re-scan for a customer's device if it didn't appear immediately.
export const resellerScanForDevices = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ memberId: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const reseller = await requireReseller(data.portalCode);
    if (!reseller.auth_token) throw new Error("Connect your Plex account first.");
    const member = await myMember(reseller.id, data.memberId);
    const settings = await getSettings();
    const claimed = new Set((await listMemberRows()).flatMap((m) => m.device_ids));
    const devices = await getDevices(reseller.auth_token, settings.client_identifier);
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
      return { attached: true, member: toMember(row) };
    }
    return { attached: false, member: toMember(member) };
  });

// Extend an existing customer (spends credits).
export const resellerRenewMember = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    baseSchema.extend({ memberId: z.string(), months: monthsSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    const reseller = await requireReseller(data.portalCode);
    const member = await myMember(reseller.id, data.memberId);
    const cost = data.months;
    if (reseller.credits < cost) {
      throw new Error(`Not enough credits: this needs ${cost}, you have ${reseller.credits}.`);
    }
    const spent = await spendCredits(reseller.id, cost);
    if (spent === null) throw new Error("Credit deduction failed — try again.");

    const base =
      member.expires_at && new Date(member.expires_at).getTime() > Date.now()
        ? new Date(member.expires_at)
        : new Date();
    const expiresAt = new Date(
      base.getTime() + data.months * CREDIT_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    let message: string | null = null;
    if (member.status !== "active") {
      message =
        "Customer reactivated. Their old device sign-in was revoked, so have them send a fresh 4-digit code and add them again to re-link the device.";
    }
    const row = await updateMemberRow(member.id, { status: "active", expires_at: expiresAt });
    await logEvent(
      "reseller_renewed",
      { reseller: reseller.name, months: data.months, cost, balance: spent, expiresAt },
      member.id,
    );
    return { member: toMember(row), creditsLeft: spent, message };
  });

// Remove a customer now (no credit refund).
export const resellerRemoveMember = createServerFn({ method: "POST" })
  .inputValidator((input) => baseSchema.extend({ memberId: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const reseller = await requireReseller(data.portalCode);
    const member = await myMember(reseller.id, data.memberId);
    const settings = await getSettings();
    let actions: string[] = [];
    try {
      actions = await removeMemberAccess(settings, member);
    } catch (error) {
      if (!(error instanceof PlexApiError)) throw error;
    }
    const row = await updateMemberRow(member.id, { status: "removed" });
    await logEvent("reseller_removed", { reseller: reseller.name, actions }, member.id);
    return { member: toMember(row), actions };
  });
