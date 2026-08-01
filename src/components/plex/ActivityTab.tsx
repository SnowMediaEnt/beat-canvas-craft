import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { plexGetEvents } from "@/lib/plex/plex.functions";
import type { PlexEventRow, PlexOverview } from "@/lib/plex/plex-types";
import { errMsg, fmtDate, useAccessCode } from "./plex-shared";

const ACTION_LABELS: Record<string, { label: string; className: string }> = {
  invited: { label: "invited", className: "border-sky-500/40 bg-sky-500/10 text-sky-400" },
  imported: { label: "imported", className: "border-sky-500/40 bg-sky-500/10 text-sky-400" },
  linked_device: {
    label: "device linked",
    className: "border-sky-500/40 bg-sky-500/10 text-sky-400",
  },
  device_assigned: {
    label: "device assigned",
    className: "border-sky-500/40 bg-sky-500/10 text-sky-400",
  },
  renewed: {
    label: "renewed",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  },
  auto_removed: {
    label: "auto-removed",
    className: "border-red-500/40 bg-red-500/10 text-red-400",
  },
  removed_manually: { label: "removed", className: "border-red-500/40 bg-red-500/10 text-red-400" },
  share_revoked: {
    label: "share revoked",
    className: "border-red-500/40 bg-red-500/10 text-red-400",
  },
  invite_cancelled: {
    label: "invite cancelled",
    className: "border-red-500/40 bg-red-500/10 text-red-400",
  },
  device_signed_out: {
    label: "device signed out",
    className: "border-red-500/40 bg-red-500/10 text-red-400",
  },
  session_killed: {
    label: "stream killed",
    className: "border-red-500/40 bg-red-500/10 text-red-400",
  },
  enforce_error: {
    label: "enforce error",
    className: "border-red-500/40 bg-red-500/10 text-red-400",
  },
  enforcement_run: {
    label: "enforcement",
    className: "border-border bg-secondary/60 text-secondary-foreground",
  },
  account_connected: {
    label: "account connected",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  },
  account_disconnected: {
    label: "account disconnected",
    className: "border-border bg-muted/40 text-muted-foreground",
  },
  server_selected: {
    label: "server selected",
    className: "border-border bg-secondary/60 text-secondary-foreground",
  },
  forgotten: {
    label: "stopped tracking",
    className: "border-border bg-muted/40 text-muted-foreground",
  },
};

function describeDetail(event: PlexEventRow): string {
  const d = event.detail as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof d.email === "string") bits.push(d.email);
  if (typeof d.username === "string" && d.username) bits.push(String(d.username));
  if (Array.isArray(d.actions)) bits.push((d.actions as string[]).join("; "));
  if (Array.isArray(d.devices) && d.devices.length)
    bits.push(`devices: ${(d.devices as string[]).join(", ")}`);
  if (typeof d.expiresAt === "string") bits.push(`until ${fmtDate(d.expiresAt)}`);
  if (d.expiresAt === null) bits.push("no expiration");
  if (typeof d.message === "string") bits.push(String(d.message));
  if (typeof d.reason === "string") bits.push(`"${d.reason}"`);
  if (typeof d.trigger === "string") bits.push(`via ${d.trigger}`);
  if (typeof d.removed === "number") bits.push(`${d.removed} removed`);
  if (typeof d.errors === "number" && (d.errors as number) > 0) bits.push(`${d.errors} errors`);
  return bits.join(" · ");
}

export function ActivityTab({ overview }: { overview: PlexOverview }) {
  const accessCode = useAccessCode();
  const eventsQuery = useQuery({
    queryKey: ["plex", "events"],
    queryFn: () => plexGetEvents({ data: { accessCode, limit: 100 } }),
    refetchInterval: 60_000,
  });

  const memberNames = new Map(overview.members.map((m) => [m.id, m.displayName]));
  const events = (eventsQuery.data ?? []) as PlexEventRow[];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollText className="h-5 w-5" /> Activity
        </CardTitle>
        <CardDescription>
          Every access change this dashboard has made, newest first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {eventsQuery.isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading activity…</p>
        ) : eventsQuery.isError ? (
          <p className="py-8 text-center text-sm text-red-400">{errMsg(eventsQuery.error)}</p>
        ) : events.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <div className="space-y-1.5">
            {events.map((event) => {
              const style = ACTION_LABELS[event.action] ?? {
                label: event.action,
                className: "border-border bg-secondary/60 text-secondary-foreground",
              };
              return (
                <div
                  key={event.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-2 text-sm"
                >
                  <span className="w-40 shrink-0 text-xs text-muted-foreground">
                    {fmtDate(event.createdAt)}
                  </span>
                  <Badge variant="outline" className={style.className}>
                    {style.label}
                  </Badge>
                  {event.memberId && (
                    <span className="font-medium">
                      {memberNames.get(event.memberId) ?? "former member"}
                    </span>
                  )}
                  <span className="text-muted-foreground">{describeDetail(event)}</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
