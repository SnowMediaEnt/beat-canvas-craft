import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Film, Download, Trash2, HardDrive, Clock3, Cloud, CheckCircle2 } from "lucide-react";
import type { Project, RenderJob } from "@/lib/project/types";
import { deleteJob, listJobs } from "@/lib/project/store";
import { hydrateAsset, deleteAsset, getAssetDownloadUrl } from "@/lib/project/assets";
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

const getRecordingUrl = (entry: RenderJob) => entry.localAsset?.url || entry.downloadUrl || null;

export function RecordingsDialog({ project }: Props) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<RenderJob[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const saved = listJobs().filter((entry) => entry.projectId === project.id && entry.kind === "browser");
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

  const recordings = useMemo(
    () => entries.filter((entry) => entry.kind === "browser").sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt)),
    [entries]
  );

  const handleDownload = async (entry: RenderJob) => {
    setBusyId(entry.id);
    try {
      const filename = `${(entry.projectName || "render").trim() || "render"}.${entry.fileFormat || "webm"}`;
      const localUrl = await getAssetDownloadUrl(entry.localAsset);
      const href = localUrl || entry.downloadUrl;
      console.log("[recordings] download click", {
        entryId: entry.id,
        hasLocalAsset: Boolean(entry.localAsset),
        localUrlReady: Boolean(localUrl),
        hasRemoteUrl: Boolean(entry.downloadUrl),
        filename,
      });

      if (!href) {
        console.error("[recordings] no download source", { entryId: entry.id, entry });
        toast.error("Recording file is not available yet");
        return;
      }

      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      console.log("[recordings] download triggered", { entryId: entry.id, href, filename });
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
      toast.success("Recording removed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Film className="size-4" /> Recordings
        </Button>
      </DialogTrigger>
      <DialogContent className="panel max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Film className="size-4" /> Saved recordings</DialogTitle>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs text-muted-foreground">
          Browser recordings for this project stay here so they can be re-downloaded later, even after the export dialog closes.
        </div>

        {recordings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No recordings saved yet.
          </div>
        ) : (
          <ScrollArea className="max-h-[55vh] pr-3">
            <div className="space-y-3">
              {recordings.map((entry) => {
                const available = Boolean(entry.localAsset || entry.downloadUrl || getRecordingUrl(entry));
                const uploading = entry.status === "rendering";
                return (
                  <div key={entry.id} className="rounded-lg border border-border bg-elevated/30 p-3 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">{entry.projectName || "Untitled recording"}.webm</span>
                          {available ? <Badge variant="secondary">Ready</Badge> : <Badge variant="outline">Processing</Badge>}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1"><Clock3 className="size-3.5" /> {formatDate(entry.completedAt || entry.createdAt)}</span>
                          <span className="inline-flex items-center gap-1"><HardDrive className="size-3.5" /> {formatSize(entry.sizeBytes)}</span>
                          <span className="inline-flex items-center gap-1">
                            {entry.downloadUrl ? <Cloud className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
                            {entry.downloadUrl ? "Cloud backup ready" : "Local copy ready"}
                          </span>
                        </div>
                        {uploading && <p className="text-xs text-muted-foreground">Still uploading backup copy…</p>}
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