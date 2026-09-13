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

/**
 * Every AWS region Remotion Lambda supports. Remotion names its bucket
 * `remotionlambda-<region with the dashes removed>-<random>`, so this is what
 * lets us turn a bucket name back into the region needed to sign requests
 * against it.
 */
const REMOTION_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "af-south-1", "ap-east-1", "ap-south-1",
  "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
  "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4", "ap-southeast-5",
  "ca-central-1", "eu-central-1", "eu-central-2",
  "eu-north-1", "eu-south-1", "eu-south-2",
  "eu-west-1", "eu-west-2", "eu-west-3",
  "il-central-1", "me-central-1", "me-south-1", "sa-east-1",
];

/**
 * The region a Remotion bucket lives in, read from its own name.
 *
 * Signing an S3 request for the right bucket with the wrong region fails, so
 * when a render turns out to live somewhere other than the configured bucket
 * we have to sign for that bucket's region, not the configured one.
 */
export function regionForBucket(bucketName: string, fallbackRegion: string): string {
  const m = bucketName.match(/^remotionlambda-([a-z0-9]+)-/i);
  if (!m) return fallbackRegion;
  const squashed = m[1].toLowerCase();
  return REMOTION_REGIONS.find((r) => r.replace(/-/g, "") === squashed) ?? fallbackRegion;
}

/** Region of an S3 object URL, when the hostname carries it. */
export function regionFromS3Url(url: string | undefined | null): string | null {
  if (!url) return null;
  const m = url.match(/\.s3[.-]([a-z0-9-]+)\.amazonaws\.com/i);
  return m ? m[1] : null;
}
