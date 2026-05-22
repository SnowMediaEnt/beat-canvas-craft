import { useEffect, useState } from "react";
import { Loader2, Check, AlertCircle, Sparkles } from "lucide-react";
import { get } from "idb-keyval";
import { subscribe, getEntry, retryTranscription } from "@/lib/transcribe/elevenlabs";
import type { AssetRef } from "@/lib/project/types";
import { cn } from "@/lib/utils";

interface Props {
  audio?: AssetRef;
}

export function TranscriptionStatus({ audio }: Props) {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);

  if (!audio?.id) return null;
  const entry = getEntry(audio.id);
  if (!entry) return null;

  const retry = async () => {
    const blob = await get<Blob>(`asset:${audio.id}`);
    if (!blob) return;
    retryTranscription(audio.id, blob, audio.name || "audio.mp3");
  };

  const base = "text-[11px] flex items-center gap-1.5 px-2 py-1 rounded-md border";

  if (entry.status === "uploading") {
    return (
      <div className={cn(base, "border-border bg-elevated/50 text-muted-foreground")}>
        <Sparkles className="size-3" />
        Preparing audio…
      </div>
    );
  }
  if (entry.status === "transcribing") {
    return (
      <div className={cn(base, "border-primary/40 bg-primary/10 text-foreground/90")}>
        <Loader2 className="size-3 animate-spin" />
        Analyzing audio for lyric sync…
      </div>
    );
  }
  if (entry.status === "ready") {
    return (
      <div className={cn(base, "border-emerald-500/40 bg-emerald-500/10 text-emerald-300")}>
        <Check className="size-3" />
        Audio ready for sync
      </div>
    );
  }
  if (entry.status === "error") {
    return (
      <button
        onClick={retry}
        className={cn(base, "border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 cursor-pointer")}
        title={entry.error}
      >
        <AlertCircle className="size-3" />
        Sync prep failed — click to retry
      </button>
    );
  }
  return null;
}
