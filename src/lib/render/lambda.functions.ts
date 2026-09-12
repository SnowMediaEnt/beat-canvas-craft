import { createServerFn } from "@tanstack/react-start";
import { AwsClient } from "aws4fetch";
import { z } from "zod";
import { renderInputPropsSchema, type RenderInputProps } from "./input-schema";
import {
  REMOTION_VERSION, REMOTION_OUTPUT_PREFIX, computeFramesPerLambda,
  buildPublicRenderUrl, parseBucketAndRegion,
} from "./lambda-config";

const PROGRESS_CACHE_TTL_MS = 8000;
const PROGRESS_STALE_FALLBACK_MS = 30000;
const PROGRESS_WEIGHTS = {
  evaluating: 0.1,
  encoding: 0.1,
  frames: 0.6,
  invoking: 0.1,
  combining: 0.1,
} as const;

type AwsEnv = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  functionName: string;
  serveUrl: string;
  bucketName: string;
  bucketRegion: string;
};

type LambdaProgressResponse = {
  done: boolean;
  overallProgress: number;
  outputFile?: string;
  errors: { message: string; stack?: string; isFatal?: boolean; willRetry?: boolean }[];
  fatalErrorEncountered: boolean;
  /** Coarse stage label for the UI. */
  stage?: "starting" | "rendering" | "encoding" | "combining" | "done";
};

type ProgressJson = {
  chunks?: number[];
  framesRendered?: number;
  framesEncoded?: number;
  combinedFrames?: number;
  lambdasInvoked?: number;
  retries?: unknown[];
  postRenderData?: {
    outputFile?: string | null;
    errors?: { message: string; stack?: string; isFatal?: boolean; willRetry?: boolean }[];
  } | null;
  renderMetadata?: {
    totalChunks?: number;
    estimatedRenderLambdaInvokations?: number;
    frameRange?: [number, number] | number[];
    everyNthFrame?: number;
  } | null;
  errors?: { message: string; stack?: string; isFatal?: boolean; willRetry?: boolean }[];
  timeoutTimestamp?: number | null;
  functionLaunched?: number;
  serveUrlOpened?: number | null;
  compositionValidated?: number | null;
};

const progressCache = new Map<string, { expiresAt: number; value: LambdaProgressResponse }>();
const inFlightProgress = new Map<string, Promise<LambdaProgressResponse>>();
const PROGRESS_CACHE_MAX = 200;

function rememberProgress(key: string, value: LambdaProgressResponse) {
  progressCache.set(key, { expiresAt: Date.now() + PROGRESS_CACHE_TTL_MS, value });
  if (progressCache.size > PROGRESS_CACHE_MAX) {
    const oldest = progressCache.keys().next().value;
    if (oldest) progressCache.delete(oldest);
  }
}

/** The render access code lives in the project secrets; the historical
 *  value stays as a fallback so existing users are not locked out. */
function getAccessCode(): string {
  return process.env.RENDER_ACCESS_CODE || "2650562";
}

function assertAccessCode(code: string | undefined) {
  if (!code || code !== getAccessCode()) {
    throw new Error(
      "Invalid access code. Lambda rendering requires an access code — use the free Browser Recording export instead.",
    );
  }
}

const RENDER_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;
const renderRefSchema = z.object({
  renderId: z.string().regex(RENDER_ID_RE),
  bucketName: z.string().regex(/^remotionlambda-[a-z0-9-]+$/i),
});

function getAwsEnv(): AwsEnv {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  const region = process.env.REMOTION_AWS_REGION;
  const functionName = process.env.REMOTION_AWS_FUNCTION_NAME;
  const serveUrl = process.env.REMOTION_AWS_SERVE_URL;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS credentials are not configured (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY). Open Export → AWS connection → Check for details.");
  }

  if (!region || !functionName || !serveUrl) {
    throw new Error(
      "Missing Remotion Lambda settings (REMOTION_AWS_REGION, REMOTION_AWS_FUNCTION_NAME, REMOTION_AWS_SERVE_URL). Open Export → AWS connection → Check for details.",
    );
  }

  const parsed = parseBucketAndRegion(serveUrl, region);
  if (!parsed) {
    throw new Error("Could not determine the Remotion S3 bucket from REMOTION_AWS_SERVE_URL");
  }

  return {
    accessKeyId, secretAccessKey, sessionToken, region, functionName, serveUrl,
    bucketName: parsed.bucketName, bucketRegion: parsed.region,
  };
}

/** Refuse to touch any bucket other than the configured Remotion bucket. */
function assertOwnBucket(env: AwsEnv, bucketName: string) {
  if (bucketName !== env.bucketName) {
    throw new Error("Unknown render bucket.");
  }
}

function createS3Client(env: AwsEnv) {
  return new AwsClient({
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    sessionToken: env.sessionToken,
    service: "s3",
    region: env.bucketRegion,
  });
}

function createLambdaClient(env: AwsEnv) {
  return new AwsClient({
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    sessionToken: env.sessionToken,
    service: "lambda",
    region: env.region,
  });
}

function getTotalFrames(renderMetadata: ProgressJson["renderMetadata"]) {
  if (!renderMetadata?.frameRange) return 0;
  const everyNthFrame = Math.max(1, renderMetadata.everyNthFrame ?? 1);
  const range = renderMetadata.frameRange;
  if (Array.isArray(range) && range.length === 2 && typeof range[0] === "number" && typeof range[1] === "number") {
    return Math.max(0, Math.floor((range[1] - range[0]) / everyNthFrame) + 1);
  }
  if (Array.isArray(range)) {
    return Math.max(0, Math.ceil(range.length / everyNthFrame));
  }
  return 0;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function computeOverallProgress(progress: ProgressJson) {
  const totalFrames = getTotalFrames(progress.renderMetadata);
  const totalInvocations = Math.max(1, progress.renderMetadata?.estimatedRenderLambdaInvokations ?? 1);
  const evaluationProgress = [
    Boolean(progress.functionLaunched),
    Boolean(progress.serveUrlOpened),
    Boolean(progress.compositionValidated),
  ].reduce((sum, flag) => sum + Number(flag), 0) / 3;

  const encoding = totalFrames > 0 ? (progress.framesEncoded ?? 0) / totalFrames : 0;
  const frames = totalFrames > 0 ? (progress.framesRendered ?? 0) / totalFrames : 0;
  const combining = totalFrames > 0 ? (progress.combinedFrames ?? 0) / totalFrames : 0;
  const invoking = (progress.lambdasInvoked ?? 0) / totalInvocations;

  return clamp01(
    evaluationProgress * PROGRESS_WEIGHTS.evaluating +
      clamp01(encoding) * PROGRESS_WEIGHTS.encoding +
      clamp01(frames) * PROGRESS_WEIGHTS.frames +
      clamp01(invoking) * PROGRESS_WEIGHTS.invoking +
      clamp01(combining) * PROGRESS_WEIGHTS.combining,
  );
}

function stageOf(progress: ProgressJson): LambdaProgressResponse["stage"] {
  const total = getTotalFrames(progress.renderMetadata);
  if (progress.postRenderData) return "done";
  if (total > 0 && (progress.combinedFrames ?? 0) > 0) return "combining";
  if (total > 0 && (progress.framesRendered ?? 0) >= total) return "encoding";
  if ((progress.framesRendered ?? 0) > 0) return "rendering";
  return "starting";
}

function normalizeErrors(
  errors: { message: string; stack?: string; isFatal?: boolean; willRetry?: boolean }[] | undefined | null,
) {
  if (!errors?.length) return [];
  return errors.map((error) => ({
    message: error?.message || "Render failed",
    stack: error?.stack,
    isFatal: error?.isFatal,
    willRetry: error?.willRetry,
  }));
}

// Remotion writes retryable chunk errors into progress.errors too. Only count
// an entry as fatal when it isn't explicitly marked non-fatal or willRetry.
function isFatalErrorEntry(error: { isFatal?: boolean; willRetry?: boolean }) {
  return error.isFatal !== false && error.willRetry !== true;
}

function toLambdaProgressResponse(progress: ProgressJson, region: string, renderId: string, bucketName: string): LambdaProgressResponse {
  if (progress.postRenderData) {
    const postErrors = normalizeErrors(progress.postRenderData.errors);
    return {
      done: true,
      overallProgress: 1,
      outputFile: buildPublicRenderUrl(region, bucketName, renderId),
      errors: postErrors,
      fatalErrorEncountered: false,
      stage: "done",
    };
  }

  const errors = normalizeErrors(progress.errors);
  const fatalErrors = errors.filter(isFatalErrorEntry);

  // Chunks that exceed the 900s Lambda kill leave progress.json with a
  // populated timeoutTimestamp in the past and no postRenderData.
  const now = Date.now();
  const timedOut =
    typeof progress.timeoutTimestamp === "number" &&
    progress.timeoutTimestamp > 0 &&
    now > progress.timeoutTimestamp + 60_000;

  if (timedOut) {
    return {
      done: false,
      overallProgress: computeOverallProgress(progress),
      outputFile: undefined,
      errors: errors.length
        ? errors
        : [{
            message:
              "Render timed out on AWS: chunks exceeded the 900s Lambda limit. Try a lower resolution/fps or a lighter preset.",
          }],
      fatalErrorEncountered: true,
      stage: stageOf(progress),
    };
  }

  if (fatalErrors.length > 0) {
    return {
      done: false,
      overallProgress: computeOverallProgress(progress),
      outputFile: undefined,
      errors,
      fatalErrorEncountered: true,
      stage: stageOf(progress),
    };
  }

  return {
    done: false,
    overallProgress: computeOverallProgress(progress),
    outputFile: undefined,
    errors: [],
    fatalErrorEncountered: false,
    stage: stageOf(progress),
  };
}

async function readProgressJson(env: AwsEnv, bucketName: string, renderId: string): Promise<ProgressJson | null> {
  const aws = createS3Client(env);
  const key = `${REMOTION_OUTPUT_PREFIX}${renderId}/progress.json`;
  const url = `https://${bucketName}.s3.${env.bucketRegion}.amazonaws.com/${key}`;
  const response = await aws.fetch(url, { method: "GET" });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to read render progress (${response.status})`);
  }

  return (await response.json()) as ProgressJson;
}

function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function deleteRenderPrefix(env: AwsEnv, bucketName: string, renderId: string) {
  const aws = createS3Client(env);
  const prefix = `${REMOTION_OUTPUT_PREFIX}${renderId}/`;
  let continuationToken: string | undefined;
  do {
    const params = new URLSearchParams({ "list-type": "2", prefix });
    if (continuationToken) params.set("continuation-token", continuationToken);
    const listUrl = `https://${bucketName}.s3.${env.bucketRegion}.amazonaws.com/?${params.toString()}`;
    const listResponse = await aws.fetch(listUrl, { method: "GET" });
    if (!listResponse.ok) throw new Error(`Failed to list render files (${listResponse.status})`);
    const xml = await listResponse.text();
    const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => decodeXmlText(match[1]));
    await Promise.all(
      keys.map((key) =>
        aws.fetch(`https://${bucketName}.s3.${env.bucketRegion}.amazonaws.com/${key.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" }),
      ),
    );
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    continuationToken = truncated ? xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] : undefined;
  } while (continuationToken);
}

function serializeInputProps(inputProps: RenderInputProps) {
  return { type: "payload", payload: JSON.stringify(inputProps) };
}

async function invokeLambdaJson(env: AwsEnv, payload: Record<string, unknown>, invocationType: "RequestResponse" | "Event") {
  const lambda = createLambdaClient(env);
  const url = `https://lambda.${env.region}.amazonaws.com/2015-03-31/functions/${encodeURIComponent(env.functionName)}/invocations`;
  const response = await lambda.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-amz-invocation-type": invocationType,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();

  if (!response.ok || response.headers.has("x-amz-function-error")) {
    throw new Error(text || `Lambda invocation failed (${response.status})`);
  }

  if (invocationType === "Event") return null;

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Lambda returned invalid JSON: ${text.slice(0, 300)}`);
  }
}

function safeFileName(title: string | undefined) {
  const base = (title || "visualizer").normalize("NFKD").replace(/[^\w\s.-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80);
  return `${base || "visualizer"}.mp4`;
}

/**
 * Encoder settings by quality tier. The old start call used ffmpeg defaults:
 * ~128 kbps AAC (a musician's master transcoded like a podcast), CRF 18 and
 * JPEG-80 intermediates, with no colour-space tag (players desaturate neon).
 */
function encodeSettings(quality: RenderInputProps["quality"]) {
  return quality === "standard"
    ? { jpegQuality: 85, crf: 20, audioBitrate: "256k", colorSpace: "bt709" as const }
    : { jpegQuality: 95, crf: 16, audioBitrate: "320k", colorSpace: "bt709" as const };
}

async function startRenderViaLambdaApi(env: AwsEnv, data: RenderInputProps) {
  const totalFrames = Math.ceil(data.durationSeconds * data.fps);
  const framesPerLambda = computeFramesPerLambda(totalFrames, data.fps);
  const enc = encodeSettings(data.quality);

  const result = await invokeLambdaJson(
    env,
    {
      type: "start",
      rendererFunctionName: null,
      framesPerLambda,
      concurrency: null,
      composition: "Visualizer",
      serveUrl: env.serveUrl,
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
      bucketName: env.bucketName,
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
    },
    "RequestResponse",
  );

  if (result?.type === "error") {
    throw new Error(typeof result.message === "string" ? result.message : "Lambda render failed");
  }

  const renderId = typeof result?.renderId === "string" ? result.renderId : null;
  const bucketName = typeof result?.bucketName === "string" ? result.bucketName : env.bucketName;
  if (!renderId) throw new Error("Lambda did not return a renderId");

  return { renderId, bucketName, region: env.bucketRegion, framesPerLambda };
}

export const startLambdaRender = createServerFn({ method: "POST" })
  .inputValidator((input) => renderInputPropsSchema.extend({ accessCode: z.string() }).parse(input))
  .handler(async ({ data }) => {
    assertAccessCode(data.accessCode);
    const { accessCode: _accessCode, ...renderProps } = data;
    console.log("[lambda-render-server] start", {
      preset: (renderProps.visualizer as { presetId?: string }).presetId,
      fps: renderProps.fps, width: renderProps.width, height: renderProps.height,
      duration: renderProps.durationSeconds, engineVersion: renderProps.engineVersion,
    });
    let env: AwsEnv | null = null;
    try {
      env = getAwsEnv();
      let result;
      let attempt = 0;
      const maxAttempts = 5;

      while (true) {
        try {
          result = await startRenderViaLambdaApi(env, renderProps);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const throttled = /rate exceeded|concurrency limit|throttl/i.test(msg);
          attempt += 1;
          if (!throttled || attempt >= maxAttempts) throw err;
          const backoffMs = 1000 * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }

      return result;
    } catch (error) {
      console.error("[lambda-render-server] start failed", {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
        region: env?.region,
        functionName: env?.functionName,
      });
      throw error;
    }
  });

export const getLambdaProgress = createServerFn({ method: "POST" })
  .inputValidator((input) => renderRefSchema.parse(input))
  .handler(async ({ data }) => {
    const env = getAwsEnv();
    assertOwnBucket(env, data.bucketName);
    const cacheKey = `${data.bucketName}:${data.renderId}`;
    const now = Date.now();
    const cached = progressCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inFlight = inFlightProgress.get(cacheKey);
    if (inFlight) {
      return await inFlight;
    }

    const request = (async (): Promise<LambdaProgressResponse> => {
      let lastError: unknown;
      const maxAttempts = 4;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const progress = await readProgressJson(env, data.bucketName, data.renderId);
          const response = progress
            ? toLambdaProgressResponse(progress, env.bucketRegion, data.renderId, data.bucketName)
            : {
                done: false,
                overallProgress: 0,
                outputFile: undefined,
                errors: [],
                fatalErrorEncountered: false,
                stage: "starting" as const,
              };

          rememberProgress(cacheKey, response);
          return response;
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          const throttled = /rate exceeded|concurrency limit|throttl/i.test(message);

          if (!throttled) throw error;

          const stale = progressCache.get(cacheKey);
          if (stale && stale.expiresAt + PROGRESS_STALE_FALLBACK_MS > Date.now()) {
            return stale.value;
          }

          if (attempt === maxAttempts) {
            return {
              done: false,
              overallProgress: 0,
              outputFile: undefined,
              errors: [],
              fatalErrorEncountered: false,
            };
          }

          const backoffMs = 500 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }

      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    })();

    inFlightProgress.set(cacheKey, request);

    try {
      return await request;
    } finally {
      inFlightProgress.delete(cacheKey);
    }
  });

/**
 * Remotion Lambda has no "stop" API: once the chunks are running they finish
 * (and bill) regardless. "Cancelling" therefore only stops tracking on our
 * side. The finished file can be removed afterwards with deleteLambdaRender.
 */
export const cancelLambdaRender = createServerFn({ method: "POST" })
  .inputValidator((input) => renderRefSchema.parse(input))
  .handler(async ({ data }) => {
    progressCache.delete(`${data.bucketName}:${data.renderId}`);
    return { cancelled: true, stoppedRemotely: false as const };
  });

/** Delete a render's files from S3 (requires the access code). */
export const deleteLambdaRender = createServerFn({ method: "POST" })
  .inputValidator((input) => renderRefSchema.extend({ accessCode: z.string() }).parse(input))
  .handler(async ({ data }) => {
    assertAccessCode(data.accessCode);
    const env = getAwsEnv();
    assertOwnBucket(env, data.bucketName);
    try {
      await deleteRenderPrefix(env, data.bucketName, data.renderId);
      progressCache.delete(`${data.bucketName}:${data.renderId}`);
      return { deleted: true };
    } catch (error) {
      console.error("[lambda-render-server] delete failed", error);
      throw new Error(error instanceof Error ? error.message : "Failed to delete render files");
    }
  });
