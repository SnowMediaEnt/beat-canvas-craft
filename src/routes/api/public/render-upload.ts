import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BUCKET = "render-assets";
const MAX_BYTES = 512 * 1024 * 1024; // 512MB cap for long browser-recorded WebM files
const SAFE_EXT = /^[a-z0-9]{1,8}$/;
const SAFE_ID = /^[a-zA-Z0-9_.:-]{1,128}$/;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-asset-id, x-asset-ext, x-content-type",
  "access-control-max-age": "86400",
};

export const Route = createFileRoute("/api/public/render-upload")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        const assetId = request.headers.get("x-asset-id") || "";
        const ext = (request.headers.get("x-asset-ext") || "bin").toLowerCase();
        const contentType = request.headers.get("x-content-type") || "application/octet-stream";

        if (!SAFE_ID.test(assetId) || !SAFE_EXT.test(ext)) {
          return new Response(JSON.stringify({ error: "Invalid asset identifier" }), {
            status: 400,
            headers: { "content-type": "application/json", ...CORS },
          });
        }

        const lenHeader = request.headers.get("content-length");
        if (lenHeader && Number(lenHeader) > MAX_BYTES) {
          return new Response(JSON.stringify({ error: "File too large" }), {
            status: 413,
            headers: { "content-type": "application/json", ...CORS },
          });
        }

        const buf = await request.arrayBuffer();
        if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
          return new Response(JSON.stringify({ error: "Invalid file size" }), {
            status: 400,
            headers: { "content-type": "application/json", ...CORS },
          });
        }

        const path = `${assetId.replace(/[:.]/g, "_")}.${ext}`;
        const body = new Blob([buf], { type: contentType });
        const { error } = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(path, body, { contentType, upsert: true });
        if (error && !`${error.message}`.toLowerCase().includes("exists")) {
          console.error("[render-upload] upload error", {
            message: error.message,
            name: (error as any).name,
            statusCode: (error as any).statusCode,
            assetId,
            ext,
            contentType,
            size: buf.byteLength,
          });
          return new Response(JSON.stringify({ error: "Upload failed", detail: error.message }), {
            status: 500,
            headers: { "content-type": "application/json", ...CORS },
          });
        }

        const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
        return new Response(JSON.stringify({ url: data.publicUrl }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
        });
      },
    },
  },
});
