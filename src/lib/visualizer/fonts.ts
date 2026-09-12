// Lyric font catalogue shared by the editor (RightPanel) and the Remotion
// composition. System families need no loading. Google families are pulled
// from fonts.googleapis.com — the editor already links them in __root.tsx,
// and VisualizerComp injects the same stylesheet inside Lambda's Chromium
// (which has outbound internet) and waits for document.fonts before the
// first frame, so the MP4 matches the preview.

export type LyricFontCategory = "system" | "display" | "sans" | "serif" | "script" | "mono";

export interface LyricFont {
  family: string;
  category: LyricFontCategory;
  /** Google Fonts CSS2 family spec (family name + optional weights). Absent for system fonts. */
  google?: string;
  /** Weights we render with; used to pick a CSS weight that actually exists. */
  weights: number[];
}

export const LYRIC_FONTS: LyricFont[] = [
  // System (always safe)
  { family: "Arial", category: "system", weights: [400, 700] },
  { family: "Helvetica", category: "system", weights: [400, 700] },
  { family: "Verdana", category: "system", weights: [400, 700] },
  { family: "Trebuchet MS", category: "system", weights: [400, 700] },
  { family: "Georgia", category: "system", weights: [400, 700] },
  { family: "Times New Roman", category: "system", weights: [400, 700] },
  { family: "Courier New", category: "system", weights: [400, 700] },
  { family: "Impact", category: "system", weights: [400] },
  // Google — display / headline
  { family: "Bebas Neue", category: "display", google: "Bebas+Neue", weights: [400] },
  { family: "Anton", category: "display", google: "Anton", weights: [400] },
  { family: "Oswald", category: "display", google: "Oswald:wght@500;700", weights: [500, 700] },
  { family: "Montserrat", category: "sans", google: "Montserrat:wght@700;900", weights: [700, 900] },
  { family: "Archivo Black", category: "display", google: "Archivo+Black", weights: [400] },
  { family: "Russo One", category: "display", google: "Russo+One", weights: [400] },
  { family: "Rubik Mono One", category: "display", google: "Rubik+Mono+One", weights: [400] },
  { family: "Press Start 2P", category: "mono", google: "Press+Start+2P", weights: [400] },
  { family: "Space Grotesk", category: "sans", google: "Space+Grotesk:wght@500;600;700", weights: [500, 600, 700] },
  { family: "Inter", category: "sans", google: "Inter:wght@400;500;600", weights: [400, 500, 600] },
  // Serif / elegant
  { family: "Playfair Display", category: "serif", google: "Playfair+Display:wght@700;900", weights: [700, 900] },
  { family: "Cinzel", category: "serif", google: "Cinzel:wght@700;900", weights: [700, 900] },
  // Script / handwritten
  { family: "Lobster", category: "script", google: "Lobster", weights: [400] },
  { family: "Pacifico", category: "script", google: "Pacifico", weights: [400] },
  { family: "Dancing Script", category: "script", google: "Dancing+Script:wght@700", weights: [700] },
  { family: "Permanent Marker", category: "script", google: "Permanent+Marker", weights: [400] },
];

export const LYRIC_FONT_FAMILIES = LYRIC_FONTS.map((f) => f.family);

export function getLyricFont(family: string): LyricFont | undefined {
  return LYRIC_FONTS.find((f) => f.family.toLowerCase() === (family || "").toLowerCase());
}

/** Pick the weight closest to `wanted` that the family really ships. */
export function resolveLyricFontWeight(family: string, wanted = 600): number {
  const f = getLyricFont(family);
  if (!f || !f.weights.length) return wanted;
  return f.weights.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best), f.weights[0]);
}

/** Generic CSS fallback stack for a family, so canvas never falls to serif by surprise. */
export function lyricFontStack(family: string): string {
  const f = getLyricFont(family);
  const quoted = /\s/.test(family) ? `"${family}"` : family;
  switch (f?.category) {
    case "serif": return `${quoted}, Georgia, serif`;
    case "script": return `${quoted}, "Comic Sans MS", cursive`;
    case "mono": return `${quoted}, "Courier New", monospace`;
    default: return `${quoted}, Arial, sans-serif`;
  }
}

export function googleFontsCssUrl(families: string[]): string | null {
  const specs = families
    .map((fam) => getLyricFont(fam)?.google)
    .filter((s): s is string => !!s);
  if (!specs.length) return null;
  const unique = Array.from(new Set(specs));
  return `https://fonts.googleapis.com/css2?${unique.map((s) => `family=${s}`).join("&")}&display=swap`;
}

const injected = new Set<string>();

/**
 * Make sure `family` is usable on a canvas. Resolves once the font is loaded
 * (or immediately for system fonts / when loading isn't possible). Never
 * rejects — callers treat a failed load as "draw with the fallback".
 */
export async function ensureLyricFontLoaded(family: string, weight = 600, timeoutMs = 12000): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const f = getLyricFont(family);
  if (!f || !f.google) return true; // system font
  const href = googleFontsCssUrl([family]);
  if (href && !injected.has(href) && !document.querySelector(`link[href="${href}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
    injected.add(href);
  }
  const w = resolveLyricFontWeight(family, weight);
  const fontsApi = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fontsApi || typeof fontsApi.load !== "function") return true;
  const spec = `${w} 32px "${family}"`;
  try {
    const ok = await Promise.race([
      fontsApi.load(spec).then((faces) => faces.length > 0),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    return ok;
  } catch {
    return false;
  }
}
