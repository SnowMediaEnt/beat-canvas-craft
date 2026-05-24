## Audit: UI controls → Remotion composition wiring

I traced every control in `LeftPanel`, `RightPanel`, `ExportDialog` through `Project` → `inputProps` (in `ExportDialog.onRender`) → `startLambdaRender` (zod-validated in `lambda.functions.ts`) → `VisualizerComp.tsx`.

### How props travel

`ExportDialog.onRender` builds `inputProps`:
```
{ audioUrl, durationSeconds, fps, width, height,
  backgroundUrl, backgroundType, logoUrl,
  visualizer: project.visualizer,   // whole object, passthrough
  effects:    project.effects,      // whole object, passthrough
  lyrics:     project.lyrics }      // whole object, passthrough
```
The lambda schema uses `z.record(z.string(), z.any())` for `visualizer` and `effects`, so nothing gets stripped. `VisualizerComp` then reuses the **same** `getPreset()` + `drawEffects()` + lyrics block as `VisualizerCanvas`, so parity is structural, not hand-mirrored.

### Confirmed wired (UI → Remotion frames)

**Style panel** — primary, secondary, accent, glow, overlay, overlayOpacity, size, thickness, glowIntensity, blur, position.x/y, blendMode, logoSize, logoPosition.x/y, backgroundScale, backgroundBlur, backgroundTint, backgroundTintOpacity.
**Motion panel** — bandCount, sensitivity, bass/mid/treble, smoothing (used during analysis), animationSpeed, rotation.
**FX panel** — particles (all sub-fields), beatFlash, vignette, noise, lensFlare, logoPulse, backgroundPulse.
**Lyrics panel** — enabled, lines, position, fontFamily, fontSize, color, outline, shadow, glow.
**Left panel** — presetId (equalizer), background preset / solid color / none, logo, aspect ratio, theme packages (they just mutate `project.visualizer` + `project.background`, so they ride through automatically).
**Export panel** — fps, resolution, aspect ratio → `width/height` passed to Remotion `calculateMetadata`.

### Gaps — controls that DO NOT affect the Remotion render

1. **Background videos (MP4/WebM uploads)**
   `VisualizerComp` only loads `backgroundUrl` via `new Image()` and explicitly skips when `backgroundType` starts with `"video"` (line 185). The live preview plays the video, the render shows a black background. Live preview vs Remotion **will drift** for any video background.

2. **`lyrics.style` ("subtitle" vs "karaoke")**
   The select exists, but neither `VisualizerCanvas` nor `VisualizerComp` branches on it — both always render the subtitle path. No drift, but the toggle is a no-op.

3. **`lyrics.fade`**
   Defined in config + exposed as a toggle, never read anywhere. No-op in both renderers.

4. **Motion → `movement`, `shadow`, `border` sliders**
   `cfg.movement`, `cfg.shadow`, `cfg.border` are not referenced in `presets.ts`, `effects.ts`, `VisualizerCanvas`, or `VisualizerComp`. Sliders move, nothing changes — same in preview and render.

5. **`bandCount` select range mismatch (cosmetic, not a parity issue)**
   `RightPanel` offers 32–256, the type comment says 3–32, but presets clamp via `Math.max(...)` so the value still passes through to Remotion identically.

### Minor parity notes (preview vs Remotion)

- `VisualizerCanvas` includes an "emergency break for single very long word" fallback in the lyrics wrap. `VisualizerComp` omits that branch. Only triggers on a single unbroken word wider than 80% of the canvas — unlikely to matter.
- Live preview uses real-time `AudioEngine` (WebAudio AnalyserNode); Remotion uses `@remotion/media-utils` `visualizeAudio` and synthesizes the time-domain waveform from the first 24 FFT bins. Bar/spectrum presets match closely; oscilloscope-style presets will look subtly different (smoother) on the render. Not a wiring bug — a fundamental difference in audio analysis source.

### Recommendation

Safe to tweak before rendering: every control in **Style**, **FX**, **Lyrics (except `style` + `fade`)**, plus `bandCount`, `sensitivity` family, `smoothing`, `animationSpeed`, `rotation`, presets, themes, background images, solid color, "none", aspect ratio, fps, resolution.

Avoid (or ask me to wire up) before rendering: **video backgrounds**, **lyrics style toggle**, **lyrics fade toggle**, **Motion → movement / shadow / border sliders**.

No code changed — awaiting your call on which gaps to close.