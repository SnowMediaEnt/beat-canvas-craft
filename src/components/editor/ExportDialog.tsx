import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Video, CheckCircle2, Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Project, RenderJob } from "@/lib/project/types";
import { saveJob, listJobs } from "@/lib/project/store";
import { AudioEngine } from "@/lib/visualizer/audioEngine";
import { toast } from "sonner";

interface Props {
  project: Project;
  update: (u: (p: Project) => Project) => void;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  engineRef: React.RefObject<AudioEngine | null>;
}

const pickMime = (): { mime: string; ext: string } => {
  const candidates = [
    { mime: "video/webm;codecs=vp9,opus", ext: "webm" },
    { mime: "video/webm;codecs=vp8,opus", ext: "webm" },
    { mime: "video/webm", ext: "webm" },
    { mime: "video/mp4", ext: "mp4" },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  return { mime: "", ext: "webm" };
};

export function ExportDialog({ project, canvasRef, audioRef, engineRef }: Props) {
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<RenderJob | null>(null);
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [ext, setExt] = useState("webm");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  }, [downloadUrl]);

  const startRender = async () => {
    const canvas = canvasRef.current;
    const audioEl = audioRef.current;
    if (!canvas) { toast.error("Canvas not ready"); return; }
    if (!project.audio || !audioEl) { toast.error("Upload an audio file first"); return; }

    // Ensure audio engine exists (for the audio destination stream)
    if (!engineRef.current) {
      try { engineRef.current = new AudioEngine(audioEl, project.visualizer.smoothing); }
      catch { toast.error("Could not initialize audio"); return; }
    }
    const engine = engineRef.current!;
    await engine.resume();

    const { mime, ext: outExt } = pickMime();
    setExt(outExt);

    const fps = project.export.fps;
    const videoStream = canvas.captureStream(fps);
    const audioTracks = engine.dest.stream.getAudioTracks();
    const stream = new MediaStream([...videoStream.getVideoTracks(), ...audioTracks]);

    const bitsPerSecond = project.export.quality === "high" ? 12_000_000 : 6_000_000;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: bitsPerSecond } : { videoBitsPerSecond: bitsPerSecond });
    } catch (e) {
      toast.error("Recording not supported in this browser");
      console.error(e);
      return;
    }

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const j: RenderJob = {
      id: crypto.randomUUID(),
      projectId: project.id, projectName: project.name,
      status: "rendering", progress: 0, createdAt: Date.now(),
      config: project.export, aspectRatio: project.aspectRatio,
    };
    setJob(j); saveJob(j); setProgress(0); setDownloadUrl(null);

    recorder.onstop = () => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      const blob = new Blob(chunks, { type: mime || "video/webm" });
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
      const done: RenderJob = { ...j, status: "completed", progress: 100, completedAt: Date.now(), downloadUrl: url };
      saveJob(done); setJob(done); setProgress(100);
      toast.success("Render complete — click Download");
    };

    recorderRef.current = recorder;

    // Rewind & play through
    try { audioEl.currentTime = 0; } catch { /* ignore */ }
    audioEl.onended = () => {
      // Tail to flush last frames
      setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, 300);
    };

    recorder.start(500);
    try { await audioEl.play(); } catch { toast.error("Press play on the track first, then export"); recorder.stop(); return; }

    toast.success("Recording in real time", { description: "Keep this tab focused until the track finishes" });

    const tick = () => {
      const dur = audioEl.duration || 1;
      const p = Math.min(99, (audioEl.currentTime / dur) * 100);
      setProgress(p);
      const upd: RenderJob = { ...j, status: "rendering", progress: p };
      saveJob(upd);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const cancel = () => {
    const r = recorderRef.current;
    if (r && r.state !== "inactive") r.stop();
    const a = audioRef.current; if (a) a.pause();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground hover:opacity-90">
          <Download className="size-4" /> Export
        </Button>
      </DialogTrigger>
      <DialogContent className="panel max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Video className="size-4" /> Export Video</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">FPS</label>
              <Select value={String(project.export.fps)} onValueChange={(v) => saveJob}>
                <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="60">60 fps</SelectItem><SelectItem value="30">30 fps</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Quality</label>
              <Select value={project.export.quality} onValueChange={() => {}}>
                <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="high">High (12 Mbps)</SelectItem><SelectItem value="standard">Standard (6 Mbps)</SelectItem></SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs text-muted-foreground space-y-1">
            <div className="flex items-center gap-1.5 text-foreground/90"><Video className="size-3.5" /> Real-time browser capture</div>
            <p>Records the live canvas + audio into a {ext.toUpperCase()} file. Keep this tab focused for the full duration of the track.</p>
          </div>

          {job && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  {job.status === "completed" ? <CheckCircle2 className="size-3.5 text-primary" /> : <Loader2 className="size-3.5 animate-spin" />}
                  {job.status}
                </span>
                <span className="font-mono">{Math.floor(progress)}%</span>
              </div>
              <Progress value={progress} />
              {downloadUrl && (
                <a href={downloadUrl} download={`${project.name}.${ext}`} className="block">
                  <Button variant="outline" className="w-full gap-2"><Download className="size-4" /> Download {ext.toUpperCase()}</Button>
                </a>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={startRender} disabled={job?.status === "rendering"} className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90">
              {job?.status === "rendering" ? "Recording…" : "Start Render"}
            </Button>
            {job?.status === "rendering" && (
              <Button onClick={cancel} variant="outline">Stop</Button>
            )}
          </div>

          <div className="text-[10px] text-muted-foreground">
            {listJobs().length} job{listJobs().length === 1 ? "" : "s"} in history
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
