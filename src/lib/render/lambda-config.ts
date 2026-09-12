// Values shared by the Lambda start call, the render estimate shown in the
// Export dialog, and the AWS health check. Keeping them here guarantees the
// estimate describes the SAME chunking the render will actually use.

/** Must match the Remotion version the Lambda function + site were deployed with. */
export const REMOTION_VERSION = "4.0.465";

export const REMOTION_OUTPUT_PREFIX = "renders/";

/** Hard cap on parallel Lambda workers per render (AWS concurrency quota safety). */
export const MAX_LAMBDA_WORKERS = 200;

/** Smallest chunk we ever ask a worker to render. */
export const MIN_FRAMES_PER_LAMBDA = 15;

/**
 * Chunk size used for a render. Small chunks keep each worker far below the
 * 900 s Lambda limit even for heavy presets at 4K; the worker cap keeps us
 * inside typical AWS concurrency quotas for long songs.
 */
export function computeFramesPerLambda(totalFrames: number, fps: number): number {
  const frames = Math.max(1, Math.ceil(totalFrames));
  const step = Math.max(1, Math.round(fps / 2));
  const minForCap = Math.ceil(frames / MAX_LAMBDA_WORKERS);
  const raw = Math.max(MIN_FRAMES_PER_LAMBDA, minForCap);
  return Math.ceil(raw / step) * step;
}

export function buildPublicRenderUrl(region: string, bucketName: string, renderId: string) {
  return `https://${bucketName}.s3.${region}.amazonaws.com/${REMOTION_OUTPUT_PREFIX}${renderId}/out.mp4`;
}

/** Extract bucket + region from a Remotion serve URL (virtual-hosted or path-style). */
export function parseBucketAndRegion(serveUrl: string, fallbackRegion: string): { bucketName: string; region: string } | null {
  try {
    const url = new URL(serveUrl);
    const virtualHosted = url.hostname.match(/^([^.]+)\.s3[.-]([^.]+)\.amazonaws\.com$/);
    if (virtualHosted) return { bucketName: virtualHosted[1], region: virtualHosted[2] };

    const pathStyle = url.hostname.match(/^s3[.-]([^.]+)\.amazonaws\.com$/);
    if (pathStyle) {
      const bucketName = url.pathname.split("/").filter(Boolean)[0];
      if (bucketName) return { bucketName, region: pathStyle[1] };
    }

    const bucketName = url.pathname.split("/").filter(Boolean)[0];
    if (bucketName) return { bucketName, region: fallbackRegion };
  } catch {
    /* ignore */
  }
  return null;
}

/** Region of an S3 object URL, when the hostname carries it. */
export function regionFromS3Url(url: string | undefined | null): string | null {
  if (!url) return null;
  const m = url.match(/\.s3[.-]([a-z0-9-]+)\.amazonaws\.com/i);
  return m ? m[1] : null;
}
