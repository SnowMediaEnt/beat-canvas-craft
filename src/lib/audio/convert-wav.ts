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

/**
 * A WAV above this size is not worth uploading: the upload goes through a
 * server with limited memory, so a very long song falls back to the original
 * file instead of risking a failed upload.
 */
export const MAX_RENDER_WAV_BYTES = 90 * 1024 * 1024;

export interface PreparedRenderAudio {
  /** What to upload: a clean WAV, or the original file when conversion is not possible. */
  file: File;
  /** True length of the song as decoded — not the header guess. 0 when it could not be decoded. */
  durationSeconds: number;
  /** Whether `file` is a freshly written WAV. */
  converted: boolean;
}

function looksLikeWav(blob: Blob, fileName: string) {
  const t = (blob.type || "").toLowerCase();
  return t.includes("wav") || t.includes("wave") || /\.wav$/i.test(fileName);
}

/**
 * Get a song ready for the cloud renderer.
 *
 * Measured against a real render: an MP3 saved as variable bitrate without a
 * header reports itself as ~1.2 s shorter than it is (more on a full song), so
 * both the browser and Remotion cut the ending off; and every MP3's decoder
 * delay puts the sound 40-70 ms behind the visuals, which are driven by the
 * browser's trimmed decode. Decoding once here and uploading the PCM gives
 * the renderer exactly the samples the preview plays and the visuals follow.
 */
export async function prepareAudioForRender(
  blob: Blob,
  fileName: string,
  onProgress?: (stage: string) => void,
): Promise<PreparedRenderAudio> {
  const original = new File([blob], fileName || "audio", { type: blob.type || "application/octet-stream" });
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    onProgress?.("Reading the audio…");
    const decoded = await ctx.decodeAudioData((await blob.arrayBuffer()).slice(0));
    const durationSeconds = decoded.length / decoded.sampleRate;
    if (looksLikeWav(blob, fileName)) return { file: original, durationSeconds, converted: false };

    const channels = Math.min(2, decoded.numberOfChannels);
    const wavBytes = 44 + decoded.length * channels * 2;
    if (wavBytes > MAX_RENDER_WAV_BYTES) return { file: original, durationSeconds, converted: false };

    onProgress?.("Preparing a clean copy of the audio…");
    const wav = audioBufferToWav(decoded, 2);
    const base = (fileName || "audio").replace(/\.[^.]+$/, "") || "audio";
    return { file: new File([wav], `${base}.wav`, { type: "audio/wav" }), durationSeconds, converted: true };
  } catch {
    // Not decodable here (rare): let the renderer try the original.
    return { file: original, durationSeconds: 0, converted: false };
  } finally {
    try { await ctx.close(); } catch { /* ignore */ }
  }
}
