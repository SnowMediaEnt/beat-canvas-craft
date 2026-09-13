import { createServerFn } from "@tanstack/react-start";
import { AwsClient } from "aws4fetch";
import { z } from "zod";
import { buildStartPayload, type RenderInputProps } from "./start-payload";
import { REMOTION_OUTPUT_PREFIX, parseBucketAndRegion } from "./lambda-config";

/**
 * End-to-end render self-test, run from the SERVER the app is deployed on.
 *
 * A render can work when driven from a laptop or CI and still fail in
 * production, because only the deployed server has the project's own AWS
 * secrets and network path. This walks the whole route — upload an asset,
 * check Lambda can read it, start a two-second render, watch its progress —
 * and reports where it stops, so a stuck export has an answer instead of a
 * spinner. It costs well under a cent.
 */

export interface SelfTestStep {
  id: string;
  label: string;
  status: "ok" | "fail" | "skip";
  detail: string;
}

export interface SelfTestResult {
  ok: boolean;
  steps: SelfTestStep[];
  outputUrl: string | null;
}

const POLL_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 3000;

/** A 1-second 8 kHz mono WAV tone, built in code so the test needs no assets. */
function toneWav(): Uint8Array {
  const sr = 8000, n = sr;
  const bytes = new Uint8Array(44 + n * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + n * 2, true); ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / sr)), true);
  return bytes;
}

function testProps(audioUrl: string): RenderInputProps {
  return {
    audioUrl,
    durationSeconds: 2, fps: 30, width: 640, height: 360,
    backgroundUrl: null, backgroundType: null, backgroundColor: "#0a0612", logoUrl: null,
    visualizer: {
      presetId: "circular-spectrum", primary: "#22e3ff", secondary: "#b14bff", accent: "#ff4bd1", glow: "#22e3ff",
      overlay: "#000000", overlayOpacity: 0.35, glowIntensity: 0.8, blur: 0, size: 1, thickness: 4,
      position: { x: 0, y: 0 }, logoSize: 0.35, logoPosition: { x: 0, y: 0 },
      backgroundScale: 1, backgroundBlur: 0, backgroundTint: "#0a0612", backgroundTintOpacity: 0,
      animationSpeed: 1, sensitivity: 1.2, bassSensitivity: 1.3, midSensitivity: 1, trebleSensitivity: 1,
      smoothing: 0.5, rotation: 0, movement: 0, shadow: 0, border: 0, blendMode: "source-over",
      reactivity: 1, bandCount: 48, stationary: true,
      custom: { shape: "bars", count: 48, spacing: 0.25, amplitude: 1, thickness: 0, rounded: true, symmetric: false, reactivity: 1, innerRadius: 0.35 },
    },
    effects: { particles: { enabled: false, type: "dust", density: 10, speed: 0.4, color: "#ffffff", opacity: 0.3, reactivity: 0.3 }, beatFlash: false, vignette: true, noise: false, lensFlare: false },
    lyrics: { enabled: false, lines: [], style: "Subtitle", position: "bottom", fontFamily: "Arial", fontSize: 42, color: "#ffffff", outline: true, shadow: true, glow: false, fade: true },
    title: "self test", engineVersion: 2, quality: "standard",
  } as unknown as RenderInputProps;
}

export const runRenderSelfTest = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ accessCode: z.string() }).parse(input))
  .handler(async ({ data }): Promise<SelfTestResult> => {
    const expectedCode = process.env.RENDER_ACCESS_CODE || "2650562";
    if (data.accessCode !== expectedCode) throw new Error("Invalid access code");

    const steps: SelfTestStep[] = [];
    const push = (s: SelfTestStep) => steps.push(s);
    const fail = (outputUrl: string | null = null): SelfTestResult => ({ ok: false, steps, outputUrl });

    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || "";
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "";
    const sessionToken = process.env.AWS_SESSION_TOKEN;
    const region = process.env.REMOTION_AWS_REGION || "";
    const functionName = process.env.REMOTION_AWS_FUNCTION_NAME || "";
    const serveUrl = process.env.REMOTION_AWS_SERVE_URL || "";
    const parsed = serveUrl ? parseBucketAndRegion(serveUrl, region || "us-east-1") : null;

    if (!accessKeyId || !secretAccessKey || !region || !functionName || !parsed) {
      push({ id: "env", label: "Settings", status: "fail", detail: "AWS keys, region, function name or serve URL are missing. Fix those first." });
      return fail();
    }
    const bucketName = parsed.bucketName;
    const bucketRegion = parsed.region;
    push({ id: "env", label: "Settings", status: "ok", detail: `Function ${functionName} in ${region}; bucket ${bucketName} in ${bucketRegion}.` });

    const s3 = new AwsClient({ accessKeyId, secretAccessKey, sessionToken, service: "s3", region: bucketRegion });
    const lambda = new AwsClient({ accessKeyId, secretAccessKey, sessionToken, service: "lambda", region });

    // 1. Upload a tiny asset exactly where real uploads go.
    const key = "render-assets/_selftest.wav";
    const objectUrl = `https://${bucketName}.s3.${bucketRegion}.amazonaws.com/${key}`;
    try {
      const wav = toneWav();
      const put = await s3.fetch(objectUrl, { method: "PUT", body: wav as BodyInit, headers: { "content-type": "audio/wav" } });
      if (!put.ok) {
        push({ id: "upload", label: "Upload a test asset", status: "fail", detail: `S3 refused the upload (${put.status}). The IAM user needs s3:PutObject on ${bucketName}.` });
        return fail();
      }
      push({ id: "upload", label: "Upload a test asset", status: "ok", detail: `Wrote ${key} (${wav.byteLength} bytes).` });
    } catch (e) {
      push({ id: "upload", label: "Upload a test asset", status: "fail", detail: `Could not reach S3 from the server: ${e instanceof Error ? e.message : String(e)}` });
      return fail();
    }

    // 2. Can Lambda's browser read it? It has no AWS credentials of its own.
    let audioUrl = objectUrl;
    try {
      const plain = await fetch(objectUrl, { method: "GET", headers: { range: "bytes=0-0" } });
      if (plain.ok || plain.status === 206) {
        push({ id: "read", label: "Asset readable by Lambda", status: "ok", detail: "The uploaded file is readable without credentials." });
      } else {
        const signable = new URL(objectUrl);
        signable.searchParams.set("X-Amz-Expires", "3600");
        const signed = await s3.sign(signable.toString(), { method: "GET", aws: { signQuery: true } });
        audioUrl = signed.url;
        push({ id: "read", label: "Asset readable by Lambda", status: "ok", detail: `Not public (${plain.status}) — using a signed link instead, which is what renders use.` });
      }
    } catch (e) {
      push({ id: "read", label: "Asset readable by Lambda", status: "fail", detail: `Could not fetch the uploaded file back: ${e instanceof Error ? e.message : String(e)}` });
      return fail();
    }

    // 3. Start a real two-second render.
    let renderId: string;
    try {
      const { payload } = buildStartPayload(serveUrl, bucketName, testProps(audioUrl));
      const url = `https://lambda.${region}.amazonaws.com/2015-03-31/functions/${encodeURIComponent(functionName)}/invocations`;
      const res = await lambda.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-amz-invocation-type": "RequestResponse" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok || res.headers.has("x-amz-function-error")) {
        push({ id: "start", label: "Start the render", status: "fail", detail: `Lambda refused it (${res.status}): ${text.slice(0, 300)}` });
        return fail();
      }
      const body = JSON.parse(text) as { renderId?: string; type?: string; message?: string };
      if (body.type === "error" || !body.renderId) {
        push({ id: "start", label: "Start the render", status: "fail", detail: body.message || text.slice(0, 300) });
        return fail();
      }
      renderId = body.renderId;
      push({ id: "start", label: "Start the render", status: "ok", detail: `AWS accepted it (render ${renderId}).` });
    } catch (e) {
      push({ id: "start", label: "Start the render", status: "fail", detail: `Could not reach Lambda from the server: ${e instanceof Error ? e.message : String(e)}` });
      return fail();
    }

    // 4. Watch it the way the export dialog does.
    const progressUrl = `https://${bucketName}.s3.${bucketRegion}.amazonaws.com/${REMOTION_OUTPUT_PREFIX}${renderId}/progress.json`;
    let last = "no progress file yet";
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      let json: Record<string, unknown> | null = null;
      try {
        const res = await s3.fetch(progressUrl, { method: "GET" });
        if (res.status === 404) { last = `still no progress file after ${(i + 1) * 3}s`; continue; }
        if (!res.ok) { last = `progress file unreadable (${res.status})`; continue; }
        json = (await res.json()) as Record<string, unknown>;
      } catch (e) {
        last = `progress read failed: ${e instanceof Error ? e.message : String(e)}`;
        continue;
      }
      const errors = (json.errors as { message?: string }[] | undefined) ?? [];
      if (errors.length) {
        push({ id: "render", label: "Render the frames", status: "fail", detail: String(errors[0]?.message || "Render failed").slice(0, 400) });
        return fail();
      }
      if (json.postRenderData) {
        const out = `https://s3.${bucketRegion}.amazonaws.com/${bucketName}/${REMOTION_OUTPUT_PREFIX}${renderId}/out.mp4`;
        push({ id: "render", label: "Render the frames", status: "ok", detail: `Finished in about ${(i + 1) * 3}s.` });
        return { ok: true, steps, outputUrl: out };
      }
      last = `launcher started=${Boolean(json.functionLaunched)}, bundle opened=${Boolean(json.serveUrlOpened)}, workers=${json.lambdasInvoked ?? 0}, frames=${json.framesRendered ?? 0}`;
    }

    push({ id: "render", label: "Render the frames", status: "fail", detail: `Never finished within ${(POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s — ${last}.` });
    return fail();
  });
