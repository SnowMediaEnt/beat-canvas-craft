import { useEffect, useState } from "react";
import { Loader2, Check, AlertCircle, Sparkles, Mic } from "lucide-react";
import { get } from "idb-keyval";
import { subscribe, getEntry, hydrateFromIdb, transcribeInBackground, retryTranscription } from "@/lib/transcribe/elevenlabs";
import type { AssetRef } from "@/lib/project/types";
import { cn } from "@/lib/utils";

interface Props {
  audio?: AssetRef;
}

const fmt = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
};

/**
 * Shows what the lyric analysis of the uploaded song is doing: working (with
 * a live timer), ready to go, failed (with the reason and a retry), or not
 * started yet (with a button), so the user always knows whether the song is
 * fully loaded before moving on to the lyrics.
 */
export function TranscriptionStatus({ audio }: Props) {
  const [, force] = useState(0);
  const [checked, setChecked] = useState<string | null>(null);

  useEffect(() => {
    const unsub = subscribe(() => force((n) => n + 1));
    return () => { unsub(); };
  }, []);

  // Look for an analysis saved from an earlier visit before deciding the song
  // "has not been analysed", so reopening a project never flashes the button.
  const audioId = audio?.id;
  useEffect(() => {
    if (!audioId) return;
    let live = true;
    void hydrateFromIdb(audioId).finally(() => { if (live) setChecked(audioId); });
    return () => { live = false; };
  }, [audioId]);

  const entry = getEntry(audioId);
  const working = entry?.status === "uploading" || entry?.status === "transcribing";

  // Tick once a second while working so the timer moves.
  useEffect(() => {
    if (!working) return;
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [working]);

  if (!audio?.id) return null;

  const base = "text-[11px] flex items-start gap-1.5 px-2 py-1.5 rounded-md border leading-snug";

  const load = async () => {
    const blob = await get<Blob>(`asset:${audio.id}`);
    if (!blob) return null;
    return blob;
  };
  const retry = async () => {
    const blob = await load();
    if (blob) void retryTranscription(audio.id, blob, audio.name || "audio.mp3").catch(() => {});
  };
  const start = async () => {
    const blob = await load();
    if (blob) void transcribeInBackground(audio.id, blob, audio.name || "audio.mp3").catch(() => {});
  };

  if (!entry) {
    if (checked !== audio.id) return null; // still looking for a saved analysis
    return (
      <button
        onClick={start}
        className={cn(base, "w-full items-center border-border bg-elevated/50 text-muted-foreground hover:bg-elevated hover:text-foreground cursor-pointer")}
        title="Listens to the song so lyrics can be synced to it"
      >
        <Mic className="size-3 shrink-0" />
        Song not analysed for lyrics yet. Click to analyse
      </button>
    );
  }

  const elapsed = entry.startedAt ? (Date.now() - entry.startedAt) / 1000 : 0;

  if (entry.status === "uploading") {
    return (
      <div className={cn(base, "border-border bg-elevated/50 text-muted-foreground")}>
        <Sparkles className="size-3 mt-0.5 shrink-0" />
        <span>Getting the song ready for analysis…</span>
      </div>
    );
  }
  if (entry.status === "transcribing") {
    return (
      <div className={cn(base, "border-primary/40 bg-primary/10 text-foreground/90")}>
        <Loader2 className="size-3 mt-0.5 shrink-0 animate-spin" />
        <span>
          Analysing the song for lyric sync… <span className="font-mono">{fmt(elapsed)}</span>
          <span className="block text-muted-foreground">
            Usually under a minute. You can keep editing; lyric sync unlocks when this turns green.
          </span>
        </span>
      </div>
    );
  }
  if (entry.status === "ready") {
    const n = entry.words?.length ?? 0;
    return (
      <div className={cn(base, "border-emerald-500/40 bg-emerald-500/10 text-emerald-300")}>
        <Check className="size-3 mt-0.5 shrink-0" />
        <span>
          Song analysed and ready
          <span className="block text-emerald-300/70">
            {n > 0
              ? `${n.toLocaleString()} words found${entry.reused ? " (reused from an earlier upload)" : ""}. Lyric sync is ready to use.`
              : "No spoken or sung words detected, so this works as an instrumental."}
          </span>
        </span>
      </div>
    );
  }
  if (entry.status === "error") {
    return (
      <button
        onClick={retry}
        className={cn(base, "w-full text-left border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 cursor-pointer")}
        title={entry.error}
      >
        <AlertCircle className="size-3 mt-0.5 shrink-0" />
        <span>
          Couldn&apos;t analyse the song. Click to retry
          {entry.error && <span className="block text-red-300/70 break-words">{entry.error.slice(0, 140)}</span>}
        </span>
      </button>
    );
  }
  return null;
}
