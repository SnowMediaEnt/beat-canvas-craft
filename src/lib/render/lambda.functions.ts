import { createServerFn } from "@tanstack/react-start";
import { AwsClient } from "aws4fetch";
import { z } from "zod";
import { loadRemotionLambdaClient } from "./remotion-lambda-client.server";

const REMOTION_OUTPUT_PREFIX = "renders/";
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

function getAwsEnv(): AwsEnv {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
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

  return { accessKeyId, secretAccessKey, region, functionName, serveUrl };
}

function createAwsClient(env: AwsEnv) {
  return new AwsClient({
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    service: "s3",
    region: env.region,
  });
}

function getTotalFrames(frameRange: ProgressJson["renderMetadata"] extends infer _T ? ProgressJson["renderMetadata"] : never) {
  if (!frameRange?.frameRange) return 0;
  const everyNthFrame = Math.max(1, frameRange.everyNthFrame ?? 1);
  const range = frameRange.frameRange;
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
  const fatalErrorEncountered = errors.length > 0;

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

export const startLambdaRender = createServerFn({ method: "POST" })
  .inputValidator((input) => inputPropsSchema.parse(input))
  .handler(async ({ data }) => {
    console.log("[lambda-render-server] validated inputProps", data);
    let env: AwsEnv | null = null;
    try {
      env = getAwsEnv();
      const { renderMediaOnLambda } = loadRemotionLambdaClient();
      const FRAMES_PER_LAMBDA = 60;
      const MAX_WORKERS = 200;
      let result;
      let attempt = 0;
      const maxAttempts = 5;

      while (true) {
        try {
          const totalFrames = Math.ceil(data.durationSeconds * data.fps);
          const step = Math.max(1, Math.round(data.fps / 2));
          const minForCap = Math.ceil(totalFrames / MAX_WORKERS);
          const rawFramesPerLambda = Math.max(FRAMES_PER_LAMBDA, minForCap);
          const framesPerLambda = Math.ceil(rawFramesPerLambda / step) * step;

          result = await renderMediaOnLambda({
            region: env.region as any,
            functionName: env.functionName,
            serveUrl: env.serveUrl,
            composition: "Visualizer",
            codec: "h264",
            inputProps: data,
            imageFormat: "jpeg",
            maxRetries: 3,
            privacy: "public",
            concurrencyPerLambda: 1,
            framesPerLambda,
            timeoutInMilliseconds: 120000,
          });
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
    const { deleteRender } = loadRemotionLambdaClient();
    const env = getAwsEnv();
    try {
      await deleteRender({
        region: env.region as any,
        bucketName: data.bucketName,
        renderId: data.renderId,
      });
      progressCache.delete(`${data.bucketName}:${data.renderId}`);
      return { cancelled: true };
    } catch (error) {
      console.error("[lambda-render-server] cancel failed", error);
      throw error;
    }
  });
