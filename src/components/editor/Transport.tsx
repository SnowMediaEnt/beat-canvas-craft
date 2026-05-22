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

  const autoSync = async (text: string) => {
    if (!project.audio?.id) { toast.error("Upload an audio track first."); return; }
    const blob = await get<Blob>(`asset:${project.audio.id}`);
    if (!blob) { toast.error("Audio file not found in local storage."); return; }
    const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (rawLines.length === 0) { toast.error("Paste the lyrics first."); return; }

    setSyncing(true);
    const toastId = toast.loading("Analyzing audio with ElevenLabs…");
    try {
      const filename = project.audio.name || "audio.mp3";
      const mime = project.audio.type || blob.type || "audio/mpeg";
      const fd = new FormData();
      fd.append("file", new Blob([blob], { type: mime }), filename);
      fd.append("filename", filename);
      const transcribeUrl = (() => {
        if (typeof window === "undefined") return "/api/public/transcribe";
        const url = new URL("/api/public/transcribe", window.location.origin);
        const previewToken = new URLSearchParams(window.location.search).get("__lovable_token");
        if (previewToken) url.searchParams.set("__lovable_token", previewToken);
        return url.toString();
      })();
      const res = await fetch(transcribeUrl, { method: "POST", body: fd });
      const raw = await res.text();
      let json: { words?: Array<{ text: string; start: number; end: number }>; error?: string } | null = null;
      try {
        json = raw ? JSON.parse(raw) as { words?: Array<{ text: string; start: number; end: number }>; error?: string } : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const fallback = raw.trim().slice(0, 200) || `Request failed (${res.status})`;
        throw new Error(json?.error || fallback);
      }
      if (json?.error) throw new Error(json.error);
      const words = json.words ?? [];
      if (!words.length) throw new Error("No words detected in audio.");
      const aligned = alignLyrics(rawLines, words);
      update(p => ({ ...p, lyrics: { ...p.lyrics, lines: aligned, enabled: true } }));
      const formatted = aligned.map(l => `[${fmt(l.time)}] ${l.text}`).join("\n");
      setLyricsText(formatted);
      toast.success(`Synced ${aligned.length} lines to ${words.length} detected words.`, { id: toastId });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed.", { id: toastId });
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
