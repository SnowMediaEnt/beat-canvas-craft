// A tiny radix-2 FFT that reproduces what the browser's AnalyserNode does
// in getByteFrequencyData(): Blackman window → FFT → magnitude / fftSize →
// exponential smoothing → dB → byte in [minDecibels, maxDecibels].
//
// The Remotion render used @remotion/media-utils' visualizeAudio(), which
// uses a rectangular window, a different normalisation and averages the
// previous/next frames. That produced brighter, smeared spectra compared to
// the preview. Running THIS on the decoded samples makes the MP4 respond to
// the music exactly like the editor does.

const twiddleCache = new Map<number, { cos: Float32Array; sin: Float32Array; rev: Uint32Array }>();

function tables(n: number) {
  let t = twiddleCache.get(n);
  if (t) return t;
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  t = { cos, sin, rev };
  twiddleCache.set(n, t);
  return t;
}

const windowCache = new Map<number, Float32Array>();
/** Blackman window (same coefficients as Chromium's RealtimeAnalyser). */
function blackman(n: number) {
  let w = windowCache.get(n);
  if (w) return w;
  w = new Float32Array(n);
  const a0 = 0.42, a1 = 0.5, a2 = 0.08;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    w[i] = a0 - a1 * Math.cos(2 * Math.PI * x) + a2 * Math.cos(4 * Math.PI * x);
  }
  windowCache.set(n, w);
  return w;
}

/**
 * In-place iterative FFT on (re, im). Length must be a power of two.
 */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  const { cos, sin, rev } = tables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const i = start + k, j = i + half;
        const xr = re[j] * wr - im[j] * wi;
        const xi = re[j] * wi + im[j] * wr;
        re[j] = re[i] - xr; im[j] = im[i] - xi;
        re[i] += xr;        im[i] += xi;
      }
    }
  }
}

export interface AnalyserState {
  /** Smoothed linear magnitudes from the previous call (length fftSize/2). */
  smoothed: Float32Array | null;
}

export interface AnalyserOptions {
  fftSize: number;               // e.g. 1024
  smoothingTimeConstant: number; // 0..0.99
  minDecibels?: number;          // default -100
  maxDecibels?: number;          // default -30
}

/**
 * Compute AnalyserNode-equivalent byte frequency data for the fftSize samples
 * ENDING at `endSample` (AnalyserNode analyses the most recent buffer).
 * Missing samples (before 0 / after the end) are treated as silence.
 */
export function analyserBytes(
  samples: Float32Array,
  endSample: number,
  opts: AnalyserOptions,
  state: AnalyserState,
  out?: Uint8Array,
): Uint8Array {
  const n = opts.fftSize;
  const bins = n / 2;
  const minDb = opts.minDecibels ?? -100;
  const maxDb = opts.maxDecibels ?? -30;
  const k = Math.max(0, Math.min(0.99, opts.smoothingTimeConstant));
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const win = blackman(n);
  const start = Math.floor(endSample) - n;
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    const s = idx >= 0 && idx < samples.length ? samples[idx] : 0;
    re[i] = s * win[i];
  }
  fft(re, im);
  if (!state.smoothed || state.smoothed.length !== bins) state.smoothed = new Float32Array(bins);
  const sm = state.smoothed;
  const scale = 1 / n;
  const result = out && out.length === bins ? out : new Uint8Array(bins);
  const range = maxDb - minDb;
  for (let i = 0; i < bins; i++) {
    const mag = Math.hypot(re[i], im[i]) * scale;
    // AnalyserNode smooths the *linear* magnitude, then converts to dB.
    const v = k * sm[i] + (1 - k) * mag;
    sm[i] = Number.isFinite(v) ? v : 0;
    const db = sm[i] > 0 ? 20 * Math.log10(sm[i]) : -Infinity;
    let byte = 0;
    if (db > minDb) byte = db >= maxDb ? 255 : Math.round(((db - minDb) / range) * 255);
    result[i] = byte;
  }
  return result;
}

/**
 * AnalyserNode-equivalent byte time-domain data: the last fftSize samples
 * ending at `endSample`, mapped to 128 ± 127.
 */
export function analyserWaveBytes(samples: Float32Array, endSample: number, fftSize: number, out?: Uint8Array): Uint8Array {
  const result = out && out.length === fftSize ? out : new Uint8Array(fftSize);
  const start = Math.floor(endSample) - fftSize;
  for (let i = 0; i < fftSize; i++) {
    const idx = start + i;
    const s = idx >= 0 && idx < samples.length ? samples[idx] : 0;
    result[i] = Math.max(0, Math.min(255, Math.round(128 + s * 127)));
  }
  return result;
}

/** Mix an arbitrary number of channels down to mono, once per render. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const len = channels[0].length;
  const out = new Float32Array(len);
  const inv = 1 / channels.length;
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    for (let i = 0; i < len; i++) out[i] += ch[i] * inv;
  }
  return out;
}
