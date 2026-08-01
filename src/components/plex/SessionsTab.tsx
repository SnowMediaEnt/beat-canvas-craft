import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorPlay, RefreshCw, Square } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { plexGetSessions, plexKillSession } from "@/lib/plex/plex.functions";
import type { PlexOverview, PlexSessionRow } from "@/lib/plex/plex-types";
import { errMsg, useAccessCode } from "./plex-shared";

const DEFAULT_REASON = "Your access period has ended. Contact Snow Media to renew.";

export function SessionsTab({ overview }: { overview: PlexOverview }) {
  const accessCode = useAccessCode();
  const queryClient = useQueryClient();

  const sessionsQuery = useQuery({
    queryKey: ["plex", "sessions"],
    queryFn: () => plexGetSessions({ data: { accessCode } }),
    enabled: overview.connected && Boolean(overview.server?.url),
    refetchInterval: 15_000,
    retry: 1,
  });

  const sessions = (sessionsQuery.data ?? []) as PlexSessionRow[];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <MonitorPlay className="h-5 w-5" /> Streaming right now
          </CardTitle>
          <CardDescription>
            Live sessions straight from your server, refreshed every 15 seconds.
            {overview.account && !overview.account.plexPass && (
              <span className="mt-1 block text-amber-400">
                Heads up: killing a stream is a Plex Pass feature — Plex will refuse it without one.
                Removing access still works either way.
              </span>
            )}
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => queryClient.invalidateQueries({ queryKey: ["plex", "sessions"] })}
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {!overview.connected ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Connect your Plex account first.
          </p>
        ) : !overview.server?.url ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No reachable server URL yet — re-select your server (or set a server URL) in Settings.
          </p>
        ) : sessionsQuery.isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Checking sessions…</p>
        ) : sessionsQuery.isError ? (
          <p className="py-8 text-center text-sm text-red-400">{errMsg(sessionsQuery.error)}</p>
        ) : sessions.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nobody is streaming right now.
          </p>
        ) : (
          <div className="space-y-3">
            {sessions.map((session, i) => (
              <SessionRow key={session.sessionId ?? i} session={session} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SessionRow({ session }: { session: PlexSessionRow }) {
  const accessCode = useAccessCode();
  const queryClient = useQueryClient();
  const [killOpen, setKillOpen] = useState(false);
  const [reason, setReason] = useState(DEFAULT_REASON);

  const kill = useMutation({
    mutationFn: () =>
      plexKillSession({ data: { accessCode, sessionId: session.sessionId as string, reason } }),
    onSuccess: () => {
      toast.success("Stream terminated");
      setKillOpen(false);
      queryClient.invalidateQueries({ queryKey: ["plex", "sessions"] });
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/50 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{session.mediaTitle}</p>
        <p className="text-xs text-muted-foreground">
          {session.memberName ? `${session.memberName} · ` : ""}
          {session.userTitle ?? "unknown user"} ·{" "}
          {session.playerTitle ?? session.product ?? "unknown player"}
          {session.address ? ` · ${session.address}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className={
            session.state === "paused"
              ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
          }
        >
          {session.state ?? "playing"}
        </Badge>
        {session.sessionId && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-red-400 hover:text-red-300"
            onClick={() => setKillOpen(true)}
          >
            <Square className="h-3.5 w-3.5" /> Kill
          </Button>
        )}
      </div>

      <Dialog open={killOpen} onOpenChange={setKillOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kill this stream?</DialogTitle>
            <DialogDescription>
              {session.userTitle ?? "The viewer"} sees the message below on their screen.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="kill-reason">Message shown to them</Label>
            <Input id="kill-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="destructive" onClick={() => kill.mutate()} disabled={kill.isPending}>
              Kill stream
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
