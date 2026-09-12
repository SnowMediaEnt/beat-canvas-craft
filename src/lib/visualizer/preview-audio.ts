// Deterministic synthetic AudioData used for preset thumbnails, the hover
// preview in the preset picker, and any place we need "music-like" motion
// without a real track loaded. Purely a function of time → identical on
// every machine. Emits every musical feature the real engine produces
// (kick/snare/hat envelopes, ages, history) from its own 124 BPM grid.

import type { AudioData } from "./audioEngine";
import { AUDIBLE_MIN_HZ, AUDIBLE_MAX_HZ, BASS_MAX_HZ, MID_MAX_HZ, TREBLE_MAX_HZ, hzToBin, binToHz } from "./audioEngine";
import { HISTORY_BANDS, HISTORY_FRAMES, HISTORY_HOP } from "./onset";

const FREQ_BINS = 512;
const WAVE_LEN = 1024;
const SAMPLE_RATE = 48000;
const BPM = 124;

type U8 = Uint8Array<ArrayBuffer>;

export interface SyntheticOptions {
  /** 0..1 overall energy. Default 0.8. */
  energy?: number;
  /** Tempo in BPM. Default 124. */
  bpm?: number;
  /** Optional deterministic seed for slight variation between callers. */
  seed?: number;
  /** Skip the (moderately expensive) spectral history. Default false. */
  noHistory?: boolean;
}

const beatPhase = (t: number, bpm: number) => {
  const beatLen = 60 / bpm;
  const p = (t % beatLen) / beatLen; // 0..1 inside the beat
  return { p, beatIndex: Math.floor(t / beatLen), beatLen };
};

interface Groove {
  kick: number; snare: number; hat: number; vocal: number; vocalHz: number; bassNoteHz: number;
  kickAge: number; snareAge: number; hatAge: number; beatLen: number; p: number; beatIndex: number;
}

function groove(t: number, bpm: number, seed: number): Groove {
  const { p, beatIndex, beatLen } = beatPhase(Math.max(0, t), bpm);
  const kickAge = p * beatLen;
  const kick = Math.exp(-kickAge / 0.14) * (0.85 + 0.15 * Math.sin(beatIndex * 1.7 + seed));
  const snareOn = beatIndex % 2 === 1;
  const snareAge = snareOn ? kickAge : kickAge + beatLen;
  const snare = Math.exp(-snareAge / 0.18) * 0.9;
  const hatAge = (t % (beatLen / 2)) ;
  const hat = Math.exp(-hatAge / 0.07) * 0.8;
  const vocal = 0.45 + 0.35 * Math.sin(t * 1.3 + seed) * Math.sin(t * 0.37 + 1.2);
  const vocalHz = 600 * Math.pow(2, Math.sin(t * 0.9 + seed * 0.3) * 1.2);
  const bassNoteHz = 55 * Math.pow(2, Math.floor((beatIndex / 4) % 4) / 12 * 3);
  return { kick, snare, hat, vocal, vocalHz, bassNoteHz, kickAge, snareAge, hatAge, beatLen, p, beatIndex };
}

function spectrumAt(t: number, energy: number, g: Groove, seed: number, out: Uint8Array) {
  for (let i = 0; i < out.length; i++) {
    const hz = Math.max(1, binToHz(i, out.length, SAMPLE_RATE));
    // Pink-ish floor: -3 dB/oct.
    let v = 0.16 * Math.pow(60 / hz, 0.28);
    // Sub / kick body 40–120 Hz + bass note harmonics.
    v += g.kick * 0.95 * Math.exp(-Math.pow(Math.log(hz / 62), 2) * 2.2);
    v += 0.5 * Math.exp(-Math.pow(Math.log(hz / g.bassNoteHz), 2) * 6) * (0.6 + g.kick * 0.4);
    v += 0.28 * Math.exp(-Math.pow(Math.log(hz / (g.bassNoteHz * 2)), 2) * 6);
    // Snare 180–260 Hz body + 2–5 kHz crack.
    v += g.snare * 0.55 * Math.exp(-Math.pow(Math.log(hz / 210), 2) * 3);
    v += g.snare * 0.45 * Math.exp(-Math.pow(Math.log(hz / 3300), 2) * 1.6);
    // Vocal formant band.
    v += g.vocal * 0.5 * Math.exp(-Math.pow(Math.log(hz / g.vocalHz), 2) * 1.1);
    v += g.vocal * 0.25 * Math.exp(-Math.pow(Math.log(hz / (g.vocalHz * 2.3)), 2) * 1.4);
    // Hats / air 6–14 kHz.
    v += g.hat * 0.5 * Math.exp(-Math.pow(Math.log(hz / 9000), 2) * 1.2);
    // Subtle shimmer so bars aren't frozen between hits.
    v += 0.03 * (0.5 + 0.5 * Math.sin(i * 0.37 + t * 7.1 + seed));
    v *= energy;
    if (hz > AUDIBLE_MAX_HZ) v *= 0.1;
    if (hz < AUDIBLE_MIN_HZ) v *= 0.3;
    out[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
}

const histBandEdges = (() => {
  const lo = Math.log(30), hi = Math.log(16000);
  const edges: { a: number; b: number }[] = [];
  for (let i = 0; i < HISTORY_BANDS; i++) {
    const hzA = Math.exp(lo + (i / HISTORY_BANDS) * (hi - lo));
    const hzB = Math.exp(lo + ((i + 1) / HISTORY_BANDS) * (hi - lo));
    const a = Math.max(0, Math.min(FREQ_BINS - 1, Math.floor(hzToBin(hzA, FREQ_BINS, SAMPLE_RATE))));
    const b = Math.max(a + 1, Math.min(FREQ_BINS, Math.ceil(hzToBin(hzB, FREQ_BINS, SAMPLE_RATE))));
    edges.push({ a, b });
  }
  return edges;
})();

// History rows are quantised to the 20 ms hop grid and memoised per
// (bpm, seed, energy) so an animating thumbnail only computes 1–2 new rows
// per frame instead of 128 full spectra.
const historyRowCache = new Map<string, Map<number, Uint8Array>>();
const HISTORY_CACHE_ROWS = 4096;

function historyRowAt(hop: number, energy: number, bpm: number, seed: number): Uint8Array {
  const key = `${bpm}|${seed}|${Math.round(energy * 100)}`;
  let rows = historyRowCache.get(key);
  if (!rows) {
    rows = new Map();
    historyRowCache.set(key, rows);
    if (historyRowCache.size > 8) {
      const first = historyRowCache.keys().next().value;
      if (first) historyRowCache.delete(first);
    }
  }
  let row = rows.get(hop);
  if (row) return row;
  const ht = hop * HISTORY_HOP;
  const spectrum = new Uint8Array(FREQ_BINS);
  spectrumAt(ht, energy, groove(ht, bpm, seed), seed, spectrum);
  row = new Uint8Array(HISTORY_BANDS);
  for (let b = 0; b < HISTORY_BANDS; b++) {
    const { a, b: bb } = histBandEdges[b];
    let s = 0;
    for (let q = a; q < bb; q++) s += spectrum[q];
    row[b] = Math.round(s / (bb - a));
  }
  rows.set(hop, row);
  if (rows.size > HISTORY_CACHE_ROWS) {
    const first = rows.keys().next().value;
    if (first !== undefined) rows.delete(first);
  }
  return row;
}

function buildHistory(t: number, energy: number, bpm: number, seed: number): Uint8Array {
  const history = new Uint8Array(HISTORY_FRAMES * HISTORY_BANDS);
  const newestHop = Math.round(t / HISTORY_HOP);
  for (let r = 0; r < HISTORY_FRAMES; r++) {
    const hop = newestHop - (HISTORY_FRAMES - 1 - r);
    history.set(historyRowAt(hop, energy, bpm, seed), r * HISTORY_BANDS);
  }
  return history;
}

/**
 * Build a plausible pop/EDM-like spectrum snapshot at time `t` (seconds).
 * Bass thumps on every beat, a snare-ish mid burst on beats 2 & 4, hats
 * on 8ths, and a slowly wandering "vocal" formant in the 300 Hz–3 kHz range.
 */
export function syntheticAudio(t: number, opts: SyntheticOptions = {}): AudioData {
  const energy = Math.max(0, Math.min(1, opts.energy ?? 0.8));
  const bpm = opts.bpm ?? BPM;
  const seed = opts.seed ?? 0;
  const g = groove(t, bpm, seed);

  const freq = new Uint8Array(new ArrayBuffer(FREQ_BINS)) as U8;
  spectrumAt(t, energy, g, seed, freq);

  const wave = new Uint8Array(new ArrayBuffer(WAVE_LEN)) as U8;
  for (let i = 0; i < WAVE_LEN; i++) {
    const tt = t + i / SAMPLE_RATE;
    const s =
      Math.sin(tt * g.bassNoteHz * Math.PI * 2) * (0.35 + g.kick * 0.45) +
      Math.sin(tt * g.vocalHz * Math.PI * 2) * g.vocal * 0.25 +
      Math.sin(tt * 3300 * Math.PI * 2) * g.snare * 0.15 +
      Math.sin(tt * 9000 * Math.PI * 2 + i) * g.hat * 0.08;
    wave[i] = Math.max(0, Math.min(255, Math.round(128 + s * energy * 110)));
  }

  const sliceAvg = (lo: number, hi: number) => {
    const a = Math.max(0, Math.floor(hzToBin(lo, FREQ_BINS, SAMPLE_RATE)));
    const b = Math.max(a + 1, Math.min(FREQ_BINS, Math.ceil(hzToBin(hi, FREQ_BINS, SAMPLE_RATE))));
    let s = 0;
    for (let i = a; i < b; i++) s += freq[i];
    return s / (b - a) / 255;
  };
  const bass = Math.min(1, sliceAvg(AUDIBLE_MIN_HZ, BASS_MAX_HZ) * 1.3);
  const mid = Math.min(1, sliceAvg(BASS_MAX_HZ, MID_MAX_HZ) * 1.1);
  const treble = Math.min(1, sliceAvg(MID_MAX_HZ, TREBLE_MAX_HZ) * 1.2);
  let sum = 0;
  for (let i = 0; i < FREQ_BINS; i++) sum += freq[i];
  const volume = Math.min(1, (sum / FREQ_BINS / 255) * 1.6);
  const beat = g.p < 0.06;

  let history: Uint8Array | undefined;
  let historyRows: number | undefined;
  if (!opts.noHistory) {
    history = buildHistory(t, energy, bpm, seed);
    historyRows = HISTORY_FRAMES;
  }

  return {
    freq,
    wave,
    bass,
    mid,
    treble,
    volume,
    beat,
    time: t,
    duration: 180,
    sampleRate: SAMPLE_RATE,
    onset: Math.max(g.kick, g.snare * 0.8),
    onsetAge: Math.min(g.kickAge, g.snareAge),
    energy: volume,
    kick: g.kick,
    snare: g.snare,
    hat: g.hat,
    kickAge: g.kickAge,
    snareAge: g.snareAge,
    hatAge: g.hatAge,
    history,
    historyRows,
    dt: 1 / 60,
  };
}

/** A still, "mid-song" snapshot — good for static thumbnails. */
export const THUMBNAIL_AUDIO_TIME = 1.21;
