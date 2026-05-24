import { useEffect, useState } from "react";
import { Play, Pause, SkipBack, Plus, Wand2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { get } from "idb-keyval";
import { toast } from "sonner";
import { alignLyrics } from "@/lib/lyrics/align";
import type { Project } from "@/lib/project/types";
import { ensureTranscription, getEntry } from "@/lib/transcribe/elevenlabs";
import { TranscriptionStatus } from "./TranscriptionStatus";

const fmt = (s: number) => {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60); const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
};

interface Props {
  project: Project;
  update: (u: (p: Project) => Project) => void;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  onPlayToggle: () => void;
}

export function Transport({ project, update, audioRef, onPlayToggle }: Props) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [lyricsText, setLyricsText] = useState(project.lyrics.lines.map(l => `[${fmt(l.time)}] ${l.text}`).join("\n"));
  const [syncing, setSyncing] = useState(false);
  

  useEffect(() => {
    const el = audioRef.current; if (!el) return;
    const onTime = () => setTime(el.currentTime);
    const onDur = () => setDuration(el.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onDur);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onDur);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, [audioRef, project.audio]);

  const parseLyrics = (text: string) => {
    const dur = duration || audioRef.current?.duration || 180;
    const raw = text.split(/\r?\n/).map(l => l.trim());
    const tsRe = /^\[(\d+):(\d{2})(?:\.(\d+))?\]\s*(.*)$/;
    const sectionRe = /^\[[^\]]+\]$/; // [Verse 1], [Chorus], etc.
    const parsed: { time: number; text: string }[] = [];
    let hasTs = false;
    for (const line of raw) {
      if (!line) continue;
      const m = line.match(tsRe);
      if (m) {
        hasTs = true;
        const t = parseInt(m[1]) * 60 + parseInt(m[2]) + (m[3] ? parseFloat("0." + m[3]) : 0);
        if (m[4]) parsed.push({ time: t, text: m[4] });
        continue;
      }
      if (sectionRe.test(line)) continue; // skip section headers
      parsed.push({ time: -1, text: line });
    }
    if (!hasTs && parsed.length) {
      const intro = Math.min(4, dur * 0.04);
      const span = Math.max(1, dur - intro - dur * 0.05);
      parsed.forEach((l, i) => { l.time = intro + (i / parsed.length) * span; });
    } else {
      // interpolate missing times between known timestamps
      let lastT = 0;
      for (let i = 0; i < parsed.length; i++) {
        if (parsed[i].time >= 0) { lastT = parsed[i].time; continue; }
        let nIdx = -1;
        for (let j = i + 1; j < parsed.length; j++) if (parsed[j].time >= 0) { nIdx = j; break; }
        if (nIdx === -1) { parsed[i].time = lastT + 2; lastT = parsed[i].time; }
        else { const gap = (parsed[nIdx].time - lastT) / (nIdx - i + 1); parsed[i].time = lastT + gap; lastT = parsed[i].time; }
      }
    }
    update(p => ({ ...p, lyrics: { ...p.lyrics, lines: parsed, enabled: true } }));
  };

  const groupWordsIntoLines = (
    words: { text: string; start: number; end: number }[],
  ): { time: number; text: string }[] => {
    const lines: { time: number; text: string; end: number }[] = [];
    const GAP = 0.7; // seconds of silence => new line
    const INSTRUMENTAL_GAP = 8; // seconds of silence => insert instrumental marker
    const MAX_WORDS = 9;
    let buf: { text: string; start: number; end: number }[] = [];
    const flush = () => {
      if (!buf.length) return;
      lines.push({
        time: buf[0].start,
        end: buf[buf.length - 1].end,
        text: buf.map(w => w.text).join(" ").replace(/\s+([,.;:!?])/g, "$1").trim(),
      });
      buf = [];
    };
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const prev = words[i - 1];
      const gap = prev ? w.start - prev.end : 0;
      if (buf.length >= MAX_WORDS || (prev && gap > GAP)) flush();
      buf.push(w);
    }
    flush();

    // Insert instrumental markers for long silent spans
    const dur = audioRef.current?.duration || 0;
    const out: { time: number; text: string }[] = [];
    if (lines.length && lines[0].time >= INSTRUMENTAL_GAP) {
      out.push({ time: 0.2, text: "♪ instrumental ♪" });
    }
    for (let i = 0; i < lines.length; i++) {
      out.push({ time: lines[i].time, text: lines[i].text });
      const next = lines[i + 1];
      if (next && next.time - lines[i].end >= INSTRUMENTAL_GAP) {
        out.push({ time: lines[i].end + 0.2, text: "♪ instrumental ♪" });
      }
    }
    if (lines.length && dur && dur - lines[lines.length - 1].end >= INSTRUMENTAL_GAP) {
      out.push({ time: lines[lines.length - 1].end + 0.2, text: "♪ instrumental ♪" });
    }
    return out;
  };

  const autoSync = async (text: string) => {
    if (!project.audio?.id) { toast.error("Upload an audio track first."); return; }
    const tsPrefix = /^\[\d+:\d{2}(?:\.\d+)?\]\s*/;
    const sectionOnly = /^\[[^\]]+\]\s*$/;
    const rawLines = text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .filter(l => !sectionOnly.test(l)) // drop [Verse] markers
      .map(l => l.replace(tsPrefix, "").trim()) // strip [0:12] prefixes
      .filter(Boolean);
    const hasUserLyrics = rawLines.length > 0;

    const assetId = project.audio.id;
    const filename = project.audio.name || "audio.mp3";

    setSyncing(true);
    const entry = getEntry(assetId);
    const initialMsg =
      entry?.status === "ready" ? (hasUserLyrics ? "Aligning lyrics…" : "Building lyrics from audio…") :
      entry?.status === "transcribing" ? "Finishing audio analysis…" :
      entry?.status === "error" ? "Retrying audio analysis…" :
      "Preparing audio…";
    const toastId = toast.loading(initialMsg);
    try {
      let words = entry?.status === "ready" ? entry.words : undefined;
      if (!words) {
        const blob = await get<Blob>(`asset:${assetId}`);
        if (!blob) throw new Error("Audio file not found in local storage.");
        const MAX = 100 * 1024 * 1024;
        if (blob.size > MAX) throw new Error(`Audio is ${(blob.size / 1024 / 1024).toFixed(1)}MB — max 100MB.`);
        words = await ensureTranscription(assetId, blob, filename);
      }
      if (!words || !words.length) throw new Error("No words detected in audio.");

      const aligned = hasUserLyrics
        ? alignLyrics(rawLines, words)
        : groupWordsIntoLines(words);


      update(p => ({ ...p, lyrics: { ...p.lyrics, lines: aligned, enabled: true } }));
      const formatted = aligned.map(l => `[${fmt(l.time)}] ${l.text}`).join("\n");
      setLyricsText(formatted);
      toast.success(
        hasUserLyrics
          ? `Synced ${aligned.length} lines to ${words.length} detected words.`
          : `Generated ${aligned.length} lines from audio transcript.`,
        { id: toastId },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sync failed.";
      console.error("[autoSync] failed:", e);
      toast.error(msg, { id: toastId });
    } finally {
      setSyncing(false);
    }
  };


  return (
    <div className="panel rounded-xl px-4 py-3 flex items-center gap-3">
      <Button size="icon" variant="ghost" onClick={() => { const el = audioRef.current; if (el) el.currentTime = 0; }}>
        <SkipBack className="size-4" />
      </Button>
      <Button size="icon" onClick={onPlayToggle} className="bg-primary text-primary-foreground hover:bg-primary/90">
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </Button>
      <span className="text-xs font-mono text-muted-foreground tabular-nums w-12">{fmt(time)}</span>
      <Slider
        min={0} max={Math.max(0.1, duration)} step={0.01}
        value={[time]}
        onValueChange={(v) => { const el = audioRef.current; if (el) el.currentTime = v[0]; }}
        className="flex-1"
      />
      <span className="text-xs font-mono text-muted-foreground tabular-nums w-12 text-right">{fmt(duration)}</span>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5 bg-elevated/60">
            <Plus className="size-3.5" /> Lyrics
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[28rem] p-3 panel" align="end">
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              Paste lyrics — section markers like <span className="font-mono">[Verse]</span> are skipped, and lines without timestamps are auto-spread across the song. Optional format: <span className="font-mono">[0:12] line text</span>
            </div>
            <Textarea
              value={lyricsText}
              onChange={(e) => setLyricsText(e.target.value)}
              placeholder={"[Intro]\nFirst line of the song\nSecond line\n\n[Verse]\nKeep going..."}
              className="h-64 font-mono text-xs bg-elevated/40"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => autoSync(lyricsText)} disabled={syncing} className="flex-1 gap-1.5">
                {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
                Auto-sync to audio
              </Button>
              <Button size="sm" onClick={() => parseLyrics(lyricsText)} className="flex-1">Apply</Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
