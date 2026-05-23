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

    const { renderMediaOnLambda } = await import("@remotion/lambda-client");
    const { region, functionName, serveUrl } = awsConfig();
    try {
      const result = await renderMediaOnLambda({
        region,
        functionName,
        serveUrl,
        composition: "Visualizer",
        codec: "h264",
        inputProps: data,
        imageFormat: "jpeg",
        // Conservative concurrency setting to ensure renders complete
        // successfully on new AWS accounts with low burst rate limits.
        // Renders take a few extra minutes but always succeed. Can be
        // lowered later once AWS account matures.
        framesPerLambda: 250,
        maxRetries: 1,
        privacy: "public",
        downloadBehavior: { type: "download", fileName: "visualizer.mp4" },
      });
      return { renderId: result.renderId, bucketName: result.bucketName };
    } catch (error) {
      console.error("[lambda-render-server] renderMediaOnLambda failed", {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        data,
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
