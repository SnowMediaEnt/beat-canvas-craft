import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { REGEXP_ONLY_DIGITS_AND_CHARS } from "input-otp";
import { AlertTriangle, Link2, Mail } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { plexGetLibraries, plexInviteMember, plexLinkCode } from "@/lib/plex/plex.functions";
import type { PlexOverview } from "@/lib/plex/plex-types";
import {
  DEFAULT_DURATION,
  DurationPicker,
  durationSummary,
  errMsg,
  toDurationInput,
  useAccessCode,
  type DurationValue,
} from "./plex-shared";

export function AddMemberTab({ overview, onDone }: { overview: PlexOverview; onDone: () => void }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <InviteCard overview={overview} onDone={onDone} />
      <LinkCodeCard overview={overview} onDone={onDone} />
    </div>
  );
}

function InviteCard({ overview, onDone }: { overview: PlexOverview; onDone: () => void }) {
  const accessCode = useAccessCode();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [duration, setDuration] = useState<DurationValue>(DEFAULT_DURATION);
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<string[] | null>(null);

  const librariesQuery = useQuery({
    queryKey: ["plex", "libraries"],
    queryFn: () => plexGetLibraries({ data: { accessCode } }),
    enabled: overview.connected && Boolean(overview.server),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const libraries = librariesQuery.data ?? [];
  const effectiveSelected =
    selected ??
    (overview.defaultLibraryIds.length > 0
      ? overview.defaultLibraryIds
      : libraries.map((l) => l.id));

  const invite = useMutation({
    mutationFn: () =>
      plexInviteMember({
        data: {
          accessCode,
          name: name.trim(),
          email: email.trim(),
          libraryIds: effectiveSelected,
          duration: toDurationInput(duration),
          notes,
        },
      }),
    onSuccess: (member) => {
      toast.success(
        `Invite sent to ${member.email}. Access ${member.expiresAt ? "runs out automatically" : "has no expiration"} — ${durationSummary(duration)}.`,
      );
      setName("");
      setEmail("");
      setNotes("");
      queryClient.invalidateQueries({ queryKey: ["plex"] });
      onDone();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const ready = overview.connected && Boolean(overview.server);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-5 w-5" /> Invite by email
        </CardTitle>
        <CardDescription>
          The clean way: they use their own Plex account, you pick the libraries, and this dashboard
          revokes the share the moment their time is up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!ready && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
            Connect your Plex account and select your server in Settings first.
          </p>
        )}
        <div className="space-y-2">
          <Label htmlFor="invite-name">Member name</Label>
          <Input
            id="invite-name"
            placeholder="Who is this? (your label, not theirs)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invite-email">Plex email or username</Label>
          <Input
            id="invite-email"
            placeholder="person@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Libraries to share</Label>
          {librariesQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading libraries…</p>
          ) : libraries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No libraries found yet.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {libraries.map((lib) => (
                <label key={lib.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={effectiveSelected.includes(lib.id)}
                    onCheckedChange={(checked) => {
                      const base = effectiveSelected;
                      setSelected(checked ? [...base, lib.id] : base.filter((id) => id !== lib.id));
                    }}
                  />
                  {lib.title}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-2">
          <Label>Access lasts</Label>
          <DurationPicker value={duration} onChange={setDuration} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invite-notes">Notes (optional)</Label>
          <Textarea
            id="invite-notes"
            rows={2}
            placeholder="Paid $10 on CashApp, renews monthly…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <Button
          className="w-full"
          disabled={!ready || !name.trim() || !email.trim() || invite.isPending}
          onClick={() => invite.mutate()}
        >
          {invite.isPending ? "Sending invite…" : "Send invite"}
        </Button>
      </CardContent>
    </Card>
  );
}

function LinkCodeCard({ overview, onDone }: { overview: PlexOverview; onDone: () => void }) {
  const accessCode = useAccessCode();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [duration, setDuration] = useState<DurationValue>(DEFAULT_DURATION);
  const [notes, setNotes] = useState("");

  const link = useMutation({
    mutationFn: () =>
      plexLinkCode({
        data: { accessCode, name: name.trim(), code, duration: toDurationInput(duration), notes },
      }),
    onSuccess: (result) => {
      if (result.devicesFound > 0) {
        toast.success(
          `Device linked for ${result.member.displayName} (${result.member.deviceNames.join(", ")}). It signs out automatically when their time is up.`,
        );
      } else {
        toast.info(
          "Code accepted, but the device hasn't shown up yet. Open their member menu and hit “Scan for their device” in a minute.",
          { duration: 12000 },
        );
      }
      setName("");
      setCode("");
      setNotes("");
      queryClient.invalidateQueries({ queryKey: ["plex"] });
      onDone();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const usingLinkAccount = Boolean(overview.linkAccount);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-5 w-5" /> Link a device (4-digit code)
        </CardTitle>
        <CardDescription>
          For TVs and boxes signed in at plex.tv/link. The code signs their device into your account
          — this dashboard records the device and signs it out remotely when their time expires.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className={
            usingLinkAccount
              ? "rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
              : "rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300"
          }
        >
          {usingLinkAccount ? (
            <>
              Devices get signed in to your dedicated link account{" "}
              <span className="font-semibold">{overview.linkAccount?.username}</span> — good setup.
            </>
          ) : (
            <span className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Devices will be signed in to your OWNER account, which lets them see everything and
                touch admin features in some apps. Strongly recommended: create a spare Plex
                account, invite it to your server, and connect it as the “device sign-in account” in
                Settings.
              </span>
            </span>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="link-name">Member name</Label>
          <Input
            id="link-name"
            placeholder="Who owns this TV/device?"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>The 4-character code on their screen</Label>
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
          <p className="text-xs text-muted-foreground">
            Codes expire after a few minutes — link it while they're on the screen.
          </p>
        </div>
        <div className="space-y-2">
          <Label>Access lasts</Label>
          <DurationPicker value={duration} onChange={setDuration} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="link-notes">Notes (optional)</Label>
          <Textarea
            id="link-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <Button
          className="w-full"
          disabled={!overview.connected || !name.trim() || code.length !== 4 || link.isPending}
          onClick={() => link.mutate()}
        >
          {link.isPending ? "Linking device (takes ~15s)…" : "Link their device"}
        </Button>
      </CardContent>
    </Card>
  );
}
