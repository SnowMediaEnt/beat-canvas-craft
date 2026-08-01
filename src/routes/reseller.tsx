import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { REGEXP_ONLY_DIGITS_AND_CHARS } from "input-otp";
import { Coins, KeyRound, Link2, Lock, MoreHorizontal, PlugZap, RefreshCw, Tv } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ExpiryLabel, errMsg, fmtAgo } from "@/components/plex/plex-shared";
import {
  resellerCompleteSignIn,
  resellerGetPortal,
  resellerLinkCode,
  resellerRemoveMember,
  resellerRenewMember,
  resellerSaveToken,
  resellerScanForDevices,
  resellerStartSignIn,
} from "@/lib/plex/reseller.functions";
import { CREDIT_PACKAGES, type PlexMember, type ResellerPortalData } from "@/lib/plex/plex-types";

const PORTAL_CODE_KEY = "plex_reseller_code";

export const Route = createFileRoute("/reseller")({
  component: ResellerPage,
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === "string" ? search.code : undefined,
  }),
});

function ResellerPage() {
  const search = useSearch({ from: "/reseller" });
  const [portalCode, setPortalCode] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const fromUrl = search.code;
    const stored = window.localStorage.getItem(PORTAL_CODE_KEY);
    const code = fromUrl || stored;
    if (code) {
      window.localStorage.setItem(PORTAL_CODE_KEY, code);
      setPortalCode(code);
    }
    setChecked(true);
  }, [search.code]);

  if (!checked) return null;

  if (!portalCode) {
    return (
      <GateScreen
        onUnlocked={(code) => {
          window.localStorage.setItem(PORTAL_CODE_KEY, code);
          setPortalCode(code);
        }}
      />
    );
  }

  return (
    <ResellerDashboard
      portalCode={portalCode}
      onSignOut={() => {
        window.localStorage.removeItem(PORTAL_CODE_KEY);
        setPortalCode(null);
      }}
    />
  );
}

function GateScreen({ onUnlocked }: { onUnlocked: (code: string) => void }) {
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    if (!code.trim()) return;
    setChecking(true);
    try {
      await resellerGetPortal({ data: { portalCode: code.trim() } });
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
          <CardTitle>Reseller Portal</CardTitle>
          <CardDescription>Enter your portal code to manage your customers.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            placeholder="Portal code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            autoFocus
          />
          <Button className="w-full" onClick={submit} disabled={checking || !code.trim()}>
            {checking ? "Checking…" : "Enter portal"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ResellerDashboard({
  portalCode,
  onSignOut,
}: {
  portalCode: string;
  onSignOut: () => void;
}) {
  const portalQuery = useQuery({
    queryKey: ["reseller", portalCode],
    queryFn: () => resellerGetPortal({ data: { portalCode } }),
    refetchInterval: 60_000,
    retry: (count, error) => !errMsg(error).includes("Invalid portal code") && count < 2,
  });

  useEffect(() => {
    if (portalQuery.isError && errMsg(portalQuery.error).includes("Invalid portal code")) {
      toast.error("Portal code no longer valid.");
      onSignOut();
    }
  }, [portalQuery.isError, portalQuery.error, onSignOut]);

  const data = portalQuery.data;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/30">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3 px-4 py-4">
          <Tv className="h-6 w-6 text-primary" />
          <div className="mr-auto">
            <h1 className="text-lg font-semibold leading-tight">
              {data?.resellerName ? `${data.resellerName}'s Portal` : "Reseller Portal"}
            </h1>
            <p className="text-xs text-muted-foreground">Add and manage your Plex customers</p>
          </div>
          {data && (
            <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 text-primary">
              <Coins className="h-3.5 w-3.5" /> {data.credits} credits
            </Badge>
          )}
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        {portalQuery.isLoading ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
        ) : portalQuery.isError ? (
          <p className="py-16 text-center text-sm text-red-400">{errMsg(portalQuery.error)}</p>
        ) : data ? (
          <>
            <ConnectCard portalCode={portalCode} data={data} />
            {data.connected && <AddCustomerCard portalCode={portalCode} data={data} />}
            <CustomersCard portalCode={portalCode} data={data} />
          </>
        ) : null}
      </main>
    </div>
  );
}

function ConnectCard({ portalCode, data }: { portalCode: string; data: ResellerPortalData }) {
  const queryClient = useQueryClient();
  const [manualToken, setManualToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["reseller", portalCode] });

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  const startSignIn = async () => {
    try {
      setSigningIn(true);
      const start = await resellerStartSignIn({ data: { portalCode } });
      const popup = window.open(start.authUrl, "plex-signin", "width=640,height=780");
      if (!popup) {
        toast.error("Popup blocked — allow popups and try again.");
        setSigningIn(false);
        return;
      }
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts += 1;
        if (attempts > 100) {
          if (pollRef.current) clearInterval(pollRef.current);
          setSigningIn(false);
          toast.error("Sign-in timed out.");
          return;
        }
        try {
          const result = await resellerCompleteSignIn({ data: { portalCode, pinId: start.pinId } });
          if (!result.pending) {
            if (pollRef.current) clearInterval(pollRef.current);
            setSigningIn(false);
            toast.success(`Connected as ${result.username}`);
            popup.close();
            refresh();
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
    mutationFn: () => resellerSaveToken({ data: { portalCode, token: manualToken } }),
    onSuccess: (result) => {
      toast.success(`Connected as ${result.username}`);
      setManualToken("");
      refresh();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  if (data.connected) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <div className="flex items-center gap-2">
            <PlugZap className="h-5 w-5 text-emerald-400" />
            <div>
              <p className="text-sm font-medium text-emerald-300">
                Plex connected — {data.plexUsername}
              </p>
              <p className="text-xs text-muted-foreground">
                Your customers' devices sign in to this account.
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setShowToken((v) => !v)}>
            Reconnect
          </Button>
        </CardContent>
        {showToken && (
          <CardContent className="pt-0">
            <Button className="gap-2" onClick={startSignIn} disabled={signingIn}>
              <KeyRound className="h-4 w-4" />
              {signingIn ? "Waiting for approval…" : "Sign in with Plex again"}
            </Button>
          </CardContent>
        )}
      </Card>
    );
  }

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlugZap className="h-5 w-5" /> Connect your Plex account
        </CardTitle>
        <CardDescription>
          Your customers' devices sign into <span className="font-medium">your</span> Plex account.
          Connect it once. (The administrator must have already invited your account to the server.)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button className="w-full gap-2" onClick={startSignIn} disabled={signingIn}>
          <KeyRound className="h-4 w-4" />
          {signingIn ? "Waiting for you to approve in the Plex window…" : "Sign in with Plex"}
        </Button>
        <div className="flex gap-2">
          <Input
            type="password"
            placeholder="…or paste an X-Plex-Token"
            value={manualToken}
            onChange={(e) => setManualToken(e.target.value)}
          />
          <Button
            variant="outline"
            onClick={() => saveToken.mutate()}
            disabled={manualToken.trim().length < 8 || saveToken.isPending}
          >
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AddCustomerCard({ portalCode, data }: { portalCode: string; data: ResellerPortalData }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [months, setMonths] = useState(1);

  const link = useMutation({
    mutationFn: () => resellerLinkCode({ data: { portalCode, name: name.trim(), code, months } }),
    onSuccess: (result) => {
      if (result.devicesFound > 0) {
        toast.success(
          `${result.member.displayName} added — device linked. ${result.creditsLeft} credits left.`,
        );
      } else {
        toast.info(
          `${result.member.displayName} added and charged, but the device hasn't appeared yet. Use "Scan for device" on their row in a minute.`,
          { duration: 12000 },
        );
      }
      setName("");
      setCode("");
      queryClient.invalidateQueries({ queryKey: ["reseller", portalCode] });
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const notEnough = data.credits < months;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-5 w-5" /> Add a customer
        </CardTitle>
        <CardDescription>
          Your customer opens the Plex app on their TV, reads you the 4-character code from the
          plex.tv/link screen, and you enter it here. 1 month = 1 credit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="cust-name">Customer name</Label>
            <Input
              id="cust-name"
              placeholder="Who is this?"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cust-months">Length</Label>
            <Select value={String(months)} onValueChange={(v) => setMonths(Number(v))}>
              <SelectTrigger id="cust-months">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CREDIT_PACKAGES.map((pkg) => (
                  <SelectItem key={pkg.months} value={String(pkg.months)}>
                    {pkg.label} — {pkg.credits} {pkg.credits === 1 ? "credit" : "credits"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <Label>4-character code on their screen</Label>
          <InputOTP
            maxLength={4}
            value={code}
            onChange={(value) => setCode(value.toUpperCase())}
            pattern={REGEXP_ONLY_DIGITS_AND_CHARS}
          >
            <InputOTPGroup>
              {[0, 1, 2, 3].map((i) => (
                <InputOTPSlot key={i} index={i} className="h-12 w-12 text-lg uppercase" />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
        {notEnough && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            This costs {months} {months === 1 ? "credit" : "credits"} but you only have{" "}
            {data.credits}. Contact the administrator to top up.
          </p>
        )}
        <Button
          className="w-full"
          disabled={!name.trim() || code.length !== 4 || notEnough || link.isPending}
          onClick={() => link.mutate()}
        >
          {link.isPending
            ? "Linking device (takes ~15s)…"
            : `Add customer — ${months} ${months === 1 ? "credit" : "credits"}`}
        </Button>
      </CardContent>
    </Card>
  );
}

function CustomersCard({ portalCode, data }: { portalCode: string; data: ResellerPortalData }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["reseller", portalCode] });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Your customers</CardTitle>
          <CardDescription>Access ends automatically when their time runs out.</CardDescription>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={refresh}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {data.members.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No customers yet. Add one above with their 4-digit code.
          </p>
        ) : (
          <div className="space-y-2">
            {data.members.map((member) => (
              <CustomerRow
                key={member.id}
                portalCode={portalCode}
                member={member}
                credits={data.credits}
                onChanged={refresh}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CustomerRow({
  portalCode,
  member,
  credits,
  onChanged,
}: {
  portalCode: string;
  member: PlexMember;
  credits: number;
  onChanged: () => void;
}) {
  const [renewOpen, setRenewOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const scan = useMutation({
    mutationFn: () => resellerScanForDevices({ data: { portalCode, memberId: member.id } }),
    onSuccess: (result) => {
      if (result.attached) toast.success("Device found and linked.");
      else toast.info("No new device yet — have them finish sign-in, then scan again.");
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const remove = useMutation({
    mutationFn: () => resellerRemoveMember({ data: { portalCode, memberId: member.id } }),
    onSuccess: () => {
      toast.success(`${member.displayName} removed`);
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const needsDevice = member.deviceIds.length === 0 && member.status === "active";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/50 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{member.displayName}</span>
          {member.status === "active" ? (
            <Badge
              variant="outline"
              className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
            >
              active
            </Badge>
          ) : (
            <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-400">
              {member.status}
            </Badge>
          )}
          {needsDevice && (
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-400">
              no device
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {member.deviceNames.length > 0 ? member.deviceNames.join(", ") : "no device recorded"} ·{" "}
          <ExpiryLabel member={member} />
          {member.lastSeenAt ? ` · watched ${fmtAgo(member.lastSeenAt)}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setRenewOpen(true)}>
          Extend
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{member.displayName}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {needsDevice && (
              <DropdownMenuItem onClick={() => scan.mutate()}>Scan for device</DropdownMenuItem>
            )}
            {member.status === "active" && (
              <DropdownMenuItem className="text-red-400" onClick={() => setConfirmRemove(true)}>
                Remove now
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <RenewCustomerDialog
        portalCode={portalCode}
        member={member}
        credits={credits}
        open={renewOpen}
        onOpenChange={setRenewOpen}
        onChanged={onChanged}
      />

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {member.displayName} now?</AlertDialogTitle>
            <AlertDialogDescription>
              Their device is signed out immediately. This does not refund credits.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => remove.mutate()}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RenewCustomerDialog({
  portalCode,
  member,
  credits,
  open,
  onOpenChange,
  onChanged,
}: {
  portalCode: string;
  member: PlexMember;
  credits: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [months, setMonths] = useState(1);

  const renew = useMutation({
    mutationFn: () => resellerRenewMember({ data: { portalCode, memberId: member.id, months } }),
    onSuccess: (result) => {
      toast.success(`${member.displayName} extended. ${result.creditsLeft} credits left.`);
      if (result.message) toast.info(result.message, { duration: 12000 });
      onOpenChange(false);
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const notEnough = credits < months;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Extend {member.displayName}</DialogTitle>
          <DialogDescription>
            Adds time on top of their current expiration. 1 month = 1 credit. You have {credits}.
          </DialogDescription>
        </DialogHeader>
        <Select value={String(months)} onValueChange={(v) => setMonths(Number(v))}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CREDIT_PACKAGES.map((pkg) => (
              <SelectItem key={pkg.months} value={String(pkg.months)}>
                {pkg.label} — {pkg.credits} {pkg.credits === 1 ? "credit" : "credits"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {notEnough && (
          <p className="text-sm text-red-400">
            Not enough credits ({months} needed, {credits} available).
          </p>
        )}
        <DialogFooter>
          <Button onClick={() => renew.mutate()} disabled={notEnough || renew.isPending}>
            Extend — {months} {months === 1 ? "credit" : "credits"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
