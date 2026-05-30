// Triggers a file download. For cross-origin signed S3 URLs we rely on the
// server-set `Content-Disposition: attachment` header to force a download,
// and navigate via a hidden anchor click in the SAME tab — opening these in
// a new tab via window.open leaves a blank white tab behind in most browsers
// (Chrome/Edge can't close cross-origin tabs it didn't fully load).
function clickAnchor(href: string, filename?: string) {
  const a = document.createElement("a");
  a.href = href;
  if (filename) a.download = filename;
  a.rel = "noopener noreferrer";
  a.style.position = "fixed";
  a.style.left = "-9999px";
  a.style.top = "0";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function triggerDownload(href: string, filename?: string, _openInNewTab = false) {
  // Always use an in-page anchor click. For signed S3 URLs the response has
  // Content-Disposition: attachment, so the browser downloads the file
  // without navigating away. For local blob: URLs the download attribute
  // does the same. No new tab, no white page.
  try {
    clickAnchor(href, filename);
  } catch {
    window.location.assign(href);
  }
}
