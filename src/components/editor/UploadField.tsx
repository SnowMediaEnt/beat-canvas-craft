import { useRef, useState } from "react";
import { Upload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { storeAsset } from "@/lib/project/assets";
import type { AssetRef } from "@/lib/project/types";
import { toast } from "sonner";
import { transcribeInBackground } from "@/lib/transcribe/elevenlabs";

interface Props {
  label: string;
  accept: string;
  value?: AssetRef;
  onChange: (ref: AssetRef) => void;
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
      onChange(asset);
      // Kick off background transcription for audio uploads — don't await.
      if (accept.startsWith("audio/") || file.type.startsWith("audio/")) {
        transcribeInBackground(asset.id, file, file.name);
      }
    } catch (err) {
      console.error("Upload failed", err);
      toast.error(`Couldn't load ${label.toLowerCase()}: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</div>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => ref.current?.click()}
        className="w-full justify-start gap-2 bg-elevated/60 hover:bg-elevated border-border h-10"
      >
        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <Upload className="size-4 shrink-0" />}
        <span className="truncate text-left">{value?.name || `Upload ${label.toLowerCase()}`}</span>
      </Button>
      <input ref={ref} type="file" accept={accept} className="hidden" onChange={handle} />
    </div>
  );
}
