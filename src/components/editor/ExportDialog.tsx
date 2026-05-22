import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Server, CheckCircle2, Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Project, RenderJob } from "@/lib/project/types";
import { saveJob, listJobs } from "@/lib/project/store";
import { toast } from "sonner";

interface Props { project: Project; update: (u: (p: Project) => Project) => void; }

export function ExportDialog({ project, update }: Props) {
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<RenderJob | null>(null);
  const [progress, setProgress] = useState(0);

  const startRender = () => {
    const j: RenderJob = {
      id: crypto.randomUUID(),
      projectId: project.id, projectName: project.name,
      status: "queued", progress: 0, createdAt: Date.now(),
      config: project.export, aspectRatio: project.aspectRatio,
    };
    setJob(j); saveJob(j); setProgress(0);
    toast.success("Render queued", { description: "Job submitted to render pipeline" });

    // Simulated render queue (placeholder for server-side FFmpeg worker)
    let p = 0;
    const tick = () => {
      p += Math.random() * 8 + 2;
      if (p >= 100) {
        p = 100;
        const done: RenderJob = { ...j, status: "completed", progress: 100, completedAt: Date.now(), downloadUrl: project.audio?.url };
        saveJob(done); setJob(done); setProgress(100);
        toast.success("Render complete");
        return;
      }
      setProgress(p);
      const upd: RenderJob = { ...j, status: "rendering", progress: p };
      saveJob(upd); setJob(upd);
      setTimeout(tick, 400);
    };
    setTimeout(tick, 600);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground hover:opacity-90">
          <Download className="size-4" /> Export
        </Button>
      </DialogTrigger>
      <DialogContent className="panel max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Server className="size-4" /> Export Video</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Resolution</label>
              <Select value={project.export.resolution} onValueChange={(v) => update(p => ({ ...p, export: { ...p.export, resolution: v as "1080p" | "720p" } }))}>
                <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="1080p">1080p</SelectItem><SelectItem value="720p">720p</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">FPS</label>
              <Select value={String(project.export.fps)} onValueChange={(v) => update(p => ({ ...p, export: { ...p.export, fps: Number(v) as 30 | 60 } }))}>
                <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="60">60 fps</SelectItem><SelectItem value="30">30 fps</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 col-span-2">
              <label className="text-xs text-muted-foreground">Quality</label>
              <Select value={project.export.quality} onValueChange={(v) => update(p => ({ ...p, export: { ...p.export, quality: v as "high" | "standard" } }))}>
                <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="high">High</SelectItem><SelectItem value="standard">Standard</SelectItem></SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs text-muted-foreground space-y-1">
            <div className="flex items-center gap-1.5 text-foreground/90"><Server className="size-3.5" /> Server-side render queue</div>
            <p>Final {project.export.resolution} {project.export.fps}fps MP4 will be produced by the FFmpeg render worker and uploaded to cloud storage. Connect Lovable Cloud to enable.</p>
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
              {job.status === "completed" && job.downloadUrl && (
                <a href={job.downloadUrl} download={`${project.name}.mp4`} className="block">
                  <Button variant="outline" className="w-full gap-2"><Download className="size-4" /> Download</Button>
                </a>
              )}
            </div>
          )}

          <Button onClick={startRender} className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
            {job?.status === "rendering" ? "Rendering…" : "Start Render"}
          </Button>

          <div className="text-[10px] text-muted-foreground">
            {listJobs().length} job{listJobs().length === 1 ? "" : "s"} in history
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
