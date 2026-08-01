import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Coins, MoreHorizontal, Store, UserCog } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  plexAdjustCredits,
  plexCreateReseller,
  plexDeleteReseller,
  plexRegenResellerCode,
  plexUpdateReseller,
} from "@/lib/plex/plex.functions";
import type { PlexOverview, PlexResellerSummary } from "@/lib/plex/plex-types";
import { errMsg, useAccessCode } from "./plex-shared";

export function ResellersTab({ overview }: { overview: PlexOverview }) {
  const [createOpen, setCreateOpen] = useState(false);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["plex", "overview"] });

  const resellers = overview.resellers;
  const totalCredits = resellers.reduce((sum, r) => sum + r.credits, 0);
  const totalCustomers = resellers.reduce((sum, r) => sum + r.activeMemberCount, 0);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Store className="h-5 w-5" /> Resellers
            </CardTitle>
            <CardDescription>
              Give trusted people a credit balance and their own portal to add customers under their
              own Plex account. 1 credit = 1 month for 1 customer.
            </CardDescription>
          </div>
          <Button onClick={() => setCreateOpen(true)}>Add reseller</Button>
        </CardHeader>
        <CardContent>
          {resellers.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No resellers yet. Add one, grant them credits, and share their portal link.
            </p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap gap-4 text-sm text-muted-foreground">
                <span>
                  <span className="font-semibold text-foreground">{resellers.length}</span>{" "}
                  resellers
                </span>
                <span>
                  <span className="font-semibold text-foreground">{totalCredits}</span> credits
                  outstanding
                </span>
                <span>
                  <span className="font-semibold text-foreground">{totalCustomers}</span> active
                  reseller customers
                </span>
              </div>
              <div className="space-y-3">
                {resellers.map((reseller) => (
                  <ResellerCard key={reseller.id} reseller={reseller} onChanged={refresh} />
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <CreateResellerDialog open={createOpen} onOpenChange={setCreateOpen} onChanged={refresh} />
    </div>
  );
}

function ResellerCard({
  reseller,
  onChanged,
}: {
  reseller: PlexResellerSummary;
  onChanged: () => void;
}) {
  const accessCode = useAccessCode();
  const [copied, setCopied] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const portalUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/reseller?code=${reseller.portalCode}`
      : `/reseller?code=${reseller.portalCode}`;

  const toggleStatus = useMutation({
    mutationFn: () =>
      plexUpdateReseller({
        data: {
          accessCode,
          resellerId: reseller.id,
          status: reseller.status === "active" ? "disabled" : "active",
        },
      }),
    onSuccess: () => {
      toast.success(reseller.status === "active" ? "Reseller disabled" : "Reseller enabled");
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const regen = useMutation({
    mutationFn: () => plexRegenResellerCode({ data: { accessCode, resellerId: reseller.id } }),
    onSuccess: () => {
      toast.success("New portal code generated — share the new link.");
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const del = useMutation({
    mutationFn: () => plexDeleteReseller({ data: { accessCode, resellerId: reseller.id } }),
    onSuccess: () => {
      toast.success(`${reseller.name} deleted`);
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  return (
    <div className="rounded-lg border border-border bg-card/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="font-medium">{reseller.name}</p>
            {reseller.status === "disabled" && (
              <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-400">
                disabled
              </Badge>
            )}
            {reseller.connected ? (
              <Badge
                variant="outline"
                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
              >
                {reseller.plexUsername}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-amber-500/40 bg-amber-500/10 text-amber-400"
              >
                Plex not connected
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {reseller.activeMemberCount} active · {reseller.memberCount} total customers
            {reseller.plexEmail ? ` · ${reseller.plexEmail}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 text-primary">
            <Coins className="h-3.5 w-3.5" /> {reseller.credits} credits
          </Badge>
          <Button size="sm" variant="outline" onClick={() => setCreditOpen(true)}>
            Credits
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{reseller.name}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                Edit name / notes
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => toggleStatus.mutate()}>
                {reseller.status === "active" ? "Disable portal" : "Enable portal"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => regen.mutate()}>Reset portal code</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-400" onClick={() => setConfirmDelete(true)}>
                Delete reseller
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Label className="shrink-0 text-xs text-muted-foreground">Portal link</Label>
        <Input readOnly value={portalUrl} className="h-8 font-mono text-xs" />
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={async () => {
            await navigator.clipboard.writeText(portalUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>

      <CreditDialog
        reseller={reseller}
        open={creditOpen}
        onOpenChange={setCreditOpen}
        onChanged={onChanged}
      />
      <EditResellerDialog
        reseller={reseller}
        open={editOpen}
        onOpenChange={setEditOpen}
        onChanged={onChanged}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {reseller.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the reseller and disables their portal. Their customers must be removed
              or reassigned first — deletion is blocked while they still have any.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => del.mutate()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const CREDIT_PRESETS = [1, 3, 6, 12, 24];

function CreditDialog({
  reseller,
  open,
  onOpenChange,
  onChanged,
}: {
  reseller: PlexResellerSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const accessCode = useAccessCode();
  const [amount, setAmount] = useState(1);

  const adjust = useMutation({
    mutationFn: (delta: number) =>
      plexAdjustCredits({ data: { accessCode, resellerId: reseller.id, delta } }),
    onSuccess: (summary) => {
      toast.success(`${reseller.name} now has ${summary.credits} credits`);
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Credits for {reseller.name}</DialogTitle>
          <DialogDescription>
            Currently <span className="font-semibold text-foreground">{reseller.credits}</span>. 1
            credit = 1 month of access for one of their customers. Charge them for these however you
            like — outside this app.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {CREDIT_PRESETS.map((n) => (
              <Button
                key={n}
                variant={amount === n ? "default" : "outline"}
                size="sm"
                onClick={() => setAmount(n)}
              >
                {n}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Label className="shrink-0">Amount</Label>
            <Input
              type="number"
              value={amount}
              onChange={(e) => setAmount(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="outline"
            className="text-red-400"
            onClick={() => adjust.mutate(-amount)}
            disabled={adjust.isPending}
          >
            Remove {amount}
          </Button>
          <Button onClick={() => adjust.mutate(amount)} disabled={adjust.isPending}>
            Add {amount} credits
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateResellerDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const accessCode = useAccessCode();
  const [name, setName] = useState("");
  const [plexEmail, setPlexEmail] = useState("");
  const [credits, setCredits] = useState(10);
  const [notes, setNotes] = useState("");

  const create = useMutation({
    mutationFn: () =>
      plexCreateReseller({
        data: {
          accessCode,
          name: name.trim(),
          plexEmail: plexEmail.trim() || undefined,
          credits,
          notes,
        },
      }),
    onSuccess: () => {
      toast.success(`${name} added — share their portal link from the card.`);
      setName("");
      setPlexEmail("");
      setCredits(10);
      setNotes("");
      onOpenChange(false);
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCog className="h-5 w-5" /> Add reseller
          </DialogTitle>
          <DialogDescription>
            They'll get a private portal link and code. Have them invite their own Plex account to
            your server, then connect it in their portal.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reseller-name">Reseller name</Label>
            <Input
              id="reseller-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Marcus"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reseller-email">Their Plex email (optional, for your reference)</Label>
            <Input
              id="reseller-email"
              value={plexEmail}
              onChange={(e) => setPlexEmail(e.target.value)}
              placeholder="reseller@email.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reseller-credits">Starting credits</Label>
            <Input
              id="reseller-credits"
              type="number"
              value={credits}
              onChange={(e) => setCredits(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reseller-notes">Notes (optional)</Label>
            <Textarea
              id="reseller-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
            Create reseller
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditResellerDialog({
  reseller,
  open,
  onOpenChange,
  onChanged,
}: {
  reseller: PlexResellerSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const accessCode = useAccessCode();
  const [name, setName] = useState(reseller.name);

  const save = useMutation({
    mutationFn: () => plexUpdateReseller({ data: { accessCode, resellerId: reseller.id, name } }),
    onSuccess: () => {
      toast.success("Reseller updated");
      onOpenChange(false);
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit reseller</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`edit-reseller-${reseller.id}`}>Name</Label>
          <Input
            id={`edit-reseller-${reseller.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
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
