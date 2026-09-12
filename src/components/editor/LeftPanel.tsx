import { useMemo, useState, useRef, useEffect, type ReactNode } from "react";
import { PRESETS, presetCategories } from "@/lib/visualizer/presets";
import { PRESET_BACKGROUNDS, presetBackgroundRef, PRESET_BG_PREFIX, COLOR_BG_PREFIX, solidColorBackgroundRef } from "@/lib/visualizer/backgrounds";
import { PACKAGES, applyPackage } from "@/lib/visualizer/packages";
import type { Project } from "@/lib/project/types";
import { UploadField } from "./UploadField";
import { TranscriptionStatus } from "./TranscriptionStatus";
import { PresetThumb } from "./PresetThumb";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Search, Shuffle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface Props {
  project: Project;
  update: (u: (p: Project) => Project) => void;
}

const RATIOS = [
  { value: "16:9", label: "16:9 YouTube" },
  { value: "1:1", label: "1:1 Square" },
  { value: "9:16", label: "9:16 Reels" },
  { value: "4:5", label: "4:5 Feed" },
] as const;

function Section({ title, defaultOpen = true, count, action, children }: { title: string; defaultOpen?: boolean; count?: number; action?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <CollapsibleTrigger className="flex-1 flex items-center justify-between group min-w-0">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors truncate">
            {title}{count != null && <span className="ml-2 text-[10px] text-muted-foreground/70 normal-case font-normal">{count}</span>}
          </h3>
          <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform shrink-0", open && "rotate-180")} />
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsibleContent className="space-y-3 data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function LeftPanel({ project, update }: Props) {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 288;
    const saved = Number(localStorage.getItem("leftPanelWidth"));
    return saved >= 240 && saved <= 560 ? saved : 288;
  });
  const draggingRef = useRef(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All");
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const next = Math.min(560, Math.max(240, e.clientX - 12)); // 12 = outer padding
      setWidth(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("leftPanelWidth", String(width));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [width]);

  const categories = useMemo(() => ["All", ...presetCategories()], []);
  const visiblePresets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PRESETS.filter((p) => {
      if (category !== "All" && p.category !== category) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [query, category]);

  const shuffle = () => {
    const preset = PRESETS[Math.floor(Math.random() * PRESETS.length)];
    const pkg = PACKAGES[Math.floor(Math.random() * PACKAGES.length)];
    update((p) => {
      const themed = applyPackage(p, pkg);
      return { ...themed, visualizer: { ...themed.visualizer, presetId: preset.id } };
    });
    toast.message(`${preset.name} × ${pkg.name}`, { description: "Shuffled a new look. Hit again for another." });
  };

  return (
    <aside
      className="shrink-0 panel rounded-xl overflow-hidden flex flex-col relative w-full lg:w-[var(--lp-w)] max-h-[60vh] lg:max-h-none lg:order-first"
      style={{ ["--lp-w" as string]: `${width}px` } as React.CSSProperties}
    >

      <ScrollArea className="flex-1">
        <div className="p-4 pr-5 space-y-5">
          <Section title="Assets" defaultOpen>
            <UploadField label="Audio" accept="audio/*,.mp3,.m4a,.wav,.aac,.flac,.ogg,.oga,.opus,.aiff,.aif" value={project.audio}
              onChange={(a) => update(p => ({
                ...p,
                audio: a,
                // Seed the song title from the file name the first time.
                trackTitle: p.trackTitle || (a ? a.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() : p.trackTitle),
              }))} />
            <TranscriptionStatus audio={project.audio} />
            <div className="grid grid-cols-2 gap-1.5">
              <div className="space-y-1">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Song title</div>
                <Input
                  value={project.trackTitle ?? ""}
                  onChange={(e) => update(p => ({ ...p, trackTitle: e.target.value }))}
                  placeholder={project.name}
                  className="h-8 bg-elevated/60 text-xs"
                />
              </div>
              <div className="space-y-1">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Artist</div>
                <Input
                  value={project.trackArtist ?? ""}
                  onChange={(e) => update(p => ({ ...p, trackArtist: e.target.value }))}
                  placeholder="Optional"
                  className="h-8 bg-elevated/60 text-xs"
                />
              </div>
            </div>
            <UploadField label="Logo" accept="image/png,image/svg+xml,image/jpeg,image/webp" value={project.logo}
              onChange={(a) => update(p => ({ ...p, logo: a }))} />

            <UploadField label="Background" accept="image/*,video/*" value={project.background}
              onChange={(a) => update(p => ({ ...p, background: a }))} />
          </Section>

          <Separator />

          <Section
            title="Visualizer"
            count={PRESETS.length}
            defaultOpen
            action={
              <Button size="sm" variant="outline" className="h-7 px-2 gap-1.5 bg-elevated/60 text-xs shrink-0" onClick={shuffle} title="Random visualizer + theme">
                <Shuffle className="size-3.5" /> Shuffle
              </Button>
            }
          >
            <div className="relative">
              <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search visualizers…"
                className="h-8 pl-8 pr-7 bg-elevated/60 text-xs"
              />
              {query && (
                <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                    category === c ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
            {visiblePresets.length === 0 ? (
              <p className="text-[11px] text-muted-foreground py-4 text-center">No visualizers match “{query}”.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {visiblePresets.map(p => {
                  const active = project.visualizer.presetId === p.id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => update(pr => ({ ...pr, visualizer: { ...pr.visualizer, presetId: p.id } }))}
                      onMouseEnter={() => setHovered(p.id)}
                      onMouseLeave={() => setHovered((h) => (h === p.id ? null : h))}
                      onFocus={() => setHovered(p.id)}
                      onBlur={() => setHovered((h) => (h === p.id ? null : h))}
                      title={p.description ?? p.name}
                      className={cn(
                        "group text-left rounded-lg border overflow-hidden transition-all bg-black",
                        active
                          ? "border-primary shadow-[0_0_0_1px_var(--color-primary)]"
                          : "border-border hover:border-foreground/40",
                      )}
                    >
                      <PresetThumb presetId={p.id} cfg={project.visualizer} animate={hovered === p.id} />
                      <div className="px-2 py-1.5">
                        <div className="text-xs font-medium truncate">{p.name}</div>
                        <div className="text-[10px] text-muted-foreground truncate">{p.category}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Section>

          <Separator />

          <Section title="Themes" count={PACKAGES.length} defaultOpen={false}>
            <p className="text-[11px] text-muted-foreground -mt-1">Background + color palette only — combine with any visualizer above.</p>
            <div className="grid grid-cols-2 gap-2">
              {PACKAGES.map(pkg => {
                const bg = PRESET_BACKGROUNDS.find(b => b.id === pkg.backgroundId);
                const active = project.background?.id === `${PRESET_BG_PREFIX}${pkg.backgroundId}` &&
                  project.visualizer.primary.toLowerCase() === pkg.colors.primary.toLowerCase();
                return (
                  <button
                    key={pkg.id}
                    onClick={() => update(p => applyPackage(p, pkg))}
                    className={cn(
                      "group relative overflow-hidden rounded-lg border text-left aspect-video transition-all",
                      active ? "border-primary shadow-[0_0_0_1px_var(--color-primary)]" : "border-border hover:border-foreground/30"
                    )}
                  >
                    {bg && <img src={bg.url} alt={pkg.name} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
                    <div className="absolute inset-x-0 bottom-0 p-1.5 flex items-end justify-between gap-1">
                      <div className="text-[11px] font-medium text-white truncate">{pkg.name}</div>
                      <div className="flex gap-0.5 shrink-0">
                        {[pkg.colors.primary, pkg.colors.secondary, pkg.colors.accent].map((c) => (
                          <span key={c} className="size-2 rounded-full border border-white/40" style={{ background: c }} />
                        ))}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </Section>

          <Separator />

          <Section title="Background Library" count={PRESET_BACKGROUNDS.length + 2} defaultOpen={false}>
            <div className="grid grid-cols-3 gap-1.5">
              <button
                onClick={() => update(p => ({ ...p, background: undefined }))}
                title="None — solid black"
                className={cn(
                  "relative overflow-hidden rounded-md aspect-video border transition-all bg-black flex items-center justify-center",
                  !project.background ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/40"
                )}
              >
                <span className="text-[10px] font-medium text-white/80">None</span>
              </button>

              {(() => {
                const isColor = project.background?.id.startsWith(COLOR_BG_PREFIX);
                const currentHex = isColor
                  ? project.background!.id.slice(COLOR_BG_PREFIX.length)
                  : "#7c3aed";
                return (
                  <label
                    title="Pick a solid color"
                    className={cn(
                      "relative overflow-hidden rounded-md aspect-video border transition-all cursor-pointer flex items-center justify-center",
                      isColor ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/40"
                    )}
                    style={{ backgroundColor: isColor ? currentHex : undefined,
                             backgroundImage: isColor ? undefined : "linear-gradient(135deg,#ef4444,#f59e0b,#10b981,#3b82f6,#8b5cf6,#ec4899)" }}
                  >
                    <span className="text-[10px] font-medium text-white drop-shadow">Color</span>
                    <input
                      type="color"
                      value={currentHex}
                      onChange={(e) => update(p => ({ ...p, background: solidColorBackgroundRef(e.target.value) }))}
                      className="absolute inset-0 opacity-0 cursor-pointer"
                    />
                  </label>
                );
              })()}

              {PRESET_BACKGROUNDS.map(bg => {
                const active = project.background?.id === `${PRESET_BG_PREFIX}${bg.id}`;
                return (
                  <button
                    key={bg.id}
                    onClick={() => update(p => ({ ...p, background: presetBackgroundRef(bg.id) }))}
                    title={`${bg.name} · ${bg.mood}`}
                    className={cn(
                      "relative overflow-hidden rounded-md aspect-video border transition-all",
                      active ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/40"
                    )}
                  >
                    <img src={bg.url} alt={bg.name} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                  </button>
                );
              })}
            </div>
          </Section>

          <Separator />

          <Section title="Canvas" defaultOpen>
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">Aspect ratio</div>
              <Select value={project.aspectRatio} onValueChange={(v) => update(p => ({ ...p, aspectRatio: v as Project["aspectRatio"] }))}>
                <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RATIOS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </Section>
        </div>
      </ScrollArea>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={(e) => {
          e.preventDefault();
          draggingRef.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        onDoubleClick={() => setWidth(288)}
        title="Drag to resize · double-click to reset"
        className="hidden lg:block absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 transition-colors"
      />
    </aside>
  );
}
