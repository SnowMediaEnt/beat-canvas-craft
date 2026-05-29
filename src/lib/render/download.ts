// Robust download helper. The same-origin proxy at /api/public/render-download
// streams S3 with attachment headers, but it isn't always reachable (the
// preview URL is behind an auth wall, and older published builds may not
// include the route yet). We probe the proxy and fall back to opening the
// direct URL in a new tab so the user always gets the file.

function directDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  a.target = "_blank";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function tryProxyBlobDownload(remoteUrl: string, filename: string): Promise<boolean> {
  const proxy = `/api/public/render-download?url=${encodeURIComponent(remoteUrl)}&filename=${encodeURIComponent(filename)}`;
  try {
    const res = await fetch(proxy, { method: "GET", redirect: "follow" });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || ct.includes("text/html")) return false;
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    try {
      directDownload(objUrl, filename);
    } finally {
      setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
    }
    return true;
  } catch {
    return false;
  }
}

export async function triggerDownload(href: string, filename: string, isRemote: boolean) {
  if (!isRemote) {
    directDownload(href, filename);
    return;
  }
  const ok = await tryProxyBlobDownload(href, filename);
  if (ok) return;
  // Fallback: open the direct S3 URL. Browsers will save mp4/webm with the
  // attribute, or play it inline where the user can right-click → save as.
  directDownload(href, filename);
}
