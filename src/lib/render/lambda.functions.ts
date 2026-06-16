import { createServerFn } from "@tanstack/react-start";
import { AwsClient } from "aws4fetch";
import { z } from "zod";

const REMOTION_OUTPUT_PREFIX = "renders/";
const REMOTION_VERSION = "4.0.465";
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
};

type LambdaProgressResponse = {
  done: boolean;
  overallProgress: number;
  outputFile?: string;
  errors: { message: string; stack?: string }[];
  fatalErrorEncountered: boolean;
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
    errors?: { message: string; stack?: string }[];
  } | null;
  renderMetadata?: {
    totalChunks?: number;
    estimatedRenderLambdaInvokations?: number;
    frameRange?: [number, number] | number[];
    everyNthFrame?: number;
  } | null;
  errors?: { message: string; stack?: string }[];
  timeoutTimestamp?: number | null;
  functionLaunched?: number;
  serveUrlOpened?: number | null;
  compositionValidated?: number | null;
};

const progressCache = new Map<string, { expiresAt: number; value: LambdaProgressResponse }>();
const inFlightProgress = new Map<string, Promise<LambdaProgressResponse>>();

const lyricLineSchema = z.object({ time: z.number(), text: z.string() });
const visualizerConfigSchema = z.record(z.string(), z.any());
const effectsConfigSchema = z.record(z.string(), z.any());
const lyricsConfigSchema = z.object({
  enabled: z.boolean(),
  lines: z.array(lyricLineSchema),
  style: z.string(),
  position: z.string(),
  fontFamily: z.string(),
  fontSize: z.number(),
  color: z.string(),
  outline: z.boolean(),
  shadow: z.boolean(),
  glow: z.boolean(),
  fade: z.boolean(),
});

const inputPropsSchema = z.object({
  audioUrl: z.string().url(),
  durationSeconds: z.number().positive(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  backgroundUrl: z.string().url().nullable(),
  backgroundType: z.string().nullable(),
  logoUrl: z.string().url().nullable(),
  visualizer: visualizerConfigSchema,
  effects: effectsConfigSchema,
  lyrics: lyricsConfigSchema,
});

function buildPublicRenderUrl(region: string, bucketName: string, renderId: string) {
  return `https://${bucketName}.s3.${region}.amazonaws.com/${REMOTION_OUTPUT_PREFIX}${renderId}/out.mp4`;
}

function parseBucketAndRegion(serveUrl: string, fallbackRegion: string): { bucketName: string; region: string } | null {
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

function getAwsEnv(): AwsEnv {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  const region = process.env.REMOTION_AWS_REGION;
  const functionName = process.env.REMOTION_AWS_FUNCTION_NAME;
  const serveUrl = process.env.REMOTION_AWS_SERVE_URL;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Missing AWS credentials");
  }

  if (!region || !functionName || !serveUrl) {
    throw new Error(
      "Missing Remotion Lambda env vars (REMOTION_AWS_REGION, REMOTION_AWS_FUNCTION_NAME, REMOTION_AWS_SERVE_URL)",
    );
  }

  return { accessKeyId, secretAccessKey, sessionToken, region, functionName, serveUrl };
}

function createAwsClient(env: AwsEnv) {
  return new AwsClient({
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    sessionToken: env.sessionToken,
    service: "s3",
    region: env.region,
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

function normalizeErrors(errors: { message: string; stack?: string }[] | undefined | null) {
  if (!errors?.length) return [];
  return errors.map((error) => ({
    message: error?.message || "Render failed",
    stack: error?.stack,
  }));
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
    };
  }

  const errors = normalizeErrors(progress.errors);
  const fatalErrorEncountered = false;

  return {
    done: false,
    overallProgress: computeOverallProgress(progress),
    outputFile: undefined,
    errors,
    fatalErrorEncountered,
  };
}

async function readProgressJson(env: AwsEnv, bucketName: string, renderId: string): Promise<ProgressJson | null> {
  const aws = createAwsClient(env);
  const key = `${REMOTION_OUTPUT_PREFIX}${renderId}/progress.json`;
  const url = `https://${bucketName}.s3.${env.region}.amazonaws.com/${key}`;
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
  const aws = createAwsClient(env);
  const prefix = `${REMOTION_OUTPUT_PREFIX}${renderId}/`;
  const listUrl = `https://${bucketName}.s3.${env.region}.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  const listResponse = await aws.fetch(listUrl, { method: "GET" });
  if (!listResponse.ok) throw new Error(`Failed to list render files (${listResponse.status})`);

  const xml = await listResponse.text();
  const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => decodeXmlText(match[1]));
  await Promise.all(
    keys.map((key) =>
      aws.fetch(`https://${bucketName}.s3.${env.region}.amazonaws.com/${key}`, { method: "DELETE" }),
    ),
  );
}

function serializeInputProps(inputProps: z.infer<typeof inputPropsSchema>) {
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

async function startRenderViaLambdaApi(env: AwsEnv, data: z.infer<typeof inputPropsSchema>) {
  const parsedServeUrl = parseBucketAndRegion(env.serveUrl, env.region);
  if (!parsedServeUrl) {
    throw new Error("Could not determine Remotion S3 bucket from REMOTION_AWS_SERVE_URL");
  }

  const totalFrames = Math.ceil(data.durationSeconds * data.fps);
  const step = Math.max(1, Math.round(data.fps / 2));
  const maxWorkers = 200;
  const minForCap = Math.ceil(totalFrames / maxWorkers);
  const rawFramesPerLambda = Math.max(60, minForCap);
  const framesPerLambda = Math.ceil(rawFramesPerLambda / step) * step;

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
      crf: null,
      envVariables: {},
      pixelFormat: null,
      proResProfile: null,
      x264Preset: null,
      jpegQuality: 80,
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
      downloadBehavior: { type: "play-in-browser" },
      muted: false,
      version: REMOTION_VERSION,
      overwrite: false,
      audioBitrate: null,
      videoBitrate: null,
      encodingBufferSize: null,
      encodingMaxRate: null,
      webhook: null,
      forceHeight: null,
      forceWidth: null,
      forceFps: null,
      forceDurationInFrames: null,
      bucketName: parsedServeUrl.bucketName,
      audioCodec: null,
      offthreadVideoCacheSizeInBytes: null,
      deleteAfter: null,
      colorSpace: null,
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
  const bucketName = typeof result?.bucketName === "string" ? result.bucketName : parsedServeUrl.bucketName;
  if (!renderId) throw new Error("Lambda did not return a renderId");

  return { renderId, bucketName };
}

export const startLambdaRender = createServerFn({ method: "POST" })
  .inputValidator((input) => inputPropsSchema.parse(input))
  .handler(async ({ data }) => {
    console.log("[lambda-render-server] validated inputProps", data);
    let env: AwsEnv | null = null;
    try {
      env = getAwsEnv();
      let result;
      let attempt = 0;
      const maxAttempts = 5;

      while (true) {
        try {
          result = await startRenderViaLambdaApi(env, data);
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

      return { renderId: result.renderId, bucketName: result.bucketName };
    } catch (error) {
      console.error("[lambda-render-server] renderMediaOnLambda failed", {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
        region: env?.region,
        functionName: env?.functionName,
        serveUrl: env?.serveUrl,
      });
      throw error;
    }
  });

export const getLambdaProgress = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ renderId: z.string(), bucketName: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const env = getAwsEnv();
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
            ? toLambdaProgressResponse(progress, env.region, data.renderId, data.bucketName)
            : {
                done: false,
                overallProgress: 0,
                outputFile: undefined,
                errors: [],
                fatalErrorEncountered: false,
              };

          progressCache.set(cacheKey, {
            expiresAt: Date.now() + PROGRESS_CACHE_TTL_MS,
            value: response,
          });
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

export const cancelLambdaRender = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ renderId: z.string(), bucketName: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const env = getAwsEnv();
    try {
      await deleteRenderPrefix(env, data.bucketName, data.renderId);
      progressCache.delete(`${data.bucketName}:${data.renderId}`);
      return { cancelled: true };
    } catch (error) {
      console.error("[lambda-render-server] cancel failed", error);
      return { cancelled: true };
    }
  });
