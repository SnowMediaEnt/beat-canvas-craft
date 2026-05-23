import { useState, type ReactNode } from "react";
import { PRESETS } from "@/lib/visualizer/presets";
import { PRESET_BACKGROUNDS, presetBackgroundRef, PRESET_BG_PREFIX, COLOR_BG_PREFIX, solidColorBackgroundRef } from "@/lib/visualizer/backgrounds";
import { PACKAGES, applyPackage } from "@/lib/visualizer/packages";
import type { Project } from "@/lib/project/types";
import { UploadField } from "./UploadField";
import { TranscriptionStatus } from "./TranscriptionStatus";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

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

function Section({ title, defaultOpen = true, count, children }: { title: string; defaultOpen?: boolean; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-3">
      <CollapsibleTrigger className="w-full flex items-center justify-between group">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">
          {title}{count != null && <span className="ml-2 text-[10px] text-muted-foreground/70 normal-case font-normal">{count}</span>}
        </h3>
        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function LeftPanel({ project, update }: Props) {
  return (
    <aside className="w-72 shrink-0 panel rounded-xl overflow-hidden flex flex-col">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">
          <Section title="Assets" defaultOpen>
            <UploadField label="Audio" accept="audio/*" value={project.audio}
              onChange={(a) => update(p => ({ ...p, audio: a }))} />
            <TranscriptionStatus audio={project.audio} />
            <UploadField label="Logo" accept="image/png,image/svg+xml,image/jpeg" value={project.logo}
              onChange={(a) => update(p => ({ ...p, logo: a }))} />

            <UploadField label="Background" accept="image/*,video/*" value={project.background}
              onChange={(a) => update(p => ({ ...p, background: a }))} />
          </Section>

          <Separator />

          <Section title="Themes" count={PACKAGES.length} defaultOpen={false}>
            <p className="text-[11px] text-muted-foreground -mt-1">Background + color palette only — pick an equalizer below to combine.</p>
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
                    <div className="absolute inset-x-0 bottom-0 p-1.5">
                      <div className="text-[11px] font-medium text-white truncate">{pkg.name}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </Section>

          <Separator />

          <Section title="Background Library" count={PRESET_BACKGROUNDS.length + 2} defaultOpen={false}>
            <div className="grid grid-cols-3 gap-1.5">
              {/* None / Black */}
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

              {/* Solid color picker */}
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

          <Separator />

          <Section title="Equalizer" count={PRESETS.length} defaultOpen>
            <p className="text-[11px] text-muted-foreground -mt-1">Choose the visualizer style — works with any theme above.</p>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map(p => (
                <button
                  key={p.id}
                  onClick={() => update(pr => ({ ...pr, visualizer: { ...pr.visualizer, presetId: p.id } }))}
                  className={cn(
                    "text-left px-2.5 py-2 rounded-lg text-xs border transition-all",
                    project.visualizer.presetId === p.id
                      ? "border-primary bg-primary/10 text-foreground shadow-[0_0_0_1px_var(--color-primary)]"
                      : "border-border bg-elevated/40 hover:bg-elevated text-foreground/80"
                  )}
                >
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{p.category}</div>
                </button>
              ))}
            </div>
          </Section>
        </div>
      </ScrollArea>
    </aside>
  );
}
