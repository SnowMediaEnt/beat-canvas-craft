import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const lyricLineSchema = z.object({ time: z.number(), text: z.string() });

const inputPropsSchema = z.object({
  audioUrl: z.string().url(),
  durationSeconds: z.number().positive(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  backgroundUrl: z.string().url().nullable(),
  logoUrl: z.string().url().nullable(),
  primary: z.string(),
  secondary: z.string(),
  accent: z.string(),
  glow: z.string(),
  bandCount: z.number(),
  sensitivity: z.number(),
  thickness: z.number(),
  reactivity: z.number(),
  lyrics: z.array(lyricLineSchema),
  lyricsEnabled: z.boolean(),
  lyricsColor: z.string(),
  lyricsFontFamily: z.string(),
  lyricsFontSize: z.number(),
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
      const { renderMediaOnLambda } = await import("@remotion/lambda-client");
      console.log("[lambda-render-server] module loaded; invoking renderMediaOnLambda");
      // Spawn as few render lambdas as possible to stay under AWS's per-second
      // invoke rate limit (the "Rate Exceeded" error). With framesPerLambda
      // very high, a typical song produces only 2-3 worker lambdas + the
      // orchestrator, which AWS will not throttle.
      // Retry the orchestrator invoke if AWS throttles us (Rate Exceeded).
      // maxRetries on renderMediaOnLambda only applies to per-chunk renders,
      // not the initial invocation.
      let result;
      let attempt = 0;
      const maxAttempts = 5;
      while (true) {
        try {
          result = await renderMediaOnLambda({
            region,
            functionName,
            serveUrl,
            composition: "Visualizer",
            codec: "h264",
            inputProps: data,
            imageFormat: "jpeg",
            framesPerLambda: 12000,
            maxRetries: 3,
            privacy: "public",
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
    const { getRenderProgress } = await import("@remotion/lambda-client");
    const { region, functionName } = awsConfig();
    const p = await getRenderProgress({
      renderId: data.renderId,
      bucketName: data.bucketName,
      functionName,
      region,
    });
    return {
      done: p.done,
      overallProgress: p.overallProgress,
      outputFile: p.outputFile,
      errors: p.errors.map((e) => ({ message: e.message, stack: e.stack })),
      fatalErrorEncountered: p.fatalErrorEncountered,
    };
  });
