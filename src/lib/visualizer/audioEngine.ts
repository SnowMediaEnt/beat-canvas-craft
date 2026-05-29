type U8 = Uint8Array<ArrayBuffer>;
export interface AudioData {
  freq: U8;
  wave: U8;
  bass: number;   // 0..1
  mid: number;
  treble: number;
  volume: number;
  beat: boolean;
  time: number;
  duration: number;
  /** Sample rate of the source audio (Hz). Used to map FFT bins to real Hz
   *  so every preset divides the audible 20 Hz – 20 kHz range identically. */
  sampleRate: number;
}

// Audible range used by every visualizer for band division + bass/mid/treble
// slicing. Mid/treble crossover points roughly match human perception of
// kick/snare vs vocal vs cymbal/air.
export const AUDIBLE_MIN_HZ = 20;
export const AUDIBLE_MAX_HZ = 20000;
export const BASS_MAX_HZ = 250;
export const MID_MAX_HZ = 4000;

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

export class AudioEngine {
  ctx: AudioContext;
  el: HTMLAudioElement;
  analyser: AnalyserNode;
  src: MediaElementAudioSourceNode;
  dest: MediaStreamAudioDestinationNode;
  freq: U8;
  wave: U8;
  private lastBass = 0;
  private beatCooldown = 0;

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
    this.analyser.fftSize = 1024;
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

  read(sens = { master: 1, bass: 1, mid: 1, treble: 1 }): AudioData {
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.wave);
    const len = this.freq.length;
    const sr = this.ctx.sampleRate;
    // Average bins between two real Hz boundaries. Mapping Hz → bin uses
    // the analyser's sample rate so the same crossover points hold for
    // any audio file (44.1k, 48k, etc.).
    const sliceAvgHz = (loHz: number, hiHz: number) => {
      const lo = Math.max(0, Math.min(len - 1, Math.floor(hzToBin(loHz, len, sr))));
      const hi = Math.max(lo + 1, Math.min(len, Math.ceil(hzToBin(hiHz, len, sr))));
      let s = 0;
      for (let i = lo; i < hi; i++) s += this.freq[i];
      return (s / Math.max(1, hi - lo)) / 255;
    };
    const bass = Math.min(1, sliceAvgHz(AUDIBLE_MIN_HZ, BASS_MAX_HZ) * sens.bass * sens.master);
    const mid = Math.min(1, sliceAvgHz(BASS_MAX_HZ, MID_MAX_HZ) * sens.mid * sens.master);
    const treble = Math.min(1, sliceAvgHz(MID_MAX_HZ, AUDIBLE_MAX_HZ) * sens.treble * sens.master);
    let sum = 0; for (let i = 0; i < len; i++) sum += this.freq[i];
    const volume = Math.min(1, (sum / len / 255) * sens.master);
    let beat = false;
    if (this.beatCooldown > 0) this.beatCooldown--;
    if (bass > 0.55 && bass > this.lastBass * 1.25 && this.beatCooldown === 0) { beat = true; this.beatCooldown = 8; }
    this.lastBass = bass;
    return { freq: this.freq, wave: this.wave, bass, mid, treble, volume, beat, time: this.el.currentTime, duration: this.el.duration || 0, sampleRate: sr };
  }

  destroy() { try { this.src.disconnect(); this.analyser.disconnect(); this.ctx.close(); } catch { /* ignore */ } }
}
