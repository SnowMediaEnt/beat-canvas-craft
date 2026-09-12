import { useRef, useState } from "react";
import { Upload, Loader2, X, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { storeAsset, deleteAsset } from "@/lib/project/assets";
import { isAssetReferenced } from "@/lib/project/store";
import type { AssetRef } from "@/lib/project/types";
import { toast } from "sonner";

interface Props {
  label: string;
  accept: string;
  value?: AssetRef;
  onChange: (ref: AssetRef | undefined) => void;
}

function errorMessage(err: unknown, fallback = "Unknown error"): string {
  if (err == null) return fallback;
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === "string") return err;
  try {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg) return msg;
  } catch {
    /* ignore */
  }
  try {
    return JSON.stringify(err) || fallback;
  } catch {
    return fallback;
  }
}

/** Remove a blob only when no other project or render job still points at it. */
function releaseAsset(ref: AssetRef | undefined, currentProjectStillUses = false) {
  if (!ref || currentProjectStillUses) return;
  // The project that owns this field is about to drop the reference; if any
  // OTHER saved project (a duplicate, for instance) still uses it, keep it.
  if (isAssetReferenced(ref.id)) return;
  deleteAsset(ref).catch(() => {});
}

export function UploadField({ label, accept, value, onChange }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const handle = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const asset = await storeAsset(file);
      const previous = value;
      onChange(asset);
      // Transcription for lyric sync now starts lazily from "Auto-sync"
      // instead of on every upload (each run is billed).
      // Defer the cleanup so the project save (which drops the old reference) lands first.
      setTimeout(() => releaseAsset(previous), 500);
    } catch (err) {
      const msg = errorMessage(err, "Storage failed");
      console.error("Upload failed:", msg, err);
      toast.error(`Couldn't load ${label.toLowerCase()}: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!value) return;
    const previous = value;
    onChange(undefined);
    setTimeout(() => releaseAsset(previous), 500);
  };

  const meta = value?.duration ? ` · ${Math.floor(value.duration / 60)}:${String(Math.floor(value.duration % 60)).padStart(2, "0")}` : "";

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="flex gap-1.5">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => ref.current?.click()}
          className="flex-1 justify-start gap-2 bg-elevated/60 hover:bg-elevated border-border h-10 min-w-0"
          title={value ? `Click to replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
        >
          {busy ? (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          ) : value ? (
            <RefreshCw className="size-4 shrink-0" />
          ) : (
            <Upload className="size-4 shrink-0" />
          )}
          <span className="truncate text-left">{value ? `${value.name}${meta}` : `Upload ${label.toLowerCase()}`}</span>
        </Button>
        {value && !busy && (
          <Button
            variant="outline"
            size="icon"
            onClick={handleRemove}
            className="h-10 w-10 shrink-0 bg-elevated/60 hover:bg-destructive/20 hover:text-destructive border-border"
            title={`Remove ${label.toLowerCase()}`}
            aria-label={`Remove ${label.toLowerCase()}`}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
      <input ref={ref} type="file" accept={accept} className="hidden" onChange={handle} />
    </div>
  );
}
