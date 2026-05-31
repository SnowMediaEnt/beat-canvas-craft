// Triggers a file download. Cross-origin signed S3 URLs are unreliable on
// mobile: the `download` attribute is ignored for cross-origin URLs, and
// mobile Safari navigates away to the file instead of downloading. For
// lambda renders we therefore route through the same-origin proxy at
// /api/public/render-download which streams the S3 object back with
// Content-Disposition: attachment, which all browsers honor as a download.
function clickAnchor(href: string, filename?: string) {
  const a = document.createElement("a");
  a.href = href;
  if (filename) a.download = filename;
  a.rel = "noopener";
  a.style.position = "fixed";
  a.style.left = "-9999px";
  a.style.top = "0";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function buildProxyDownloadUrl(s3Url: string, filename?: string) {
  const params = new URLSearchParams({ url: s3Url });
  if (filename) params.set("filename", filename);
  return `/api/public/render-download?${params.toString()}`;
}

export function triggerDownload(href: string, filename?: string, _openInNewTab = false) {
  try {
    clickAnchor(href, filename);
  } catch {
    window.location.assign(href);
  }
}
