import type { TranscribedWord } from "./types";

const norm = (s: string) =>
  s.toLowerCase().replace(/[''`]/g, "'").replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();

const tokenize = (s: string) => norm(s).split(" ").filter(Boolean);

/**
 * Align user-pasted lyric lines to ASR word timestamps.
 * Greedy: for each line, scan transcript words forward from the current pointer
 * looking for the best matching window of the line's first tokens.
 */
export function alignLyrics(lines: string[], words: TranscribedWord[]): Array<{ time: number; text: string }> {
  const wTokens = words.map((w) => norm(w.text));
  let cursor = 0;
  const out: Array<{ time: number; text: string }> = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // skip section markers like [Chorus]
    if (/^\[[^\]]+\]$/.test(line)) continue;

    const tokens = tokenize(line);
    if (tokens.length === 0) {
      out.push({ time: cursor < words.length ? words[cursor].start : 0, text: line });
      continue;
    }

    const probe = tokens.slice(0, Math.min(4, tokens.length));
    let bestIdx = -1;
    let bestScore = -1;
    const searchEnd = Math.min(wTokens.length, cursor + 400); // window cap

    for (let i = cursor; i < searchEnd; i++) {
      let score = 0;
      for (let k = 0; k < probe.length && i + k < wTokens.length; k++) {
        if (wTokens[i + k] === probe[k]) score += 2;
        else if (wTokens[i + k].startsWith(probe[k].slice(0, 3))) score += 1;
      }
      // bias toward earlier matches
      score -= (i - cursor) * 0.01;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1 || bestScore <= 0) {
      // no match — fall back to interpolation later by setting -1
      out.push({ time: -1, text: line });
    } else {
      out.push({ time: words[bestIdx].start, text: line });
      cursor = bestIdx + tokens.length;
    }
  }

  // interpolate any -1 times
  let lastT = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i].time >= 0) { lastT = out[i].time; continue; }
    let n = -1;
    for (let j = i + 1; j < out.length; j++) if (out[j].time >= 0) { n = j; break; }
    if (n === -1) { out[i].time = lastT + 2; lastT = out[i].time; }
    else { const gap = (out[n].time - lastT) / (n - i + 1); out[i].time = lastT + gap; lastT = out[i].time; }
  }
  return out;
}
