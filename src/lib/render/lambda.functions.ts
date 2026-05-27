import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { loadRemotionLambdaClient } from "./remotion-lambda-client.server";

const REMOTION_OUTPUT_PREFIX = "renders/";
const PROGRESS_CACHE_TTL_MS = 8000;
const PROGRESS_STALE_FALLBACK_MS = 30000;

type LambdaProgressResponse = {
  done: boolean;
  overallProgress: number;
  outputFile?: string;
  errors: { message: string; stack?: string }[];
  fatalErrorEncountered: boolean;
};

const progressCache = new Map<string, { expiresAt: number; value: LambdaProgressResponse }>();
const inFlightProgress = new Map<string, Promise<LambdaProgressResponse>>();

const lyricLineSchema = z.object({ time: z.number(), text: z.string() });

// Visualizer / Effects / Lyrics configs are passed through to the Remotion
// composition unchanged. We use loose schemas here (passthrough) so the schema
// doesn't have to be kept in lock-step with VisualizerConfig — the renderer
// is the single source of truth.
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

function awsConfig() {
  const region = process.env.REMOTION_AWS_REGION;
  const functionName = process.env.REMOTION_AWS_FUNCTION_NAME;
  const serveUrl = process.env.REMOTION_AWS_SERVE_URL;
  if (!region || !functionName || !serveUrl) {
    throw new Error(
      "Missing Remotion Lambda env vars (REMOTION_AWS_REGION, REMOTION_AWS_FUNCTION_NAME, REMOTION_AWS_SERVE_URL)",
    );
  }
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("Missing AWS credentials");
  }
  return { region: region as any, functionName, serveUrl };
}

function toLambdaProgressResponse(
  p: Awaited<ReturnType<ReturnType<typeof loadRemotionLambdaClient>["getRenderProgress"]>>,
  region: string,
  renderId: string,
  bucketName: string,
): LambdaProgressResponse {
  let outputFile = p.outputFile ?? undefined;

  if (!outputFile && p.done && !p.fatalErrorEncountered) {
    outputFile = `https://s3.${region}.amazonaws.com/${bucketName}/${REMOTION_OUTPUT_PREFIX}${renderId}/out.mp4`;
  }

  return {
    done: p.done,
    overallProgress: p.overallProgress,
    outputFile,
    errors: p.errors.map((e) => ({ message: e.message, stack: e.stack })),
    fatalErrorEncountered: p.fatalErrorEncountered,
  };
}

export const startLambdaRender = createServerFn({ method: "POST" })
  .inputValidator((input) => inputPropsSchema.parse(input))
  .handler(async ({ data }) => {
    console.log("[lambda-render-server] validated inputProps", data);
    let region: any;
    let functionName = "";
    let serveUrl = "";
    try {
      ({ region, functionName, serveUrl } = awsConfig());
      console.log("[lambda-render-server] awsConfig ok", {
        region,
        functionName,
        serveUrl,
        hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
        hasSecret: !!process.env.AWS_SECRET_ACCESS_KEY,
      });
      const { renderMediaOnLambda } = loadRemotionLambdaClient();
      console.log("[lambda-render-server] module loaded; invoking renderMediaOnLambda");
      // IMPORTANT: we intentionally keep framesPerLambda high (1501) so the
      // render splits into ~10-12 chunks instead of 100+. Each Lambda worker
      // gets ~30-40s of video. At ~160ms/frame (1080p heuristic) that's
      // ~240s render time per worker, well under AWS's 900s hard timeout.
      // This trades worker wall-time for fewer concurrent invocations, which
      // is required because our AWS account has a low unreserved concurrency
      // limit (10). If you raise that limit, you can lower framesPerLambda.
      let result;
      let attempt = 0;
      const maxAttempts = 5;
      while (true) {
        try {
          const totalFrames = Math.ceil(data.durationSeconds * data.fps);
          const framesPerLambda = 2000;
          console.log("[lambda-render-server] renderMediaOnLambda params", {
            framesPerLambda,
            totalFrames,
            estimatedWorkers: totalFrames / framesPerLambda,
            fps: data.fps,
            durationInFrames: totalFrames,
          });
          result = await renderMediaOnLambda({
            region,
            functionName,
            serveUrl,
            composition: "Visualizer",
            codec: "h264",
            inputProps: data,
            imageFormat: "jpeg",
            maxRetries: 3,
            privacy: "public",
            concurrencyPerLambda: 1,
            framesPerLambda,
          });
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const throttled = /rate exceeded|concurrency limit|throttl/i.test(msg);
          attempt += 1;
          if (!throttled || attempt >= maxAttempts) throw err;
          const backoffMs = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s, 16s
          console.warn(`[lambda-render-server] AWS throttled, retry ${attempt}/${maxAttempts - 1} in ${backoffMs}ms`);
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }

      console.log("[lambda-render-server] renderMediaOnLambda result", result);
      return { renderId: result.renderId, bucketName: result.bucketName };

    } catch (error) {
      console.error("[lambda-render-server] renderMediaOnLambda failed", {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
        region,
        functionName,
        serveUrl,
      });
      throw error;
    }
  });

export const getLambdaProgress = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ renderId: z.string(), bucketName: z.string() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { getRenderProgress } = loadRemotionLambdaClient();
    const { region, functionName } = awsConfig();
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
          const p = await getRenderProgress({
            renderId: data.renderId,
            bucketName: data.bucketName,
            functionName,
            region,
          });

          const response = toLambdaProgressResponse(p, region, data.renderId, data.bucketName);
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
            console.warn("[lambda-render-server] getRenderProgress throttled; returning cached progress", {
              renderId: data.renderId,
              attempt,
              overallProgress: stale.value.overallProgress,
            });
            return stale.value;
          }

          if (attempt === maxAttempts) {
            console.warn("[lambda-render-server] getRenderProgress throttled; returning pending fallback", {
              renderId: data.renderId,
              attempt,
            });
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
