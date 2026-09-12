import { useEffect, useState } from "react";
import { Play, Pause, SkipBack, Plus, Wand2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { get } from "idb-keyval";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { alignLyrics } from "@/lib/lyrics/align";
import { aiAlignLyrics } from "@/lib/lyrics/ai-align.functions";
import type { Project } from "@/lib/project/types";
import { ensureTranscription, getEntry } from "@/lib/transcribe/elevenlabs";
import { getStoredAccessCode } from "@/lib/render/access-code";
import { TranscriptionStatus } from "./TranscriptionStatus";

const fmt = (s: number) => {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60); const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
};

// Lyric timestamps keep centiseconds so "Apply" after an auto-sync no longer
// rounds every line down to whole seconds (which de-synced the whole song).
const fmtLyric = (s: number) => {
  if (!isFinite(s) || s < 0) return "0:00.00";
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const ss = Math.floor(rest).toString().padStart(2, "0");
  const cc = Math.round((rest - Math.floor(rest)) * 100).toString().padStart(2, "0");
  return `${m}:${ss}.${cc === "100" ? "99" : cc}`;
};

const formatLyricLines = (lines: Project["lyrics"]["lines"]) =>
  lines.map(l => `[${fmtLyric(l.time)}] ${l.text}`).join("\n");

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
  const [lyricsText, setLyricsText] = useState(formatLyricLines(project.lyrics.lines));
  const [syncing, setSyncing] = useState(false);
  const aiAlign = useServerFn(aiAlignLyrics);

  

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
    const parsed: { time: number; text: string; words?: { time: number; text: string }[] }[] = [];
    let hasTs = false;
    // Lines whose text is unchanged keep their precise time + word timings.
    const existing = new Map<string, { time: number; words?: { time: number; text: string }[] }>();
    for (const l of project.lyrics.lines) existing.set(`${l.text.trim()}@${Math.round(l.time * 100)}`, { time: l.time, words: l.words });
    for (const line of raw) {
      if (!line) continue;
      const m = line.match(tsRe);
      if (m) {
        hasTs = true;
        const t = parseInt(m[1]) * 60 + parseInt(m[2]) + (m[3] ? parseFloat("0." + m[3]) : 0);
        if (m[4]) {
          const keep = existing.get(`${m[4].trim()}@${Math.round(t * 100)}`);
          parsed.push(keep ? { time: keep.time, text: m[4], ...(keep.words ? { words: keep.words } : {}) } : { time: t, text: m[4] });
        }
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
  ): { time: number; text: string; words?: { time: number; text: string }[] }[] => {
    const lines: { time: number; text: string; end: number; words: { time: number; text: string }[] }[] = [];
    const GAP = 0.7; // seconds of silence => new line
    const INSTRUMENTAL_GAP = 8; // seconds of silence => insert instrumental marker
    const MAX_WORDS = 9;
    let buf: { text: string; start: number; end: number }[] = [];
    const flush = () => {
      if (!buf.length) return;
      const text = buf.map(w => w.text).join(" ").replace(/\s+([,.;:!?])/g, "$1").trim();
      // Keep per-word start times so karaoke can highlight word by word.
      // Only when the word tokens map 1:1 onto the displayed text.
      const tokens = text.split(" ").filter(Boolean);
      const wordTimes = tokens.length === buf.length
        ? buf.map((w, i) => ({ time: w.start, text: tokens[i] }))
        : [];
      lines.push({ time: buf[0].start, end: buf[buf.length - 1].end, text, words: wordTimes });
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
    const out: { time: number; text: string; words?: { time: number; text: string }[] }[] = [];
    if (lines.length && lines[0].time >= INSTRUMENTAL_GAP) {
      out.push({ time: 0.2, text: "♪ instrumental ♪" });
    }
    for (let i = 0; i < lines.length; i++) {
      out.push({ time: lines[i].time, text: lines[i].text, ...(lines[i].words.length ? { words: lines[i].words } : {}) });
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

    // Detect "quoted mode": the user wrapped the whole pasted block in
    // straight or curly double-quotes. Signals "these are MY lyrics —
    // align them, don't replace them with transcribed text".
    const trimmed = text.trim();
    const quoteOpen = /^["“”]/;
    const quoteClose = /["“”]$/;
    const aiMode = quoteOpen.test(trimmed) && quoteClose.test(trimmed) && trimmed.length > 2;
    const stripped = aiMode ? trimmed.replace(quoteOpen, "").replace(quoteClose, "").trim() : text;

    const tsPrefix = /^\[\d+:\d{2}(?:\.\d+)?\]\s*/;
    const sectionOnly = /^\[[^\]]+\]\s*$/;
    const rawLines = stripped
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
      entry?.status === "ready" ? (aiMode ? "AI-aligning your lyrics…" : hasUserLyrics ? "Aligning lyrics…" : "Building lyrics from audio…") :
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

      let aligned: { time: number; text: string; words?: { time: number; text: string }[] }[];
      if (aiMode && hasUserLyrics) {
        toast.loading("AI-aligning your lyrics…", { id: toastId });
        const { times } = await aiAlign({ data: { lines: rawLines, words, accessCode: getStoredAccessCode() } });
        aligned = rawLines.map((textLine, i) => ({ time: times[i] ?? 0, text: textLine }));
      } else if (hasUserLyrics) {
        aligned = alignLyrics(rawLines, words);
      } else {
        aligned = groupWordsIntoLines(words);
      }


      update(p => ({ ...p, lyrics: { ...p.lyrics, lines: aligned, enabled: true } }));
      const formatted = formatLyricLines(aligned);
      setLyricsText(formatted);
      toast.success(
        aiMode
          ? `AI-synced ${aligned.length} lines to your audio.`
          : hasUserLyrics
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
    <div className="panel rounded-xl px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-3 flex-wrap sm:flex-nowrap">
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
        className="flex-1 min-w-[120px]"
      />
      <span className="text-xs font-mono text-muted-foreground tabular-nums w-12 text-right">{fmt(duration)}</span>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5 bg-elevated/60">
            <Plus className="size-3.5" /> Lyrics
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(28rem,calc(100vw-2rem))] p-3 panel" align="end">
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              Paste lyrics — section markers like <span className="font-mono">[Verse]</span> are skipped. Wrap the whole block in <span className="font-mono">"…"</span> to AI-align your exact lyrics to the audio (best for fixing missing or wrong lines). Otherwise lines are spread across the song. Optional: <span className="font-mono">[0:12.50] line text</span>. Lines you don't edit keep their exact timing.
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
