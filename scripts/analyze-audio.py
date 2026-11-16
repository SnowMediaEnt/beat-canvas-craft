"""Measure what a rendered video did to a known test track.

The test track is a steady 440 Hz tone plus a sharp click every 0.5 s. Against
that we can see, for every half-second of the song: how far the click moved
(timing drift), how far the tone's pitch moved (warping), and whether the
level dropped (dropouts). Usage: analyze-audio.py SOURCE.wav OUTPUT.mp4 LABEL
"""
import subprocess, sys
import numpy as np

SR = 44100

def load(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0

def analyse(a):
    slots = int(len(a) / SR / 0.5) - 1
    clicks, tone, level = [], [], []
    for k in range(slots):
        t0 = k * 0.5
        lo, hi = max(0, int((t0 - 0.1) * SR)), int((t0 + 0.25) * SR)
        seg = a[lo:hi]
        idx = np.flatnonzero(np.abs(seg) > 0.8)
        clicks.append((lo + idx[0]) / SR - t0 if len(idx) else None)
        w = a[int((t0 + 0.30) * SR): int((t0 + 0.48) * SR)]
        if len(w) < 2000:
            tone.append(None); level.append(None); continue
        if float(np.sqrt(np.mean(w ** 2))) < 0.005:   # silence: no pitch to measure
            tone.append(None); level.append(0.0); continue
        win = w * np.hanning(len(w))
        spec = np.abs(np.fft.rfft(win, 1 << 18))
        f = np.fft.rfftfreq(1 << 18, 1 / SR)
        m = (f > 400) & (f < 480)
        i = np.argmax(np.where(m, spec, 0))
        if 0 < i < len(spec) - 1:   # parabolic peak interpolation
            y0, y1, y2 = np.log(spec[i - 1] + 1e-12), np.log(spec[i] + 1e-12), np.log(spec[i + 1] + 1e-12)
            d = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2)
        else:
            d = 0.0
        freq = (i + d) * (SR / (1 << 18))
        tone.append(1200 * np.log2(freq / 440.0))
        level.append(float(np.sqrt(np.mean(w ** 2))))
    return clicks, tone, level

def summarize(name, a):
    clicks, tone, level = analyse(a)
    have = [c for c in clicks if c is not None]
    med = float(np.median(have)) if have else 0.0
    missing = [round(k * 0.5, 1) for k, c in enumerate(clicks) if c is None]
    drift = [(k, (c - med) * 1000) for k, c in enumerate(clicks) if c is not None]
    bad_drift = [(round(k * 0.5, 1), round(d, 1)) for k, d in drift if abs(d) > 5]
    tv = [(k, c) for k, c in enumerate(tone) if c is not None]
    bad_tone = [(round(k * 0.5, 1), round(c, 1)) for k, c in tv if abs(c) > 8]
    lv = [x for x in level if x is not None]
    lmed = float(np.median(lv)) if lv else 0.0
    quiet = [round(k * 0.5, 1) for k, x in enumerate(level) if x is not None and x < 0.5 * lmed]
    print(f"  {name:10} length {len(a)/SR:7.3f}s  clicks {len(have)}/{len(clicks)}  start delay {med*1000:+6.1f} ms")
    print(f"  {'':10} timing moves >5 ms at: {bad_drift[:10] or 'never'}  (worst {max((abs(d) for _, d in drift), default=0):.1f} ms)")
    print(f"  {'':10} pitch off >8 cents at: {bad_tone[:10] or 'never'}  (worst {max((abs(c) for _, c in tv), default=0):.1f} cents)")
    print(f"  {'':10} dropouts at: {quiet[:10] or 'none'}   missing clicks at: {missing[:10] or 'none'}")

if __name__ == "__main__":
    src, out, label = sys.argv[1], sys.argv[2], sys.argv[3]
    print(f"=== {label}")
    summarize("source", load(src))
    summarize("rendered", load(out))
