import { OnsetDetector, HISTORY_BANDS, HISTORY_FRAMES } from "./onset";

type U8 = Uint8Array<ArrayBuffer>;
export interface AudioData {
  freq: U8;
  wave: U8;
  bass: number;   // 0..1
  mid: number;
  treble: number;
  volume: number;
  /** True on the single frame a kick/onset is accepted. */
  beat: boolean;
  time: number;
  duration: number;
  /** Sample rate of the source audio (Hz). Used to map FFT bins to real Hz
   *  so every preset divides the audible 20 Hz – 20 kHz range identically. */
  sampleRate: number;

  // ── Musical features (optional: older code paths / synthetic data may omit them) ──
  /** Onset strength 0..1 for this frame (spectral flux above the adaptive baseline). */
  onset?: number;
  /** Seconds since the last accepted onset (Infinity before the first one). */
  onsetAge?: number;
  /** Slow loudness envelope 0..1 — fast attack, slow release. */
  energy?: number;
  /** Percussive envelopes 0..1: instant attack, exponential release. */
  kick?: number;
  snare?: number;
  hat?: number;
  /** Seconds since the last accepted kick / snare / hat (Infinity before the first). */
  kickAge?: number;
  snareAge?: number;
  hatAge?: number;
  /**
   * Spectral history: HISTORY_FRAMES rows × HISTORY_BANDS bytes (log-spaced
   * 30 Hz–16 kHz), one row every 20 ms, OLDEST row first, newest row last.
   * `historyRows` says how many trailing rows are valid.
   */
  history?: Uint8Array;
  historyRows?: number;
  /** Seconds since the previous analysed frame (preview: measured; render: 1/fps). */
  dt?: number;
}

export { HISTORY_BANDS, HISTORY_FRAMES };

// Audible range used by every visualizer for band division + bass/mid/treble
// slicing. Mid/treble crossover points roughly match human perception of
// kick/snare vs vocal vs cymbal/air.
export const AUDIBLE_MIN_HZ = 20;
export const AUDIBLE_MAX_HZ = 20000;
export const BASS_MAX_HZ = 250;
export const MID_MAX_HZ = 4000;
/** Treble is measured up to 16 kHz: lossy sources (MP3/AAC) carry nothing
 *  above that, which used to halve the treble reading for audible hi-hats. */
export const TREBLE_MAX_HZ = 16000;

/** AnalyserNode fftSize used by the preview. Remotion mirrors it (bins = fftSize / 2). */
export const ANALYSER_FFT_SIZE = 1024;

/** Convert a frequency in Hz to a fractional FFT bin index. */
export function hzToBin(hz: number, freqLen: number, sampleRate: number): number {
  const fftSize = freqLen * 2; // AnalyserNode: frequencyBinCount = fftSize/2
  return (hz * fftSize) / Math.max(1, sampleRate);
}

/** Convert an FFT bin index back to Hz. */
export function binToHz(bin: number, freqLen: number, sampleRate: number): number {
  const fftSize = freqLen * 2;
  return (bin * sampleRate) / Math.max(1, fftSize);
}

/** Silent AudioData with the same array shapes the analyser produces. */
export function emptyAudioData(sampleRate = 48000): AudioData {
  return {
    freq: new Uint8Array(new ArrayBuffer(ANALYSER_FFT_SIZE / 2)) as U8,
    wave: new Uint8Array(new ArrayBuffer(ANALYSER_FFT_SIZE)).fill(128) as U8,
    bass: 0, mid: 0, treble: 0, volume: 0, beat: false, time: 0, duration: 0,
    sampleRate, onset: 0, onsetAge: Number.POSITIVE_INFINITY, energy: 0,
    kick: 0, snare: 0, hat: 0, kickAge: Number.POSITIVE_INFINITY, snareAge: Number.POSITIVE_INFINITY, hatAge: Number.POSITIVE_INFINITY,
    dt: 1 / 60,
  };
}

/**
 * Average the byte spectrum between two real Hz boundaries (0..1). Shared by
 * the preview engine and the Remotion frame builder so bass/mid/treble mean
 * the same thing in both.
 */
export function sliceAverageHz(freq: Uint8Array, loHz: number, hiHz: number, sampleRate: number): number {
  const len = freq.length;
  if (!len) return 0;
  const lo = Math.max(0, Math.min(len - 1, Math.floor(hzToBin(loHz, len, sampleRate))));
  const hi = Math.max(lo + 1, Math.min(len, Math.ceil(hzToBin(hiHz, len, sampleRate))));
  let s = 0;
  for (let i = lo; i < hi; i++) s += freq[i];
  return (s / Math.max(1, hi - lo)) / 255;
}

/**
 * Loudness 0..1 as the mean of 24 log-spaced bands (20 Hz–16 kHz). Averaging
 * the raw linear bins let the ~80 % of bins above 4 kHz dominate, so `volume`
 * measured cymbal density and codec bandwidth instead of loudness.
 */
export function logBandLoudness(freq: Uint8Array, sampleRate: number): number {
  const len = freq.length;
  if (!len) return 0;
  const count = 24;
  const lo = Math.log(AUDIBLE_MIN_HZ);
  const hi = Math.log(Math.min(sampleRate / 2, TREBLE_MAX_HZ));
  let total = 0;
  for (let i = 0; i < count; i++) {
    const hzA = Math.exp(lo + (i / count) * (hi - lo));
    const hzB = Math.exp(lo + ((i + 1) / count) * (hi - lo));
    total += sliceAverageHz(freq, hzA, hzB, sampleRate);
  }
  return total / count;
}

/**
 * Soft limiter for gained levels: identical below 0.8, then eases toward 1
 * instead of flat-topping (a pinned 1.0 made bass pulses disappear in loud
 * sections when sensitivity was raised).
 */
export function softClip01(v: number): number {
  if (!(v > 0)) return 0;
  if (v < 0.8) return v;
  return 0.8 + 0.2 * (1 - Math.exp(-(v - 0.8) / 0.2));
}

export interface Sensitivity { master: number; bass: number; mid: number; treble: number }

/**
 * Derive bass/mid/treble/volume from a byte spectrum with the user's
 * sensitivity gains. Used verbatim by the preview engine and the Remotion
 * frame builder.
 */
export function bandMetrics(freq: Uint8Array, sampleRate: number, sens: Sensitivity) {
  const bass = softClip01(sliceAverageHz(freq, AUDIBLE_MIN_HZ, BASS_MAX_HZ, sampleRate) * sens.bass * sens.master);
  const mid = softClip01(sliceAverageHz(freq, BASS_MAX_HZ, MID_MAX_HZ, sampleRate) * sens.mid * sens.master);
  const treble = softClip01(sliceAverageHz(freq, MID_MAX_HZ, TREBLE_MAX_HZ, sampleRate) * sens.treble * sens.master);
  const rawVolume = logBandLoudness(freq, sampleRate);
  const volume = softClip01(rawVolume * sens.master);
  return { bass, mid, treble, volume, rawVolume };
}

export class AudioEngine {
  ctx: AudioContext;
  el: HTMLAudioElement;
  analyser: AnalyserNode;
  src: MediaElementAudioSourceNode;
  dest: MediaStreamAudioDestinationNode;
  freq: U8;
  wave: U8;
  private tracker = new OnsetDetector();
  private lastReadAt = 0;

  constructor(el: HTMLAudioElement, smoothing = 0.5) {
    this.el = el;
    // `latencyHint: "interactive"` asks the browser for the smallest stable
    // output buffer, which shrinks the gap between sample playback and the
    // analyser's view of that sample.
    const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    this.ctx = new Ctx({ latencyHint: "interactive" });
    this.src = this.ctx.createMediaElementSource(el);
    this.analyser = this.ctx.createAnalyser();
    // Smaller FFT = shorter analysis window = faster visual reaction.
    // 1024 samples ≈ 21ms @ 48kHz vs 2048 ≈ 43ms.
    this.analyser.fftSize = ANALYSER_FFT_SIZE;
    this.analyser.smoothingTimeConstant = smoothing;
    this.dest = this.ctx.createMediaStreamDestination();
    this.src.connect(this.analyser);
    this.src.connect(this.dest);
    this.analyser.connect(this.ctx.destination);
    this.freq = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.wave = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
  }

  setSmoothing(v: number) { this.analyser.smoothingTimeConstant = Math.max(0, Math.min(0.99, v)); }

  async resume() { if (this.ctx.state === "suspended") await this.ctx.resume(); }

  read(sens: Sensitivity = { master: 1, bass: 1, mid: 1, treble: 1 }): AudioData {
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.wave);
    const sr = this.ctx.sampleRate;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const dt = this.lastReadAt ? Math.max(0.001, Math.min(0.25, (now - this.lastReadAt) / 1000)) : 1 / 60;
    this.lastReadAt = now;

    const m = bandMetrics(this.freq, sr, sens);

    // Feature tracking runs on the UNSCALED spectrum so the sensitivity
    // sliders change how big things move, not whether a hit is detected.
    const f = this.tracker.update(this.freq, this.el.currentTime, m.rawVolume, sr);

    return {
      freq: this.freq, wave: this.wave, bass: m.bass, mid: m.mid, treble: m.treble, volume: m.volume,
      beat: f.beat, time: this.el.currentTime, duration: this.el.duration || 0, sampleRate: sr,
      onset: f.onset, onsetAge: f.onsetAge, energy: softClip01(f.energy * sens.master),
      kick: f.kick, snare: f.snare, hat: f.hat, kickAge: f.kickAge, snareAge: f.snareAge, hatAge: f.hatAge,
      history: this.tracker.history, historyRows: this.tracker.historyRows,
      dt,
    };
  }

  destroy() { try { this.src.disconnect(); this.analyser.disconnect(); this.ctx.close(); } catch { /* ignore */ } }
}
