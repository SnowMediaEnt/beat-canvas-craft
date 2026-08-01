import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Clapperboard, Lock, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { ActivityTab } from "@/components/plex/ActivityTab";
import { AddMemberTab } from "@/components/plex/AddMemberTab";
import { DevicesTab } from "@/components/plex/DevicesTab";
import { MembersTab } from "@/components/plex/MembersTab";
import { SessionsTab } from "@/components/plex/SessionsTab";
import { SettingsTab } from "@/components/plex/SettingsTab";
import {
  ACCESS_CODE_STORAGE_KEY,
  PlexAccessProvider,
  errMsg,
  fmtAgo,
} from "@/components/plex/plex-shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { plexEnforceNow, plexGetOverview } from "@/lib/plex/plex.functions";
import type { PlexOverview } from "@/lib/plex/plex-types";

export const Route = createFileRoute("/plex")({
  component: PlexPage,
  ssr: false,
});

function PlexPage() {
  const [accessCode, setAccessCode] = useState<string | null>(null);
  const [checkedStorage, setCheckedStorage] = useState(false);

  useEffect(() => {
    setAccessCode(window.localStorage.getItem(ACCESS_CODE_STORAGE_KEY));
    setCheckedStorage(true);
  }, []);

  if (!checkedStorage) return null;

  if (!accessCode) {
    return (
      <GateScreen
        onUnlocked={(code) => {
          window.localStorage.setItem(ACCESS_CODE_STORAGE_KEY, code);
          setAccessCode(code);
        }}
      />
    );
  }

  return (
    <PlexAccessProvider value={accessCode}>
      <Dashboard
        accessCode={accessCode}
        onLock={() => {
          window.localStorage.removeItem(ACCESS_CODE_STORAGE_KEY);
          setAccessCode(null);
        }}
      />
    </PlexAccessProvider>
  );
}

function GateScreen({ onUnlocked }: { onUnlocked: (code: string) => void }) {
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    if (!code.trim()) return;
    setChecking(true);
    try {
      await plexGetOverview({ data: { accessCode: code.trim() } });
      onUnlocked(code.trim());
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Lock className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>Plex Member Manager</CardTitle>
          <CardDescription>Enter your admin access code.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            type="password"
            placeholder="Access code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            autoFocus
          />
          <Button className="w-full" onClick={submit} disabled={checking || !code.trim()}>
            {checking ? "Checking…" : "Unlock"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Dashboard({ accessCode, onLock }: { accessCode: string; onLock: () => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("members");

  const overviewQuery = useQuery({
    queryKey: ["plex", "overview"],
    queryFn: () => plexGetOverview({ data: { accessCode } }),
    refetchInterval: 60_000,
    retry: (failureCount, error) =>
      !errMsg(error).includes("Invalid access code") && failureCount < 2,
  });

  // Wrong stored code → back to the gate.
  useEffect(() => {
    if (overviewQuery.isError && errMsg(overviewQuery.error).includes("Invalid access code")) {
      toast.error("Access code no longer valid.");
      onLock();
    }
  }, [overviewQuery.isError, overviewQuery.error, onLock]);

  const enforce = useMutation({
    mutationFn: () => plexEnforceNow({ data: { accessCode } }),
    onSuccess: (result) => {
      if (result.removed.length > 0) {
        toast.info(`Auto-removed ${result.removed.map((r) => r.name).join(", ")} — time expired.`);
        queryClient.invalidateQueries({ queryKey: ["plex"] });
      }
    },
  });

  // While the dashboard is open, sweep for expired members every 5 minutes.
  const connected = overviewQuery.data?.connected ?? false;
  useEffect(() => {
    if (!connected) return;
    enforce.mutate();
    const interval = setInterval(() => enforce.mutate(), 5 * 60 * 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const overview = overviewQuery.data;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/30">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-4">
          <Clapperboard className="h-6 w-6 text-primary" />
          <div className="mr-auto">
            <h1 className="text-lg font-semibold leading-tight">Plex Member Manager</h1>
            <p className="text-xs text-muted-foreground">
              {overview?.server?.name ? (
                <>
                  {overview.server.name}
                  {overview.account ? ` · ${overview.account.username}` : ""}
                  {overview.lastEnforcedAt
                    ? ` · last check ${fmtAgo(overview.lastEnforcedAt)}`
                    : ""}
                </>
              ) : (
                "Invite, link, monitor, and auto-expire access to your server"
              )}
            </p>
          </div>
          {overview && (
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={
                  overview.connected
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-400"
                }
              >
                <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                {overview.connected ? "connected" : "not connected"}
              </Badge>
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onLock}>
                Lock
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {overviewQuery.isLoading ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
        ) : overviewQuery.isError ? (
          <p className="py-16 text-center text-sm text-red-400">{errMsg(overviewQuery.error)}</p>
        ) : overview ? (
          <>
            {!overview.connected && (
              <Card className="mb-6 border-amber-500/30 bg-amber-500/5">
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <p className="text-sm">
                    <span className="font-medium">Get started:</span> connect your Plex account and
                    pick your server in Settings — then you can invite people, link 4-digit codes,
                    and let expirations handle themselves.
                  </p>
                  <Button size="sm" onClick={() => setTab("settings")}>
                    Open Settings
                  </Button>
                </CardContent>
              </Card>
            )}
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="mb-6 flex h-auto w-full flex-wrap justify-start">
                <TabsTrigger value="members">
                  Members
                  {overview.members.filter((m) => m.status === "active").length > 0 && (
                    <span className="ml-1.5 rounded-full bg-primary/15 px-1.5 text-xs text-primary">
                      {overview.members.filter((m) => m.status === "active").length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="add">Add member</TabsTrigger>
                <TabsTrigger value="devices">Devices</TabsTrigger>
                <TabsTrigger value="sessions">Sessions</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
              <TabsContent value="members">
                <MembersTab overview={overview as PlexOverview} />
              </TabsContent>
              <TabsContent value="add">
                <AddMemberTab
                  overview={overview as PlexOverview}
                  onDone={() => setTab("members")}
                />
              </TabsContent>
              <TabsContent value="devices">
                <DevicesTab overview={overview as PlexOverview} />
              </TabsContent>
              <TabsContent value="sessions">
                <SessionsTab overview={overview as PlexOverview} />
              </TabsContent>
              <TabsContent value="activity">
                <ActivityTab overview={overview as PlexOverview} />
              </TabsContent>
              <TabsContent value="settings">
                <SettingsTab overview={overview as PlexOverview} />
              </TabsContent>
            </Tabs>
          </>
        ) : null}
      </main>
    </div>
  );
}
