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
import snowfallNight from "@/assets/backgrounds/snowfall-night.jpg";
import snowPeaks from "@/assets/backgrounds/snow-peaks.jpg";
import frozenAurora from "@/assets/backgrounds/frozen-aurora.jpg";
import snowForest from "@/assets/backgrounds/snow-forest.jpg";

export interface PresetBackground {
  id: string;
  name: string;
  mood: string;
  url: string;
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
  { id: "snowfall-night", name: "Snowfall Night", mood: "Snow",        url: snowfallNight },
  { id: "snow-peaks",     name: "Snow Peaks",     mood: "Snow",        url: snowPeaks },
  { id: "frozen-aurora",  name: "Frozen Aurora",  mood: "Snow",        url: frozenAurora },
  { id: "snow-forest",    name: "Snow Forest",    mood: "Snow",        url: snowForest },
];

export const PRESET_BG_PREFIX = "preset:";
export const COLOR_BG_PREFIX = "color:";

export const getPresetBackground = (id: string) =>
  PRESET_BACKGROUNDS.find(b => b.id === id);

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

/** Solid-color background as a tiny generated PNG data URL.
 *  Works in canvas preview and uploads cleanly for Lambda renders. */
export const solidColorBackgroundRef = (hex: string) => {
  const color = (hex.startsWith("#") ? hex : `#${hex}`).toLowerCase();
  let url = "";
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = 16; canvas.height = 16;
    const ctx = canvas.getContext("2d");
    if (ctx) { ctx.fillStyle = color; ctx.fillRect(0, 0, 16, 16); }
    url = canvas.toDataURL("image/png");
  }
  return {
    id: `${COLOR_BG_PREFIX}${color}`,
    name: `Solid ${color.toUpperCase()}`,
    type: "image/png",
    url,
  };
};
