import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Video, CheckCircle2, Loader2, Cloud, Circle, Square } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Project, RenderJob } from "@/lib/project/types";
import { saveJob, listJobs } from "@/lib/project/store";
import { getAssetDownloadUrl, storeAsset } from "@/lib/project/assets";
import { AudioEngine } from "@/lib/visualizer/audioEngine";
import { useServerFn } from "@tanstack/react-start";
import { startLambdaRender, getLambdaProgress } from "@/lib/render/lambda.functions";
import { assertRenderableAssetUrl, uploadAssetForRender, uploadBlobForRender } from "@/lib/render/upload";
import { estimateRender, formatBytes, formatDuration } from "@/lib/render/estimate";
import { toast } from "sonner";


interface Props {
  project: Project;
  update: (u: (p: Project) => Project) => void;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  engineRef: React.RefObject<AudioEngine | null>;
}

const RES_DIMS = {
  "16:9": { "4k": [3840, 2160], "1080p": [1920, 1080], "720p": [1280, 720] },
  "1:1":  { "4k": [2160, 2160], "1080p": [1080, 1080], "720p": [720, 720] },
  "9:16": { "4k": [2160, 3840], "1080p": [1080, 1920], "720p": [720, 1280] },
  "4:5":  { "4k": [2160, 2700], "1080p": [1080, 1350], "720p": [864, 1080] },
} as const;

export function ExportDialog({ project, update, audioRef, canvasRef, engineRef }: Props) {
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<RenderJob | null>(null);
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [stage, setStage] = useState<string>("");
  const pollRef = useRef<number | null>(null);

  // Browser recording state
  const [recording, setRecording] = useState(false);
  const [recordProgress, setRecordProgress] = useState(0);
  const [recordUrl, setRecordUrl] = useState<string | null>(null);
  const [recordStage, setRecordStage] = useState<string>("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordRafRef = useRef<number | null>(null);

  const startRender = useServerFn(startLambdaRender);
  const pollProgress = useServerFn(getLambdaProgress);

  const downloadFile = async (url: string, filename: string) => {
    console.log("[browser-record] download click", { url, filename });
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    console.log("[browser-record] download triggered", { url, filename });
  };

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    if (recordRafRef.current) cancelAnimationFrame(recordRafRef.current);
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try { recorderRef.current.stop(); } catch { /* ignore */ }
    }
  }, []);

  const persistJob = (entry: RenderJob) => {
    saveJob(entry);
  };

  const isRecording = recording && recorderRef.current?.state === "recording";

  const stopBrowserRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      setRecording(false);
      try { recorderRef.current.stop(); } catch { /* ignore */ }
    }
    if (audioRef.current) {
      audioRef.current.pause();
    }
  };

  const startBrowserRecording = async () => {
    if (!project.audio) { toast.error("Upload an audio file first"); return; }
    const canvas = canvasRef.current;
    const audioEl = audioRef.current;
    const engine = engineRef.current;
    if (!canvas || !audioEl || !engine) { toast.error("Editor not ready yet"); return; }
    const duration = audioEl.duration && isFinite(audioEl.duration) ? audioEl.duration : 0;
    if (!duration) { toast.error("Press play once so the audio duration loads"); return; }
    const browserJobBase: RenderJob = {
      id: crypto.randomUUID(),
      projectId: project.id,
      projectName: project.name,
      kind: "browser",
      fileFormat: "webm",
      status: "queued",
      progress: 0,
      createdAt: Date.now(),
      config: project.export,
      aspectRatio: project.aspectRatio,
    };

    // Pick a supported mime type
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    const mimeType = candidates.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
    if (!mimeType) { toast.error("Browser recording is not supported in this browser"); return; }

    try {
      persistJob(browserJobBase);

      await engine.resume();
      setRecordStage("Recording…");
      const fps = project.export.fps || 60;
      const canvasStream = canvas.captureStream(fps);
      const audioStream = engine.dest.stream;
      const combined = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioStream.getAudioTracks(),
      ]);

      const chunks: BlobPart[] = [];
      const rec = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 4_500_000 });
      recorderRef.current = rec;
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      rec.onstop = async () => {
        if (recordRafRef.current) { cancelAnimationFrame(recordRafRef.current); recordRafRef.current = null; }
        recorderRef.current = null;

        const videoTracks = canvasStream.getVideoTracks();
        const audioTracks = audioStream.getAudioTracks();
        [...videoTracks, ...audioTracks].forEach((track) => track.stop());

        try {
          const blob = new Blob(chunks, { type: mimeType });
          const baseName = (project.name || "render").trim() || "render";
          const fileName = `${baseName}.webm`;
          const localAsset = await storeAsset(new File([blob], fileName, { type: blob.type || "video/webm" }));
          let remoteUrl: string | undefined;
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
            fileFormat: "webm",
          };
          persistJob(completedEntry);

          try {
            setRecordStage("Uploading backup copy…");
            remoteUrl = await uploadBlobForRender({
              assetId: `browser-recording-${crypto.randomUUID()}`,
              fileName,
              contentType: blob.type || "video/webm",
              blob,
              onProgress: (pct) => setRecordProgress(pct),
            });
            persistJob({ ...completedEntry, downloadUrl: remoteUrl, status: "completed", progress: 100 });
          } catch (e: any) {
            console.error("[browser-record] remote backup upload failed", e);
            toast.error("Recording saved locally. Cloud backup upload failed.");
          }

          setRecordStage(remoteUrl ? "Recording complete" : "Recording saved locally");
          toast.success("Recording complete");
        } catch (e: any) {
          console.error("[browser-record] upload failed", e);
          setRecordStage("");
          setRecordUrl(null);
          persistJob({
            ...browserJobBase,
            status: "failed",
            error: e?.message || "Unknown error",
          });
          toast.error(`Recording upload failed: ${e?.message || "unknown"}`);
        } finally {
          setRecording(false);
        }
      };

      // Reset audio to start, play, begin recording
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
            try { recorderRef.current.stop(); } catch { /* ignore */ }
          }
          audioEl.pause();
          return;
        }
        recordRafRef.current = requestAnimationFrame(tick);
      };
      recordRafRef.current = requestAnimationFrame(tick);
    } catch (e: any) {
      console.error("[browser-record]", e);
      persistJob({ ...browserJobBase, status: "failed", error: e?.message || "Unknown error" });
      toast.error(`Recording failed: ${e?.message || "unknown"}`);
      setRecording(false);
      setRecordStage("");
    }
  };


  const onRender = async () => {
    if (!project.audio) { toast.error("Upload an audio file first"); return; }
    const audioEl = audioRef.current;
    const duration = audioEl?.duration && isFinite(audioEl.duration) ? audioEl.duration : 0;
    if (!duration) { toast.error("Press play once so the audio duration loads"); return; }

    const j: RenderJob = {
      id: crypto.randomUUID(),
      projectId: project.id, projectName: project.name,
      kind: "lambda", fileFormat: "mp4",
      status: "queued", progress: 0, createdAt: Date.now(),
      config: project.export, aspectRatio: project.aspectRatio,
    };
    setJob(j); persistJob(j); setProgress(0); setDownloadUrl(null);

    try {
      setStage("Uploading assets…");
      console.log("[lambda-render] asset upload request", {
        audio: project.audio ? { id: project.audio.id, name: project.audio.name, indexedDbKey: `asset:${project.audio.id}` } : null,
        background: project.background ? { id: project.background.id, name: project.background.name, indexedDbKey: `asset:${project.background.id}` } : null,
        logo: project.logo ? { id: project.logo.id, name: project.logo.name, indexedDbKey: `asset:${project.logo.id}` } : null,
      });

      const [audioUrl, backgroundUrl, logoUrl] = await Promise.all([
        uploadAssetForRender(project.audio),
        uploadAssetForRender(project.background),
        uploadAssetForRender(project.logo),
      ]);

      console.log("[lambda-render] asset upload results", {
        audioUrl,
        backgroundUrl,
        logoUrl,
      });

      const resolvedAudioUrl = assertRenderableAssetUrl("audio", audioUrl);
      const resolvedBackgroundUrl = project.background
        ? assertRenderableAssetUrl("background", backgroundUrl)
        : null;
      const resolvedLogoUrl = project.logo
        ? assertRenderableAssetUrl("logo", logoUrl)
        : null;

      const [w, h] = RES_DIMS[project.aspectRatio][project.export.resolution];

      setStage("Starting Lambda render…");
      const inputProps = {
        audioUrl: resolvedAudioUrl,
        durationSeconds: duration,
        fps: project.export.fps,
        width: w,
        height: h,
        backgroundUrl: resolvedBackgroundUrl,
        backgroundType: project.background?.type ?? null,
        logoUrl: resolvedLogoUrl,
        visualizer: project.visualizer,
        effects: project.effects,
        lyrics: project.lyrics,
      };

      const invalidFields = Object.entries(inputProps)
        .filter(([, value]) => value === undefined || value === "")
        .map(([key, value]) => ({ key, value }));

      console.log("[lambda-render] final inputProps", inputProps);
      if (invalidFields.length > 0) {
        console.error("[lambda-render] invalid inputProps detected before Lambda", invalidFields);
        throw new Error(`Invalid render input: ${invalidFields.map((f) => f.key).join(", ")}`);
      }

      const { renderId, bucketName } = await startRender({
        data: inputProps,
      });

      setStage("Rendering on AWS Lambda…");
      const running: RenderJob = { ...j, status: "rendering", renderId, bucketName };
      setJob(running); persistJob(running);

      await new Promise<void>((resolve, reject) => {
        pollRef.current = window.setInterval(async () => {
          try {
            const p = await pollProgress({ data: { renderId, bucketName } });
            const pct = Math.round((p.overallProgress || 0) * 100);
            setProgress(pct);
            persistJob({ ...running, progress: pct });
            if (p.done && p.outputFile) {
              window.clearInterval(pollRef.current!); pollRef.current = null;
              setDownloadUrl(p.outputFile);
              const done: RenderJob = { ...running, kind: "lambda", fileFormat: "mp4", status: "completed", progress: 100, completedAt: Date.now(), downloadUrl: p.outputFile };
              setJob(done); persistJob(done); setProgress(100);
              setStage("Complete");
              toast.success("Render complete");
              resolve();
              return;
            }
            if (p.fatalErrorEncountered && !p.outputFile) {
              const msg = p.errors[0]?.message || "Lambda render failed";
              window.clearInterval(pollRef.current!); pollRef.current = null;
              reject(new Error(msg)); return;
            }
          } catch (e: any) {
            window.clearInterval(pollRef.current!); pollRef.current = null;
            reject(e);
          }
        }, 3000);
      });
    } catch (e: any) {
      console.error("[lambda-render]", e);
      const failed: RenderJob = { ...j, kind: "lambda", fileFormat: "mp4", status: "failed", error: e?.message || "Unknown error" };
      setJob(failed); persistJob(failed);
      toast.error(`Render failed: ${e?.message || "unknown"}`);
      setStage("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground hover:opacity-90">
          <Download className="size-4" /> Export
        </Button>
      </DialogTrigger>
      <DialogContent className="panel max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Download className="size-4" /> Export Video</DialogTitle></DialogHeader>

        <Tabs defaultValue="browser" className="w-full">
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="browser" className="gap-1.5"><Circle className="size-3.5" /> Browser Recording</TabsTrigger>
            <TabsTrigger value="lambda" className="gap-1.5"><Cloud className="size-3.5" /> Lambda Render</TabsTrigger>
          </TabsList>

          {/* Browser recording — works while AWS quota is low */}
          <TabsContent value="browser" className="space-y-4 mt-4">
            <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs text-muted-foreground space-y-1">
              <div className="flex items-center gap-1.5 text-foreground/90"><Circle className="size-3.5" /> Record in your browser</div>
              <p>Plays the song from the start and captures the canvas + audio in real time as a WebM file. Finished recordings are kept in the Completed menu beside Export.</p>
            </div>

            {(recording || recordUrl) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5">
                    {recordUrl
                      ? <CheckCircle2 className="size-3.5 text-primary" />
                      : <Loader2 className="size-3.5 animate-spin" />}
                    {recordUrl ? "Recording complete" : (recordStage || "Recording…")}
                  </span>
                  <span className="font-mono">{recordProgress}%</span>
                </div>
                <Progress value={recordProgress} />
                {recordUrl && (
                  <Button
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => void downloadFile(recordUrl, `${(project.name || "render").trim() || "render"}.webm`)}
                  >
                    <Download className="size-4" /> Download WebM
                  </Button>
                )}
              </div>
            )}

            {isRecording ? (
              <Button onClick={stopBrowserRecording} variant="destructive" className="w-full gap-2">
                <Square className="size-4" /> Stop Recording
              </Button>
            ) : (
              <Button onClick={startBrowserRecording} className="w-full gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
                <Circle className="size-4" /> Start Browser Recording
              </Button>
            )}

          </TabsContent>

          {/* Server-side Lambda render */}
          <TabsContent value="lambda" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">FPS</label>
                <Select
                  value={String(project.export.fps)}
                  onValueChange={(v) => update((p) => ({ ...p, export: { ...p.export, fps: Number(v) as 30 | 45 | 60 | 120 } }))}
                >
                  <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
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
                  onValueChange={(v) => update((p) => ({ ...p, export: { ...p.export, resolution: v as "4k" | "1080p" | "720p" } }))}
                >
                  <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="720p">720p (HD)</SelectItem>
                    <SelectItem value="1080p">1080p (Full HD)</SelectItem>
                    <SelectItem value="4k">4K (Ultra HD)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {(() => {
              const duration = audioRef.current?.duration && isFinite(audioRef.current.duration) ? audioRef.current.duration : 0;
              if (!duration) {
                return (
                  <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs text-muted-foreground space-y-1">
                    <div className="flex items-center gap-1.5 text-foreground/90"><Cloud className="size-3.5" /> AWS Lambda server-side render</div>
                    <p>Press play once on the audio so we can read its duration and estimate render size/time.</p>
                  </div>
                );
              }
              const est = estimateRender({
                durationSeconds: duration,
                fps: project.export.fps,
                resolution: project.export.resolution,
                maxWorkers: 5,
              });
              return (
                <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs space-y-2">
                  <div className="flex items-center gap-1.5 text-foreground/90"><Cloud className="size-3.5" /> Render estimate</div>
                  <div className="grid grid-cols-2 gap-y-1 gap-x-3 text-muted-foreground">
                    <span>Duration</span><span className="text-right font-mono text-foreground/90">{formatDuration(duration)}</span>
                    <span>Total frames</span><span className="text-right font-mono text-foreground/90">{est.totalFrames.toLocaleString()}</span>
                    <span>Workers (cap 5)</span><span className="text-right font-mono text-foreground/90">{est.estimatedWorkers} × {est.framesPerWorker}f</span>
                    <span>Est. file size</span><span className="text-right font-mono text-foreground/90">{formatBytes(est.estimatedSizeMB)}</span>
                    <span>Est. render time</span><span className="text-right font-mono text-foreground/90">~{formatDuration(est.estimatedRenderSeconds)}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground/80 leading-relaxed">Capped at 5 parallel Lambdas to stay under the new-account AWS concurrency limit (default 10). Estimates are rough — actual times vary with preset complexity and cold starts.</p>
                  <div className="rounded bg-background/60 p-2 space-y-1">
                    <p className="text-[10px] text-muted-foreground/80">If you changed presets, effects, or colors since the last deploy, Lambda is still using the old bundle. Redeploy from your local machine:</p>
                    <code className="block font-mono text-[10px] text-foreground/90 bg-black/30 rounded px-1.5 py-1 select-all">
                      npx remotion lambda sites create src/remotion/index.ts --site-name=lyrics-viz --region=us-east-2
                    </code>
                  </div>
                </div>
              );
            })()}

            {job && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5">
                    {job.status === "completed" ? <CheckCircle2 className="size-3.5 text-primary" /> : <Loader2 className="size-3.5 animate-spin" />}
                    {stage || job.status}
                  </span>
                  <span className="font-mono">{Math.floor(progress)}%</span>
                </div>
                <Progress value={progress} />
                {downloadUrl && (
                  <Button
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => void downloadFile(downloadUrl, `${(project.name || "render").trim() || "render"}.mp4`)}
                  >
                    <Download className="size-4" /> Download MP4
                  </Button>
                )}
                {job.status === "failed" && job.error && (
                  <p className="text-xs text-destructive">{job.error}</p>
                )}
              </div>
            )}

            <Button onClick={onRender} disabled={job?.status === "queued" || job?.status === "rendering"} className="w-full bg-primary text-primary-foreground hover:bg-primary/90 gap-2">
              <Video className="size-4" />
              {job?.status === "rendering" || job?.status === "queued" ? "Rendering on Lambda…" : "Start Server Render"}
            </Button>

            <div className="text-[10px] text-muted-foreground">
              {listJobs().length} job{listJobs().length === 1 ? "" : "s"} in history
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

