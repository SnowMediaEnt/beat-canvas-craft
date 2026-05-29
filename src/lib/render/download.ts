function directDownload(href: string, filename?: string) {
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

export function openPendingDownloadWindow() {
  return window.open("", "_blank");
}

export function triggerDownload(
  href: string,
  filename?: string,
  openInNewTab = false,
  pendingWindow?: Window | null,
) {
  if (openInNewTab) {
    if (pendingWindow && !pendingWindow.closed) {
      pendingWindow.location.href = href;
      return;
    }

    const opened = window.open(href, "_blank");
    if (!opened) {
      directDownload(href, filename);
    }
    return;
  }

  directDownload(href, filename);
}
