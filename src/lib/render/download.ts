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
  return `/api/public/render-download?url=${encodeURIComponent(remoteUrl)}&filename=${encodeURIComponent(filename)}`;
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
