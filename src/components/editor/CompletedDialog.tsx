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
  ExternalLink,
} from "lucide-react";
import type { Project, RenderJob } from "@/lib/project/types";
import { deleteJob, listJobsFromStorage, saveJob } from "@/lib/project/store";
import { hydrateAsset, deleteAsset, getAssetDownloadUrl } from "@/lib/project/assets";
import { useServerFn } from "@tanstack/react-start";
import { getLambdaProgress, deleteLambdaRender } from "@/lib/render/lambda.functions";
import { listLambdaRenders, type CloudRender } from "@/lib/render/list-renders.functions";
import { getStoredAccessCode } from "@/lib/render/access-code";
import { toast } from "sonner";
import { buildProxyDownloadUrl, triggerDownload } from "@/lib/render/download";

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

const MAX_POLL_FAILURES = 6;

export function CompletedDialog({ project }: Props) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<RenderJob[]>([]);
  const [cloudOnly, setCloudOnly] = useState<RenderJob[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const pollProgress = useServerFn(getLambdaProgress);
  const fetchCloudRenders = useServerFn(listLambdaRenders);
  const deleteCloud = useServerFn(deleteLambdaRender);

  const pollingRef = useRef<Set<string>>(new Set());
  const accessCode = getStoredAccessCode();

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
        downloadUrl: cloudMatch.url,
        bucketName: entry.bucketName || cloudMatch.bucketName,
        region: entry.region || cloudMatch.region,
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
        region: c.region,
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

      // Auto-resume polling for in-flight Lambda renders (e.g. after a reload
      // or after "Stop watching" in the export dialog). Failed/cancelled jobs
      // are left alone.
      for (const entry of hydrated) {
        if (
          entry.kind === "lambda" &&
          entry.renderId &&
          entry.bucketName &&
          !entry.downloadUrl &&
          (entry.status === "queued" || entry.status === "rendering") &&
          !pollingRef.current.has(entry.id)
        ) {
          pollingRef.current.add(entry.id);
          void resumePolling(entry);
        }
      }

      // Cloud listing needs the access code (it enumerates the render bucket).
      if (!accessCode) return;
      setCloudLoading(true);
      try {
        const cloud = await fetchCloudRenders({ data: { accessCode } });
        if (cancelled) return;
        const { mergedLocal, orphans } = mergeCloudIntoEntries(hydrated, cloud);
        setEntries(mergedLocal);
        mergedLocal.forEach((entry) => saveJob(entry));
        setCloudOnly(orphans);
      } catch (e) {
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
    const STALL_MS = 6 * 60 * 1000;
    let lastPct = -1;
    let lastPctAt = Date.now();
    let failures = 0;
    try {
      while (true) {
        let p: Awaited<ReturnType<typeof pollProgress>>;
        try {
          p = await pollProgress({ data: { renderId: entry.renderId, bucketName: entry.bucketName } });
          failures = 0;
        } catch (e) {
          failures += 1;
          if (failures >= MAX_POLL_FAILURES) throw e;
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }
        const pct = Math.round((p.overallProgress || 0) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          lastPctAt = Date.now();
        }
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
        if (Date.now() - lastPctAt > STALL_MS) {
          const failed: RenderJob = {
            ...next,
            status: "failed",
            error:
              "Render appears stuck: no progress for 6 minutes. AWS Lambda likely stalled — try a lower resolution/fps or a lighter preset.",
          };
          saveJob(failed);
          setEntries((current) => current.map((it) => (it.id === entry.id ? failed : it)));
          toast.error(`Render failed: ${failed.error}`);
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (e) {
      console.error("[completed-dialog] resume polling failed", e);
    } finally {
      pollingRef.current.delete(entry.id);
    }
  };

  const completed = useMemo(
    () => [...entries].sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt)),
    [entries],
  );

  const filenameFor = (entry: RenderJob) => {
    const ext = entry.fileFormat || (entry.kind === "lambda" ? "mp4" : "webm");
    return `${(entry.projectName || "render").trim() || "render"}.${ext}`;
  };

  const handleDownload = async (entry: RenderJob, viaProxy = false) => {
    setBusyId(entry.id);
    setInlineError(null);
    try {
      const filename = filenameFor(entry);
      const hydratedLocalUrl = entry.localAsset?.url || null;
      const href =
        entry.kind === "lambda"
          ? entry.downloadUrl || hydratedLocalUrl
          : hydratedLocalUrl || entry.downloadUrl || (await getAssetDownloadUrl(entry.localAsset));

      if (!href) {
        setInlineError("This file is not available yet.");
        toast.error("File is not available yet");
        return;
      }
      const finalHref = viaProxy && /^https?:/i.test(href) ? buildProxyDownloadUrl(href, filename) : href;
      triggerDownload(finalHref, filename);
    } catch (error) {
      console.error("[render-download] failed", { entryId: entry.id, error });
      setInlineError("Download failed. Please try again.");
      toast.error("Download failed. Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (entry: RenderJob, alsoCloud: boolean) => {
    setBusyId(entry.id);
    try {
      if (alsoCloud && entry.kind === "lambda" && entry.renderId && entry.bucketName && accessCode) {
        await deleteCloud({ data: { renderId: entry.renderId, bucketName: entry.bucketName, accessCode } });
      }
      await deleteAsset(entry.localAsset);
      deleteJob(entry.id);
      setEntries((current) => current.filter((item) => item.id !== entry.id));
      setCloudOnly((current) => current.filter((item) => item.id !== entry.id));
      toast.success(alsoCloud ? "Render deleted from AWS" : "Entry removed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2" title="Completed renders" aria-label="Completed renders">
          <CheckCircle2 className="size-4" /> <span className="hidden sm:inline">Completed</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="panel max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-4" /> Completed renders
          </DialogTitle>
        </DialogHeader>

        {inlineError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {inlineError}
          </div>
        )}

        <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs text-muted-foreground">
          Finished AWS Lambda renders and browser recordings stay here so you can re-download them
          anytime. Renders still running on AWS keep updating here even if you closed the export window.
          {!accessCode && " Enter your access code in Export → Lambda Render to also see renders stored in your AWS bucket."}
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
                const available = Boolean(entry.localAsset?.url || entry.downloadUrl);
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
                          ) : entry.status === "failed" ? (
                            <Badge variant="destructive">Failed</Badge>
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
                          <span>{entry.config.resolution} · {entry.config.fps}fps · {entry.aspectRatio}</span>
                        </div>
                        {entry.error && <p className="text-xs text-destructive">{entry.error}</p>}
                      </div>
                    </div>

                    <div className="flex gap-2 flex-wrap">
                      <Button
                        variant="outline"
                        className="flex-1 gap-2"
                        disabled={!available || busyId === entry.id}
                        onClick={() => void handleDownload(entry)}
                      >
                        <Download className="size-4" /> Download
                      </Button>
                      {isLambda && entry.downloadUrl && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-xs"
                          title="Use if the download opens in a tab instead of saving"
                          disabled={busyId === entry.id}
                          onClick={() => void handleDownload(entry, true)}
                        >
                          <ExternalLink className="size-3.5" /> Alt link
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        className="gap-2"
                        disabled={busyId === entry.id}
                        onClick={() => void handleDelete(entry, false)}
                      >
                        <Trash2 className="size-4" /> Remove
                      </Button>
                      {isLambda && entry.renderId && accessCode && available && (
                        <Button
                          variant="ghost"
                          className="gap-2 text-destructive hover:text-destructive"
                          disabled={busyId === entry.id}
                          title="Delete the MP4 from your AWS bucket too"
                          onClick={() => { if (window.confirm("Delete this render from AWS S3? This cannot be undone.")) void handleDelete(entry, true); }}
                        >
                          <Cloud className="size-4" /> Delete from AWS
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}

              {cloudOnly.length > 0 && (
                <div className="pt-2">
                  <div className="px-1 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Other renders in your AWS bucket ({cloudOnly.length})
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
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              className="flex-1 gap-2"
                              disabled={busyId === entry.id}
                              onClick={() => void handleDownload(entry)}
                            >
                              <Download className="size-4" /> Download
                            </Button>
                            <Button
                              variant="ghost"
                              className="gap-2 text-destructive hover:text-destructive"
                              disabled={busyId === entry.id}
                              onClick={() => { if (window.confirm("Delete this render from AWS S3? This cannot be undone.")) void handleDelete(entry, true); }}
                            >
                              <Trash2 className="size-4" /> Delete
                            </Button>
                          </div>
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
