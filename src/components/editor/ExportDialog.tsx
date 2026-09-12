import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Video, CheckCircle2, Loader2, Cloud, Circle, Square, ExternalLink, Youtube, Smartphone, Instagram, MonitorPlay } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Project, RenderJob } from "@/lib/project/types";
import { saveJob, listJobs } from "@/lib/project/store";
import { getAssetDownloadUrl, storeAsset, deleteAsset } from "@/lib/project/assets";
import { get as idbGet } from "idb-keyval";
import { convertToWav, isAacLike } from "@/lib/audio/convert-wav";
import { AudioEngine } from "@/lib/visualizer/audioEngine";
import { useServerFn } from "@tanstack/react-start";
import {
  startLambdaRender,
  getLambdaProgress,
  cancelLambdaRender,
} from "@/lib/render/lambda.functions";
import {
  assertRenderableAssetUrl,
  uploadAssetForRender,
  uploadBlobForRender,
} from "@/lib/render/upload";
import { buildProxyDownloadUrl, triggerDownload } from "@/lib/render/download";
import { estimateRender, formatBytes, formatDuration } from "@/lib/render/estimate";
import { getStoredAccessCode, setStoredAccessCode } from "@/lib/render/access-code";
import { COLOR_BG_PREFIX } from "@/lib/visualizer/backgrounds";
import { RENDER_ENGINE_VERSION } from "@/lib/visualizer/engine-version";
import { RenderHealthPanel } from "./RenderHealthPanel";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface Props {
  project: Project;
  update: (u: (p: Project) => Project) => void;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  engineRef: React.RefObject<AudioEngine | null>;
  /** Offscreen canvas the preview loop paints into while recording (export resolution). */
  recordTargetRef?: React.MutableRefObject<HTMLCanvasElement | null>;
}

/** Browser recordings are capped at 1080p — 4K real-time capture is not realistic in a tab. */
const RECORD_MAX_RESOLUTION = "1080p" as const;

const RECORD_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function pickRecordMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return RECORD_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

const RES_DIMS = {
  "16:9": { "4k": [3840, 2160], "1080p": [1920, 1080], "720p": [1280, 720] },
  "1:1": { "4k": [2160, 2160], "1080p": [1080, 1080], "720p": [720, 720] },
  "9:16": { "4k": [2160, 3840], "1080p": [1080, 1920], "720p": [720, 1280] },
  "4:5": { "4k": [2160, 2700], "1080p": [1080, 1350], "720p": [864, 1080] },
} as const;

/** One-click platform targets: aspect ratio + fps + resolution. */
const PLATFORM_PRESETS = [
  { id: "youtube", label: "YouTube", icon: Youtube, aspectRatio: "16:9", fps: 60, resolution: "1080p", hint: "16:9 · 1080p · 60fps" },
  { id: "shorts", label: "TikTok / Reels / Shorts", icon: Smartphone, aspectRatio: "9:16", fps: 60, resolution: "1080p", hint: "9:16 · 1080p · 60fps" },
  { id: "feed", label: "Instagram feed", icon: Instagram, aspectRatio: "4:5", fps: 30, resolution: "1080p", hint: "4:5 · 1080p · 30fps" },
  { id: "4k", label: "4K showcase", icon: MonitorPlay, aspectRatio: "16:9", fps: 60, resolution: "4k", hint: "16:9 · 4K · 60fps" },
] as const;

const MAX_POLL_FAILURES = 6;

const STAGE_LABELS: Record<string, string> = {
  starting: "Starting workers on AWS…",
  rendering: "Rendering frames…",
  encoding: "Encoding video…",
  combining: "Stitching chunks together…",
  done: "Complete",
};

export function ExportDialog({ project, update, audioRef, canvasRef, engineRef, recordTargetRef }: Props) {
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<RenderJob | null>(null);
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [stage, setStage] = useState<string>("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [accessCode, setAccessCode] = useState<string>("");
  const pollRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [converting, setConverting] = useState<string | null>(null);

  const convertAudioToWav = async () => {
    const asset = project.audio;
    if (!asset) return;
    setConverting("Reading file…");
    try {
      let blob = await idbGet<Blob>(`asset:${asset.id}`);
      if (!blob && asset.url) blob = await (await fetch(asset.url)).blob();
      if (!blob) throw new Error("The original file is no longer in browser storage — please re-upload it.");
      const wav = await convertToWav(blob, asset.name, setConverting);
      setConverting("Saving…");
      const stored = await storeAsset(wav);
      const previous = asset;
      update((p) => ({ ...p, audio: stored }));
      setTimeout(() => { deleteAsset(previous).catch(() => {}); }, 800);
      toast.success(`Converted to WAV (${(wav.size / 1024 / 1024).toFixed(0)} MB). Lambda will now hear the full track.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Conversion failed");
    } finally {
      setConverting(null);
    }
  };

  useEffect(() => {
    if (open) setAccessCode(getStoredAccessCode());
  }, [open]);

  // Duration: measured at upload time when possible, else from the element.
  useEffect(() => {
    if (!open) return;
    const fromAsset = project.audio?.duration || 0;
    const el = audioRef.current;
    const fromEl = el?.duration && isFinite(el.duration) ? el.duration : 0;
    setAudioDuration(fromAsset || fromEl);
    if (!fromAsset && el && !fromEl) {
      const onMeta = () => setAudioDuration(el.duration && isFinite(el.duration) ? el.duration : 0);
      el.addEventListener("loadedmetadata", onMeta);
      return () => el.removeEventListener("loadedmetadata", onMeta);
    }
  }, [open, project.audio, audioRef]);

  // Browser recording state
  const [recording, setRecording] = useState(false);
  const [recordProgress, setRecordProgress] = useState(0);
  const [recordUrl, setRecordUrl] = useState<string | null>(null);
  const [recordStage, setRecordStage] = useState<string>("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordRafRef = useRef<number | null>(null);

  const startRender = useServerFn(startLambdaRender);
  const pollProgress = useServerFn(getLambdaProgress);
  const cancelRender = useServerFn(cancelLambdaRender);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const downloadFile = (url: string | null | undefined, filename: string, viaProxy = false) => {
    setInlineError(null);
    if (!url) {
      setInlineError("Download failed: file URL is missing.");
      toast.error("Download failed: file URL is missing.");
      return;
    }
    try {
      const href = viaProxy && /^https?:/i.test(url) ? buildProxyDownloadUrl(url, filename) : url;
      triggerDownload(href, filename);
    } catch (error) {
      console.error("[render-download] failed", { url, filename, error });
      setInlineError("Download failed. Please try again.");
      toast.error("Download failed. Please try again.");
    }
  };

  useEffect(
    () => () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
      if (recordRafRef.current) cancelAnimationFrame(recordRafRef.current);
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {
          /* ignore */
        }
      }
    },
    [],
  );

  const persistJob = (entry: RenderJob) => {
    saveJob(entry);
  };

  const isRecording = recording && recorderRef.current?.state === "recording";

  const stopBrowserRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      setRecording(false);
      try {
        recorderRef.current.stop();
      } catch {
        /* ignore */
      }
    }
    if (audioRef.current) {
      audioRef.current.pause();
    }
  };

  const startBrowserRecording = async () => {
    if (!project.audio) {
      setInlineError("Upload an audio file first.");
      toast.error("Upload an audio file first");
      return;
    }
    const canvas = canvasRef.current;
    const audioEl = audioRef.current;
    const engine = engineRef.current;
    if (!canvas || !audioEl || !engine) {
      setInlineError("Editor not ready yet.");
      toast.error("Editor not ready yet");
      return;
    }
    const duration = audioEl.duration && isFinite(audioEl.duration) ? audioEl.duration : audioDuration;
    if (!duration) {
      setInlineError("Press play once so the audio duration loads.");
      toast.error("Press play once so the audio duration loads");
      return;
    }
    const mimeType = pickRecordMime();
    if (!mimeType) {
      toast.error("Browser recording is not supported in this browser");
      return;
    }
    const fileFormat: "mp4" | "webm" = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
    const recResolution = project.export.resolution === "4k" ? RECORD_MAX_RESOLUTION : project.export.resolution;
    const [recW, recH] = RES_DIMS[project.aspectRatio][recResolution];

    const browserJobBase: RenderJob = {
      id: crypto.randomUUID(),
      projectId: project.id,
      projectName: project.name,
      kind: "browser",
      fileFormat,
      status: "queued",
      progress: 0,
      createdAt: Date.now(),
      config: { ...project.export, resolution: recResolution },
      aspectRatio: project.aspectRatio,
    };

    // Export-resolution offscreen canvas painted by the preview loop (same
    // frame data as the preview, full size). Falls back to the on-screen
    // canvas when the ref isn't wired.
    let captureSource: HTMLCanvasElement = canvas;
    if (recordTargetRef) {
      const off = document.createElement("canvas");
      off.width = recW;
      off.height = recH;
      recordTargetRef.current = off;
      captureSource = off;
    }
    const releaseRecordTarget = () => { if (recordTargetRef) recordTargetRef.current = null; };

    // rAF (and therefore the canvas) freezes in background tabs: stop instead
    // of silently producing a frozen video.
    const onVisibility = () => {
      if (document.hidden && recorderRef.current && recorderRef.current.state === "recording") {
        toast.error("Recording stopped: the tab was hidden. Keep this tab visible while recording.");
        stopBrowserRecording();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    try {
      persistJob(browserJobBase);

      await engine.resume();
      setRecordStage("Recording…");
      const fps = Math.min(60, project.export.fps || 60);
      const canvasStream = captureSource.captureStream(fps);
      const audioStream = engine.dest.stream;
      const combined = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioStream.getAudioTracks(),
      ]);

      const chunks: BlobPart[] = [];
      const bitrate = recResolution === "1080p" ? 12_000_000 : 7_000_000;
      const rec = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: bitrate, audioBitsPerSecond: 256_000 });
      recorderRef.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = async () => {
        if (recordRafRef.current) {
          cancelAnimationFrame(recordRafRef.current);
          recordRafRef.current = null;
        }
        recorderRef.current = null;
        document.removeEventListener("visibilitychange", onVisibility);
        releaseRecordTarget();

        const videoTracks = canvasStream.getVideoTracks();
        const audioTracks = audioStream.getAudioTracks();
        [...videoTracks, ...audioTracks].forEach((track) => track.stop());

        try {
          const blob = new Blob(chunks, { type: mimeType });
          const baseName = (project.name || "render").trim() || "render";
          const fileName = `${baseName}.${fileFormat}`;
          const localAsset = await storeAsset(
            new File([blob], fileName, { type: blob.type || (fileFormat === "mp4" ? "video/mp4" : "video/webm") }),
          );
          const localUrl = await getAssetDownloadUrl(localAsset);

          setRecordUrl(localUrl || localAsset.url);
          setRecordProgress(100);
          setRecordStage("Saving recording…");

          const completedEntry: RenderJob = {
            ...browserJobBase,
            status: "completed",
            progress: 100,
            completedAt: Date.now(),
            localAsset,
            sizeBytes: blob.size,
            fileFormat,
          };
          persistJob(completedEntry);

          // Cloud backup only when the owner's access code is available.
          const code = getStoredAccessCode();
          let remoteUrl: string | undefined;
          if (code) {
            try {
              setRecordStage("Uploading backup copy…");
              remoteUrl = await uploadBlobForRender({
                assetId: `browser-recording-${crypto.randomUUID()}`,
                fileName,
                contentType: blob.type || (fileFormat === "mp4" ? "video/mp4" : "video/webm"),
                blob,
                accessCode: code,
                onProgress: (pct) => setRecordProgress(pct),
              });
              persistJob({ ...completedEntry, downloadUrl: remoteUrl });
            } catch (e) {
              console.error("[browser-record] remote backup upload failed", e);
              toast.error("Recording saved locally. Cloud backup upload failed.");
            }
          }

          setRecordStage(remoteUrl ? "Recording complete" : "Recording saved locally");
          toast.success("Recording complete");
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          console.error("[browser-record] save failed", e);
          setRecordStage("");
          setRecordUrl(null);
          persistJob({ ...browserJobBase, status: "failed", error: msg });
          toast.error(`Recording failed: ${msg}`);
        } finally {
          setRecording(false);
        }
      };

      setRecordUrl(null);
      setRecordProgress(0);
      setRecordStage("Recording…");
      audioEl.currentTime = 0;
      await audioEl.play();
      rec.start(1000);
      setRecording(true);
      persistJob({ ...browserJobBase, status: "rendering" });

      const tick = () => {
        if (!audioEl) return;
        const pct = Math.min(100, Math.round((audioEl.currentTime / duration) * 100));
        setRecordProgress(pct);
        if (audioEl.ended || audioEl.currentTime >= duration - 0.05) {
          if (recorderRef.current && recorderRef.current.state !== "inactive") {
            setRecording(false);
            try {
              recorderRef.current.stop();
            } catch {
              /* ignore */
            }
          }
          audioEl.pause();
          return;
        }
        recordRafRef.current = requestAnimationFrame(tick);
      };
      recordRafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error("[browser-record]", e);
      document.removeEventListener("visibilitychange", onVisibility);
      releaseRecordTarget();
      persistJob({ ...browserJobBase, status: "failed", error: msg });
      toast.error(`Recording failed: ${msg}`);
      setRecording(false);
      setRecordStage("");
    }
  };

  const onRender = async () => {
    if (!project.audio) {
      toast.error("Upload an audio file first");
      return;
    }
    const duration = audioDuration || (audioRef.current?.duration && isFinite(audioRef.current.duration) ? audioRef.current.duration : 0);
    if (!duration) {
      toast.error("Press play once so the audio duration loads");
      return;
    }
    const code = accessCode.trim();

    const j: RenderJob = {
      id: crypto.randomUUID(),
      projectId: project.id,
      projectName: project.name,
      kind: "lambda",
      fileFormat: "mp4",
      status: "queued",
      progress: 0,
      createdAt: Date.now(),
      config: project.export,
      aspectRatio: project.aspectRatio,
    };
    setJob(j);
    persistJob(j);
    setProgress(0);
    setDownloadUrl(null);
    setInlineError(null);
    cancelledRef.current = false;

    try {
      setStage("Uploading assets…");
      const isColorBg = !!project.background?.id.startsWith(COLOR_BG_PREFIX);
      const backgroundColor = isColorBg ? project.background!.id.slice(COLOR_BG_PREFIX.length) : null;

      const [audioUrl, backgroundUrl, logoUrl] = await Promise.all([
        uploadAssetForRender(project.audio, code),
        isColorBg ? Promise.resolve(null) : uploadAssetForRender(project.background, code),
        uploadAssetForRender(project.logo, code),
      ]);

      const resolvedAudioUrl = assertRenderableAssetUrl("audio", audioUrl);
      const resolvedBackgroundUrl = project.background && !isColorBg
        ? assertRenderableAssetUrl("background", backgroundUrl)
        : null;
      const resolvedLogoUrl = project.logo ? assertRenderableAssetUrl("logo", logoUrl) : null;

      const [w, h] = RES_DIMS[project.aspectRatio][project.export.resolution];

      setStage("Starting Lambda render…");
      const inputProps = {
        audioUrl: resolvedAudioUrl,
        durationSeconds: duration,
        fps: project.export.fps,
        width: w,
        height: h,
        backgroundUrl: resolvedBackgroundUrl,
        backgroundType: isColorBg ? "color" : (project.background?.type ?? null),
        backgroundColor,
        logoUrl: resolvedLogoUrl,
        visualizer: project.visualizer,
        effects: project.effects,
        lyrics: project.lyrics,
        title: project.trackTitle || project.name,
        engineVersion: RENDER_ENGINE_VERSION,
        quality: project.export.quality,
      };

      const { renderId, bucketName, region } = await startRender({
        data: { ...inputProps, accessCode: code },
      });
      setStoredAccessCode(code);

      setStage(STAGE_LABELS.starting);
      const running: RenderJob = { ...j, status: "rendering", renderId, bucketName, region };
      setJob(running);
      persistJob(running);

      await new Promise<void>((resolve, reject) => {
        let stopped = false;
        // Client-side stall watchdog: if overallProgress does not advance
        // for 6 minutes we assume Lambda is wedged and fail the job instead
        // of polling forever.
        const STALL_MS = 6 * 60 * 1000;
        let lastPct = -1;
        let lastPctAt = Date.now();
        let failures = 0;
        const stop = () => {
          stopped = true;
          if (pollRef.current) {
            window.clearTimeout(pollRef.current);
            pollRef.current = null;
          }
        };

        const runPoll = async () => {
          try {
            if (cancelledRef.current) {
              stop();
              resolve();
              return;
            }
            let p: Awaited<ReturnType<typeof pollProgress>>;
            try {
              p = await pollProgress({ data: { renderId, bucketName } });
              failures = 0;
            } catch (e) {
              // Transient network / throttling blips must not fail a
              // multi-minute render.
              failures += 1;
              if (failures >= MAX_POLL_FAILURES) throw e;
              if (!stopped) pollRef.current = window.setTimeout(() => void runPoll(), 4000);
              return;
            }
            if (cancelledRef.current || !mountedRef.current) {
              stop();
              resolve();
              return;
            }
            const pct = Math.round((p.overallProgress || 0) * 100);
            setProgress(pct);
            if (p.stage && STAGE_LABELS[p.stage]) setStage(STAGE_LABELS[p.stage]);

            if (pct !== lastPct) {
              lastPct = pct;
              lastPctAt = Date.now();
            }

            persistJob({ ...running, progress: pct });
            if (p.done && p.outputFile) {
              stop();
              const done: RenderJob = {
                ...running,
                status: "completed",
                progress: 100,
                completedAt: Date.now(),
                downloadUrl: p.outputFile,
              };
              if (mountedRef.current) {
                setDownloadUrl(p.outputFile);
                setJob(done);
                setProgress(100);
                setStage("Complete");
              }
              persistJob(done);
              toast.success("Render complete");
              resolve();
              return;
            }
            if (p.fatalErrorEncountered && !p.outputFile) {
              stop();
              const msg = p.errors[0]?.message || "Lambda render failed";
              reject(new Error(msg));
              return;
            }

            if (Date.now() - lastPctAt > STALL_MS) {
              stop();
              reject(
                new Error(
                  "Render appears stuck: no progress for 6 minutes. AWS Lambda likely stalled — try a lower resolution/fps or a lighter preset.",
                ),
              );
              return;
            }

            if (!stopped) {
              pollRef.current = window.setTimeout(() => {
                void runPoll();
              }, 3000);
            }
          } catch (e) {
            stop();
            reject(e);
          }
        };

        void runPoll();
      });
    } catch (e) {
      if (cancelledRef.current) return;
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error("[lambda-render]", e);
      if (/invalid access code/i.test(msg)) setStoredAccessCode("");
      setInlineError(msg);
      const failed: RenderJob = { ...j, status: "failed", error: msg };
      setJob(failed);
      persistJob(failed);
      toast.error(`Render failed: ${msg}`);
      setStage("");
    }
  };

  /**
   * Remotion Lambda cannot stop a render that has started — the chunks
   * finish on AWS regardless. So this only stops watching; the job stays
   * "rendering" and the Completed dialog picks it up when it finishes.
   */
  const stopWatching = async () => {
    cancelledRef.current = true;
    if (pollRef.current) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    setCancelling(true);
    try {
      if (job?.renderId && job?.bucketName) {
        await cancelRender({ data: { renderId: job.renderId, bucketName: job.bucketName } });
      }
      toast.message("Stopped watching this render", {
        description: "AWS finishes it in the background — it will appear under Completed.",
      });
      setStage("Stopped watching — check Completed later");
      setJob(null);
    } finally {
      setCancelling(false);
    }
  };

  const applyPlatform = (preset: (typeof PLATFORM_PRESETS)[number]) => {
    update((p) => ({
      ...p,
      aspectRatio: preset.aspectRatio,
      export: { ...p.export, fps: preset.fps, resolution: preset.resolution },
    }));
  };

  const activePlatform = PLATFORM_PRESETS.find(
    (pp) => pp.aspectRatio === project.aspectRatio && pp.fps === project.export.fps && pp.resolution === project.export.resolution,
  )?.id;

  const isAac = isAacLike(project.audio);
  const recordFormatLabel = typeof window !== "undefined" && (pickRecordMime() ?? "").startsWith("video/mp4") ? "MP4" : "WebM";

  const est = audioDuration
    ? estimateRender({ durationSeconds: audioDuration, fps: project.export.fps, resolution: project.export.resolution })
    : null;

  const busy = job?.status === "queued" || job?.status === "rendering";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground hover:opacity-90">
          <Download className="size-4" /> Export
        </Button>
      </DialogTrigger>
      <DialogContent className="panel max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="size-4" /> Export Video
          </DialogTitle>
        </DialogHeader>

        {inlineError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {inlineError}
          </div>
        )}

        {/* Platform quick picks */}
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Where is this going?</div>
          <div className="grid grid-cols-2 gap-1.5">
            {PLATFORM_PRESETS.map((pp) => {
              const Icon = pp.icon;
              const active = activePlatform === pp.id;
              return (
                <button
                  key={pp.id}
                  onClick={() => applyPlatform(pp)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-all",
                    active ? "border-primary bg-primary/10" : "border-border bg-elevated/40 hover:bg-elevated",
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="font-medium truncate">{pp.label}</div>
                    <div className="text-[10px] text-muted-foreground">{pp.hint}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <Tabs defaultValue={getStoredAccessCode() ? "lambda" : "browser"} className="w-full">
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="browser" className="gap-1.5">
              <Circle className="size-3.5" /> Browser Recording
            </TabsTrigger>
            <TabsTrigger value="lambda" className="gap-1.5">
              <Cloud className="size-3.5" /> Lambda Render
            </TabsTrigger>
          </TabsList>

          <TabsContent value="browser" className="space-y-4 mt-4">
            <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs text-muted-foreground space-y-1">
              <div className="flex items-center gap-1.5 text-foreground/90">
                <Circle className="size-3.5" /> Record in your browser
              </div>
              <p>
                Plays the song from the start and records it in real time at{" "}
                {project.export.resolution === "4k" ? "1080p (browser max)" : project.export.resolution} as{" "}
                {recordFormatLabel}. Free and instant. Keep this tab visible until it finishes — for 4K or
                perfectly smooth 60 fps use Lambda Render.
              </p>
            </div>

            {(recording || recordUrl) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5">
                    {recordUrl ? (
                      <CheckCircle2 className="size-3.5 text-primary" />
                    ) : (
                      <Loader2 className="size-3.5 animate-spin" />
                    )}
                    {recordUrl ? "Recording complete" : recordStage || "Recording…"}
                  </span>
                  <span className="font-mono">{recordProgress}%</span>
                </div>
                <Progress value={recordProgress} />
                {recordUrl && (
                  <Button
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => downloadFile(recordUrl, `${(project.name || "render").trim() || "render"}.${recordFormatLabel.toLowerCase()}`)}
                  >
                    <Download className="size-4" /> Download {recordFormatLabel}
                  </Button>
                )}
              </div>
            )}

            {isRecording ? (
              <Button onClick={stopBrowserRecording} variant="destructive" className="w-full gap-2">
                <Square className="size-4" /> Stop Recording
              </Button>
            ) : (
              <Button
                onClick={startBrowserRecording}
                className="w-full gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Circle className="size-4" /> Start Browser Recording
              </Button>
            )}
          </TabsContent>

          <TabsContent value="lambda" className="space-y-4 mt-4">
            {isAac && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200/90 space-y-2">
                <div className="font-medium text-amber-100">M4A/AAC audio detected</div>
                <p>
                  AWS can't decode this format properly, so the visualizer would barely move in the
                  MP4. Convert it to WAV right here (takes a few seconds, happens in your browser).
                </p>
                <Button size="sm" variant="outline" className="h-8 gap-1.5 bg-background/40" onClick={() => void convertAudioToWav()} disabled={!!converting}>
                  {converting ? <Loader2 className="size-3.5 animate-spin" /> : <Video className="size-3.5" />}
                  {converting || "Convert to WAV now"}
                </Button>
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Quality</label>
                <Select
                  value={project.export.quality}
                  onValueChange={(v) =>
                    update((p) => ({ ...p, export: { ...p.export, quality: v as "high" | "standard" } }))
                  }
                >
                  <SelectTrigger className="h-9 bg-elevated/60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="high">High (320k audio)</SelectItem>
                    <SelectItem value="standard">Standard (smaller file)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">FPS</label>
                <Select
                  value={String(project.export.fps)}
                  onValueChange={(v) =>
                    update((p) => ({
                      ...p,
                      export: { ...p.export, fps: Number(v) as 30 | 45 | 60 | 120 },
                    }))
                  }
                >
                  <SelectTrigger className="h-9 bg-elevated/60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="30">30 fps</SelectItem>
                    <SelectItem value="45">45 fps</SelectItem>
                    <SelectItem value="60">60 fps</SelectItem>
                    <SelectItem value="120">120 fps</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Resolution</label>
                <Select
                  value={project.export.resolution}
                  onValueChange={(v) =>
                    update((p) => ({
                      ...p,
                      export: { ...p.export, resolution: v as "4k" | "1080p" | "720p" },
                    }))
                  }
                >
                  <SelectTrigger className="h-9 bg-elevated/60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="720p">720p (HD)</SelectItem>
                    <SelectItem value="1080p">1080p (Full HD)</SelectItem>
                    <SelectItem value="4k">4K (Ultra HD)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {!est ? (
              <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs text-muted-foreground space-y-1">
                <div className="flex items-center gap-1.5 text-foreground/90">
                  <Cloud className="size-3.5" /> AWS Lambda server-side render
                </div>
                <p>Upload a song (or press play once) so we can read its duration and estimate the render.</p>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs space-y-2">
                <div className="flex items-center gap-1.5 text-foreground/90">
                  <Cloud className="size-3.5" /> Render estimate
                </div>
                <div className="grid grid-cols-2 gap-y-1 gap-x-3 text-muted-foreground">
                  <span>Duration</span>
                  <span className="text-right font-mono text-foreground/90">{formatDuration(audioDuration)}</span>
                  <span>Total frames</span>
                  <span className="text-right font-mono text-foreground/90">{est.totalFrames.toLocaleString()}</span>
                  <span>Workers</span>
                  <span className="text-right font-mono text-foreground/90">{est.estimatedWorkers} × {est.framesPerWorker}f</span>
                  <span>Est. file size</span>
                  <span className="text-right font-mono text-foreground/90">{formatBytes(est.estimatedSizeMB)}</span>
                  <span>Est. render time</span>
                  <span className="text-right font-mono text-foreground/90">~{formatDuration(est.estimatedRenderSeconds)}</span>
                </div>
              </div>
            )}

            {job && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5">
                    {job.status === "completed" ? (
                      <CheckCircle2 className="size-3.5 text-primary" />
                    ) : job.status === "failed" ? (
                      <Square className="size-3.5 text-destructive" />
                    ) : (
                      <Loader2 className="size-3.5 animate-spin" />
                    )}
                    {stage || job.status}
                  </span>
                  <span className="font-mono">{Math.floor(progress)}%</span>
                </div>
                <Progress value={progress} />
                {downloadUrl && (
                  <div className="space-y-1">
                    <Button
                      variant="outline"
                      className="w-full gap-2"
                      onClick={() => downloadFile(downloadUrl, `${(project.name || "render").trim() || "render"}.mp4`)}
                    >
                      <Download className="size-4" /> Download MP4
                    </Button>
                    <button
                      className="w-full text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center justify-center gap-1"
                      onClick={() => downloadFile(downloadUrl, `${(project.name || "render").trim() || "render"}.mp4`, true)}
                    >
                      <ExternalLink className="size-3" /> Download not starting? Use the alternate link
                    </button>
                  </div>
                )}
                {job.status === "failed" && job.error && (
                  <p className="text-xs text-destructive">{job.error}</p>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Access code</label>
              <input
                type="password"
                inputMode="numeric"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
                placeholder="Enter access code"
                className="w-full h-9 rounded-md border border-border bg-elevated/60 px-3 text-sm outline-none focus:ring-2 focus:ring-primary/40"
              />
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Lambda rendering requires an access code. Don't have one? Use the free Browser
                Recording tab — it records in real time while you wait.
              </p>
            </div>

            <Button
              onClick={onRender}
              disabled={!accessCode.trim() || busy}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 gap-2"
            >
              <Video className="size-4" />
              {busy ? "Rendering on Lambda…" : "Start Server Render"}
            </Button>

            {busy && (
              <Button
                onClick={stopWatching}
                disabled={cancelling}
                variant="outline"
                className="w-full gap-2"
                title="AWS cannot abort a render that already started; this just stops watching it here."
              >
                <Square className="size-4" />
                {cancelling ? "Stopping…" : "Stop watching (render continues on AWS)"}
              </Button>
            )}

            <RenderHealthPanel compact accessCode={accessCode} />

            <div className="text-[10px] text-muted-foreground">
              {listJobs().length} job{listJobs().length === 1 ? "" : "s"} in history
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
