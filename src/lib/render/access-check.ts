// Server-side check for the render access code. The code lives ONLY in the
// RENDER_ACCESS_CODE project secret; there is deliberately no fallback value,
// because this repository is public. With the secret unset every check fails.

export function isValidAccessCode(code: string | undefined | null): boolean {
  const expected = process.env.RENDER_ACCESS_CODE;
  if (!expected || !code) return false;
  // Constant-time compare so response timing can't leak the code.
  const a = new TextEncoder().encode(code);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}
