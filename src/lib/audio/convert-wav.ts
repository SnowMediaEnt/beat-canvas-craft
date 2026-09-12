// Browser-side M4A/AAC → WAV conversion. Lambda's audio decoder produces
// near-silent samples for AAC, so the visualizer barely moves in the MP4.
// Decoding in the browser (which handles AAC fine) and uploading PCM removes
// the problem entirely.

function writeString(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

export function audioBufferToWav(buffer: AudioBuffer, maxChannels = 2): Blob {
  const channels = Math.min(maxChannels, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);          // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const chans: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([out], { type: "audio/wav" });
}

/**
 * Decode any browser-supported audio blob and re-encode it as 16-bit WAV.
 * Rejects with a friendly message when the browser can't decode the file.
 */
export async function convertToWav(blob: Blob, fileName: string, onProgress?: (stage: string) => void): Promise<File> {
  onProgress?.("Decoding audio…");
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const bytes = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(bytes.slice(0));
    onProgress?.("Writing WAV…");
    const wav = audioBufferToWav(decoded, 2);
    const base = fileName.replace(/\.[^.]+$/, "") || "audio";
    return new File([wav], `${base}.wav`, { type: "audio/wav" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Couldn't convert this file in your browser (${msg}). Try exporting it as WAV or MP3 from your audio editor.`);
  } finally {
    try { await ctx.close(); } catch { /* ignore */ }
  }
}

export function isAacLike(asset: { type?: string; name?: string } | undefined): boolean {
  if (!asset) return false;
  const t = (asset.type || "").toLowerCase();
  const n = (asset.name || "").toLowerCase();
  return t.includes("m4a") || t.includes("aac") || t.includes("mp4") || t.includes("x-m4a") || n.endsWith(".m4a") || n.endsWith(".aac");
}
