import { createFileRoute } from "@tanstack/react-router";
import { AwsClient } from "aws4fetch";

// Proxies a Remotion-lambda S3 render through our origin so the browser can
// stream it as a real attachment. Direct cross-origin downloads from S3 fail
// when the bucket has no CORS config — the fetch starts then aborts, which is
// exactly the "starts then stops" symptom users see. Restricted to
// remotionlambda-* buckets so this can't be used as an open proxy.
const ALLOWED_HOST = /^(?:[a-z0-9-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i;
const ALLOWED_KEY_BUCKET = /^remotionlambda-[a-z0-9-]+$/i;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]+/g, "_") || "render.mp4";
}

function decodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeObjectKey(key: string) {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseS3Target(rawUrl: string) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" || !ALLOWED_HOST.test(parsed.hostname)) {
    throw new Error("host not allowed");
  }

  const pathParts = parsed.pathname.split("/").filter(Boolean).map(decodePathSegment);
  const regionMatch = parsed.hostname.match(/(?:^|\.)(?:s3[.-]([a-z0-9-]+))\.amazonaws\.com$/i);
  const defaultRegion = process.env.REMOTION_AWS_REGION || "us-east-1";

  let bucketName = "";
  let objectKey = "";

  if (/^s3(?:[.-]|\.)/i.test(parsed.hostname)) {
    bucketName = pathParts[0] || "";
    objectKey = pathParts.slice(1).join("/");
  } else {
    bucketName = parsed.hostname.split(".")[0] || "";
    objectKey = pathParts.join("/");
  }

  if (!ALLOWED_KEY_BUCKET.test(bucketName) || !objectKey) {
    throw new Error("bucket not allowed");
  }

  return {
    bucketName,
    objectKey,
    region: regionMatch?.[1] || defaultRegion,
  };
}

async function ensureSignedDownloadUrl(rawUrl: string, filename: string) {
  const parsed = new URL(rawUrl);
  if (parsed.searchParams.has("X-Amz-Signature")) {
    return parsed.toString();
  }

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("missing aws credentials");
  }

  const { bucketName, objectKey, region } = parseS3Target(rawUrl);
  const signTarget = new URL(`https://s3.${region}.amazonaws.com/${bucketName}/${encodeObjectKey(objectKey)}`);
  signTarget.searchParams.set(
    "response-content-disposition",
    `attachment; filename=\"${sanitizeFilename(filename)}\"`,
  );

  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    sessionToken,
    service: "s3",
    region,
  });

  const signed = await client.sign(signTarget.toString(), {
    method: "GET",
    aws: { signQuery: true },
  });

  return signed.url.toString();
}

export const Route = createFileRoute("/api/public/render-download")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => {
        const u = new URL(request.url);
        const target = u.searchParams.get("url");
        const filename = sanitizeFilename(u.searchParams.get("filename") || "render.mp4");
        if (!target) return new Response("missing url", { status: 400, headers: CORS });

        let parsed: URL;
        try {
          parsed = new URL(await ensureSignedDownloadUrl(target, filename));
          parseS3Target(parsed.toString());
        } catch (error) {
          const message = error instanceof Error ? error.message : "bad url";
          const status = message === "bad url" ? 400 : message.includes("allowed") ? 403 : 500;
          return new Response(message, { status, headers: CORS });
        }

        const upstream = await fetch(parsed.toString());
        if (!upstream.ok || !upstream.body) {
          return new Response(`upstream ${upstream.status}`, { status: 502, headers: CORS });
        }

        const headers = new Headers(CORS);
        headers.set("content-type", upstream.headers.get("content-type") || "video/mp4");
        const len = upstream.headers.get("content-length");
        if (len) headers.set("content-length", len);
        headers.set("content-disposition", `attachment; filename="${filename}"`);
        headers.set("cache-control", "no-store");
        return new Response(upstream.body, { status: 200, headers });
      },
    },
  },
});
