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
/**
 * dB window the flux bands are normalised over when the caller supplies the
 * float (dB) spectrum. The byte spectrum only spans -100..-30 dB and pins at
 * 255 for any bin louder than -30 dB — i.e. for most bass in mastered music —
 * so a kick on top of a bass note produced zero flux and was never detected.
 */
const DB_FLOOR = -84;
const DB_RANGE = 84;
const HISTORY_SECONDS = 1.1;
const THRESHOLD_FLOOR = 0.012;
const ENERGY_ATTACK = 0.08;
const ENERGY_RELEASE = 0.65;

type Band = { a: number; b: number; weight: number };

interface HitDetector {
  /** Band indices (into the 24 flux bands) that feed this detector (broadband onset). */
  bands: number[];
  /**
   * Hz ranges feeding this detector (percussive detectors). Resolved to raw
   * FFT bins in ensureBands(): with a 1024-point FFT a bin is ~43-47 Hz wide,
   * so log bands below ~150 Hz all collapse onto bins 0-2 (DC + one bass
   * bin) and a kick's real energy (60-180 Hz) never reached the "kick" bands.
   */
  hz: [number, number][];
  /** FFT bins resolved from `hz` (DC bin excluded). */
  bins: number[];
  /**
   * Optional second Hz group. When present the detector's flux is the
   * geometric mean of both groups, so it only fires when BOTH move — a snare
   * has body (200-500 Hz) and crack (2-6 kHz) at once, a kick has no crack
   * and a hat has no body.
   */
  hz2: [number, number][];
  bins2: number[];
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

const makeHit = (
  bands: number[], hz: [number, number][], k: number, floor: number, minInterval: number, release: number,
  hz2: [number, number][] = [],
): HitDetector => ({
  bands, hz, bins: [], hz2, bins2: [], k, floor, minInterval, release, histT: [], histF: [], prevFlux: 0, lastHit: -Infinity, env: 0,
});

/** Unique FFT bins (excluding DC) covering the given Hz ranges. */
function binsForHz(ranges: [number, number][], freqLen: number, sampleRate: number): number[] {
  const set = new Set<number>();
  for (const [lo, hi] of ranges) {
    const a = Math.max(1, Math.floor(hzToBin(lo, freqLen, sampleRate)));
    const b = Math.min(freqLen - 1, Math.ceil(hzToBin(hi, freqLen, sampleRate)));
    for (let k = a; k <= Math.max(a, b); k++) set.add(k);
  }
  return Array.from(set).sort((x, y) => x - y);
}

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

function runHit(d: HitDetector, flux: number, time: number, dt: number): { value: number; hit: boolean; age: number } {
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
  // Broadband onset over the 24 weighted log bands.
  private onset = makeHit([...Array(FLUX_BANDS).keys()], [], 1.35, THRESHOLD_FLOOR, 0.11, 0.25);
  // Percussive detectors on raw FFT bins covering musical ranges:
  //   kick 40–180 Hz · snare 180–500 Hz body + 2–6 kHz crack · hats 6–16 kHz
  private kick = makeHit([], [[40, 180]], 1.3, 0.02, 0.09, 0.14);
  private snare = makeHit([], [[200, 500]], 1.45, 0.015, 0.08, 0.18, [[2000, 6000]]);
  private hat = makeHit([], [[6000, 16000]], 1.4, 0.01, 0.05, 0.07);
  private prevLvl: Float32Array | null = null;
  private prevPeak = 0;
  private binFlux: Float32Array | null = null;
  /** Ring buffer: HISTORY_FRAMES rows × HISTORY_BANDS bytes, oldest first. */
  readonly history = new Uint8Array(HISTORY_FRAMES * HISTORY_BANDS);
  private historyFilled = 0;
  private lastHistoryTime = -Infinity;

  reset() {
    this.prevBands = null;
    this.prevLvl = null;
    this.prevPeak = 0;
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
    for (const d of [this.kick, this.snare, this.hat]) {
      d.bins = binsForHz(d.hz, freqLen, sampleRate);
      d.bins2 = binsForHz(d.hz2, freqLen, sampleRate);
    }
    this.prevLvl = null;
    this.bandsKey = key;
  }

  /** Number of valid rows at the END of `history` (rows before that are zero). */
  get historyRows(): number { return this.historyFilled; }

  /**
   * @param freq   byte spectrum (0..255), AnalyserNode-compatible — feeds the
   *               spectral history used by waterfall/terrain presets
   * @param time   seconds on the audio clock
   * @param volume 0..1 loudness estimate for this frame
   * @param db     optional float spectrum in dB (getFloatFrequencyData /
   *               analyserBytes' outDb). When present the onset, kick, snare
   *               and hat detectors read it instead of the clipped bytes.
   */
  update(freq: Uint8Array, time: number, volume: number, sampleRate = 48000, db?: Float32Array | null): FeatureFrame {
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

    // Per-bin level 0..1 (wide-range dB when available, else the bytes) and
    // its positive change since the previous frame (per-bin spectral flux).
    const useDb = !!db && db.length === len;
    const lvl = new Float32Array(len);
    for (let q = 0; q < len; q++) {
      const v = useDb ? (db![q] - DB_FLOOR) / DB_RANGE : freq[q] / 255;
      lvl[q] = v > 0 ? (v < 1 ? v : 1) : 0;
    }
    let peak = 0;
    for (let q = 1; q < len; q++) if (lvl[q] > peak) peak = lvl[q];
    if (!this.binFlux || this.binFlux.length !== len) this.binFlux = new Float32Array(len);
    const binFlux = this.binFlux;
    // The jump out of silence (song start, first frame after a seek) is not a
    // drum hit; feeding it to the detectors inflated their adaptive thresholds
    // for the next second and swallowed the first real kicks.
    const fromSilence = this.prevPeak < 0.05;
    if (this.prevLvl && this.prevLvl.length === len && !fromSilence) {
      for (let q = 0; q < len; q++) { const d = lvl[q] - this.prevLvl[q]; binFlux[q] = d > 0 ? d : 0; }
    } else {
      binFlux.fill(0);
    }
    this.prevLvl = lvl;
    this.prevPeak = peak;

    // 24 log bands for the broadband onset (bass-weighted).
    const bands = new Float32Array(FLUX_BANDS);
    for (let i = 0; i < FLUX_BANDS; i++) {
      const { a, b } = fluxBands[i];
      let s = 0;
      for (let q = a; q < b; q++) s += lvl[q];
      bands[i] = s / Math.max(1, b - a);
    }
    let flux = 0;
    const bf = this.bandFlux;
    if (this.prevBands && !fromSilence) {
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

    const meanBinFlux = (bins: number[]) => {
      if (!bins.length) return 0;
      let s = 0;
      for (const q of bins) s += binFlux[q];
      return s / bins.length;
    };
    let onFlux = 0;
    for (const i of this.onset.bands) onFlux += bf[i];
    onFlux /= Math.max(1, this.onset.bands.length);

    const detFlux = (d: HitDetector) =>
      d.bins2.length ? Math.sqrt(meanBinFlux(d.bins) * meanBinFlux(d.bins2)) : meanBinFlux(d.bins);
    const on = runHit(this.onset, onFlux, time, dt);
    const k = runHit(this.kick, detFlux(this.kick), time, dt);
    const s = runHit(this.snare, detFlux(this.snare), time, dt);
    const h = runHit(this.hat, detFlux(this.hat), time, dt);

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
