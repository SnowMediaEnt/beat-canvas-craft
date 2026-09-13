/**
 * Sends the render request EXACTLY as the app's server does (same payload
 * builder, same raw Lambda REST call, same progress polling), so a render
 * that works from the Remotion CLI but not from the app can be told apart.
 *
 * Run in CI with AWS creds in the environment; not shipped to the browser.
 */
import { AwsClient } from "aws4fetch";
import { buildStartPayload, type RenderInputProps } from "../src/lib/render/start-payload";
import { REMOTION_OUTPUT_PREFIX, parseBucketAndRegion } from "../src/lib/render/lambda-config";

const region = process.env.REMOTION_AWS_REGION || "us-east-2";
const functionName = process.env.REMOTION_AWS_FUNCTION_NAME || "";
const serveUrl = process.env.REMOTION_AWS_SERVE_URL || "";
const audioUrl = process.env.DIAG_AUDIO_URL || "";

const parsed = parseBucketAndRegion(serveUrl, region);
if (!functionName || !serveUrl || !parsed) {
  console.error("Missing REMOTION_AWS_FUNCTION_NAME / REMOTION_AWS_SERVE_URL");
  process.exit(1);
}
const bucketName = parsed.bucketName;
const bucketRegion = parsed.region;
console.log(`function=${functionName}`);
console.log(`bucket=${bucketName} region=${bucketRegion}`);

const creds = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  sessionToken: process.env.AWS_SESSION_TOKEN,
};
const lambda = new AwsClient({ ...creds, service: "lambda", region });
const s3 = new AwsClient({ ...creds, service: "s3", region: bucketRegion });

const data = {
  audioUrl,
  durationSeconds: 2, fps: 30, width: 640, height: 360,
  backgroundUrl: null, backgroundType: null, backgroundColor: "#0a0612", logoUrl: null,
  visualizer: { presetId: "circular-spectrum", primary: "#22e3ff", secondary: "#b14bff", accent: "#ff4bd1", glow: "#22e3ff", overlay: "#000000", overlayOpacity: 0.35, glowIntensity: 0.8, blur: 0, size: 1, thickness: 4, position: { x: 0, y: 0 }, logoSize: 0.35, logoPosition: { x: 0, y: 0 }, backgroundScale: 1, backgroundBlur: 0, backgroundTint: "#0a0612", backgroundTintOpacity: 0, animationSpeed: 1, sensitivity: 1.2, bassSensitivity: 1.3, midSensitivity: 1, trebleSensitivity: 1, smoothing: 0.5, rotation: 0, movement: 0, shadow: 0, border: 0, blendMode: "source-over", reactivity: 1, bandCount: 48, stationary: true, custom: { shape: "bars", count: 48, spacing: 0.25, amplitude: 1, thickness: 0, rounded: true, symmetric: false, reactivity: 1, innerRadius: 0.35 } },
  effects: { particles: { enabled: false, type: "dust", density: 10, speed: 0.4, color: "#ffffff", opacity: 0.3, reactivity: 0.3 }, beatFlash: false, vignette: true, noise: false, lensFlare: false },
  lyrics: { enabled: false, lines: [], style: "Subtitle", position: "bottom", fontFamily: "Arial", fontSize: 42, color: "#ffffff", outline: true, shadow: true, glow: false, fade: true },
  title: "diagnostic", engineVersion: 2, quality: "standard",
} as unknown as RenderInputProps;

const { payload, framesPerLambda } = buildStartPayload(serveUrl, bucketName, data);
console.log(`framesPerLambda=${framesPerLambda}`);

const url = `https://lambda.${region}.amazonaws.com/2015-03-31/functions/${encodeURIComponent(functionName)}/invocations`;
const res = await lambda.fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-amz-invocation-type": "RequestResponse" },
  body: JSON.stringify(payload),
});
const text = await res.text();
console.log(`start -> HTTP ${res.status}${res.headers.has("x-amz-function-error") ? " FUNCTION-ERROR" : ""}`);
if (!res.ok || res.headers.has("x-amz-function-error")) {
  console.log(text.slice(0, 2000));
  process.exit(1);
}
const parsedResult = JSON.parse(text) as { renderId?: string; type?: string; message?: string };
if (parsedResult.type === "error" || !parsedResult.renderId) {
  console.log("start returned:", text.slice(0, 2000));
  process.exit(1);
}
const renderId = parsedResult.renderId;
console.log(`renderId=${renderId}`);

// Poll progress.json exactly like the app does.
const key = `${REMOTION_OUTPUT_PREFIX}${renderId}/progress.json`;
const progressUrl = `https://${bucketName}.s3.${bucketRegion}.amazonaws.com/${key}`;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const p = await s3.fetch(progressUrl, { method: "GET" });
  if (p.status === 404) {
    console.log(`t+${(i + 1) * 3}s  progress.json: 404 (app would show "Starting workers on AWS")`);
    continue;
  }
  if (!p.ok) {
    console.log(`t+${(i + 1) * 3}s  progress.json: HTTP ${p.status}`);
    continue;
  }
  const j = (await p.json()) as Record<string, unknown>;
  const errors = (j.errors as { message?: string }[] | undefined) ?? [];
  console.log(
    `t+${(i + 1) * 3}s  launched=${Boolean(j.functionLaunched)} serveUrlOpened=${Boolean(j.serveUrlOpened)} ` +
    `compositionValidated=${Boolean(j.compositionValidated)} lambdasInvoked=${j.lambdasInvoked ?? 0} ` +
    `framesRendered=${j.framesRendered ?? 0} errors=${errors.length}${j.postRenderData ? " DONE" : ""}`,
  );
  for (const e of errors.slice(0, 3)) console.log(`     error: ${String(e.message).slice(0, 300)}`);
  if (j.postRenderData) { console.log("RENDER COMPLETED"); process.exit(0); }
  if (errors.length) { console.log("RENDER FAILED"); process.exit(1); }
}
console.log("gave up after 120s — this is the hang the app reports");
process.exit(1);
