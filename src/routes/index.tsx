import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Plus, Music2, Sparkles, Trash2, Copy, Play } from "lucide-react";
import { useProjects, newProject, saveProject, deleteProject, duplicateProject, listJobs } from "@/lib/project/store";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pulse — Music Visualizer Studio" },
      { name: "description", content: "Create cinematic, audio-reactive music visualizer videos with custom presets, lyrics, and effects." },
      { property: "og:title", content: "Pulse — Music Visualizer Studio" },
      { property: "og:description", content: "Cinematic, audio-reactive visualizer videos with cloud rendering." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { projects, refresh } = useProjects();
  const nav = useNavigate();
  const [jobs, setJobs] = useState<ReturnType<typeof listJobs>>([]);
  useEffect(() => { setJobs(listJobs()); }, [projects]);

  const create = () => {
    const p = newProject();
    saveProject(p);
    nav({ to: "/editor/$projectId", params: { projectId: p.id } });
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-border/60 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5 group">
            <div className="size-9 rounded-lg bg-gradient-to-br from-primary to-accent grid place-items-center glow-ring">
              <Sparkles className="size-4 text-primary-foreground" />
            </div>
            <div>
              <div className="font-display font-bold text-lg leading-none">Pulse</div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Visualizer Studio</div>
            </div>
          </Link>
          <Button onClick={create} className="gap-2 bg-gradient-to-r from-primary to-accent text-primary-foreground hover:opacity-90">
            <Plus className="size-4" /> New Project
          </Button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-10 space-y-12">
        <section className="space-y-3">
          <h1 className="text-5xl md:text-6xl font-display font-bold tracking-tight">
            Make music <span className="text-gradient">move</span>.
          </h1>
          <p className="text-muted-foreground max-w-xl">
            Upload a track, drop in a logo, choose from 20 reactive presets and export cinematic visualizer videos
            ready for YouTube, Reels, and TikTok.
          </p>
        </section>

        <section>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-xl font-display font-semibold">Recent projects</h2>
            <span className="text-xs text-muted-foreground">{projects.length} total</span>
          </div>

          {projects.length === 0 ? (
            <Card className="panel p-12 text-center">
              <Music2 className="size-10 mx-auto mb-3 text-muted-foreground" />
              <p className="text-muted-foreground mb-4">No projects yet — create your first visualizer.</p>
              <Button onClick={create} className="gap-2"><Plus className="size-4" /> New Project</Button>
            </Card>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map(p => (
                <Card key={p.id} className="panel group overflow-hidden hover:border-primary/50 transition-all">
                  <Link to="/editor/$projectId" params={{ projectId: p.id }} className="block">
                    <div className="aspect-video relative overflow-hidden"
                      style={{
                        background: `linear-gradient(135deg, ${p.visualizer.primary}33, ${p.visualizer.accent}33)`,
                      }}>
                      <div className="absolute inset-0 grid place-items-center">
                        <div className="size-16 rounded-full grid place-items-center backdrop-blur-sm bg-background/40 border border-border group-hover:scale-110 transition-transform">
                          <Play className="size-6 text-foreground" />
                        </div>
                      </div>
                    </div>
                  </Link>
                  <div className="p-4 space-y-2">
                    <div className="font-medium truncate">{p.name}</div>
                    <div className="text-xs text-muted-foreground flex items-center justify-between">
                      <span>{p.aspectRatio}</span>
                      <span>{new Date(p.updatedAt).toLocaleDateString()}</span>
                    </div>
                    <div className="flex gap-1 pt-1">
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={(e) => { e.preventDefault(); duplicateProject(p.id); refresh(); }}>
                        <Copy className="size-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 hover:text-destructive" onClick={(e) => { e.preventDefault(); deleteProject(p.id); refresh(); }}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>

        {jobs.length > 0 && (
          <section>
            <h2 className="text-xl font-display font-semibold mb-4">Render history</h2>
            <Card className="panel divide-y divide-border">
              {jobs.slice(0, 8).map(j => (
                <div key={j.id} className="p-4 flex items-center justify-between text-sm">
                  <div>
                    <div className="font-medium">{j.projectName}</div>
                    <div className="text-xs text-muted-foreground">{j.config.resolution} · {j.config.fps}fps · {j.aspectRatio}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-xs px-2 py-1 rounded-md ${j.status === "completed" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>{j.status}</span>
                    {j.downloadUrl && <a href={j.downloadUrl} download className="text-xs text-primary hover:underline">Download</a>}
                  </div>
                </div>
              ))}
            </Card>
          </section>
        )}
      </main>
    </div>
  );
}
