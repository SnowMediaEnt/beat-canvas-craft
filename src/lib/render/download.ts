// Download helper. Remote renders are routed through our same-origin proxy so
// the browser receives a real attachment response. Keep this synchronous so it
// runs within the original click gesture — async fetch/blob workflows can make
// browsers silently block the download.

function directDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function getProxyDownloadUrl(remoteUrl: string, filename: string) {
  const url = new URL("/api/public/render-download", window.location.origin);
  url.searchParams.set("url", remoteUrl);
  url.searchParams.set("filename", filename);

  const previewToken = new URLSearchParams(window.location.search).get("__lovable_token");
  if (previewToken) {
    url.searchParams.set("__lovable_token", previewToken);
  }

  return url.toString();
}

function downloadViaHiddenFrame(href: string) {
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.setAttribute("aria-hidden", "true");
  frame.src = href;
  document.body.appendChild(frame);
  window.setTimeout(() => {
    frame.remove();
  }, 60_000);
}

export function triggerDownload(href: string, filename: string, isRemote: boolean) {
  if (!isRemote) {
    directDownload(href, filename);
    return;
  }

  downloadViaHiddenFrame(getProxyDownloadUrl(href, filename));
}
