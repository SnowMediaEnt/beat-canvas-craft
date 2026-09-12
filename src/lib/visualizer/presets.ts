// Preset registry. Individual presets live in packs:
//   presets-core.ts       – the original 33 (ported to shared helpers)
//   presets-cinematic.ts  – light, depth and motion-graphics looks
//   presets-groove.ts     – drum/onset-locked presets
//   presets-showcase.ts   – logo / cover-art / typography / history presets
// Every pack imports the same helpers from draw-utils.ts, so the live
// preview and the Lambda render stay pixel-identical by construction.

import { CORE_PRESETS } from "./presets-core";
import { CINEMATIC_PRESETS } from "./presets-cinematic";
import { GROOVE_PRESETS } from "./presets-groove";
import { SHOWCASE_PRESETS } from "./presets-showcase";
import type { Preset } from "./presets-core";

export type { DrawContext, Preset, CurrentLyric } from "./presets-core";
export { bandLevels, freqAtPos, freqAt } from "./draw-utils";

const dedupe = (list: Preset[]) => {
  const seen = new Set<string>();
  return list.filter((p) => {
    if (seen.has(p.id)) {
      console.warn(`[presets] duplicate preset id "${p.id}" ignored`);
      return false;
    }
    seen.add(p.id);
    return true;
  });
};

export const PRESETS: Preset[] = dedupe([
  ...CORE_PRESETS,
  ...CINEMATIC_PRESETS,
  ...GROOVE_PRESETS,
  ...SHOWCASE_PRESETS,
]);

const byId = new Map(PRESETS.map((p) => [p.id, p]));

export const getPreset = (id: string): Preset => byId.get(id) ?? PRESETS[0];
export const hasPreset = (id: string): boolean => byId.has(id);

/** Category order for the picker (unknown categories sort last, alphabetically). */
export const PRESET_CATEGORY_ORDER = [
  "Logo", "Typography", "Circular", "Bars", "Grid", "Wave", "3D", "Ambient", "Morph",
  "Shapes", "Particles", "Organic", "Sacred", "Retro", "Unconventional", "Custom",
];

export function presetCategories(): string[] {
  const seen = new Set<string>();
  for (const p of PRESETS) seen.add(p.category);
  const known = PRESET_CATEGORY_ORDER.filter((c) => seen.has(c));
  const rest = Array.from(seen).filter((c) => !PRESET_CATEGORY_ORDER.includes(c)).sort();
  return [...known, ...rest];
}
