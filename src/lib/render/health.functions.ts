import { createServerFn } from "@tanstack/react-start";
import { AwsClient } from "aws4fetch";
import { z } from "zod";
import { REMOTION_VERSION, parseBucketAndRegion } from "./lambda-config";

// One-click AWS diagnostics for the Export dialog. Every check is read-only
// (no Lambda invocations, no S3 writes) so it is safe to run repeatedly.

export type HealthStatus = "ok" | "warn" | "fail" | "skip";

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
}

export interface RenderHealth {
  ok: boolean;
  checkedAt: number;
  env: {
    hasAccessKey: boolean;
    hasSecretKey: boolean;
    hasSessionToken: boolean;
    region: string | null;
    functionName: string | null;
    serveUrl: string | null;
    bucket: string | null;
    siteName: string | null;
    expectedRemotionVersion: string;
  };
  checks: HealthCheck[];
  deployCommand: string | null;
}

const FETCH_TIMEOUT_MS = 9000;

async function fetchWithTimeout(client: AwsClient | null, url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const opts = { ...init, signal: controller.signal };
    return client ? await client.fetch(url, opts) : await fetch(url, opts);
  } finally {
    clearTimeout(timer);
  }
}

function parseSiteName(serveUrl: string | null): string | null {
  if (!serveUrl) return null;
  const m = serveUrl.match(/\/sites\/([^/]+)\//);
  return m ? m[1] : null;
}

function parseFunctionVersion(functionName: string | null): string | null {
  if (!functionName) return null;
  const m = functionName.match(/remotion-render-(\d+)-(\d+)-(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export const getRenderHealth = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ accessCode: z.string() }).parse(input))
  .handler(async ({ data }): Promise<RenderHealth> => {
  // The report names the function, bucket and site, so it is owner-only.
  const expectedCode = process.env.RENDER_ACCESS_CODE || "2650562";
  if (data.accessCode !== expectedCode) {
    throw new Error("Enter your render access code to run the AWS check.");
  }
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "";
  const sessionToken = process.env.AWS_SESSION_TOKEN || undefined;
  const region = process.env.REMOTION_AWS_REGION || null;
  const functionName = process.env.REMOTION_AWS_FUNCTION_NAME || null;
  const serveUrl = process.env.REMOTION_AWS_SERVE_URL || null;
  const parsed = serveUrl ? parseBucketAndRegion(serveUrl, region || "us-east-1") : null;
  const bucket = parsed?.bucketName ?? null;
  const bucketRegion = parsed?.region ?? region ?? null;
  const siteName = parseSiteName(serveUrl);

  const checks: HealthCheck[] = [];
  const push = (c: HealthCheck) => checks.push(c);

  // 1. Credentials present
  const hasCreds = Boolean(accessKeyId && secretAccessKey);
  push({
    id: "credentials",
    label: "AWS credentials",
    status: hasCreds ? "ok" : "fail",
    detail: hasCreds
      ? `Access key ending …${accessKeyId.slice(-4)}${sessionToken ? " (with session token)" : ""}`
      : "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set in the project secrets.",
  });

  // 2. Remotion env present
  const missing = [
    !region ? "REMOTION_AWS_REGION" : null,
    !functionName ? "REMOTION_AWS_FUNCTION_NAME" : null,
    !serveUrl ? "REMOTION_AWS_SERVE_URL" : null,
  ].filter(Boolean) as string[];
  push({
    id: "config",
    label: "Remotion Lambda settings",
    status: missing.length ? "fail" : "ok",
    detail: missing.length
      ? `Missing: ${missing.join(", ")}`
      : `Region ${region} · bucket ${bucket ?? "?"} · site "${siteName ?? "?"}"`,
  });

  // 3. Function name encodes the Remotion version it was deployed with.
  const fnVersion = parseFunctionVersion(functionName);
  if (functionName) {
    push({
      id: "version",
      label: "Lambda function version",
      status: !fnVersion ? "warn" : fnVersion === REMOTION_VERSION ? "ok" : "fail",
      detail: !fnVersion
        ? `Could not read a version from "${functionName}" — expected a name like remotion-render-${REMOTION_VERSION.replace(/\./g, "-")}-mem2048mb-disk2048mb-900sec.`
        : fnVersion === REMOTION_VERSION
          ? `Function is Remotion ${fnVersion}, matching the app (${REMOTION_VERSION}).`
          : `Function is Remotion ${fnVersion} but the app expects ${REMOTION_VERSION}. Renders will be rejected — deploy a matching function: npx remotion lambda functions deploy --region=${region ?? "<region>"}`,
    });
  }

  if (!hasCreds || missing.length) {
    return {
      ok: false,
      checkedAt: Date.now(),
      env: {
        hasAccessKey: Boolean(accessKeyId), hasSecretKey: Boolean(secretAccessKey), hasSessionToken: Boolean(sessionToken),
        region, functionName, serveUrl, bucket, siteName, expectedRemotionVersion: REMOTION_VERSION,
      },
      checks,
      deployCommand: siteName && region ? `npx remotion lambda sites create src/remotion/index.ts --site-name=${siteName} --region=${region}` : null,
    };
  }

  const lambdaClient = new AwsClient({ accessKeyId, secretAccessKey, sessionToken, service: "lambda", region: region! });
  const s3Client = new AwsClient({ accessKeyId, secretAccessKey, sessionToken, service: "s3", region: bucketRegion || region! });

  // 4. Lambda function exists in this region (read-only GetFunctionConfiguration)
  try {
    const res = await fetchWithTimeout(
      lambdaClient,
      `https://lambda.${region}.amazonaws.com/2015-03-31/functions/${encodeURIComponent(functionName!)}/configuration`,
      { method: "GET" },
    );
    if (res.ok) {
      const cfg = (await res.json().catch(() => ({}))) as { Timeout?: number; MemorySize?: number; EphemeralStorage?: { Size?: number }; LastModified?: string };
      push({
        id: "function",
        label: "Lambda function reachable",
        status: "ok",
        detail: `Timeout ${cfg.Timeout ?? "?"}s · memory ${cfg.MemorySize ?? "?"} MB · disk ${cfg.EphemeralStorage?.Size ?? "?"} MB${cfg.LastModified ? ` · deployed ${cfg.LastModified}` : ""}`,
      });
    } else if (res.status === 403) {
      push({ id: "function", label: "Lambda function reachable", status: "warn", detail: "Credentials can't inspect the function (lambda:GetFunctionConfiguration denied). Renders may still work if lambda:InvokeFunction is allowed." });
    } else if (res.status === 404) {
      push({ id: "function", label: "Lambda function reachable", status: "fail", detail: `No function named "${functionName}" in ${region}. Deploy one with: npx remotion lambda functions deploy --region=${region}` });
    } else {
      push({ id: "function", label: "Lambda function reachable", status: "fail", detail: `AWS answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}` });
    }
  } catch (e) {
    push({ id: "function", label: "Lambda function reachable", status: "fail", detail: `Could not reach AWS Lambda: ${e instanceof Error ? e.message : String(e)}` });
  }

  // 5. Site bundle is deployed (public read) — also tells the user WHEN it was last deployed.
  try {
    const res = await fetchWithTimeout(null, serveUrl!, { method: "HEAD" });
    const lm = res.headers.get("last-modified");
    if (res.ok) {
      push({ id: "site", label: "Visualizer bundle on S3", status: "ok", detail: `Deployed${lm ? ` ${new Date(lm).toLocaleString("en-US")}` : ""}. If you changed presets or effects since then, redeploy so Lambda renders the new code.` });
    } else {
      // Bucket may not allow anonymous HEAD — retry signed.
      const signed = await fetchWithTimeout(s3Client, serveUrl!, { method: "HEAD" });
      const lm2 = signed.headers.get("last-modified");
      push({
        id: "site",
        label: "Visualizer bundle on S3",
        status: signed.ok ? "warn" : "fail",
        detail: signed.ok
          ? `Deployed${lm2 ? ` ${new Date(lm2).toLocaleString("en-US")}` : ""}, but not publicly readable (${res.status}). Lambda needs public read on sites/ to load the bundle.`
          : `Bundle not found at the serve URL (${signed.status}). Deploy it with the command below.`,
      });
    }
  } catch (e) {
    push({ id: "site", label: "Visualizer bundle on S3", status: "fail", detail: `Could not reach the serve URL: ${e instanceof Error ? e.message : String(e)}` });
  }

  // 6. Bucket read access (signed ListObjectsV2, max 1 key) — needed for progress polling + downloads.
  if (bucket) {
    try {
      const url = `https://${bucket}.s3.${bucketRegion}.amazonaws.com/?list-type=2&prefix=renders%2F&max-keys=1`;
      const res = await fetchWithTimeout(s3Client, url, { method: "GET" });
      if (res.ok) {
        push({ id: "bucket", label: "S3 bucket access", status: "ok", detail: `Can read ${bucket} (progress polling + downloads will work).` });
      } else if (res.status === 301 || res.status === 400) {
        push({ id: "bucket", label: "S3 bucket access", status: "fail", detail: `Bucket ${bucket} is not in ${bucketRegion} — REMOTION_AWS_REGION / REMOTION_AWS_SERVE_URL disagree with the bucket's real region.` });
      } else {
        push({ id: "bucket", label: "S3 bucket access", status: "fail", detail: `S3 answered ${res.status} for ${bucket}. Check the IAM policy (s3:ListBucket, s3:GetObject, s3:PutObject).` });
      }
    } catch (e) {
      push({ id: "bucket", label: "S3 bucket access", status: "fail", detail: `Could not reach S3: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  const ok = checks.every((c) => c.status === "ok" || c.status === "warn" || c.status === "skip");
  return {
    ok,
    checkedAt: Date.now(),
    env: {
      hasAccessKey: Boolean(accessKeyId), hasSecretKey: Boolean(secretAccessKey), hasSessionToken: Boolean(sessionToken),
      region, functionName, serveUrl, bucket, siteName, expectedRemotionVersion: REMOTION_VERSION,
    },
    checks,
    deployCommand: siteName && region ? `npx remotion lambda sites create src/remotion/index.ts --site-name=${siteName} --region=${region}` : null,
  };
});
