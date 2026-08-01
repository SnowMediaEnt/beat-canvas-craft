import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorSmartphone, RefreshCw, ServerIcon } from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { plexAssignDevice, plexDeleteDevice, plexListDevices } from "@/lib/plex/plex.functions";
import type { PlexDeviceRow, PlexOverview } from "@/lib/plex/plex-types";
import { errMsg, fmtAgo, fmtDate, useAccessCode } from "./plex-shared";

export function DevicesTab({ overview }: { overview: PlexOverview }) {
  const accessCode = useAccessCode();
  const queryClient = useQueryClient();

  const devicesQuery = useQuery({
    queryKey: ["plex", "devices"],
    queryFn: () => plexListDevices({ data: { accessCode } }),
    enabled: overview.connected,
    refetchInterval: 60_000,
    retry: 1,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["plex", "devices"] });

  const devices = (devicesQuery.data ?? []) as PlexDeviceRow[];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <MonitorSmartphone className="h-5 w-5" /> Signed-in devices
          </CardTitle>
          <CardDescription>
            Every device holding a token for your account
            {overview.linkAccount ? " and your link account" : ""}. Signing a device out revokes its
            token instantly — that's how 4-digit-code members get cut off.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={refresh}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {!overview.connected ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Connect your Plex account first.
          </p>
        ) : devicesQuery.isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading devices…</p>
        ) : devicesQuery.isError ? (
          <p className="py-8 text-center text-sm text-red-400">{errMsg(devicesQuery.error)}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Device</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Member</TableHead>
                <TableHead>First seen</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map((device) => (
                <DeviceRow
                  key={`${device.account}:${device.id}`}
                  device={device}
                  overview={overview}
                  onChanged={refresh}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function DeviceRow({
  device,
  overview,
  onChanged,
}: {
  device: PlexDeviceRow;
  overview: PlexOverview;
  onChanged: () => void;
}) {
  const accessCode = useAccessCode();
  const queryClient = useQueryClient();
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const signOut = useMutation({
    mutationFn: () =>
      plexDeleteDevice({ data: { accessCode, deviceId: device.id, account: device.account } }),
    onSuccess: () => {
      toast.success(`${device.name} signed out`);
      onChanged();
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const assign = useMutation({
    mutationFn: (memberId: string) =>
      plexAssignDevice({
        data: {
          accessCode,
          memberId,
          deviceId: device.id,
          deviceClientIdentifier: device.clientIdentifier,
          deviceName: `${device.name}${device.platform ? ` (${device.platform})` : ""}`,
        },
      }),
    onSuccess: () => {
      toast.success("Device assigned");
      onChanged();
      queryClient.invalidateQueries({ queryKey: ["plex", "overview"] });
    },
    onError: (error) => toast.error(errMsg(error)),
  });

  const assignableMembers = overview.members.filter((m) => m.status === "active");

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2 font-medium">
          {device.providesServer && <ServerIcon className="h-4 w-4 text-emerald-400" />}
          {device.name}
        </div>
        <div className="text-xs text-muted-foreground">
          {[device.product, device.platform, device.publicAddress].filter(Boolean).join(" · ")}
        </div>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="border-border bg-secondary/60">
          {device.account === "link" ? "link account" : "owner"}
        </Badge>
      </TableCell>
      <TableCell className="text-sm">
        {device.memberName ?? <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{fmtDate(device.createdAt)}</TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {device.lastSeenAt ? fmtAgo(device.lastSeenAt) : "—"}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          {!device.memberId && assignableMembers.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  Assign
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Assign to member</DropdownMenuLabel>
                {assignableMembers.map((m) => (
                  <DropdownMenuItem key={m.id} onClick={() => assign.mutate(m.id)}>
                    {m.displayName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {device.providesServer ? (
            <Button
              variant="ghost"
              size="sm"
              disabled
              title="This is your Plex Media Server — don't sign it out from here."
            >
              Sign out
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-red-400 hover:text-red-300"
              onClick={() => setConfirmSignOut(true)}
            >
              Sign out
            </Button>
          )}
        </div>

        <AlertDialog open={confirmSignOut} onOpenChange={setConfirmSignOut}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Sign out {device.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                The device's token is revoked immediately and it will have to sign in again.
                {device.memberName ? ` This device belongs to ${device.memberName}.` : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-red-600 text-white hover:bg-red-700"
                onClick={() => signOut.mutate()}
              >
                Sign out device
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}
