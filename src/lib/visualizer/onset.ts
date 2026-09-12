// Musical feature tracker shared by the live preview (AudioEngine) and the
// Remotion render (VisualizerComp). Turns the raw byte spectrum into signals
// presets can dance to:
//
//   onset / beat / onsetAge   broadband spectral-flux onsets (adaptive threshold)
//   kick / snare / hat        percussive envelopes (instant attack, exp release)
//   kickAge / snareAge / hatAge   seconds since the last accepted hit
//   energy                    slow loudness envelope (fast attack, slow release)
//   history                   ring buffer of the last HISTORY_FRAMES log-band
//                             spectra sampled every HISTORY_HOP seconds
//                             (newest row last) for waterfall/terrain presets
//
// Everything is expressed in seconds so 30 / 60 / 120 fps renders and the
// ~60 Hz preview behave identically. The tracker is a pure function of the
// sequence of frames it has seen; Remotion warms it up with the preceding
// frames at the start of every chunk (see VisualizerComp).

import { AUDIBLE_MIN_HZ, hzToBin } from "./audioEngine";

export interface FeatureFrame {
  onset: number;
  beat: boolean;
  onsetAge: number;
  energy: number;
  kick: number;
  snare: number;
  hat: number;
  kickAge: number;
  snareAge: number;
  hatAge: number;
  /** Raw (weighted) spectral flux this frame — handy for debugging/tuning. */
  flux: number;
}

export const HISTORY_BANDS = 64;
export const HISTORY_FRAMES = 128;
/** Seconds between history rows (50 Hz). 128 rows ≈ 2.56 s of song. */
export const HISTORY_HOP = 0.02;
/** Seconds of history the tracker needs to be fully warm. */
export const TRACKER_WARMUP_SECONDS = HISTORY_FRAMES * HISTORY_HOP + 0.2;

const FLUX_BANDS = 24;
const HISTORY_SECONDS = 1.1;
const THRESHOLD_FLOOR = 0.012;
const ENERGY_ATTACK = 0.08;
const ENERGY_RELEASE = 0.65;

type Band = { a: number; b: number; weight: number };

interface HitDetector {
  /** Band indices (into the 24 flux bands) that feed this detector. */
  bands: number[];
  k: number;           // threshold multiplier (mean + k·std)
  floor: number;       // minimum threshold
  minInterval: number; // seconds between accepted hits
  release: number;     // envelope release time constant (s)
  // state
  histT: number[];
  histF: number[];
  prevFlux: number;
  lastHit: number;
  env: number;
}

const makeHit = (bands: number[], k: number, floor: number, minInterval: number, release: number): HitDetector => ({
  bands, k, floor, minInterval, release, histT: [], histF: [], prevFlux: 0, lastHit: -Infinity, env: 0,
});

function logBands(count: number, loHz: number, hiHz: number, freqLen: number, sampleRate: number): Band[] {
  const nyquist = sampleRate / 2;
  const lo = Math.log(loHz);
  const hi = Math.log(Math.min(nyquist, hiHz));
  const out: Band[] = [];
  for (let i = 0; i < count; i++) {
    const hzA = Math.exp(lo + (i / count) * (hi - lo));
    const hzB = Math.exp(lo + ((i + 1) / count) * (hi - lo));
    const a = Math.max(0, Math.min(freqLen - 1, Math.floor(hzToBin(hzA, freqLen, sampleRate))));
    const b = Math.max(a + 1, Math.min(freqLen, Math.ceil(hzToBin(hzB, freqLen, sampleRate))));
    out.push({ a, b, weight: 1 });
  }
  return out;
}

function runHit(d: HitDetector, bandFlux: Float32Array, time: number, dt: number): { value: number; hit: boolean; age: number } {
  let flux = 0;
  for (const i of d.bands) flux += bandFlux[i];
  flux /= Math.max(1, d.bands.length);
  d.histT.push(time);
  d.histF.push(flux);
  while (d.histT.length && time - d.histT[0] > HISTORY_SECONDS) { d.histT.shift(); d.histF.shift(); }
  const n = d.histF.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += d.histF[i];
  mean /= Math.max(1, n);
  let variance = 0;
  for (let i = 0; i < n; i++) { const x = d.histF[i] - mean; variance += x * x; }
  const std = Math.sqrt(variance / Math.max(1, n));
  const threshold = Math.max(d.floor, mean + d.k * std);
  const over = flux - threshold;
  const strength = over > 0 ? Math.min(1, (over / Math.max(threshold, 0.02)) * 0.9) : 0;
  let hit = false;
  if (n >= 6 && strength > 0 && flux >= d.prevFlux && time - d.lastHit >= d.minInterval) {
    hit = true;
    d.lastHit = time;
    d.env = Math.max(d.env, 0.35 + 0.65 * strength);
  }
  d.prevFlux = flux;
  // Exponential release toward zero.
  d.env *= Math.exp(-dt / d.release);
  if (d.env < 0.002) d.env = 0;
  return { value: d.env, hit, age: Number.isFinite(d.lastHit) ? Math.max(0, time - d.lastHit) : Number.POSITIVE_INFINITY };
}

export class OnsetDetector {
  private prevBands: Float32Array | null = null;
  private bandFlux = new Float32Array(FLUX_BANDS);
  private lastTime = -Infinity;
  private energyEnv = 0;
  private fluxBands: Band[] | null = null;
  private histBands: Band[] | null = null;
  private bandsKey = "";
  // Broadband onset
  private onset = makeHit([...Array(FLUX_BANDS).keys()], 1.35, THRESHOLD_FLOOR, 0.11, 0.25);
  // Percussive detectors on band subsets (24 log bands 20 Hz → 16 kHz):
  //   0-5 ≈ 20–150 Hz (kick), 6-9 ≈ 150–400 Hz + 15-19 ≈ 2–6 kHz (snare body + crack), 20-23 ≈ 6–16 kHz (hats)
  private kick = makeHit([0, 1, 2, 3, 4, 5], 1.3, 0.02, 0.09, 0.14);
  private snare = makeHit([6, 7, 8, 9, 15, 16, 17, 18, 19], 1.45, 0.015, 0.08, 0.18);
  private hat = makeHit([20, 21, 22, 23], 1.4, 0.01, 0.05, 0.07);
  /** Ring buffer: HISTORY_FRAMES rows × HISTORY_BANDS bytes, oldest first. */
  readonly history = new Uint8Array(HISTORY_FRAMES * HISTORY_BANDS);
  private historyFilled = 0;
  private lastHistoryTime = -Infinity;

  reset() {
    this.prevBands = null;
    this.lastTime = -Infinity;
    this.energyEnv = 0;
    for (const d of [this.onset, this.kick, this.snare, this.hat]) {
      d.histT = []; d.histF = []; d.prevFlux = 0; d.lastHit = -Infinity; d.env = 0;
    }
    this.history.fill(0);
    this.historyFilled = 0;
    this.lastHistoryTime = -Infinity;
  }

  private ensureBands(freqLen: number, sampleRate: number) {
    const key = `${freqLen}:${sampleRate}`;
    if (this.fluxBands && this.histBands && this.bandsKey === key) return;
    this.fluxBands = logBands(FLUX_BANDS, AUDIBLE_MIN_HZ, 16000, freqLen, sampleRate);
    // Kick/snare live low; weight the bottom third ×2 in the broadband flux so drops land harder.
    this.fluxBands.forEach((b, i) => { b.weight = i < FLUX_BANDS / 3 ? 2 : i < (2 * FLUX_BANDS) / 3 ? 1.2 : 0.8; });
    this.histBands = logBands(HISTORY_BANDS, 30, 16000, freqLen, sampleRate);
    this.bandsKey = key;
  }

  /** Number of valid rows at the END of `history` (rows before that are zero). */
  get historyRows(): number { return this.historyFilled; }

  /**
   * @param freq   byte spectrum (0..255), AnalyserNode-compatible
   * @param time   seconds on the audio clock
   * @param volume 0..1 loudness estimate for this frame
   */
  update(freq: Uint8Array, time: number, volume: number, sampleRate = 48000): FeatureFrame {
    const len = Math.max(1, freq.length);
    this.ensureBands(len, sampleRate);
    const fluxBands = this.fluxBands!;
    const histBands = this.histBands!;

    // Seeking backwards (scrub) or a big jump → fresh start.
    if (Number.isFinite(this.lastTime) && (time < this.lastTime - 0.05 || time - this.lastTime > 1.5)) {
      this.reset();
    }
    const dt = Number.isFinite(this.lastTime) ? Math.max(0.0005, Math.min(0.5, time - this.lastTime)) : 1 / 60;
    this.lastTime = time;

    const bands = new Float32Array(FLUX_BANDS);
    for (let i = 0; i < FLUX_BANDS; i++) {
      const { a, b } = fluxBands[i];
      let s = 0;
      for (let k = a; k < b; k++) s += freq[k];
      bands[i] = s / Math.max(1, b - a) / 255;
    }

    let flux = 0;
    const bf = this.bandFlux;
    if (this.prevBands) {
      for (let i = 0; i < FLUX_BANDS; i++) {
        const d = bands[i] - this.prevBands[i];
        bf[i] = d > 0 ? d : 0;
        flux += bf[i] * fluxBands[i].weight;
      }
      flux /= FLUX_BANDS;
    } else {
      bf.fill(0);
    }
    this.prevBands = bands;

    const on = runHit(this.onset, bf, time, dt);
    const k = runHit(this.kick, bf, time, dt);
    const s = runHit(this.snare, bf, time, dt);
    const h = runHit(this.hat, bf, time, dt);

    // Loudness envelope with attack/release.
    const v = Math.max(0, Math.min(1, volume));
    const tau = v > this.energyEnv ? ENERGY_ATTACK : ENERGY_RELEASE;
    this.energyEnv += (v - this.energyEnv) * (1 - Math.exp(-dt / tau));

    // History rows at a fixed 50 Hz cadence (time-based, fps independent).
    if (!Number.isFinite(this.lastHistoryTime) || time - this.lastHistoryTime >= HISTORY_HOP - 1e-6) {
      const rowsToAdd = Number.isFinite(this.lastHistoryTime)
        ? Math.min(HISTORY_FRAMES, Math.max(1, Math.round((time - this.lastHistoryTime) / HISTORY_HOP)))
        : 1;
      const row = new Uint8Array(HISTORY_BANDS);
      for (let i = 0; i < HISTORY_BANDS; i++) {
        const { a, b } = histBands[i];
        let sum = 0;
        for (let q = a; q < b; q++) sum += freq[q];
        row[i] = Math.max(0, Math.min(255, Math.round(sum / Math.max(1, b - a))));
      }
      // Shift left by rowsToAdd rows and append (repeat the row to fill gaps).
      this.history.copyWithin(0, rowsToAdd * HISTORY_BANDS);
      for (let r = 0; r < rowsToAdd; r++) {
        this.history.set(row, (HISTORY_FRAMES - rowsToAdd + r) * HISTORY_BANDS);
      }
      this.historyFilled = Math.min(HISTORY_FRAMES, this.historyFilled + rowsToAdd);
      this.lastHistoryTime = Number.isFinite(this.lastHistoryTime) ? this.lastHistoryTime + rowsToAdd * HISTORY_HOP : time;
    }

    // Use the strongest of onset/kick as the legacy "beat" trigger so
    // sustained bass no longer keeps rings inflated while kicks barely pop.
    const beat = k.hit || (on.hit && k.age > 0.05);

    return {
      onset: Math.max(on.value, k.value),
      beat,
      onsetAge: Math.min(on.age, k.age),
      energy: this.energyEnv,
      kick: k.value,
      snare: s.value,
      hat: h.value,
      kickAge: k.age,
      snareAge: s.age,
      hatAge: h.age,
      flux,
    };
  }
}
