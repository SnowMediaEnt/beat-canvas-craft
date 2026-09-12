import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Activity, AlertTriangle, CheckCircle2, Copy, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getRenderHealth, type HealthCheck, type RenderHealth } from "@/lib/render/health.functions";
import { getStoredAccessCode } from "@/lib/render/access-code";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

function StatusIcon({ status }: { status: HealthCheck["status"] }) {
  if (status === "ok") return <CheckCircle2 className="size-3.5 text-emerald-400 shrink-0" />;
  if (status === "warn") return <AlertTriangle className="size-3.5 text-amber-400 shrink-0" />;
  if (status === "fail") return <XCircle className="size-3.5 text-red-400 shrink-0" />;
  return <Activity className="size-3.5 text-muted-foreground shrink-0" />;
}

/**
 * "Is AWS actually connected?" — one click runs read-only checks on the
 * server (credentials, Remotion settings, Lambda function, deployed bundle,
 * S3 access) and explains what to do about anything red.
 */
export function RenderHealthPanel({ compact = false, accessCode }: { compact?: boolean; accessCode?: string }) {
  const check = useServerFn(getRenderHealth);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<RenderHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const code = (accessCode ?? "").trim() || getStoredAccessCode();
    if (!code) {
      setError("Enter your access code above first — the AWS report is owner-only.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await check({ data: { accessCode: code } });
      setHealth(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Health check failed");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Couldn't copy — select the text manually");
    }
  };

  const failures = health?.checks.filter((c) => c.status === "fail").length ?? 0;
  const warnings = health?.checks.filter((c) => c.status === "warn").length ?? 0;

  return (
    <div className="rounded-lg border border-border bg-elevated/40 p-3 text-xs space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-foreground/90">
          <Activity className="size-3.5" /> AWS connection
          {health && (
            <span
              className={cn(
                "ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
                failures ? "bg-red-500/15 text-red-300" : warnings ? "bg-amber-500/15 text-amber-200" : "bg-emerald-500/15 text-emerald-300",
              )}
            >
              {failures ? `${failures} problem${failures === 1 ? "" : "s"}` : warnings ? "connected (warnings)" : "connected"}
            </span>
          )}
        </div>
        <Button size="sm" variant="outline" className="h-7 px-2 gap-1.5 bg-background/40" onClick={run} disabled={busy}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Activity className="size-3" />}
          {health ? "Re-check" : "Check"}
        </Button>
      </div>

      {!health && !error && !compact && (
        <p className="text-muted-foreground">
          Verifies your AWS keys, the Remotion Lambda function, the deployed visualizer bundle and S3 access — without starting a render.
        </p>
      )}

      {error && <p className="text-destructive">{error}</p>}

      {health && (
        <ul className="space-y-1.5">
          {health.checks.map((c) => (
            <li key={c.id} className="flex gap-2">
              <StatusIcon status={c.status} />
              <div className="min-w-0">
                <div className="text-foreground/90 font-medium">{c.label}</div>
                <div className="text-muted-foreground break-words leading-relaxed">{c.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {health?.deployCommand && (
        <div className="rounded bg-background/60 p-2 space-y-1">
          <p className="text-[10px] text-muted-foreground/80">
            After changing presets, effects or colors in the code, redeploy the bundle so Lambda renders the new version (run on a machine with your AWS keys):
          </p>
          <div className="flex items-start gap-1">
            <code className="flex-1 block font-mono text-[10px] text-foreground/90 bg-black/30 rounded px-1.5 py-1 select-all break-all">
              {health.deployCommand}
            </code>
            <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={() => void copy(health.deployCommand!)} title="Copy command">
              <Copy className="size-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
