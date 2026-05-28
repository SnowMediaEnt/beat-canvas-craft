import { createFileRoute } from "@tanstack/react-router";

// Proxies a Remotion-lambda S3 render through our origin so the browser can
// stream it as a real attachment. Direct cross-origin downloads from S3 fail
// when the bucket has no CORS config — the fetch starts then aborts, which is
// exactly the "starts then stops" symptom users see. Restricted to
// remotionlambda-* buckets so this can't be used as an open proxy.
const ALLOWED_HOST = /^(?:[a-z0-9-]+\.)?s3[.-][a-z0-9-]+\.amazonaws\.com$/i;
const ALLOWED_KEY_BUCKET = /^remotionlambda-[a-z0-9-]+$/i;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export const Route = createFileRoute("/api/public/render-download")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => {
        const u = new URL(request.url);
        const target = u.searchParams.get("url");
        const filename = (u.searchParams.get("filename") || "render.mp4").replace(/[^a-zA-Z0-9._-]+/g, "_");
        if (!target) return new Response("missing url", { status: 400, headers: CORS });

        let parsed: URL;
        try { parsed = new URL(target); } catch { return new Response("bad url", { status: 400, headers: CORS }); }
        if (parsed.protocol !== "https:" || !ALLOWED_HOST.test(parsed.hostname)) {
          return new Response("host not allowed", { status: 403, headers: CORS });
        }
        // bucket lives either in the subdomain (bucket.s3.region.amazonaws.com)
        // or as the first path segment (s3.region.amazonaws.com/bucket/key)
        const subBucket = parsed.hostname.split(".")[0];
        const pathBucket = parsed.pathname.split("/").filter(Boolean)[0] || "";
        const bucket = ALLOWED_KEY_BUCKET.test(subBucket) ? subBucket : pathBucket;
        if (!ALLOWED_KEY_BUCKET.test(bucket)) {
          return new Response("bucket not allowed", { status: 403, headers: CORS });
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
