// The Lambda access code the owner types into the Export dialog. Stored in
// localStorage so the Completed dialog and cloud uploads can reuse it.
const KEY = "ac_lambda_access_code";

export function getStoredAccessCode(): string {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(KEY) || ""; } catch { return ""; }
}

export function setStoredAccessCode(code: string) {
  if (typeof window === "undefined") return;
  try {
    if (code) window.localStorage.setItem(KEY, code);
    else window.localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}

export const ACCESS_CODE_HEADER = "x-render-code";
