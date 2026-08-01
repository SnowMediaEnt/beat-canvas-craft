import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, PlugZap, ServerIcon, ShieldCheck, TimerReset } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  plexCompleteSignIn,
  plexDisconnect,
  plexEnforceNow,
  plexGetLibraries,
  plexListServers,
  plexSaveToken,
  plexSelectServer,
  plexStartSignIn,
  plexUpdateSettings,
} from "@/lib/plex/plex.functions";
import type { PlexOverview } from "@/lib/plex/plex-types";
import { errMsg, fmtDate, useAccessCode } from "./plex-shared";

export function SettingsTab({ overview }: { overview: PlexOverview }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["plex"] });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <AccountCard
        overview={overview}
        target="owner"
        title="Plex account (server owner)"
        description="The account that owns your server. Used to send invites, revoke shares, list devices, and watch sessions."
        onChanged={refresh}
      />
      <AccountCard
        overview={overview}
        target="link"
        title="Device sign-in account (recommended)"
        description="A spare Plex account that 4-digit-code devices get signed in to, so customers never hold your owner login. Create one, invite it to your server with the libraries you want, then connect it here."
        onChanged={refresh}
      />
      <ServerCard overview={overview} onChanged={refresh} />
      <DefaultsCard overview={overview} onChanged={refresh} />
      <EnforcementCard overview={overview} onChanged={refresh} />
    </div>
  );
}

function AccountCard({
  overview,
  target,
  title,
  description,
  onChanged,
}: {
  overview: PlexOverview;
  target: "owner" | "link";
  title: string;
  description: string;
  onChanged: () => void;
}) {
  const accessCode = useAccessCode();
  const [manualToken, setManualToken] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connected = target === "owner" ? overview.account : overview.linkAccount;

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  const startSignIn = async () => {
    try {
      setSigningIn(true);
      const start = await plexStartSignIn({ data: { accessCode, target } });
      const popup = window.open(start.authUrl, "plex-signin", "width=640,height=780");
      if (!popup) {
        toast.error("Popup blocked — allow popups for this site and try again.");
        setSigningIn(false);
        return;
      }
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts += 1;
        if (attempts > 100) {
          if (pollRef.current) clearInterval(pollRef.current);
          setSigningIn(false);
          toast.error("Sign-in timed out. Try again.");
          return;
        }
        try {
          const result = await plexCompleteSignIn({
            data: { accessCode, pinId: start.pinId, target },
          });
          if (!result.pending) {
            if (pollRef.current) clearInterval(pollRef.current);
            setSigningIn(false);
            toast.success(`Connected as ${result.username}`);
            popup.close();
            onChanged();
          }
        } catch (error) {
          if (pollRef.current) clearInterval(pollRef.current);
          setSigningIn(false);
          toast.error(errMsg(error));
        }
      }, 3000);
    } catch (error) {
      setSigningIn(false);
      toast.error(errMsg(error));
    }
  };

  const saveToken = useMutation({
    mutationFn: () => plexSaveToken({ data: { accessCode, token: manualToken, target } }),
    onSuccess: (result) => {
      toast.success(`Connected as ${result.username}`);
      setManualToken("");
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const disconnect = useMutation({
    mutationFn: () => plexDisconnect({ data: { accessCode, target } }),
    onSuccess: () => {
      toast.success("Disconnected");
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlugZap className="h-5 w-5" /> {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connected ? (
          <div className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-emerald-300">
                {connected.username}
                {target === "owner" && overview.account?.plexPass && (
                  <Badge
                    variant="outline"
                    className="ml-2 border-amber-500/40 bg-amber-500/10 text-amber-400"
                  >
                    Plex Pass
                  </Badge>
                )}
              </p>
              <p className="text-xs text-muted-foreground">{connected.email}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-400"
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <Button className="w-full gap-2" onClick={startSignIn} disabled={signingIn}>
            <KeyRound className="h-4 w-4" />
            {signingIn ? "Waiting for you to approve in the Plex window…" : "Sign in with Plex"}
          </Button>
        )}

        <Collapsible>
          <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            {connected ? "Replace with a token instead" : "Or paste an X-Plex-Token manually"}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 flex gap-2">
            <Input
              placeholder="X-Plex-Token"
              value={manualToken}
              onChange={(e) => setManualToken(e.target.value)}
              type="password"
            />
            <Button
              variant="outline"
              onClick={() => saveToken.mutate()}
              disabled={manualToken.trim().length < 8 || saveToken.isPending}
            >
              Save
            </Button>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

function ServerCard({ overview, onChanged }: { overview: PlexOverview; onChanged: () => void }) {
  const accessCode = useAccessCode();
  const [serverUrl, setServerUrl] = useState(overview.server?.url ?? "");

  useEffect(() => {
    setServerUrl(overview.server?.url ?? "");
  }, [overview.server?.url]);

  const serversQuery = useQuery({
    queryKey: ["plex", "servers"],
    queryFn: () => plexListServers({ data: { accessCode } }),
    enabled: overview.connected,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const select = useMutation({
    mutationFn: (value: { machineIdentifier: string; name: string }) =>
      plexSelectServer({ data: { accessCode, ...value } }),
    onSuccess: (result) => {
      toast.success(
        result.url
          ? `Server selected — reachable at ${result.url}`
          : "Server selected. No public connection found — set a server URL below for session monitoring.",
      );
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const saveUrl = useMutation({
    mutationFn: () => plexUpdateSettings({ data: { accessCode, serverUrl: serverUrl || null } }),
    onSuccess: () => {
      toast.success("Server URL saved");
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ServerIcon className="h-5 w-5" /> Media server
        </CardTitle>
        <CardDescription>Which of your servers this dashboard manages.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!overview.connected ? (
          <p className="text-sm text-muted-foreground">Connect your Plex account first.</p>
        ) : (
          <>
            <div className="space-y-2">
              <Label>Server</Label>
              <Select
                value={overview.server?.machineIdentifier ?? ""}
                onValueChange={(machineIdentifier) => {
                  const server = serversQuery.data?.find(
                    (s) => s.machineIdentifier === machineIdentifier,
                  );
                  if (server) select.mutate({ machineIdentifier, name: server.name });
                }}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      serversQuery.isLoading ? "Loading your servers…" : "Pick your server"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {(serversQuery.data ?? []).map((s) => (
                    <SelectItem key={s.machineIdentifier} value={s.machineIdentifier}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {serversQuery.isError && (
                <p className="text-xs text-red-400">{errMsg(serversQuery.error)}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="server-url">Server URL (for live sessions & stream kills)</Label>
              <div className="flex gap-2">
                <Input
                  id="server-url"
                  placeholder="https://1-2-3-4.xxxx.plex.direct:32400"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                />
                <Button
                  variant="outline"
                  onClick={() => saveUrl.mutate()}
                  disabled={saveUrl.isPending}
                >
                  Save
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Auto-detected when you pick a server. Must be reachable from the internet (a
                plex.direct URL or your public IP + port).
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DefaultsCard({ overview, onChanged }: { overview: PlexOverview; onChanged: () => void }) {
  const accessCode = useAccessCode();
  const librariesQuery = useQuery({
    queryKey: ["plex", "libraries"],
    queryFn: () => plexGetLibraries({ data: { accessCode } }),
    enabled: overview.connected && Boolean(overview.server),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const update = useMutation({
    mutationFn: (patch: { removeFriendOnExpiry?: boolean; defaultLibraryIds?: string[] }) =>
      plexUpdateSettings({ data: { accessCode, ...patch } }),
    onSuccess: () => onChanged(),
    onError: (error) => toast.error(errMsg(error)),
  });

  const libraries = librariesQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" /> Sharing behavior
        </CardTitle>
        <CardDescription>Defaults applied when inviting and removing members.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Also unfriend on removal</p>
            <p className="text-xs text-muted-foreground">
              Besides revoking the library share, drop the plex.tv friendship so they fully
              disappear from your users list.
            </p>
          </div>
          <Switch
            checked={overview.removeFriendOnExpiry}
            onCheckedChange={(checked) => update.mutate({ removeFriendOnExpiry: checked })}
          />
        </div>
        <div className="space-y-2">
          <Label>Default libraries for new invites</Label>
          {libraries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {overview.server ? "Loading libraries…" : "Select a server first."}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {libraries.map((lib) => (
                <label key={lib.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={overview.defaultLibraryIds.includes(lib.id)}
                    onCheckedChange={(checked) => {
                      const next = checked
                        ? [...overview.defaultLibraryIds, lib.id]
                        : overview.defaultLibraryIds.filter((id) => id !== lib.id);
                      update.mutate({ defaultLibraryIds: next });
                    }}
                  />
                  {lib.title}
                </label>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EnforcementCard({
  overview,
  onChanged,
}: {
  overview: PlexOverview;
  onChanged: () => void;
}) {
  const accessCode = useAccessCode();
  const [copied, setCopied] = useState(false);

  const enforceNow = useMutation({
    mutationFn: () => plexEnforceNow({ data: { accessCode } }),
    onSuccess: (result) => {
      if (result.skipped) toast.info(`Enforcement skipped: ${result.skipped}`);
      else
        toast.success(
          `Checked ${result.checked} active members — removed ${result.removed.length}, errors ${result.errors.length}.`,
        );
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const enforceUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/public/plex-enforce?key=${overview.enforceKey}`
      : `/api/public/plex-enforce?key=${overview.enforceKey}`;

  const lastResult = overview.lastEnforceResult;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TimerReset className="h-5 w-5" /> Automatic shut-off
        </CardTitle>
        <CardDescription>
          This is the piece Plex doesn't give you: when a member's time runs out, their share is
          revoked or their devices are signed out — automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card/50 px-4 py-3 text-sm">
          <span className="text-muted-foreground">Last run:</span>
          <span className="font-medium">
            {overview.lastEnforcedAt ? fmtDate(overview.lastEnforcedAt) : "never"}
          </span>
          {lastResult && (
            <span className="text-muted-foreground">
              via {lastResult.trigger} · {lastResult.removed.length} removed ·{" "}
              {lastResult.errors.length} errors
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => enforceNow.mutate()}
            disabled={enforceNow.isPending}
          >
            {enforceNow.isPending ? "Running…" : "Run now"}
          </Button>
        </div>

        <div className="space-y-2">
          <Label>External trigger URL (keep this secret)</Label>
          <div className="flex gap-2">
            <Input readOnly value={enforceUrl} className="font-mono text-xs" />
            <Button
              variant="outline"
              size="icon"
              onClick={async () => {
                await navigator.clipboard.writeText(enforceUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? (
                <Check className="h-4 w-4 text-emerald-400" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>Expirations are checked every 5 minutes while this dashboard is open.</li>
          <li>
            <span className="font-medium text-foreground">Recommended:</span> point a free pinger
            (cron-job.org, UptimeRobot) at the URL above every 10–15 minutes — any GET request with
            the key runs a check, so expirations are enforced 24/7 even with everything closed.
            Check "Last run" above to confirm it's working.
          </li>
          <li>
            A Cloudflare cron trigger is also configured and may run every 15 minutes depending on
            how the app is deployed.
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}
