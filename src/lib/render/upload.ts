import { get } from "idb-keyval";
import { Upload as TusUpload } from "tus-js-client";
import type { AssetRef } from "@/lib/project/types";
import { supabase } from "@/integrations/supabase/client";

const UPLOAD_ENDPOINT = "/api/public/render-upload";
const RENDER_BUCKET = "render-assets";

const uploadedCache = new Map<string, string>();

type UploadKind = "audio" | "background" | "logo" | "asset";

function getSafeExt(name: string) {
  return (name.split(".").pop() || "bin")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8) || "bin";
}

export async function uploadBlobForRender({
  assetId,
  fileName,
  contentType,
  blob,
  onProgress,
}: {
  assetId: string;
  fileName: string;
  contentType: string;
  blob: Blob;
  onProgress?: (progress: number) => void;
}): Promise<string> {
  if (blob.size > 500 * 1024 * 1024) {
    return uploadLargeBlobForRender({ assetId, fileName, contentType, blob, onProgress });
  }

  const ext = getSafeExt(fileName);

  console.log("[render-upload] upload start", {
    assetId,
    name: fileName,
    type: contentType,
    size: blob.size,
  });

  // Materialize the blob to an ArrayBuffer before sending. Some browsers
  // (notably Safari) fail with a generic "Load failed" when streaming a
  // Blob pulled from IndexedDB directly through fetch — reading it into
  // memory first avoids the streaming path and makes the upload reliable.
  let body: ArrayBuffer;
  try {
    body = await blob.arrayBuffer();
  } catch (err) {
    // IndexedDB stores File/Blob objects "by reference" to an internal
    // file handle. If the user moved/renamed/deleted the source file, or
    // the browser evicted the backing store, reading throws
    // NotFoundError ("The object can not be found here.").
    const name = err instanceof Error ? err.name : "";
    if (name === "NotFoundError" || name === "NotReadableError") {
      throw new Error(
        `"${fileName}" can't be read from your browser anymore. Please re-upload it in the editor and try again.`,
      );
    }
    throw err;
  }

  const res = await fetch(UPLOAD_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-asset-id": assetId,
      "x-asset-ext": ext,
      "x-content-type": contentType || "application/octet-stream",
    },
    body,
  });


  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("[render-upload] upload error", { status: res.status, body: txt.slice(0, 300) });
    throw new Error(`Upload failed: ${res.status}`);
  }

  const { url } = (await res.json()) as { url?: string };
  if (!url) {
    console.error("[render-upload] public URL missing", { assetId, name: fileName });
    throw new Error("Upload succeeded but no file URL was returned");
  }

  console.log("[render-upload] upload success", { assetId, name: fileName, publicUrl: url });
  onProgress?.(100);
  return url;
}

async function uploadLargeBlobForRender({
  assetId,
  fileName,
  contentType,
  blob,
  onProgress,
}: {
  assetId: string;
  fileName: string;
  contentType: string;
  blob: Blob;
  onProgress?: (progress: number) => void;
}) {
  const ext = getSafeExt(fileName);
  const path = `${assetId.replace(/[:.]/g, "_")}.${ext}`;
  const contentTypeSafe = contentType || "application/octet-stream";
  const baseUrl = import.meta.env.VITE_SUPABASE_URL || (typeof window !== "undefined" ? window.location.origin : "");
  const projectRef = (() => {
    try {
      return new URL(baseUrl).hostname.split(".")[0];
    } catch {
      return "";
    }
  })();
  const storageEndpoint = projectRef
    ? `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`
    : `${baseUrl}/storage/v1/upload/resumable`;

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (sessionError || !accessToken) {
    throw new Error("Could not authorize large file upload");
  }

  return new Promise<string>((resolve, reject) => {
    const upload = new TusUpload(blob as File, {
      endpoint: storageEndpoint,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-upsert": "true",
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: 6 * 1024 * 1024,
      metadata: {
        bucketName: RENDER_BUCKET,
        objectName: path,
        contentType: contentTypeSafe,
        cacheControl: "3600",
      },
      onError: (error) => reject(error),
      onProgress: (uploaded, total) => {
        if (total > 0) onProgress?.(Math.round((uploaded / total) * 100));
      },
      onSuccess: () => {
        const { data } = supabase.storage.from(RENDER_BUCKET).getPublicUrl(path);
        if (!data.publicUrl) {
          reject(new Error("Upload succeeded but no file URL was returned"));
          return;
        }
        onProgress?.(100);
        resolve(data.publicUrl);
      },
    });

    upload.findPreviousUploads().then((previousUploads) => {
      if (previousUploads.length > 0) upload.resumeFromPreviousUpload(previousUploads[0]);
      upload.start();
    }).catch(reject);
  });
}

async function getBlob(ref: AssetRef): Promise<Blob | null> {
  const blob = await get<Blob>(`asset:${ref.id}`);
  return blob ?? null;
}

async function getBlobFromUrl(url: string, ref: AssetRef): Promise<Blob | null> {
  if (!url) return null;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[render-upload] fetch asset url failed", { assetId: ref.id, url, status: res.status });
      return null;
    }

    const blob = await res.blob();
    console.log("[render-upload] fetched asset from current url", {
      assetId: ref.id,
      name: ref.name,
      url,
      size: blob.size,
    });
    return blob;
  } catch (error) {
    console.error("[render-upload] fetch asset url error", { assetId: ref.id, url, error });
    return null;
  }
}

export async function uploadAssetForRender(ref: AssetRef | undefined): Promise<string | null> {
  if (!ref) return null;
  const cached = uploadedCache.get(ref.id);
  if (cached) {
    console.log("[render-upload] cache hit", { assetId: ref.id, name: ref.name, url: cached });
    return cached;
  }

  let blob: Blob | null = null;

  // Prefer the live object URL from the current editor session when available.
  // This avoids stale IndexedDB handles after a user replaces the file and
  // immediately renders again.
  if (ref.url?.startsWith("blob:")) {
    blob = await getBlobFromUrl(ref.url, ref);
  }

  if (!blob) {
    blob = await getBlob(ref);
  }

  if (!blob && ref.url) {
    blob = await getBlobFromUrl(ref.url, ref);
  }

  if (!blob) {
    console.error("[render-upload] missing IndexedDB blob", { assetId: ref.id, name: ref.name, type: ref.type });
    return null;
  }

  const url = await uploadBlobForRender({
    assetId: ref.id,
    fileName: ref.name,
    contentType: ref.type || "application/octet-stream",
    blob,
  });

  uploadedCache.set(ref.id, url);
  return url;
}


export function assertRenderableAssetUrl(kind: UploadKind, url: string | null | undefined) {
  if (typeof url === "string" && url.trim().length > 0) return url;

  const messageByKind: Record<UploadKind, string> = {
    audio: "Audio upload failed — cannot render",
    background: "Background upload failed — cannot render with the selected background",
    logo: "Logo upload failed — cannot render with the selected logo",
    asset: "Asset upload failed — cannot render",
  };

  throw new Error(messageByKind[kind]);
}
