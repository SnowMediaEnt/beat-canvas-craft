import { useState } from "react";
import type { ParticleTrigger, ParticleType, Project } from "@/lib/project/types";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SliderField, ColorField } from "./SliderField";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useServerFn } from "@tanstack/react-start";
import { generateVisualizerFromPrompt } from "@/lib/visualizer/ai-generate.functions";
import { LYRIC_FONTS, type LyricFontCategory } from "@/lib/visualizer/fonts";
import { BAND_COUNT_OPTIONS, defaultEffects } from "@/lib/project/store";
import { getStoredAccessCode } from "@/lib/render/access-code";
import { toast } from "sonner";
import { Sparkles, Loader2 } from "lucide-react";

interface Props {
  project: Project;
  update: (u: (p: Project) => Project) => void;
}

const setV = (update: Props["update"], k: keyof Project["visualizer"]) => (v: number | string) =>
  update((p) => ({ ...p, visualizer: { ...p.visualizer, [k]: v } }));

const setCustom =
  (update: Props["update"], k: keyof Project["visualizer"]["custom"]) =>
  (v: number | string | boolean) =>
    update((p) => ({
      ...p,
      visualizer: { ...p.visualizer, custom: { ...p.visualizer.custom, [k]: v } },
    }));

const FONT_GROUPS: { label: string; category: LyricFontCategory }[] = [
  { label: "Bold & headline", category: "display" },
  { label: "Clean sans", category: "sans" },
  { label: "Elegant serif", category: "serif" },
  { label: "Script & handwritten", category: "script" },
  { label: "Mono & retro", category: "mono" },
  { label: "System", category: "system" },
];

export function RightPanel({ project, update }: Props) {
  const V = project.visualizer;
  const L = project.lyrics;
  const E = project.effects;
  const C = V.custom;
  const isCustom = V.presetId === "custom-equalizer";
  const generate = useServerFn(generateVisualizerFromPrompt);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const setL = <K extends keyof Project["lyrics"]>(k: K, v: Project["lyrics"][K]) =>
    update((p) => ({ ...p, lyrics: { ...p.lyrics, [k]: v } }));

  const runGenerate = async () => {
    if (!prompt.trim()) return;
    const accessCode = getStoredAccessCode();
    if (!accessCode) {
      toast.error("Enter your access code in Export → Lambda Render to use the AI generator.");
      return;
    }
    setBusy(true);
    try {
      const { patch, backgroundUrl } = await generate({ data: { prompt: prompt.trim(), accessCode } });
      const customPatch = (patch.custom as { shape?: string } | undefined) || {};
      const shape = customPatch.shape;
      const floorShapes = new Set(["bars", "wave", "triangles", "dots", "mirrored"]);
      const defaultPosition =
        shape && floorShapes.has(shape)
          ? { x: 0, y: 1 }
          : shape === "radial" || shape === "ring"
            ? { x: 0, y: 0 }
            : undefined;
      update((p) => ({
        ...p,
        visualizer: {
          ...p.visualizer,
          ...patch,
          presetId: "custom-equalizer",
          position: defaultPosition ?? p.visualizer.position,
          custom: { ...p.visualizer.custom, ...((patch.custom as object) || {}) },
        } as Project["visualizer"],
        background: backgroundUrl
          ? {
              id: `ai-bg-${Date.now()}`,
              name: "AI background",
              type: "image/png",
              url: backgroundUrl,
            }
          : p.background,
      }));
      toast.success(backgroundUrl ? "Generated preset + background applied" : "Generated preset applied");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="w-full lg:w-80 shrink-0 min-h-0 max-h-[50vh] lg:max-h-none panel rounded-xl overflow-hidden flex flex-col">
      <Tabs defaultValue="style" className="flex-1 min-h-0 flex flex-col">
        <TabsList className="grid grid-cols-4 m-2 bg-elevated/60">
          <TabsTrigger value="style">Style</TabsTrigger>
          <TabsTrigger value="motion">Motion</TabsTrigger>
          <TabsTrigger value="effects">FX</TabsTrigger>
          <TabsTrigger value="lyrics">Lyrics</TabsTrigger>
        </TabsList>

        <TabPanel value="style">
          <Section title="AI Generator">
            <p className="text-[11px] text-muted-foreground -mt-1">
              Describe a vibe — colors, shape, motion, and a matching background image are auto-tuned.
            </p>
            <div className="flex gap-1.5">
              <Input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void runGenerate(); }}
                placeholder="neon city rain, energetic"
                className="h-9 bg-elevated/60"
              />
              <Button
                size="sm"
                onClick={runGenerate}
                disabled={busy || !prompt.trim()}
                className="h-9 px-2.5"
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
              </Button>
            </div>
          </Section>

          {isCustom && (
            <Section title="Custom Builder">
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Shape</div>
                <Select value={C.shape} onValueChange={(v) => setCustom(update, "shape")(v)}>
                  <SelectTrigger className="h-9 bg-elevated/60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      ["bars", "mirrored", "radial", "ring", "wave", "dots", "triangles"] as const
                    ).map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <SliderField
                label="Count"
                value={C.count}
                min={3}
                max={256}
                step={1}
                onChange={(v) => setCustom(update, "count")(Math.round(v))}
                format={(n) => n.toFixed(0)}
              />
              <SliderField
                label="Spacing"
                value={C.spacing}
                max={0.9}
                onChange={(v) => setCustom(update, "spacing")(v)}
              />
              <SliderField
                label="Amplitude"
                value={C.amplitude}
                max={2}
                onChange={(v) => setCustom(update, "amplitude")(v)}
              />
              <SliderField
                label="Thickness (0 = inherit)"
                value={C.thickness}
                max={40}
                step={1}
                onChange={(v) => setCustom(update, "thickness")(v)}
                format={(n) => n.toFixed(0)}
              />
              <SliderField
                label="Reactivity"
                value={C.reactivity}
                max={3}
                onChange={(v) => setCustom(update, "reactivity")(v)}
              />
              <SliderField
                label="Inner radius"
                value={C.innerRadius}
                max={0.9}
                onChange={(v) => setCustom(update, "innerRadius")(v)}
              />
              <Toggle
                label="Rounded"
                value={C.rounded}
                onChange={(v) => setCustom(update, "rounded")(v)}
              />
              <Toggle
                label="Symmetric"
                value={C.symmetric}
                onChange={(v) => setCustom(update, "symmetric")(v)}
              />
            </Section>
          )}

          <Section title="Colors">
            <ColorField
              label="Primary"
              value={V.primary}
              onChange={(v) => setV(update, "primary")(v)}
            />
            <ColorField
              label="Secondary"
              value={V.secondary}
              onChange={(v) => setV(update, "secondary")(v)}
            />
            <ColorField
              label="Accent"
              value={V.accent}
              onChange={(v) => setV(update, "accent")(v)}
            />
            <ColorField label="Glow" value={V.glow} onChange={(v) => setV(update, "glow")(v)} />
            <ColorField
              label="Overlay"
              value={V.overlay}
              onChange={(v) => setV(update, "overlay")(v)}
            />
            <SliderField
              label="Overlay opacity"
              value={V.overlayOpacity}
              onChange={(v) => setV(update, "overlayOpacity")(v)}
            />
          </Section>

          <Section title="Visualizer">
            <SliderField
              label="Size"
              value={V.size}
              min={0.2}
              max={2.5}
              onChange={(v) => setV(update, "size")(v)}
            />
            <SliderField
              label="Thickness"
              value={V.thickness}
              min={1}
              max={30}
              step={1}
              onChange={(v) => setV(update, "thickness")(v)}
              format={(n) => n.toFixed(0)}
            />
            <SliderField
              label="Glow intensity"
              value={V.glowIntensity}
              max={2}
              onChange={(v) => setV(update, "glowIntensity")(v)}
            />
            <SliderField
              label="Blur"
              value={V.blur}
              max={20}
              step={1}
              onChange={(v) => setV(update, "blur")(v)}
              format={(n) => `${n.toFixed(0)}px`}
            />
            <SliderField
              label="Position X"
              value={V.position.x}
              min={-1}
              max={1}
              onChange={(v) =>
                update((p) => ({
                  ...p,
                  visualizer: { ...p.visualizer, position: { ...V.position, x: v } },
                }))
              }
            />
            <SliderField
              label="Position Y"
              value={V.position.y}
              min={-1}
              max={1}
              onChange={(v) =>
                update((p) => ({
                  ...p,
                  visualizer: { ...p.visualizer, position: { ...V.position, y: v } },
                }))
              }
            />
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">Blend mode</div>
              <Select value={V.blendMode} onValueChange={(v) => setV(update, "blendMode")(v)}>
                <SelectTrigger className="h-9 bg-elevated/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    [
                      "source-over",
                      "screen",
                      "lighter",
                      "overlay",
                      "multiply",
                      "color-dodge",
                    ] as const
                  ).map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Section>

          <Section title="Logo">
            <SliderField
              label="Logo size"
              value={V.logoSize}
              max={1}
              onChange={(v) => setV(update, "logoSize")(v)}
            />
            <SliderField
              label="Logo X"
              value={V.logoPosition.x}
              min={-1}
              max={1}
              onChange={(v) =>
                update((p) => ({
                  ...p,
                  visualizer: { ...p.visualizer, logoPosition: { ...V.logoPosition, x: v } },
                }))
              }
            />
            <SliderField
              label="Logo Y"
              value={V.logoPosition.y}
              min={-1}
              max={1}
              onChange={(v) =>
                update((p) => ({
                  ...p,
                  visualizer: { ...p.visualizer, logoPosition: { ...V.logoPosition, y: v } },
                }))
              }
            />
          </Section>

          <Section title="Background">
            <SliderField
              label="Scale"
              value={V.backgroundScale}
              min={0.8}
              max={2}
              onChange={(v) => setV(update, "backgroundScale")(v)}
            />
            <SliderField
              label="Blur"
              value={V.backgroundBlur}
              max={40}
              step={1}
              onChange={(v) => setV(update, "backgroundBlur")(v)}
              format={(n) => `${n.toFixed(0)}px`}
            />
            <ColorField
              label="Tint"
              value={V.backgroundTint}
              onChange={(v) => setV(update, "backgroundTint")(v)}
            />
            <SliderField
              label="Tint opacity"
              value={V.backgroundTintOpacity}
              onChange={(v) => setV(update, "backgroundTintOpacity")(v)}
            />
          </Section>
        </TabPanel>

        <TabPanel value="motion">
          <Section title="Audio Reactivity">
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">Detail (bands)</div>
              <Select
                value={String(V.bandCount)}
                onValueChange={(v) => setV(update, "bandCount")(Number(v))}
              >
                <SelectTrigger className="h-9 bg-elevated/60">
                  <SelectValue placeholder={`${V.bandCount} bands`} />
                </SelectTrigger>
                <SelectContent>
                  {BAND_COUNT_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} bands
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">Fewer bands = chunky, more = fine detail. Some visualizers use it as particle or line count.</p>
            </div>
            <SliderField
              label="Sensitivity"
              value={V.sensitivity}
              max={3}
              onChange={(v) => setV(update, "sensitivity")(v)}
            />
            <SliderField
              label="Bass"
              value={V.bassSensitivity}
              max={3}
              onChange={(v) => setV(update, "bassSensitivity")(v)}
            />
            <SliderField
              label="Mids"
              value={V.midSensitivity}
              max={3}
              onChange={(v) => setV(update, "midSensitivity")(v)}
            />
            <SliderField
              label="Treble"
              value={V.trebleSensitivity}
              max={3}
              onChange={(v) => setV(update, "trebleSensitivity")(v)}
            />
            <SliderField
              label="Smoothing"
              value={V.smoothing}
              max={0.95}
              onChange={(v) => setV(update, "smoothing")(v)}
              hint="Low = snappy and twitchy, high = slow and silky."
            />
            <SliderField
              label="Reactivity"
              value={V.reactivity}
              max={3}
              onChange={(v) => setV(update, "reactivity")(v)}
              hint="How far the visualizer moves for the same sound."
            />
          </Section>
          <Section title="Animation">
            <Toggle
              label="Keep stationary"
              value={V.stationary}
              onChange={(v) => update((p) => ({ ...p, visualizer: { ...p.visualizer, stationary: v } }))}
            />
            <SliderField
              label="Speed"
              value={V.animationSpeed}
              min={0.1}
              max={3}
              onChange={(v) => setV(update, "animationSpeed")(v)}
            />
            <SliderField
              label="Rotation"
              value={V.rotation}
              min={-Math.PI}
              max={Math.PI}
              onChange={(v) => setV(update, "rotation")(v)}
              format={(n) => `${Math.round((n * 180) / Math.PI)}°`}
            />
            <SliderField
              label="Movement"
              value={V.movement}
              onChange={(v) => setV(update, "movement")(v)}
              hint="Adds time-based floating. Turn on Keep stationary to lock the equalizer in place while it still reacts to audio."
            />
            <SliderField
              label="Shadow"
              value={V.shadow}
              onChange={(v) => setV(update, "shadow")(v)}
            />
            <SliderField
              label="Border"
              value={V.border}
              onChange={(v) => setV(update, "border")(v)}
            />
          </Section>
        </TabPanel>

        <TabPanel value="effects">
          <EffectsTab effects={E} update={update} />
        </TabPanel>

        <TabPanel value="lyrics">
          <Toggle
            label="Enable lyrics"
            value={L.enabled}
            onChange={(v) => setL("enabled", v)}
          />
          {L.enabled && L.lines.length === 0 && (
            <p className="text-[11px] text-muted-foreground -mt-1">
              No lyrics yet — use the <span className="font-medium text-foreground/90">+ Lyrics</span> button in the bottom bar to paste or auto-sync them.
            </p>
          )}
          <Section title="Style">
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">Style</div>
              <Select
                value={L.style}
                onValueChange={(v) => setL("style", v as typeof L.style)}
              >
                <SelectTrigger className="h-9 bg-elevated/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="subtitle">Subtitle</SelectItem>
                  <SelectItem value="karaoke">Karaoke highlight</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">Position</div>
              <Select
                value={L.position}
                onValueChange={(v) => setL("position", v as typeof L.position)}
              >
                <SelectTrigger className="h-9 bg-elevated/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["bottom", "center", "top", "left", "right"] as const).map((x) => (
                    <SelectItem key={x} value={x}>
                      {x}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">Font</div>
              <Select
                value={L.fontFamily}
                onValueChange={(v) => setL("fontFamily", v)}
              >
                <SelectTrigger className="h-9 bg-elevated/60" style={{ fontFamily: `"${L.fontFamily}", sans-serif` }}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONT_GROUPS.map((g) => {
                    const fonts = LYRIC_FONTS.filter((f) => f.category === g.category);
                    if (!fonts.length) return null;
                    return (
                      <SelectGroup key={g.category}>
                        <SelectLabel>{g.label}</SelectLabel>
                        {fonts.map((f) => (
                          <SelectItem key={f.family} value={f.family} style={{ fontFamily: `"${f.family}", sans-serif` }}>
                            {f.family}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">All fonts here render identically in the exported video.</p>
            </div>
            <SliderField
              label="Font size"
              value={L.fontSize}
              min={16}
              max={140}
              step={1}
              onChange={(v) => setL("fontSize", v)}
              format={(n) => `${n.toFixed(0)}px`}
            />
            <ColorField
              label="Color"
              value={L.color}
              onChange={(v) => setL("color", v)}
            />
            {L.style === "karaoke" && (
              <ColorField
                label="Highlight"
                value={L.highlightColor || V.glow}
                onChange={(v) => setL("highlightColor", v)}
              />
            )}
            <Toggle label="Uppercase" value={Boolean(L.uppercase)} onChange={(v) => setL("uppercase", v)} />
            <Toggle label="Outline" value={L.outline} onChange={(v) => setL("outline", v)} />
            <Toggle label="Shadow" value={L.shadow} onChange={(v) => setL("shadow", v)} />
            <Toggle label="Glow" value={L.glow} onChange={(v) => setL("glow", v)} />
          </Section>
          <Section title="Motion">
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">Line entrance</div>
              <Select
                value={L.animation ?? "none"}
                onValueChange={(v) => setL("animation", v as NonNullable<typeof L.animation>)}
              >
                <SelectTrigger className="h-9 bg-elevated/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="slide">Slide up</SelectItem>
                  <SelectItem value="pop">Pop</SelectItem>
                  <SelectItem value="typewriter">Typewriter</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Toggle label="Fade in / out" value={L.fade} onChange={(v) => setL("fade", v)} />
            <Toggle
              label="Show next line"
              value={Boolean(L.showNext)}
              onChange={(v) => setL("showNext", v)}
            />
            {L.style === "karaoke" && (
              <Toggle
                label="Word-by-word highlight"
                value={L.wordHighlight ?? true}
                onChange={(v) => setL("wordHighlight", v)}
              />
            )}
            <SliderField
              label="Timing offset"
              value={L.timingOffset ?? 0}
              min={-5}
              max={5}
              step={0.05}
              onChange={(v) => setL("timingOffset", v)}
              format={(n) => `${n > 0 ? "+" : ""}${n.toFixed(2)}s`}
              hint="Positive shows lyrics earlier, negative later."
            />
          </Section>
        </TabPanel>
      </Tabs>
    </aside>
  );
}

// ─── FX tab ──────────────────────────────────────────────────────────────

type Effects = Project["effects"];

// Nested effect objects are optional on saved projects; spread these so an
// update never produces a half-formed object. Same numbers as the store.
const FX_DEFAULTS = (() => {
  const d = defaultEffects();
  return {
    particles: d.particles,
    camera: d.camera ?? { zoom: 0, shake: 0 },
    reflection: d.reflection ?? { enabled: false, opacity: 0.35, height: 0.35, horizon: 0.78 },
    trails: d.trails ?? { enabled: false, decay: 0.82 },
    lightStreaks: d.lightStreaks ?? { enabled: false, intensity: 0.6, color: "#ffffff" },
    fog: d.fog ?? { enabled: false, density: 0.4, color: "#9fb4ff", speed: 0.4 },
    gradientWash: d.gradientWash ?? { enabled: false, intensity: 0.5 },
    ripples: d.ripples ?? { enabled: false, intensity: 0.6 },
  };
})();

const PARTICLE_TYPES: { value: ParticleType; label: string }[] = [
  { value: "snow", label: "Snow" },
  { value: "dust", label: "Dust" },
  { value: "sparks", label: "Sparks" },
  { value: "bokeh", label: "Bokeh" },
  { value: "lights", label: "Lights" },
  { value: "embers", label: "Embers" },
  { value: "stars", label: "Stars" },
];

const PARTICLE_TRIGGERS: { value: ParticleTrigger; label: string }[] = [
  { value: "volume", label: "Volume" },
  { value: "kick", label: "Kick" },
  { value: "snare", label: "Snare" },
  { value: "hat", label: "Hi-hat" },
];

const pct = (n: number) => `${Math.round(n * 100)}%`;

function EffectsTab({ effects: E, update }: { effects: Effects; update: Props["update"] }) {
  const patch = (fn: (e: Effects) => Partial<Effects>) =>
    update((p) => ({ ...p, effects: { ...p.effects, ...fn(p.effects) } }));
  const setParticles = (v: Partial<Effects["particles"]>) =>
    patch((e) => ({ particles: { ...FX_DEFAULTS.particles, ...e.particles, ...v } }));
  const setCamera = (v: Partial<typeof FX_DEFAULTS.camera>) =>
    patch((e) => ({ camera: { ...FX_DEFAULTS.camera, ...e.camera, ...v } }));
  const setReflection = (v: Partial<typeof FX_DEFAULTS.reflection>) =>
    patch((e) => ({ reflection: { ...FX_DEFAULTS.reflection, ...e.reflection, ...v } }));
  const setTrails = (v: Partial<typeof FX_DEFAULTS.trails>) =>
    patch((e) => ({ trails: { ...FX_DEFAULTS.trails, ...e.trails, ...v } }));
  const setStreaks = (v: Partial<typeof FX_DEFAULTS.lightStreaks>) =>
    patch((e) => ({ lightStreaks: { ...FX_DEFAULTS.lightStreaks, ...e.lightStreaks, ...v } }));
  const setFog = (v: Partial<typeof FX_DEFAULTS.fog>) =>
    patch((e) => ({ fog: { ...FX_DEFAULTS.fog, ...e.fog, ...v } }));
  const setWash = (v: Partial<typeof FX_DEFAULTS.gradientWash>) =>
    patch((e) => ({ gradientWash: { ...FX_DEFAULTS.gradientWash, ...e.gradientWash, ...v } }));
  const setRipples = (v: Partial<typeof FX_DEFAULTS.ripples>) =>
    patch((e) => ({ ripples: { ...FX_DEFAULTS.ripples, ...e.ripples, ...v } }));

  const P = E.particles;
  const cam = { ...FX_DEFAULTS.camera, ...E.camera };
  const refl = { ...FX_DEFAULTS.reflection, ...E.reflection };
  const trails = { ...FX_DEFAULTS.trails, ...E.trails };
  const streaks = { ...FX_DEFAULTS.lightStreaks, ...E.lightStreaks };
  const fog = { ...FX_DEFAULTS.fog, ...E.fog };
  const wash = { ...FX_DEFAULTS.gradientWash, ...E.gradientWash };
  const ripples = { ...FX_DEFAULTS.ripples, ...E.ripples };

  return (
    <>
      <Section title="Particles">
        <Toggle label="Enable particles" value={P.enabled} onChange={(v) => setParticles({ enabled: v })} />
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Type</div>
          <Select value={P.type} onValueChange={(v) => setParticles({ type: v as ParticleType })}>
            <SelectTrigger className="h-9 bg-elevated/60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PARTICLE_TYPES.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <SliderField
          label="Density"
          value={P.density}
          min={0}
          max={200}
          step={1}
          onChange={(v) => setParticles({ density: v })}
          format={(n) => n.toFixed(0)}
          hint="How many particles are on screen."
        />
        <SliderField
          label="Size"
          value={P.size ?? 1}
          min={0.3}
          max={3}
          onChange={(v) => setParticles({ size: v })}
          format={(n) => `${n.toFixed(2)}×`}
          hint="How big each particle is."
        />
        <SliderField
          label="Speed"
          value={P.speed}
          max={3}
          onChange={(v) => setParticles({ speed: v })}
          hint="How fast the particles drift."
        />
        <SliderField
          label="Jitter"
          value={P.jitter ?? 0.3}
          onChange={(v) => setParticles({ jitter: v })}
          hint="Adds a random wobble to the motion."
        />
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Reacts to</div>
          <Select value={P.trigger ?? "volume"} onValueChange={(v) => setParticles({ trigger: v as ParticleTrigger })}>
            <SelectTrigger className="h-9 bg-elevated/60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PARTICLE_TRIGGERS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">Which part of the music makes the particles surge.</p>
        </div>
        <SliderField
          label="Reactivity"
          value={P.reactivity}
          max={2}
          onChange={(v) => setParticles({ reactivity: v })}
          hint="How hard the particles surge forward on that signal."
        />
        <SliderField
          label="Burst"
          value={P.burst ?? 0}
          max={2}
          onChange={(v) => setParticles({ burst: v })}
          hint="Particles swell and brighten on every hit."
        />
        <SliderField label="Opacity" value={P.opacity} onChange={(v) => setParticles({ opacity: v })} />
        <ColorField label="Color" value={P.color} onChange={(v) => setParticles({ color: v })} />
      </Section>

      <Section title="Camera & Motion">
        <SliderField
          label="Beat zoom"
          value={cam.zoom}
          max={0.15}
          step={0.005}
          onChange={(v) => setCamera({ zoom: v })}
          format={pct}
          hint="Punches the whole picture in on every kick."
        />
        <SliderField
          label="Shake"
          value={cam.shake}
          onChange={(v) => setCamera({ shake: v })}
          hint="Handheld camera wobble on kicks."
        />
        <SliderField
          label="Background zoom pulse"
          value={E.bgZoomPulse ?? 0}
          max={0.2}
          step={0.005}
          onChange={(v) => patch(() => ({ bgZoomPulse: v }))}
          format={pct}
          hint="The background image swells with the bass."
        />
        <SliderField
          label="Beat split"
          value={E.beatSplit ?? 0}
          onChange={(v) => patch(() => ({ beatSplit: v }))}
          hint="Ghost copies split left and right on kicks."
        />
      </Section>

      <Section title="Layers">
        <FxToggle
          label="Floor reflection"
          value={refl.enabled}
          onChange={(v) => setReflection({ enabled: v })}
          hint="Mirrors the visualizer below a floor line, like a wet stage."
        />
        {refl.enabled && (
          <div className="pl-3 border-l border-border/60 space-y-2.5">
            <SliderField label="Opacity" value={refl.opacity} onChange={(v) => setReflection({ opacity: v })} />
            <SliderField
              label="Height"
              value={refl.height}
              min={0.05}
              max={0.8}
              onChange={(v) => setReflection({ height: v })}
              hint="How far down the reflection reaches before it fades out."
            />
            <SliderField
              label="Horizon"
              value={refl.horizon}
              min={0.3}
              max={1}
              onChange={(v) => setReflection({ horizon: v })}
              hint="Where the floor line sits (1 = bottom edge)."
            />
          </div>
        )}

        <FxToggle
          label="Trails"
          value={trails.enabled}
          onChange={(v) => setTrails({ enabled: v })}
          hint="Leaves glowing after-images behind anything that moves."
        />
        {trails.enabled && (
          <div className="pl-3 border-l border-border/60 space-y-2.5">
            <SliderField
              label="Persistence"
              value={trails.decay}
              min={0.5}
              max={0.97}
              step={0.005}
              onChange={(v) => setTrails({ decay: v })}
              hint="Higher = the trails linger longer."
            />
          </div>
        )}

        <FxToggle
          label="Light streaks"
          value={streaks.enabled}
          onChange={(v) => setStreaks({ enabled: v })}
          hint="Long diagonal beams sweep across on kicks and snares."
        />
        {streaks.enabled && (
          <div className="pl-3 border-l border-border/60 space-y-2.5">
            <SliderField label="Intensity" value={streaks.intensity} onChange={(v) => setStreaks({ intensity: v })} />
            <ColorField label="Color" value={streaks.color} onChange={(v) => setStreaks({ color: v })} />
          </div>
        )}

        <FxToggle
          label="Fog"
          value={fog.enabled}
          onChange={(v) => setFog({ enabled: v })}
          hint="Slow drifting haze that thickens a little when the song gets loud."
        />
        {fog.enabled && (
          <div className="pl-3 border-l border-border/60 space-y-2.5">
            <SliderField label="Density" value={fog.density} onChange={(v) => setFog({ density: v })} />
            <SliderField
              label="Speed"
              value={fog.speed}
              max={2}
              onChange={(v) => setFog({ speed: v })}
              hint="How quickly the fog drifts."
            />
            <ColorField label="Color" value={fog.color} onChange={(v) => setFog({ color: v })} />
          </div>
        )}

        <FxToggle
          label="Colour wash"
          value={wash.enabled}
          onChange={(v) => setWash({ enabled: v })}
          hint="Soft moving colour clouds from your palette; the bass swells them."
        />
        {wash.enabled && (
          <div className="pl-3 border-l border-border/60 space-y-2.5">
            <SliderField label="Intensity" value={wash.intensity} onChange={(v) => setWash({ intensity: v })} />
          </div>
        )}

        <FxToggle
          label="Beat ripples"
          value={ripples.enabled}
          onChange={(v) => setRipples({ enabled: v })}
          hint="Rings ripple out from the visualizer on every kick."
        />
        {ripples.enabled && (
          <div className="pl-3 border-l border-border/60 space-y-2.5">
            <SliderField label="Intensity" value={ripples.intensity} onChange={(v) => setRipples({ intensity: v })} />
          </div>
        )}
      </Section>

      <Section title="Atmosphere">
        <Toggle label="Beat flash" value={E.beatFlash} onChange={(v) => patch(() => ({ beatFlash: v }))} />
        <Toggle label="Vignette" value={E.vignette} onChange={(v) => patch(() => ({ vignette: v }))} />
        {E.vignette && (
          <div className="pl-3 border-l border-border/60 space-y-2.5">
            <SliderField
              label="Breathing vignette"
              value={E.breathingVignette ?? 0}
              onChange={(v) => patch(() => ({ breathingVignette: v }))}
              hint="The dark edges close in when the music goes quiet and open up on the loud parts."
            />
          </div>
        )}
        <Toggle label="Film grain" value={E.noise} onChange={(v) => patch(() => ({ noise: v }))} />
        {E.noise && (
          <div className="pl-3 border-l border-border/60 space-y-2.5">
            <SliderField
              label="Grain amount"
              value={E.noiseAmount ?? 0.07}
              max={0.3}
              onChange={(v) => patch(() => ({ noiseAmount: v }))}
              hint="How strong the film grain is."
            />
          </div>
        )}
        <Toggle label="Lens flare" value={E.lensFlare} onChange={(v) => patch(() => ({ lensFlare: v }))} />
        <Toggle label="Logo pulse" value={E.logoPulse} onChange={(v) => patch(() => ({ logoPulse: v }))} />
        <Toggle label="Logo bounce" value={E.logoBounce} onChange={(v) => patch(() => ({ logoBounce: v }))} />
        <Toggle
          label="Background pulse"
          value={E.backgroundPulse}
          onChange={(v) => patch(() => ({ backgroundPulse: v }))}
        />
      </Section>
    </>
  );
}

function FxToggle({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <Toggle label={label} value={value} onChange={onChange} />
      {hint && <p className="text-[10px] text-muted-foreground leading-snug">{hint}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      <div className="space-y-2.5">{children}</div>
      <Separator />
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

function TabPanel({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsContent value={value} className="mt-0 flex-1 min-h-0 data-[state=inactive]:hidden">
      <ScrollArea className="h-full max-h-full">
        <div className="space-y-4 p-4 pt-2">{children}</div>
      </ScrollArea>
    </TabsContent>
  );
}
