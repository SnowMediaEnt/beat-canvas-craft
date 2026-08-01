import { createContext, useContext, useState } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { CalendarIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DurationInput, MemberStatus, PlexMember } from "@/lib/plex/plex-types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Access code context (the admin gate). Stored in localStorage, sent with
// every server-function call.
// ---------------------------------------------------------------------------

export const ACCESS_CODE_STORAGE_KEY = "plex_admin_code";

const PlexAccessContext = createContext<string>("");

export const PlexAccessProvider = PlexAccessContext.Provider;

export function useAccessCode(): string {
  return useContext(PlexAccessContext);
}

export function errMsg(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return format(new Date(iso), "MMM d, yyyy h:mm a");
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  return `${formatDistanceToNowStrict(new Date(iso))} ago`;
}

export function ExpiryLabel({ member }: { member: PlexMember }) {
  if (member.status === "removed") return <span className="text-muted-foreground">removed</span>;
  if (!member.expiresAt) return <span className="text-muted-foreground">never expires</span>;
  const date = new Date(member.expiresAt);
  const expired = date.getTime() <= Date.now();
  return (
    <span className={cn("whitespace-nowrap", expired ? "text-red-400" : "text-foreground")}>
      {expired
        ? `expired ${formatDistanceToNowStrict(date)} ago`
        : `in ${formatDistanceToNowStrict(date)}`}
      <span className="ml-1.5 text-xs text-muted-foreground">({format(date, "MMM d, yyyy")})</span>
    </span>
  );
}

export function StatusBadge({ status, pending }: { status: MemberStatus; pending?: boolean }) {
  if (status === "active" && pending) {
    return (
      <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-400">
        invite sent
      </Badge>
    );
  }
  const styles: Record<MemberStatus, string> = {
    active: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
    expired: "border-red-500/40 bg-red-500/10 text-red-400",
    removed: "border-border bg-muted/40 text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={styles[status]}>
      {status}
    </Badge>
  );
}

export function AccessTypeBadge({ type }: { type: "invite" | "link_code" }) {
  return (
    <Badge variant="outline" className="border-border bg-secondary/60 text-secondary-foreground">
      {type === "invite" ? "invite" : "4-digit code"}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Duration picker — how long access lasts
// ---------------------------------------------------------------------------

export type DurationValue =
  { kind: "days"; days: number } | { kind: "date"; date: Date | undefined } | { kind: "never" };

export const DEFAULT_DURATION: DurationValue = { kind: "days", days: 30 };

export function toDurationInput(value: DurationValue): DurationInput {
  if (value.kind === "never") return { never: true };
  if (value.kind === "date" && value.date) return { expiresAt: value.date.toISOString() };
  if (value.kind === "days") return { days: value.days };
  return { never: true };
}

const DAY_PRESETS = [7, 14, 30, 60, 90, 180, 365];

export function DurationPicker({
  value,
  onChange,
}: {
  value: DurationValue;
  onChange: (value: DurationValue) => void;
}) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const selectValue =
    value.kind === "never" ? "never" : value.kind === "date" ? "date" : String(value.days);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={selectValue}
        onValueChange={(v) => {
          if (v === "never") onChange({ kind: "never" });
          else if (v === "date") {
            onChange({ kind: "date", date: undefined });
            setCalendarOpen(true);
          } else onChange({ kind: "days", days: Number(v) });
        }}
      >
        <SelectTrigger className="w-44">
          <SelectValue placeholder="Duration" />
        </SelectTrigger>
        <SelectContent>
          {DAY_PRESETS.map((d) => (
            <SelectItem key={d} value={String(d)}>
              {d} days
            </SelectItem>
          ))}
          <SelectItem value="date">Until a specific date…</SelectItem>
          <SelectItem value="never">No expiration</SelectItem>
        </SelectContent>
      </Select>

      {value.kind === "date" && (
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <CalendarIcon className="h-4 w-4" />
              {value.date ? format(value.date, "MMM d, yyyy") : "Pick a date"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={value.date}
              disabled={{ before: new Date() }}
              onSelect={(date) => {
                onChange({ kind: "date", date: date ?? undefined });
                setCalendarOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

export function durationSummary(value: DurationValue): string {
  if (value.kind === "never") return "no expiration";
  if (value.kind === "date")
    return value.date ? `until ${format(value.date, "MMM d, yyyy")}` : "pick a date";
  return `${value.days} days`;
}
