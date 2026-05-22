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
}

export class AudioEngine {
  ctx: AudioContext;
  el: HTMLAudioElement;
  analyser: AnalyserNode;
  src: MediaElementAudioSourceNode;
  freq: U8;
  wave: U8;
  private lastBass = 0;
  private beatCooldown = 0;

  constructor(el: HTMLAudioElement, smoothing = 0.78) {
    this.el = el;
    this.ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    this.src = this.ctx.createMediaElementSource(el);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = smoothing;
    this.src.connect(this.analyser);
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
    const sliceAvg = (a: number, b: number) => {
      let s = 0; const lo = Math.floor(a * len), hi = Math.floor(b * len);
      for (let i = lo; i < hi; i++) s += this.freq[i];
      return (s / Math.max(1, hi - lo)) / 255;
    };
    const bass = Math.min(1, sliceAvg(0, 0.08) * sens.bass * sens.master);
    const mid = Math.min(1, sliceAvg(0.08, 0.4) * sens.mid * sens.master);
    const treble = Math.min(1, sliceAvg(0.4, 1) * sens.treble * sens.master);
    let sum = 0; for (let i = 0; i < len; i++) sum += this.freq[i];
    const volume = Math.min(1, (sum / len / 255) * sens.master);
    let beat = false;
    if (this.beatCooldown > 0) this.beatCooldown--;
    if (bass > 0.55 && bass > this.lastBass * 1.25 && this.beatCooldown === 0) { beat = true; this.beatCooldown = 8; }
    this.lastBass = bass;
    return { freq: this.freq, wave: this.wave, bass, mid, treble, volume, beat, time: this.el.currentTime, duration: this.el.duration || 0 };
  }

  destroy() { try { this.src.disconnect(); this.analyser.disconnect(); this.ctx.close(); } catch { /* ignore */ } }
}
