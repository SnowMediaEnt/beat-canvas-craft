// Turn transcribed words into on-screen lyric lines.
//
// The old grouping cut a line after 9 words or at a 0.7 s silence, whichever
// came first. Singing is continuous, so most lines were cut by the word count
// in the middle of a sentence and the next line began with the tail of it.
// This version chooses the break points for the whole song at once, preferring
// places a singer would breathe: sentence punctuation, then commas, then
// pauses, while keeping lines a readable length.

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface GroupedLine {
  /** When the line should appear (a little before the first word is sung). */
  time: number;
  /** When the last word of the line has been sung. */
  end: number;
  text: string;
  /** Per-word start times for karaoke; empty when words don't map 1:1 onto text. */
  words: { time: number; text: string }[];
}

/** How long before the first word the line appears, so it can be read in time. */
export const LYRIC_LEAD_IN = 0.18;

const TARGET_WORDS = 6;
const MAX_WORDS = 10;
const MAX_CHARS = 52;
const MAX_SPAN_SECONDS = 7;
/** A silence this long always ends a line. */
const HARD_BREAK_GAP = 1.2;

const STRONG_END = /[.!?…]["'”’)\]]*$/;
const SOFT_END = /[,;:—–]["'”’)\]]*$/;

/** Words a line should not end on: it reads as cut off ("across the / rain"). */
const WEAK_ENDINGS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "with", "from", "by", "into", "onto",
  "my", "your", "our", "his", "her", "their", "its", "and", "or", "but", "that", "as", "if", "so", "than",
]);
/** Words that naturally start a new line ("... the rain | and I turned back"). */
const LINE_STARTERS = new Set(["and", "but", "when", "because", "while", "until", "cause", "til", "where", "if"]);
const bare = (t: string) => t.toLowerCase().replace(/[^a-z']/g, "");

/** How natural a line break is after word `i` (higher = better place to break). */
function breakStrength(words: TimedWord[], i: number): number {
  const w = words[i];
  const next = words[i + 1];
  if (!next) return 0;
  const gap = Math.max(0, next.start - w.end);
  let s = Math.min(gap, 1.5) * 4; // 0.3 s pause = 1.2, 0.7 s = 2.8
  const t = w.text.trim();
  if (STRONG_END.test(t)) s += 4;
  else if (SOFT_END.test(t)) s += 1.5;
  else {
    if (WEAK_ENDINGS.has(bare(t))) s -= 3;
    if (LINE_STARTERS.has(bare(next.text))) s += 1.5;
  }
  return s;
}

function lengthCost(n: number): number {
  const d = (n - TARGET_WORDS) / TARGET_WORDS;
  let c = d * d * 3;
  if (n === 1) c += 2.5;
  else if (n === 2) c += 0.8;
  return c;
}

export function groupWordsIntoLines(input: TimedWord[]): GroupedLine[] {
  const words = input.filter((w) => w.text && w.text.trim().length > 0 && Number.isFinite(w.start));
  const n = words.length;
  if (!n) return [];

  // Prefix data for O(1) line checks.
  const chars = (i: number, j: number) => {
    let c = 0;
    for (let k = i; k < j; k++) c += words[k].text.length + 1;
    return c - 1;
  };
  const crossesHardGap = (i: number, j: number) => {
    for (let k = i; k < j - 1; k++) if (words[k + 1].start - words[k].end > HARD_BREAK_GAP) return true;
    return false;
  };

  // best[j] = cheapest way to lay out words[0..j); from[j] = start of the last line.
  const best = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
  const from = new Array<number>(n + 1).fill(0);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let len = 1; len <= MAX_WORDS && len <= j; len++) {
      const i = j - len;
      if (!Number.isFinite(best[i])) continue;
      if (crossesHardGap(i, j)) continue;
      const span = words[j - 1].end - words[i].start;
      if (len > 1 && (span > MAX_SPAN_SECONDS || chars(i, j) > MAX_CHARS)) continue;
      const bonus = j < n ? breakStrength(words, j - 1) : 0;
      const cost = best[i] + lengthCost(len) - bonus;
      if (cost < best[j]) { best[j] = cost; from[j] = i; }
    }
    if (!Number.isFinite(best[j])) {
      // Nothing fit (e.g. one very long single word): take it alone.
      best[j] = best[j - 1] + 5;
      from[j] = j - 1;
    }
  }

  const ranges: [number, number][] = [];
  for (let j = n; j > 0; j = from[j]) ranges.push([from[j], j]);
  ranges.reverse();

  const lines: GroupedLine[] = [];
  for (const [i, j] of ranges) {
    const buf = words.slice(i, j);
    const text = buf.map((w) => w.text.trim()).join(" ").replace(/\s+([,.;:!?])/g, "$1").trim();
    const tokens = text.split(" ").filter(Boolean);
    const wordTimes = tokens.length === buf.length ? buf.map((w, k) => ({ time: w.start, text: tokens[k] })) : [];
    lines.push({ time: buf[0].start, end: buf[buf.length - 1].end, text, words: wordTimes });
  }

  // Lead-in: show each line slightly before it is sung, but never before the
  // previous line has finished being sung.
  for (let k = 0; k < lines.length; k++) {
    const prevEnd = k > 0 ? lines[k - 1].end : 0;
    lines[k].time = Math.max(prevEnd, lines[k].time - LYRIC_LEAD_IN, 0);
  }
  return lines;
}

/**
 * For lines whose start times are already known (aligned to the user's own
 * lyrics, or typed), find when each one finishes being sung from the
 * transcribed words, and show it a little early.
 */
export function attachSungEnds<T extends { time: number }>(
  lines: T[],
  words: TimedWord[],
): (T & { end?: number })[] {
  return lines.map((line, i) => {
    const nextTime = i + 1 < lines.length ? lines[i + 1].time : Number.POSITIVE_INFINITY;
    let end: number | undefined;
    for (const w of words) {
      if (w.start >= line.time - 0.3 && w.start < nextTime - 0.05) end = Math.max(end ?? 0, w.end);
    }
    if (end !== undefined && end > nextTime) end = nextTime;
    return end !== undefined && end > line.time ? { ...line, end } : { ...line };
  });
}

/**
 * Show lines slightly before they are sung, but never before the previous
 * line has finished (or, without an end time, never closer than 0.3 s to its
 * start). Used for lines aligned to the user's own lyrics.
 */
export function applyLeadIn<T extends { time: number; end?: number }>(lines: T[]): T[] {
  return lines.map((line, i) => {
    const prev = i > 0 ? lines[i - 1] : undefined;
    const floor = prev ? (prev.end ?? prev.time + 0.3) : 0;
    return { ...line, time: Math.max(floor, line.time - LYRIC_LEAD_IN, 0) };
  });
}
