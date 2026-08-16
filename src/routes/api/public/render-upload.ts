import { createFileRoute } from "@tanstack/react-router";
import { AwsClient } from "aws4fetch";

const MAX_BYTES = 200 * 1024 * 1024; // 200MB cap
const SAFE_ID = /^[a-zA-Z0-9_.:-]{1,128}$/;

// Only the media types this app actually renders (audio track, image/video
// background, image logo) may be written to the bucket. The stored object's
// content-type is taken from this map, never from the client-supplied
// x-content-type header, so a caller cannot make S3 serve, e.g., text/html.
const ALLOWED_TYPES: Record<string, string> = {
  // audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  weba: "audio/webm",
  // image
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  // video
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-asset-id, x-asset-ext, x-content-type",
  "access-control-max-age": "86400",
};

const JSON_HEADERS = { "content-type": "application/json", ...CORS };

function jsonError(status: number, message: string, detail?: string) {
  return new Response(JSON.stringify({ error: message, ...(detail ? { detail } : {}) }), {
    status,
    headers: JSON_HEADERS,
  });
}

function parseBucketAndRegion(serveUrl: string, fallbackRegion: string): { bucket: string; region: string } | null {
  try {
    const u = new URL(serveUrl);
    // Virtual-hosted style: <bucket>.s3.<region>.amazonaws.com
    const vhost = u.hostname.match(/^([^.]+)\.s3[.-]([^.]+)\.amazonaws\.com$/);
    if (vhost) return { bucket: vhost[1], region: vhost[2] };

    // Path style: s3.<region>.amazonaws.com/<bucket>/...
    const pathHost = u.hostname.match(/^s3[.-]([^.]+)\.amazonaws\.com$/);
    if (pathHost) {
      const seg = u.pathname.split("/").filter(Boolean)[0];
      if (seg) return { bucket: seg, region: pathHost[1] };
    }

    // Fallback: first path segment as bucket
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (seg) return { bucket: seg, region: fallbackRegion };
  } catch {
    /* ignore */
  }
  return null;
}

export const Route = createFileRoute("/api/public/render-upload")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        try {
          const assetId = request.headers.get("x-asset-id") || "";
          const ext = (request.headers.get("x-asset-ext") || "bin").toLowerCase();

          if (!SAFE_ID.test(assetId)) {
            return jsonError(400, "Invalid asset identifier");
          }

          const contentType = ALLOWED_TYPES[ext];
          if (!contentType) {
            return jsonError(415, "Unsupported file type");
          }

          const lenHeader = request.headers.get("content-length");
          if (lenHeader && Number(lenHeader) > MAX_BYTES) {
            return jsonError(413, "File too large");
          }

          const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
          const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
          const sessionToken = process.env.AWS_SESSION_TOKEN;
          const region = process.env.REMOTION_AWS_REGION || "us-east-1";
          const serveUrl = process.env.REMOTION_AWS_SERVE_URL || "";

          if (!accessKeyId || !secretAccessKey) {
            return jsonError(500, "AWS credentials not configured");
          }

          const parsed = parseBucketAndRegion(serveUrl, region);
          if (!parsed) {
            return jsonError(500, "Could not determine Remotion S3 bucket from REMOTION_AWS_SERVE_URL");
          }
          const { bucket, region: bucketRegion } = parsed;

          const buf = await request.arrayBuffer();
          if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
            return jsonError(400, "Invalid file size");
          }

          const key = `render-assets/${assetId.replace(/[:.]/g, "_")}.${ext}`;
          const objectUrl = `https://${bucket}.s3.${bucketRegion}.amazonaws.com/${key}`;

          const client = new AwsClient({
            accessKeyId,
            secretAccessKey,
            sessionToken,
            service: "s3",
            region: bucketRegion,
          });

          const res = await client.fetch(objectUrl, {
            method: "PUT",
            body: buf,
            headers: { "content-type": contentType },
          });

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            console.error("[render-upload] S3 PUT failed", { status: res.status, body: text.slice(0, 400) });
            return jsonError(500, "Upload failed", `S3 ${res.status}`);
          }

          return new Response(JSON.stringify({ url: objectUrl }), {
            status: 200,
            headers: { ...JSON_HEADERS, "cache-control": "no-store" },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          console.error("[render-upload] handler error", err);
          return jsonError(500, "Upload failed", message);
        }
      },
    },
  },
});
