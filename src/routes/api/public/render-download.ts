import { createFileRoute } from "@tanstack/react-router";
import { AwsClient } from "aws4fetch";
import { parseBucketAndRegion } from "@/lib/render/lambda-config";

// Proxies a finished render through our origin so the browser can save it as
// a real attachment when the direct S3 link misbehaves (older objects without
// Content-Disposition, some mobile browsers). Restricted to the ONE bucket
// configured in REMOTION_AWS_SERVE_URL and to render output keys, so it can't
// be used as a relay for anyone else's buckets.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const RENDER_KEY = /^renders\/[A-Za-z0-9_-]{4,64}\/out\.(mp4|webm)$/;

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

function configuredBucket() {
  const region = process.env.REMOTION_AWS_REGION || "us-east-1";
  const serveUrl = process.env.REMOTION_AWS_SERVE_URL || "";
  const parsed = parseBucketAndRegion(serveUrl, region);
  if (!parsed) throw new Error("render bucket not configured");
  return parsed;
}

function parseS3Target(rawUrl: string) {
  const { bucketName: allowedBucket, region } = configuredBucket();
  let bucketName = "";
  let objectKey = "";

  if (rawUrl.startsWith("s3://")) {
    const parsed = new URL(rawUrl);
    bucketName = parsed.hostname;
    objectKey = parsed.pathname.replace(/^\/+/, "").split("/").map(decodePathSegment).join("/");
  } else {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" || !/\.amazonaws\.com$/i.test(parsed.hostname)) {
      throw new Error("host not allowed");
    }
    const pathParts = parsed.pathname.split("/").filter(Boolean).map(decodePathSegment);
    if (/^s3(?:[.-]|\.)/i.test(parsed.hostname)) {
      bucketName = pathParts[0] || "";
      objectKey = pathParts.slice(1).join("/");
    } else {
      bucketName = parsed.hostname.split(".")[0] || "";
      objectKey = pathParts.join("/");
    }
  }

  if (bucketName !== allowedBucket || !RENDER_KEY.test(objectKey)) {
    throw new Error("bucket not allowed");
  }
  return { bucketName, objectKey, region };
}

async function fetchSignedObject(rawUrl: string, filename: string) {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("missing aws credentials");
  }

  const target = parseS3Target(rawUrl);
  const objectUrl = new URL(
    `https://${target.bucketName}.s3.${target.region}.amazonaws.com/${encodeObjectKey(target.objectKey)}`,
  );
  objectUrl.searchParams.set(
    "response-content-disposition",
    `attachment; filename="${sanitizeFilename(filename)}"`,
  );

  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    sessionToken,
    service: "s3",
    region: target.region,
  });

  return client.fetch(objectUrl.toString(), { method: "GET" });
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

        try {
          parseS3Target(target);
        } catch (error) {
          const message = error instanceof Error ? error.message : "bad url";
          const status = message.includes("allowed") ? 403 : message.includes("configured") ? 500 : 400;
          return new Response(message, { status, headers: CORS });
        }

        let upstream: Response;
        try {
          upstream = await fetchSignedObject(target, filename);
        } catch (error) {
          const message = error instanceof Error ? error.message : "download failed";
          return new Response(message, { status: 500, headers: CORS });
        }
        if (!upstream.ok || !upstream.body) {
          return new Response(`upstream ${upstream.status}`, {
            status: upstream.status === 404 ? 404 : 502,
            headers: CORS,
          });
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
