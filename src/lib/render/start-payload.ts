// The exact payload the app sends to the Remotion Lambda function to start a
// render. Kept in its own module so a diagnostic can post byte-for-byte the
// same thing and prove whether a failed render is the app's request or AWS.
import type { z } from "zod";
import { REMOTION_VERSION, computeFramesPerLambda } from "./lambda-config";
import type { renderInputPropsSchema } from "./input-schema";

export type RenderInputProps = z.infer<typeof renderInputPropsSchema>;

export function serializeInputProps(inputProps: RenderInputProps) {
  return { type: "payload", payload: JSON.stringify(inputProps) };
}

export function safeFileName(title: string | undefined) {
  const base = (title || "visualizer").normalize("NFKD").replace(/[^\w\s.-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80);
  return `${base || "visualizer"}.mp4`;
}

/**
 * Encoder settings by quality tier. The old start call used ffmpeg defaults:
 * ~128 kbps AAC (a musician's master transcoded like a podcast), CRF 18 and
 * JPEG-80 intermediates, with no colour-space tag (players desaturate neon).
 */
export function encodeSettings(quality: RenderInputProps["quality"]) {
  return quality === "standard"
    ? { jpegQuality: 85, crf: 20, audioBitrate: "256k", colorSpace: "bt709" as const }
    : { jpegQuality: 95, crf: 16, audioBitrate: "320k", colorSpace: "bt709" as const };
}

export function buildStartPayload(serveUrl: string, bucketName: string, data: RenderInputProps) {
  const totalFrames = Math.ceil(data.durationSeconds * data.fps);
  const framesPerLambda = computeFramesPerLambda(totalFrames, data.fps);
  const enc = encodeSettings(data.quality);
  const payload = {
  type: "start",
  rendererFunctionName: null,
  framesPerLambda,
  concurrency: null,
  composition: "Visualizer",
  serveUrl: serveUrl,
  inputProps: serializeInputProps(data),
  codec: "h264",
  imageFormat: "jpeg",
  crf: enc.crf,
  envVariables: {},
  pixelFormat: null,
  proResProfile: null,
  x264Preset: null,
  jpegQuality: enc.jpegQuality,
  maxRetries: 3,
  privacy: "public",
  logLevel: "info",
  frameRange: null,
  outName: null,
  timeoutInMilliseconds: 120000,
  chromiumOptions: {},
  scale: 1,
  everyNthFrame: 1,
  numberOfGifLoops: null,
  concurrencyPerLambda: 1,
  // S3 serves the MP4 with Content-Disposition: attachment so the
  // Download button saves a file instead of opening a player tab.
  downloadBehavior: { type: "download", fileName: safeFileName(data.title) },
  muted: false,
  version: REMOTION_VERSION,
  overwrite: false,
  audioBitrate: enc.audioBitrate,
  videoBitrate: null,
  encodingBufferSize: null,
  encodingMaxRate: null,
  webhook: null,
  forceHeight: null,
  forceWidth: null,
  forceFps: null,
  forceDurationInFrames: null,
  bucketName: bucketName,
  audioCodec: null,
  offthreadVideoCacheSizeInBytes: null,
  deleteAfter: null,
  colorSpace: enc.colorSpace,
  preferLossless: false,
  forcePathStyle: false,
  metadata: null,
  licenseKey: null,
  offthreadVideoThreads: null,
  mediaCacheSizeInBytes: null,
  storageClass: null,
  isProduction: null,
  sampleRate: 48000,
};
  return { payload, framesPerLambda };
}
