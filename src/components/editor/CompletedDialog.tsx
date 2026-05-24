import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Download, Trash2, HardDrive, Clock3, Cloud, Circle, Loader2 } from "lucide-react";
import type { Project, RenderJob } from "@/lib/project/types";
import { deleteJob, listJobs, saveJob } from "@/lib/project/store";
import { hydrateAsset, deleteAsset, getAssetDownloadUrl } from "@/lib/project/assets";
import { useServerFn } from "@tanstack/react-start";
import { getLambdaProgress } from "@/lib/render/lambda.functions";
import { toast } from "sonner";

interface Props {
  project: Project;
}

const formatSize = (bytes?: number) => {
  if (!bytes || bytes <= 0) return "Unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
};

const formatDate = (ts?: number) => {
  if (!ts) return "Saved";
  return new Date(ts).toLocaleString();
};

export function CompletedDialog({ project }: Props) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<RenderJob[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const saved = listJobs().filter((entry) => entry.projectId === project.id);
      const hydrated = await Promise.all(
        saved.map(async (entry) => ({
          ...entry,
          localAsset: await hydrateAsset(entry.localAsset),
        }))
      );
      if (!cancelled) setEntries(hydrated);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, project.id]);

  const completed = useMemo(
    () => entries.sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt)),
    [entries]
  );

  const handleDownload = async (entry: RenderJob) => {
    setBusyId(entry.id);
    try {
      const ext = entry.fileFormat || (entry.kind === "lambda" ? "mp4" : "webm");
      const filename = `${(entry.projectName || "render").trim() || "render"}.${ext}`;
      const localUrl = await getAssetDownloadUrl(entry.localAsset);
      // Lambda renders only have a remote downloadUrl; browser recordings prefer local.
      const href = entry.kind === "lambda"
        ? (entry.downloadUrl || localUrl)
        : (localUrl || entry.downloadUrl);

      if (!href) {
        toast.error("File is not available yet");
        return;
      }

      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (entry: RenderJob) => {
    setBusyId(entry.id);
    try {
      await deleteAsset(entry.localAsset);
      deleteJob(entry.id);
      setEntries((current) => current.filter((item) => item.id !== entry.id));
      toast.success("Entry removed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <CheckCircle2 className="size-4" /> Completed
        </Button>
      </DialogTrigger>
      <DialogContent className="panel max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CheckCircle2 className="size-4" /> Completed renders</DialogTitle>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs text-muted-foreground">
          Finished AWS Lambda renders and browser recordings for this project stay here so you can re-download them anytime.
        </div>

        {completed.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No completed renders yet.
          </div>
        ) : (
          <ScrollArea className="max-h-[55vh] pr-3">
            <div className="space-y-3">
              {completed.map((entry) => {
                const ext = entry.fileFormat || (entry.kind === "lambda" ? "mp4" : "webm");
                const available = Boolean(entry.localAsset || entry.downloadUrl);
                const isLambda = entry.kind === "lambda";
                const processing = entry.status === "queued" || entry.status === "rendering";
                return (
                  <div key={entry.id} className="rounded-lg border border-border bg-elevated/30 p-3 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="truncate text-sm font-medium text-foreground">{(entry.projectName || "Untitled").trim() || "Untitled"}.{ext}</span>
                          {available ? <Badge variant="secondary">Ready</Badge> : <Badge variant="outline">{processing ? `${entry.progress || 0}%` : "Processing"}</Badge>}
                          <Badge variant="outline" className="gap-1">
                            {isLambda ? <Cloud className="size-3" /> : <Circle className="size-3" />}
                            {isLambda ? "AWS Render" : "Browser Recording"}
                          </Badge>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1"><Clock3 className="size-3.5" /> {formatDate(entry.completedAt || entry.createdAt)}</span>
                          <span className="inline-flex items-center gap-1"><HardDrive className="size-3.5" /> {formatSize(entry.sizeBytes)}</span>
                        </div>
                        {entry.error && <p className="text-xs text-destructive">{entry.error}</p>}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="flex-1 gap-2"
                        disabled={!available || busyId === entry.id}
                        onClick={() => void handleDownload(entry)}
                      >
                        <Download className="size-4" /> Download
                      </Button>
                      <Button
                        variant="ghost"
                        className="gap-2"
                        disabled={busyId === entry.id}
                        onClick={() => void handleDelete(entry)}
                      >
                        <Trash2 className="size-4" /> Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
