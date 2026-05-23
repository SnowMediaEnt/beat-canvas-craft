import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useProject } from "@/lib/project/store";
import { LeftPanel } from "@/components/editor/LeftPanel";
import { RightPanel } from "@/components/editor/RightPanel";
import { VisualizerCanvas } from "@/components/editor/VisualizerCanvas";
import { Transport } from "@/components/editor/Transport";
import { ExportDialog } from "@/components/editor/ExportDialog";
import { RecordingsDialog } from "@/components/editor/RecordingsDialog";
import { AudioEngine } from "@/lib/visualizer/audioEngine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Sparkles } from "lucide-react";

export const Route = createFileRoute("/editor/$projectId")({
  head: ({ params }) => ({
    meta: [
      { title: `Editor · Pulse` },
      { name: "description", content: `Editing visualizer project ${params.projectId}` },
    ],
  }),
  component: EditorPage,
});

function EditorPage() {
  const { projectId } = Route.useParams();
  const { project, update, loaded } = useProject(projectId);
  const audioRef = useRef<HTMLAudioElement>(null);
  const engineRef = useRef<AudioEngine | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nav = useNavigate();

  // Log codec support once so we can see what Safari reports
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    console.log("[audio] canPlayType audio/mpeg:", el.canPlayType("audio/mpeg"));
    console.log("[audio] canPlayType audio/mp4:", el.canPlayType("audio/mp4"));
    console.log("[audio] canPlayType audio/wav:", el.canPlayType("audio/wav"));
  }, []);

  if (!loaded) {
    return <div className="min-h-screen grid place-items-center text-muted-foreground text-sm">Loading project…</div>;
  }

  if (!project) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="text-center space-y-3">
          <p className="text-muted-foreground">Project not found.</p>
          <Link to="/"><Button variant="outline">Back to dashboard</Button></Link>
        </div>
      </div>
    );
  }


  const togglePlay = async () => {
    const el = audioRef.current;
    if (!el || !project.audio) return;
    if (!engineRef.current) {
      try { engineRef.current = new AudioEngine(el, project.visualizer.smoothing); } catch (err) { console.warn("[audio] engine init failed:", err); }
    }
    await engineRef.current?.resume();

    if (!el.paused) { el.pause(); return; }

    // Wait for the element to be decoded enough to play through (Safari otherwise
    // throws "The operation is not supported" when play() is called too early).
    if (el.readyState < 3) {
      console.log("[audio] not ready (readyState=" + el.readyState + "), waiting for canplaythrough");
      await new Promise<void>((resolve, reject) => {
        const onReady = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error("Audio failed to load")); };
        const cleanup = () => {
          el.removeEventListener("canplaythrough", onReady);
          el.removeEventListener("loadeddata", onReady);
          el.removeEventListener("error", onError);
        };
        el.addEventListener("canplaythrough", onReady, { once: true });
        el.addEventListener("loadeddata", onReady, { once: true });
        el.addEventListener("error", onError, { once: true });
        // Safety: don't hang forever
        setTimeout(() => { cleanup(); resolve(); }, 5000);
      });
    }

    try {
      await el.play();
    } catch (err) {
      const mediaErr = el.error;
      console.error("[audio] play() rejected:", err, {
        mediaErrorCode: mediaErr?.code,
        mediaErrorMessage: mediaErr?.message,
        src: el.currentSrc?.slice(0, 80),
        readyState: el.readyState,
        networkState: el.networkState,
      });
      const codeLabel = mediaErr
        ? ["", "ABORTED", "NETWORK", "DECODE", "SRC_NOT_SUPPORTED"][mediaErr.code] || `code ${mediaErr.code}`
        : "unknown";
      const { toast } = await import("sonner");
      toast.error(`Playback failed (${codeLabel}). ${mediaErr?.message || (err instanceof Error ? err.message : "")}`);
    }
  };

  return (
    <div className="h-screen flex flex-col p-3 gap-3 overflow-hidden">
      <header className="panel rounded-xl px-4 py-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Button size="icon" variant="ghost" onClick={() => nav({ to: "/" })}><ArrowLeft className="size-4" /></Button>
          <div className="flex items-center gap-2">
            <div className="size-7 rounded-md bg-gradient-to-br from-primary to-accent grid place-items-center">
              <Sparkles className="size-3.5 text-primary-foreground" />
            </div>
            <Input
              value={project.name}
              onChange={(e) => update(p => ({ ...p, name: e.target.value }))}
              className="h-8 bg-transparent border-0 focus-visible:ring-1 focus-visible:ring-primary w-64 font-medium"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground hidden md:inline">Auto-saved</span>
          <RecordingsDialog project={project} />
          <ExportDialog project={project} update={update} canvasRef={canvasRef} audioRef={audioRef} engineRef={engineRef} />
        </div>
      </header>

      <div className="flex-1 flex gap-3 min-h-0">
        <LeftPanel project={project} update={update} />
        <main className="flex-1 panel rounded-xl overflow-hidden min-w-0">
          <VisualizerCanvas project={project} audioRef={audioRef} engineRef={engineRef} canvasRef={canvasRef} />
        </main>
        <RightPanel project={project} update={update} />
      </div>

      <Transport project={project} update={update} audioRef={audioRef} onPlayToggle={togglePlay} />

      <audio ref={audioRef} className="hidden" />
    </div>
  );
}
