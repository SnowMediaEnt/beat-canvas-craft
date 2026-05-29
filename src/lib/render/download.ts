function directDownload(href: string, filename?: string, target?: "_blank") {
  const a = document.createElement("a");
  a.href = href;
  if (filename) a.download = filename;
  if (target) a.target = target;
  a.rel = "noopener noreferrer";
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
      try {
        directDownload(href, filename, "_blank");
      } catch {
        window.location.assign(href);
      }
    }
    return;
  }

  directDownload(href, filename);
}
