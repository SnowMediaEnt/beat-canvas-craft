// Rough render-cost estimates for the Lambda export tab.
//
// These are heuristics, not guarantees. They help users gauge file size
// and render time before kicking off a job, especially while AWS account
// concurrency quotas are low.

export interface RenderEstimate {
  totalFrames: number;
  estimatedWorkers: number;
  framesPerWorker: number;
  estimatedSizeMB: number;
  estimatedRenderSeconds: number;
}

// Target h.264 bitrate (Mbps) by resolution. Visualizer content has lots
// of motion so we err on the higher side of typical streaming bitrates.
const BITRATE_MBPS: Record<"720p" | "1080p" | "4k", number> = {
  "720p": 5,
  "1080p": 9,
  "4k": 38,
};

// Approx per-frame render cost (ms) inside a Lambda worker, by resolution.
// Calibrated from observed Visualizer renders. Real numbers vary with
// preset complexity, effects, and Lambda cold-start.
const MS_PER_FRAME: Record<"720p" | "1080p" | "4k", number> = {
  "720p": 90,
  "1080p": 160,
  "4k": 520,
};

const LAMBDA_OVERHEAD_S = 25; // cold-start + final stitch/encode

export function estimateRender(opts: {
  durationSeconds: number;
  fps: number;
  resolution: "720p" | "1080p" | "4k";
  framesPerLambda: number;
}): RenderEstimate {
  const totalFrames = Math.max(1, Math.ceil(opts.durationSeconds * opts.fps));
  const framesPerWorker = Math.max(1, opts.framesPerLambda);
  const estimatedWorkers = Math.ceil(totalFrames / framesPerWorker);

  // File size: bitrate * duration. Scale a bit with fps above 30.
  const fpsScale = 1 + Math.max(0, (opts.fps - 30) / 120);
  const bitrateMbps = BITRATE_MBPS[opts.resolution] * fpsScale;
  const estimatedSizeMB = (bitrateMbps * opts.durationSeconds) / 8;

  // Render time: longest worker chunk + overhead. Workers run in parallel
  // (subject to AWS concurrency cap), so wall time ≈ slowest chunk.
  const perWorkerSeconds = (framesPerWorker * MS_PER_FRAME[opts.resolution]) / 1000;
  const estimatedRenderSeconds = perWorkerSeconds + LAMBDA_OVERHEAD_S;

  return {
    totalFrames,
    estimatedWorkers,
    framesPerWorker,
    estimatedSizeMB,
    estimatedRenderSeconds,
  };
}

export function formatBytes(mb: number): string {
  if (mb < 1) return `${Math.round(mb * 1024)} KB`;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
