import aurora from "@/assets/backgrounds/aurora.jpg";
import ocean from "@/assets/backgrounds/ocean.jpg";
import sunsetClouds from "@/assets/backgrounds/sunset-clouds.jpg";
import nebula from "@/assets/backgrounds/nebula.jpg";
import neonCity from "@/assets/backgrounds/neon-city.jpg";
import forestMist from "@/assets/backgrounds/forest-mist.jpg";
import goldenHour from "@/assets/backgrounds/golden-hour.jpg";
import darkWaves from "@/assets/backgrounds/dark-waves.jpg";
import mountainDusk from "@/assets/backgrounds/mountain-dusk.jpg";
import cherrySky from "@/assets/backgrounds/cherry-sky.jpg";
import lava from "@/assets/backgrounds/lava.jpg";
import synthwave from "@/assets/backgrounds/synthwave.jpg";
import starfield from "@/assets/backgrounds/starfield.jpg";
import smoke from "@/assets/backgrounds/smoke.jpg";
import liquidInk from "@/assets/backgrounds/liquid-ink.jpg";

export interface PresetBackground {
  id: string;            // unique id (no prefix)
  name: string;
  mood: string;
  url: string;           // bundled asset URL
}

export const PRESET_BACKGROUNDS: PresetBackground[] = [
  { id: "aurora",         name: "Aurora",         mood: "Nightscape",  url: aurora },
  { id: "ocean",          name: "Ocean Depths",   mood: "Calm",        url: ocean },
  { id: "sunset-clouds",  name: "Sunset Clouds",  mood: "Warm",        url: sunsetClouds },
  { id: "nebula",         name: "Nebula",         mood: "Cosmic",      url: nebula },
  { id: "neon-city",      name: "Neon City",      mood: "Cyberpunk",   url: neonCity },
  { id: "forest-mist",    name: "Forest Mist",    mood: "Organic",     url: forestMist },
  { id: "golden-hour",    name: "Golden Hour",    mood: "Warm",        url: goldenHour },
  { id: "dark-waves",     name: "Dark Waves",     mood: "Calm",        url: darkWaves },
  { id: "mountain-dusk",  name: "Mountain Dusk",  mood: "Nightscape",  url: mountainDusk },
  { id: "cherry-sky",     name: "Cherry Sky",     mood: "Dreamy",      url: cherrySky },
  { id: "lava",           name: "Lava",           mood: "Intense",     url: lava },
  { id: "synthwave",      name: "Synthwave",      mood: "Retro",       url: synthwave },
  { id: "starfield",      name: "Starfield",      mood: "Cosmic",      url: starfield },
  { id: "smoke",          name: "Smoke",          mood: "Minimal",     url: smoke },
  { id: "liquid-ink",     name: "Liquid Ink",     mood: "Abstract",    url: liquidInk },
];

export const PRESET_BG_PREFIX = "preset:";

export const getPresetBackground = (id: string) =>
  PRESET_BACKGROUNDS.find(b => b.id === id);

/** Build an AssetRef-like for a preset background. */
export const presetBackgroundRef = (id: string) => {
  const bg = getPresetBackground(id);
  if (!bg) return undefined;
  return {
    id: `${PRESET_BG_PREFIX}${bg.id}`,
    name: bg.name,
    type: "image/jpeg",
    url: bg.url,
  };
};
