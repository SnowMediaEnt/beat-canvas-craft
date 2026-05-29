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

export function triggerDownload(href: string, filename?: string, openInNewTab = false) {
  if (openInNewTab) {
    const opened = window.open(href, "_blank", "noopener,noreferrer");
    if (!opened) {
      directDownload(href, filename);
    }
    return;
  }

  directDownload(href, filename);
}
