import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Video, CheckCircle2, Loader2, Cloud } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Project, RenderJob } from "@/lib/project/types";
import { saveJob, listJobs } from "@/lib/project/store";
import { AudioEngine } from "@/lib/visualizer/audioEngine";
import { useServerFn } from "@tanstack/react-start";
import { startLambdaRender, getLambdaProgress } from "@/lib/render/lambda.functions";
import { assertRenderableAssetUrl, uploadAssetForRender } from "@/lib/render/upload";
import { toast } from "sonner";

interface Props {
  project: Project;
  update: (u: (p: Project) => Project) => void;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  engineRef: React.RefObject<AudioEngine | null>;
}

const RES_DIMS = {
  "16:9": { "1080p": [1920, 1080], "720p": [1280, 720] },
  "1:1":  { "1080p": [1080, 1080], "720p": [720, 720] },
  "9:16": { "1080p": [1080, 1920], "720p": [720, 1280] },
  "4:5":  { "1080p": [1080, 1350], "720p": [864, 1080] },
} as const;

export function ExportDialog({ project, audioRef }: Props) {
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<RenderJob | null>(null);
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [stage, setStage] = useState<string>("");
  const pollRef = useRef<number | null>(null);

  const startRender = useServerFn(startLambdaRender);
  const pollProgress = useServerFn(getLambdaProgress);

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

  const onRender = async () => {
    if (!project.audio) { toast.error("Upload an audio file first"); return; }
    const audioEl = audioRef.current;
    const duration = audioEl?.duration && isFinite(audioEl.duration) ? audioEl.duration : 0;
    if (!duration) { toast.error("Press play once so the audio duration loads"); return; }

    const j: RenderJob = {
      id: crypto.randomUUID(),
      projectId: project.id, projectName: project.name,
      status: "queued", progress: 0, createdAt: Date.now(),
      config: project.export, aspectRatio: project.aspectRatio,
    };
    setJob(j); saveJob(j); setProgress(0); setDownloadUrl(null);

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
      const v = project.visualizer;
      const l = project.lyrics;
      const inputProps = {
        audioUrl: resolvedAudioUrl,
        durationSeconds: duration,
        fps: project.export.fps,
        width: w,
        height: h,
        backgroundUrl: resolvedBackgroundUrl,
        logoUrl: resolvedLogoUrl,
        primary: v.primary,
        secondary: v.secondary,
        accent: v.accent,
        glow: v.glow,
        bandCount: v.bandCount,
        sensitivity: v.sensitivity,
        thickness: v.thickness,
        reactivity: v.reactivity,
        lyrics: l.lines,
        lyricsEnabled: l.enabled,
        lyricsColor: l.color,
        lyricsFontFamily: l.fontFamily,
        lyricsFontSize: l.fontSize,
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
      const running: RenderJob = { ...j, status: "rendering" };
      setJob(running); saveJob(running);

      await new Promise<void>((resolve, reject) => {
        pollRef.current = window.setInterval(async () => {
          try {
            const p = await pollProgress({ data: { renderId, bucketName } });
            const pct = Math.round((p.overallProgress || 0) * 100);
            setProgress(pct);
            saveJob({ ...running, progress: pct });
            if (p.fatalErrorEncountered) {
              const msg = p.errors[0]?.message || "Lambda render failed";
              window.clearInterval(pollRef.current!); pollRef.current = null;
              reject(new Error(msg)); return;
            }
            if (p.done && p.outputFile) {
              window.clearInterval(pollRef.current!); pollRef.current = null;
              setDownloadUrl(p.outputFile);
              const done: RenderJob = { ...running, status: "completed", progress: 100, completedAt: Date.now(), downloadUrl: p.outputFile };
              setJob(done); saveJob(done); setProgress(100);
              setStage("Complete");
              toast.success("Render complete");
              resolve();
            }
          } catch (e: any) {
            window.clearInterval(pollRef.current!); pollRef.current = null;
            reject(e);
          }
        }, 3000);
      });
    } catch (e: any) {
      console.error("[lambda-render]", e);
      const failed: RenderJob = { ...j, status: "failed", error: e?.message || "Unknown error" };
      setJob(failed); saveJob(failed);
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
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Cloud className="size-4" /> Server Render (Remotion Lambda)</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">FPS</label>
              <Select value={String(project.export.fps)} disabled>
                <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="30">30 fps</SelectItem><SelectItem value="60">60 fps</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Resolution</label>
              <Select value={project.export.resolution} disabled>
                <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="1080p">1080p</SelectItem><SelectItem value="720p">720p</SelectItem></SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs text-muted-foreground space-y-1">
            <div className="flex items-center gap-1.5 text-foreground/90"><Cloud className="size-3.5" /> AWS Lambda server-side render</div>
            <p>Uploads your audio to storage, then renders MP4 on AWS Lambda. You can close this tab once rendering starts.</p>
          </div>

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
                <a href={downloadUrl} target="_blank" rel="noreferrer" className="block">
                  <Button variant="outline" className="w-full gap-2"><Download className="size-4" /> Download MP4</Button>
                </a>
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
