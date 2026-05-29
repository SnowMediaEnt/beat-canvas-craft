import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  Download,
  Trash2,
  HardDrive,
  Clock3,
  Cloud,
  Circle,
  Loader2,
} from "lucide-react";
import type { Project, RenderJob } from "@/lib/project/types";
import { deleteJob, listJobsFromStorage, saveJob } from "@/lib/project/store";
import { hydrateAsset, deleteAsset, getAssetDownloadUrl } from "@/lib/project/assets";
import { useServerFn } from "@tanstack/react-start";
import { getLambdaProgress } from "@/lib/render/lambda.functions";
import { listLambdaRenders, type CloudRender } from "@/lib/render/list-renders.functions";
import { getFreshRenderDownloadUrl } from "@/lib/render/download.functions";
import { toast } from "sonner";
import { triggerDownload } from "@/lib/render/download";

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
  const [cloudOnly, setCloudOnly] = useState<RenderJob[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const pollProgress = useServerFn(getLambdaProgress);
  const fetchCloudRenders = useServerFn(listLambdaRenders);
  const getFreshDownloadUrl = useServerFn(getFreshRenderDownloadUrl);
  const pollingRef = useRef<Set<string>>(new Set());

  const mergeCloudIntoEntries = (localEntries: RenderJob[], cloudEntries: CloudRender[]) => {
    const cloudByRenderId = new Map(cloudEntries.map((entry) => [entry.renderId, entry]));
    const mergedLocal = localEntries.map((entry) => {
      if (entry.kind !== "lambda" || !entry.renderId) return entry;
      const cloudMatch = cloudByRenderId.get(entry.renderId);
      if (!cloudMatch) return entry;
      return {
        ...entry,
        status: "completed" as const,
        progress: 100,
        completedAt: entry.completedAt || cloudMatch.lastModified,
        sizeBytes: entry.sizeBytes || cloudMatch.sizeBytes,
        downloadUrl: entry.downloadUrl || cloudMatch.url,
        bucketName: entry.bucketName || cloudMatch.bucketName,
        fileFormat: entry.fileFormat || cloudMatch.fileFormat,
        error: undefined,
      };
    });

    const knownRenderIds = new Set(mergedLocal.map((j) => j.renderId).filter(Boolean));
    const orphans: RenderJob[] = cloudEntries
      .filter((c) => !knownRenderIds.has(c.renderId))
      .map((c) => ({
        id: `cloud-${c.renderId}`,
        projectId: "",
        projectName: `Cloud render ${c.renderId.slice(0, 8)}`,
        kind: "lambda",
        status: "completed",
        progress: 100,
        createdAt: c.lastModified,
        completedAt: c.lastModified,
        sizeBytes: c.sizeBytes,
        downloadUrl: c.url,
        fileFormat: c.fileFormat,
        config: project.export,
        aspectRatio: project.aspectRatio,
        renderId: c.renderId,
        bucketName: c.bucketName,
      }));

    return { mergedLocal, orphans };
  };

  const refresh = async () => {
    const allJobs = await listJobsFromStorage();
    const saved = allJobs.filter((entry) => entry.projectId === project.id);
    const hydrated = await Promise.all(
      saved.map(async (entry) => ({
        ...entry,
        localAsset: await hydrateAsset(entry.localAsset),
      })),
    );
    setEntries(hydrated);
    return { hydrated, allJobs };
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const { hydrated } = await refresh();
      if (cancelled) return;

      // Auto-resume polling for any in-flight Lambda renders (e.g. page was reloaded).
      for (const entry of hydrated) {
        if (
          entry.kind === "lambda" &&
          entry.renderId &&
          entry.bucketName &&
          !entry.downloadUrl &&
          entry.status !== "completed" &&
          !pollingRef.current.has(entry.id)
        ) {
          pollingRef.current.add(entry.id);
          void resumePolling(entry);
        }
      }

      // Fetch cloud renders and merge them into local history first, then surface
      // any remaining orphans.
      setCloudLoading(true);
      try {
        const cloud = await fetchCloudRenders();
        if (cancelled) return;
        const { mergedLocal, orphans } = mergeCloudIntoEntries(hydrated, cloud);
        setEntries(mergedLocal);
        mergedLocal.forEach((entry) => saveJob(entry));
        setCloudOnly(orphans);
      } catch (e: any) {
        console.error("[completed-dialog] list cloud renders failed", e);
      } finally {
        if (!cancelled) setCloudLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project.id]);

  const resumePolling = async (entry: RenderJob) => {
    if (!entry.renderId || !entry.bucketName) return;
    try {
      while (true) {
        const p = await pollProgress({
          data: { renderId: entry.renderId, bucketName: entry.bucketName },
        });
        const pct = Math.round((p.overallProgress || 0) * 100);
        const next: RenderJob = { ...entry, progress: pct, status: "rendering" };
        saveJob(next);
        setEntries((current) =>
          current.map((it) =>
            it.id === entry.id ? { ...it, progress: pct, status: "rendering" } : it,
          ),
        );
        if (p.done && p.outputFile) {
          const done: RenderJob = {
            ...next,
            status: "completed",
            progress: 100,
            completedAt: Date.now(),
            downloadUrl: p.outputFile,
          };
          saveJob(done);
          setEntries((current) => current.map((it) => (it.id === entry.id ? done : it)));
          toast.success("Render complete");
          break;
        }
        if (p.fatalErrorEncountered && !p.outputFile) {
          const failed: RenderJob = {
            ...next,
            status: "failed",
            error: p.errors[0]?.message || "Lambda render failed",
          };
          saveJob(failed);
          setEntries((current) => current.map((it) => (it.id === entry.id ? failed : it)));
          toast.error(`Render failed: ${failed.error}`);
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (e: any) {
      console.error("[completed-dialog] resume polling failed", e);
    } finally {
      pollingRef.current.delete(entry.id);
    }
  };

  const completed = useMemo(
    () => entries.sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt)),
    [entries],
  );

  const handleDownload = async (entry: RenderJob) => {
    setBusyId(entry.id);
    try {
      const ext = entry.fileFormat || (entry.kind === "lambda" ? "mp4" : "webm");
      const filename = `${(entry.projectName || "render").trim() || "render"}.${ext}`;
      const hydratedLocalUrl = entry.localAsset?.url || null;
      const storedHref =
        entry.kind === "lambda"
          ? entry.downloadUrl || hydratedLocalUrl
          : hydratedLocalUrl || entry.downloadUrl || (await getAssetDownloadUrl(entry.localAsset));

      if (!storedHref) {
        console.log("[render-download] missing url", {
          entryId: entry.id,
          filename,
          kind: entry.kind,
        });
        toast.error("File is not available yet");
        return;
      }

      let href = storedHref;
      const isRemote = /^https?:/i.test(storedHref);

      if (entry.kind === "lambda" && isRemote) {
        href = await getFreshDownloadUrl({ data: { url: storedHref, filename } });
      }

      console.log("[render-download] trigger", {
        entryId: entry.id,
        filename,
        storedUrl: storedHref,
        finalUrl: href,
        kind: entry.kind,
      });
      triggerDownload(href, filename, isRemote);
    } catch (error) {
      console.error("[render-download] failed", { entryId: entry.id, error });
      toast.error("Download failed. Please try again.");
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
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-4" /> Completed renders
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs text-muted-foreground">
          Finished AWS Lambda renders and browser recordings stay here so you can re-download them
          anytime.
        </div>

        {completed.length === 0 && cloudOnly.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {cloudLoading ? "Loading cloud renders…" : "No completed renders yet."}
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
                  <div
                    key={entry.id}
                    className="rounded-lg border border-border bg-elevated/30 p-3 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="truncate text-sm font-medium text-foreground">
                            {(entry.projectName || "Untitled").trim() || "Untitled"}.{ext}
                          </span>
                          {available ? (
                            <Badge variant="secondary">Ready</Badge>
                          ) : (
                            <Badge variant="outline">
                              {processing ? `${entry.progress || 0}%` : "Processing"}
                            </Badge>
                          )}
                          <Badge variant="outline" className="gap-1">
                            {isLambda ? (
                              <Cloud className="size-3" />
                            ) : (
                              <Circle className="size-3" />
                            )}
                            {isLambda ? "AWS Render" : "Browser Recording"}
                          </Badge>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <Clock3 className="size-3.5" />{" "}
                            {formatDate(entry.completedAt || entry.createdAt)}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <HardDrive className="size-3.5" /> {formatSize(entry.sizeBytes)}
                          </span>
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

              {cloudOnly.length > 0 && (
                <div className="pt-2">
                  <div className="px-1 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Other cloud renders ({cloudOnly.length})
                  </div>
                  <div className="space-y-3">
                    {cloudOnly.map((entry) => {
                      const ext = entry.fileFormat || "mp4";
                      return (
                        <div
                          key={entry.id}
                          className="rounded-lg border border-border bg-elevated/20 p-3 space-y-3"
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="truncate text-sm font-medium text-foreground">
                                {entry.projectName}.{ext}
                              </span>
                              <Badge variant="secondary">Ready</Badge>
                              <Badge variant="outline" className="gap-1">
                                <Cloud className="size-3" /> S3
                              </Badge>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                              <span className="inline-flex items-center gap-1">
                                <Clock3 className="size-3.5" /> {formatDate(entry.completedAt)}
                              </span>
                              <span className="inline-flex items-center gap-1">
                                <HardDrive className="size-3.5" /> {formatSize(entry.sizeBytes)}
                              </span>
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            className="w-full gap-2"
                            disabled={busyId === entry.id}
                            onClick={() => void handleDownload(entry)}
                          >
                            <Download className="size-4" /> Download
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
