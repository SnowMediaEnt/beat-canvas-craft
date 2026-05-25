import type { Project } from "@/lib/project/types";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SliderField, ColorField } from "./SliderField";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

interface Props { project: Project; update: (u: (p: Project) => Project) => void }

const setV = (update: Props["update"], k: keyof Project["visualizer"]) => (v: number | string) =>
  update(p => ({ ...p, visualizer: { ...p.visualizer, [k]: v } }));

export function RightPanel({ project, update }: Props) {
  const V = project.visualizer; const L = project.lyrics; const E = project.effects;
  return (
    <aside className="w-80 shrink-0 panel rounded-xl overflow-hidden flex flex-col">
      <Tabs defaultValue="style" className="flex-1 flex flex-col">
        <TabsList className="grid grid-cols-4 m-2 bg-elevated/60">
          <TabsTrigger value="style">Style</TabsTrigger>
          <TabsTrigger value="motion">Motion</TabsTrigger>
          <TabsTrigger value="effects">FX</TabsTrigger>
          <TabsTrigger value="lyrics">Lyrics</TabsTrigger>
        </TabsList>

        <ScrollArea className="flex-1">
          <TabsContent value="style" className="p-4 pt-2 space-y-4 mt-0">
            <Section title="Colors">
              <ColorField label="Primary" value={V.primary} onChange={(v) => setV(update, "primary")(v)} />
              <ColorField label="Secondary" value={V.secondary} onChange={(v) => setV(update, "secondary")(v)} />
              <ColorField label="Accent" value={V.accent} onChange={(v) => setV(update, "accent")(v)} />
              <ColorField label="Glow" value={V.glow} onChange={(v) => setV(update, "glow")(v)} />
              <ColorField label="Overlay" value={V.overlay} onChange={(v) => setV(update, "overlay")(v)} />
              <SliderField label="Overlay opacity" value={V.overlayOpacity} onChange={(v) => setV(update, "overlayOpacity")(v)} />
            </Section>

            <Section title="Visualizer">
              <SliderField label="Size" value={V.size} min={0.2} max={2.5} onChange={(v) => setV(update, "size")(v)} />
              <SliderField label="Thickness" value={V.thickness} min={1} max={30} step={1} onChange={(v) => setV(update, "thickness")(v)} format={(n) => n.toFixed(0)} />
              <SliderField label="Glow intensity" value={V.glowIntensity} max={2} onChange={(v) => setV(update, "glowIntensity")(v)} />
              <SliderField label="Blur" value={V.blur} max={20} step={1} onChange={(v) => setV(update, "blur")(v)} format={(n) => `${n.toFixed(0)}px`} />
              <SliderField label="Position X" value={V.position.x} min={-1} max={1} onChange={(v) => update(p => ({ ...p, visualizer: { ...p.visualizer, position: { ...V.position, x: v } } }))} />
              <SliderField label="Position Y" value={V.position.y} min={-1} max={1} onChange={(v) => update(p => ({ ...p, visualizer: { ...p.visualizer, position: { ...V.position, y: v } } }))} />
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Blend mode</div>
                <Select value={V.blendMode} onValueChange={(v) => setV(update, "blendMode")(v)}>
                  <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(["source-over", "screen", "lighter", "overlay", "multiply", "color-dodge"] as const).map(m =>
                      <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </Section>

            <Section title="Logo">
              <SliderField label="Logo size" value={V.logoSize} max={1} onChange={(v) => setV(update, "logoSize")(v)} />
              <SliderField label="Logo X" value={V.logoPosition.x} min={-1} max={1} onChange={(v) => update(p => ({ ...p, visualizer: { ...p.visualizer, logoPosition: { ...V.logoPosition, x: v } } }))} />
              <SliderField label="Logo Y" value={V.logoPosition.y} min={-1} max={1} onChange={(v) => update(p => ({ ...p, visualizer: { ...p.visualizer, logoPosition: { ...V.logoPosition, y: v } } }))} />
            </Section>

            <Section title="Background">
              <SliderField label="Scale" value={V.backgroundScale} min={0.8} max={2} onChange={(v) => setV(update, "backgroundScale")(v)} />
              <SliderField label="Blur" value={V.backgroundBlur} max={40} step={1} onChange={(v) => setV(update, "backgroundBlur")(v)} format={(n) => `${n.toFixed(0)}px`} />
              <ColorField label="Tint" value={V.backgroundTint} onChange={(v) => setV(update, "backgroundTint")(v)} />
              <SliderField label="Tint opacity" value={V.backgroundTintOpacity} onChange={(v) => setV(update, "backgroundTintOpacity")(v)} />
            </Section>
          </TabsContent>

          <TabsContent value="motion" className="p-4 pt-2 space-y-4 mt-0">
            <Section title="Audio Reactivity">
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Bands (equalizer)</div>
                <Select value={String(V.bandCount)} onValueChange={(v) => setV(update, "bandCount")(Number(v))}>
                  <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[32, 48, 64, 96, 128, 192, 256].map(n => <SelectItem key={n} value={String(n)}>{n} bands</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <SliderField label="Sensitivity" value={V.sensitivity} max={3} onChange={(v) => setV(update, "sensitivity")(v)} />
              <SliderField label="Bass" value={V.bassSensitivity} max={3} onChange={(v) => setV(update, "bassSensitivity")(v)} />
              <SliderField label="Mids" value={V.midSensitivity} max={3} onChange={(v) => setV(update, "midSensitivity")(v)} />
              <SliderField label="Treble" value={V.trebleSensitivity} max={3} onChange={(v) => setV(update, "trebleSensitivity")(v)} />
              <SliderField label="Smoothing" value={V.smoothing} onChange={(v) => setV(update, "smoothing")(v)} />
            </Section>
            <Section title="Animation">
              <SliderField label="Speed" value={V.animationSpeed} min={0.1} max={3} onChange={(v) => setV(update, "animationSpeed")(v)} />
              <SliderField label="Rotation" value={V.rotation} min={-Math.PI} max={Math.PI} onChange={(v) => setV(update, "rotation")(v)} />
              <SliderField label="Movement" value={V.movement} onChange={(v) => setV(update, "movement")(v)} />
              <SliderField label="Shadow" value={V.shadow} onChange={(v) => setV(update, "shadow")(v)} />
              <SliderField label="Border" value={V.border} onChange={(v) => setV(update, "border")(v)} />
            </Section>
          </TabsContent>

          <TabsContent value="effects" className="p-4 pt-2 space-y-4 mt-0">
            <Section title="Particles">
              <Toggle label="Enable particles" value={E.particles.enabled} onChange={(v) => update(p => ({ ...p, effects: { ...p.effects, particles: { ...E.particles, enabled: v } } }))} />
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Type</div>
                <Select value={E.particles.type} onValueChange={(v) => update(p => ({ ...p, effects: { ...p.effects, particles: { ...E.particles, type: v as typeof E.particles.type } } }))}>
                  <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(["snow", "dust", "sparks", "bokeh", "lights"] as const).map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <SliderField label="Density" value={E.particles.density} min={0} max={200} step={1} onChange={(v) => update(p => ({ ...p, effects: { ...p.effects, particles: { ...E.particles, density: v } } }))} format={(n) => n.toFixed(0)} />
              <SliderField label="Speed" value={E.particles.speed} max={3} onChange={(v) => update(p => ({ ...p, effects: { ...p.effects, particles: { ...E.particles, speed: v } } }))} />
              <SliderField label="Opacity" value={E.particles.opacity} onChange={(v) => update(p => ({ ...p, effects: { ...p.effects, particles: { ...E.particles, opacity: v } } }))} />
              <SliderField label="Reactivity" value={E.particles.reactivity} max={2} onChange={(v) => update(p => ({ ...p, effects: { ...p.effects, particles: { ...E.particles, reactivity: v } } }))} />
              <ColorField label="Color" value={E.particles.color} onChange={(v) => update(p => ({ ...p, effects: { ...p.effects, particles: { ...E.particles, color: v } } }))} />
            </Section>
            <Section title="Atmosphere">
              <Toggle label="Beat flash" value={E.beatFlash} onChange={(v) => update(p => ({ ...p, effects: { ...p.effects, beatFlash: v } }))} />
              <Toggle label="Vignette" value={E.vignette} onChange={(v) => update(p => ({ ...p, effects: { ...p.effects, vignette: v } }))} />
              <Toggle label="Noise texture" value={E.noise} onChange={(v) => update(p => ({ ...p, effects: { ...p.effects, noise: v } }))} />
              <Toggle label="Lens flare" value={E.lensFlare} onChange={(v) => update(p => ({ ...p, effects: { ...p.effects, lensFlare: v } }))} />
              <Toggle label="Logo pulse" value={E.logoPulse} onChange={(v) => update(p => ({ ...p, effects: { ...p.effects, logoPulse: v } }))} />
              <Toggle label="Background pulse" value={E.backgroundPulse} onChange={(v) => update(p => ({ ...p, effects: { ...p.effects, backgroundPulse: v } }))} />
            </Section>
          </TabsContent>

          <TabsContent value="lyrics" className="p-4 pt-2 space-y-4 mt-0">
            <Toggle label="Enable lyrics" value={L.enabled} onChange={(v) => update(p => ({ ...p, lyrics: { ...p.lyrics, enabled: v } }))} />
            <Section title="Style">
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Position</div>
                <Select value={L.position} onValueChange={(v) => update(p => ({ ...p, lyrics: { ...p.lyrics, position: v as typeof L.position } }))}>
                  <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                  <SelectContent>{(["bottom", "center", "top", "left", "right"] as const).map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Style</div>
                <Select value={L.style} onValueChange={(v) => update(p => ({ ...p, lyrics: { ...p.lyrics, style: v as typeof L.style } }))}>
                  <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="subtitle">Subtitle</SelectItem><SelectItem value="karaoke">Karaoke</SelectItem></SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Font</div>
                <Select value={L.fontFamily} onValueChange={(v) => update(p => ({ ...p, lyrics: { ...p.lyrics, fontFamily: v } }))}>
                  <SelectTrigger className="h-9 bg-elevated/60"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {/* Restricted to system / Lambda-safe families. Lambda has no
                        Google Fonts installed, so Google-only families silently fell
                        back to a default at render time — diverging from the live
                        preview. Re-add families here only after bundling them via
                        loadFont() inside src/remotion/. */}
                    {["Arial","Helvetica","Times New Roman","Georgia","Courier New","Verdana","Trebuchet MS","Impact","Comic Sans MS"].map(f =>
                      <SelectItem key={f} value={f} style={{ fontFamily: `${f}, sans-serif` }}>{f}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <SliderField label="Font size" value={L.fontSize} min={16} max={120} step={1} onChange={(v) => update(p => ({ ...p, lyrics: { ...p.lyrics, fontSize: v } }))} format={(n) => `${n.toFixed(0)}px`} />
              <ColorField label="Color" value={L.color} onChange={(v) => update(p => ({ ...p, lyrics: { ...p.lyrics, color: v } }))} />
              <Toggle label="Outline" value={L.outline} onChange={(v) => update(p => ({ ...p, lyrics: { ...p.lyrics, outline: v } }))} />
              <Toggle label="Shadow" value={L.shadow} onChange={(v) => update(p => ({ ...p, lyrics: { ...p.lyrics, shadow: v } }))} />
              <Toggle label="Glow" value={L.glow} onChange={(v) => update(p => ({ ...p, lyrics: { ...p.lyrics, glow: v } }))} />
              <Toggle label="Fade" value={L.fade} onChange={(v) => update(p => ({ ...p, lyrics: { ...p.lyrics, fade: v } }))} />
            </Section>
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
      <div className="space-y-2.5">{children}</div>
      <Separator />
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}
