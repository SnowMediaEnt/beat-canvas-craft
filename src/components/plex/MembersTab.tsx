import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, RefreshCw, UserPlus } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  plexCancelPendingInvite,
  plexForgetMember,
  plexGetServerAccess,
  plexImportShare,
  plexRemoveMemberNow,
  plexRenewMember,
  plexRevokeShare,
  plexScanForNewDevices,
  plexUpdateMember,
} from "@/lib/plex/plex.functions";
import type { PlexMember, PlexOverview } from "@/lib/plex/plex-types";
import {
  AccessTypeBadge,
  DEFAULT_DURATION,
  DurationPicker,
  ExpiryLabel,
  StatusBadge,
  errMsg,
  fmtAgo,
  toDurationInput,
  useAccessCode,
  type DurationValue,
} from "./plex-shared";

type ServerAccess = Awaited<ReturnType<typeof plexGetServerAccess>>;

export function MembersTab({ overview }: { overview: PlexOverview }) {
  const accessCode = useAccessCode();
  const queryClient = useQueryClient();
  const hasServer = Boolean(overview.server);

  const accessQuery = useQuery({
    queryKey: ["plex", "server-access"],
    queryFn: () => plexGetServerAccess({ data: { accessCode } }),
    enabled: overview.connected && hasServer,
    refetchInterval: 120_000,
    retry: 1,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["plex", "overview"] });
    queryClient.invalidateQueries({ queryKey: ["plex", "server-access"] });
  };

  const members = overview.members;
  const access = accessQuery.data;

  // Live shares that no tracked member accounts for → "untracked".
  const matchedShareIds = new Set(
    members
      .map((m) => findShareForMember(m, access))
      .filter(Boolean)
      .map((s) => s!.sharedServerId),
  );
  const untracked = (access?.shares ?? []).filter((s) => !matchedShareIds.has(s.sharedServerId));

  const trackedEmails = new Set(
    members.flatMap((m) => [m.email?.toLowerCase(), m.plexUsername?.toLowerCase()]).filter(Boolean),
  );
  const untrackedInvites = (access?.pendingInvites ?? []).filter(
    (i) =>
      !trackedEmails.has(i.email?.toLowerCase() ?? "") &&
      !trackedEmails.has(i.username?.toLowerCase() ?? ""),
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Managed members</CardTitle>
            <CardDescription>
              Everyone this dashboard controls. Expired members are removed automatically.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={refresh} className="gap-2">
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No members yet. Use the{" "}
              <span className="font-medium text-foreground">Add member</span> tab to invite someone
              or link a device with a 4-digit code.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => (
                  <MemberRow key={member.id} member={member} access={access} onChanged={refresh} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {overview.connected && hasServer && (
        <Card>
          <CardHeader>
            <CardTitle>On your server but not managed</CardTitle>
            <CardDescription>
              People with access on plex.tv that this dashboard is not tracking yet — including
              anyone added before today. Import them to give them an expiration date.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {accessQuery.isLoading ? (
              <p className="py-4 text-sm text-muted-foreground">
                Loading live share list from plex.tv…
              </p>
            ) : accessQuery.isError ? (
              <p className="py-4 text-sm text-red-400">{errMsg(accessQuery.error)}</p>
            ) : untracked.length === 0 && untrackedInvites.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                Everyone with access to your server is being managed. 🎉
              </p>
            ) : (
              <div className="space-y-2">
                {untracked.map((share) => (
                  <UntrackedShareRow key={share.sharedServerId} share={share} onChanged={refresh} />
                ))}
                {untrackedInvites.map((invite) => (
                  <div
                    key={invite.inviteId}
                    className="flex items-center justify-between rounded-lg border border-border bg-card/50 px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {invite.friendlyName || invite.username || invite.email}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Pending invite sent outside this tool
                      </p>
                    </div>
                    <CancelInviteButton inviteId={invite.inviteId} onChanged={refresh} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function findShareForMember(member: PlexMember, access: ServerAccess | undefined) {
  if (!access) return undefined;
  return access.shares.find(
    (s) =>
      (member.sharedServerId && s.sharedServerId === member.sharedServerId) ||
      (member.plexUserId && s.userId === member.plexUserId) ||
      (member.email &&
        (s.email?.toLowerCase() === member.email.toLowerCase() ||
          s.invitedEmail?.toLowerCase() === member.email.toLowerCase())) ||
      (member.plexUsername && s.username?.toLowerCase() === member.plexUsername.toLowerCase()),
  );
}

function MemberRow({
  member,
  access,
  onChanged,
}: {
  member: PlexMember;
  access: ServerAccess | undefined;
  onChanged: () => void;
}) {
  const accessCode = useAccessCode();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);

  const share = findShareForMember(member, access);
  const pending =
    member.accessType === "invite" && (share ? !share.accepted : member.inviteStatus === "pending");
  const lastSeen = share?.lastSeenAt ?? member.lastSeenAt;

  const renewQuick = useMutation({
    mutationFn: (days: number) =>
      plexRenewMember({ data: { accessCode, memberId: member.id, duration: { days } } }),
    onSuccess: (result) => {
      toast.success(`${member.displayName} renewed`);
      if (result.message) toast.info(result.message, { duration: 10000 });
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const removeNow = useMutation({
    mutationFn: () => plexRemoveMemberNow({ data: { accessCode, memberId: member.id } }),
    onSuccess: (result) => {
      toast.success(
        `${member.displayName} removed: ${result.actions.join("; ") || "nothing to do"}`,
      );
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const forget = useMutation({
    mutationFn: () => plexForgetMember({ data: { accessCode, memberId: member.id } }),
    onSuccess: () => {
      toast.success(`${member.displayName} is no longer tracked`);
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const scanDevices = useMutation({
    mutationFn: () => plexScanForNewDevices({ data: { accessCode, memberId: member.id } }),
    onSuccess: (result) => {
      if (result.attached) toast.success("Device found and attached.");
      else if (result.candidates.length > 0)
        toast.info(
          `${result.candidates.length} possible devices found — assign one in the Devices tab.`,
        );
      else toast.info("No new device yet. Have them finish sign-in, then scan again.");
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="font-medium">{member.displayName}</div>
          <div className="text-xs text-muted-foreground">
            {member.accessType === "invite"
              ? member.plexUsername || member.email
              : member.deviceNames.length > 0
                ? member.deviceNames.join(", ")
                : "no device recorded"}
          </div>
        </TableCell>
        <TableCell>
          <AccessTypeBadge type={member.accessType} />
        </TableCell>
        <TableCell>
          <StatusBadge status={member.status} pending={pending} />
        </TableCell>
        <TableCell>
          <ExpiryLabel member={member} />
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {lastSeen ? fmtAgo(lastSeen) : "never"}
        </TableCell>
        <TableCell>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{member.displayName}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => renewQuick.mutate(30)}>
                Extend 30 days
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => renewQuick.mutate(90)}>
                Extend 90 days
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRenewOpen(true)}>
                Set expiration…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setEditOpen(true)}>Edit details…</DropdownMenuItem>
              {member.accessType === "link_code" &&
                member.deviceIds.length === 0 &&
                member.status === "active" && (
                  <DropdownMenuItem onClick={() => scanDevices.mutate()}>
                    Scan for their device
                  </DropdownMenuItem>
                )}
              <DropdownMenuSeparator />
              {member.status === "active" && (
                <DropdownMenuItem className="text-red-400" onClick={() => setConfirmRemove(true)}>
                  Remove access now
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-muted-foreground"
                onClick={() => setConfirmForget(true)}
              >
                Stop tracking
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {member.displayName}'s access now?</AlertDialogTitle>
            <AlertDialogDescription>
              {member.accessType === "invite"
                ? "Their library share will be revoked on plex.tv immediately and any active stream will be stopped."
                : "Their linked device(s) will be signed out remotely and any active stream will be stopped."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => removeNow.mutate()}
            >
              Remove access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmForget} onOpenChange={setConfirmForget}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop tracking {member.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This only deletes them from this dashboard — it does NOT change anything on Plex. If
              they still have access, they will keep it and nothing will auto-expire.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => forget.mutate()}>Stop tracking</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <EditMemberDialog
        member={member}
        open={editOpen}
        onOpenChange={setEditOpen}
        onChanged={onChanged}
      />
      <RenewDialog
        member={member}
        open={renewOpen}
        onOpenChange={setRenewOpen}
        onChanged={onChanged}
      />
    </>
  );
}

function EditMemberDialog({
  member,
  open,
  onOpenChange,
  onChanged,
}: {
  member: PlexMember;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const accessCode = useAccessCode();
  const [name, setName] = useState(member.displayName);
  const [notes, setNotes] = useState(member.notes ?? "");

  const save = useMutation({
    mutationFn: () =>
      plexUpdateMember({ data: { accessCode, memberId: member.id, name, notes: notes || null } }),
    onSuccess: () => {
      toast.success("Member updated");
      onOpenChange(false);
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit member</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`name-${member.id}`}>Name</Label>
            <Input
              id={`name-${member.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`notes-${member.id}`}>Notes (payment info, contact, etc.)</Label>
            <Textarea
              id={`notes-${member.id}`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenewDialog({
  member,
  open,
  onOpenChange,
  onChanged,
}: {
  member: PlexMember;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const accessCode = useAccessCode();
  const [duration, setDuration] = useState<DurationValue>(DEFAULT_DURATION);

  const renew = useMutation({
    mutationFn: () =>
      plexRenewMember({
        data: { accessCode, memberId: member.id, duration: toDurationInput(duration) },
      }),
    onSuccess: (result) => {
      toast.success(`${member.displayName}'s access updated`);
      if (result.reinvited)
        toast.info("A fresh invite was sent since their old share was revoked.");
      if (result.message) toast.info(result.message, { duration: 10000 });
      onOpenChange(false);
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set expiration for {member.displayName}</DialogTitle>
          <DialogDescription>
            Extending from {member.expiresAt ? "their current expiration" : "today"}. Expired
            members are re-invited automatically (invite members) when you renew.
          </DialogDescription>
        </DialogHeader>
        <DurationPicker value={duration} onChange={setDuration} />
        <DialogFooter>
          <Button onClick={() => renew.mutate()} disabled={renew.isPending}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UntrackedShareRow({
  share,
  onChanged,
}: {
  share: ServerAccess["shares"][number];
  onChanged: () => void;
}) {
  const accessCode = useAccessCode();
  const [importOpen, setImportOpen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [name, setName] = useState(share.username || share.email || "");
  const [duration, setDuration] = useState<DurationValue>(DEFAULT_DURATION);

  const doImport = useMutation({
    mutationFn: () =>
      plexImportShare({
        data: {
          accessCode,
          name: name.trim(),
          sharedServerId: share.sharedServerId,
          userId: share.userId,
          username: share.username,
          email: share.email,
          duration: toDurationInput(duration),
        },
      }),
    onSuccess: () => {
      toast.success(`${name} is now managed`);
      setImportOpen(false);
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const revoke = useMutation({
    mutationFn: () =>
      plexRevokeShare({ data: { accessCode, sharedServerId: share.sharedServerId } }),
    onSuccess: () => {
      toast.success("Access revoked");
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/50 px-4 py-3">
      <div>
        <p className="text-sm font-medium">
          {share.username || share.invitedEmail || share.email || "Unknown"}
        </p>
        <p className="text-xs text-muted-foreground">
          {share.accepted ? "Has access" : "Invite pending"} ·{" "}
          {share.allLibraries ? "all libraries" : `${share.libraryTitles.length} libraries`}
          {share.lastSeenAt ? ` · last seen ${fmtAgo(share.lastSeenAt)}` : " · never streamed"}
        </p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setImportOpen(true)}>
          <UserPlus className="h-3.5 w-3.5" /> Manage
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-red-400 hover:text-red-300"
          onClick={() => setConfirmRevoke(true)}
        >
          Revoke
        </Button>
      </div>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manage {share.username || share.email}</DialogTitle>
            <DialogDescription>
              Start tracking this person with an expiration date. Their current Plex access is
              untouched until that date passes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Display name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Uncle Mike"
              />
            </div>
            <div className="space-y-2">
              <Label>Access lasts</Label>
              <DurationPicker value={duration} onChange={setDuration} />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => doImport.mutate()} disabled={!name.trim() || doImport.isPending}>
              Start managing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke access for {share.username || share.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              Their library share is removed from plex.tv immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => revoke.mutate()}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CancelInviteButton({ inviteId, onChanged }: { inviteId: string; onChanged: () => void }) {
  const accessCode = useAccessCode();
  const cancel = useMutation({
    mutationFn: () => plexCancelPendingInvite({ data: { accessCode, inviteId } }),
    onSuccess: () => {
      toast.success("Invite cancelled");
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });
  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-red-400 hover:text-red-300"
      onClick={() => cancel.mutate()}
    >
      Cancel invite
    </Button>
  );
}
