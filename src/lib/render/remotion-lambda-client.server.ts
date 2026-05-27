// Cloudflare Workers cannot do runtime module resolution — `createRequire()`
// returns a stub that throws `No such module "@remotion/lambda-client"`.
// Use a static ESM import so Vite bundles the package into the worker.
// The ESM entry's `createRequire(import.meta.url)` call (which would otherwise
// crash on undefined `import.meta.url`) is rewritten by the
// `patchRemotionLambdaCreateRequire` plugin in vite.config.ts.
import * as remotionLambdaClient from "@remotion/lambda-client";

type ProcessLike = {
  env?: Record<string, string | undefined>;
  versions?: Record<string, string | undefined>;
  version?: string;
  release?: { name?: string };
  emitWarning?: (...args: unknown[]) => void;
};

type RemotionLambdaClient = typeof import("@remotion/lambda-client");

let cachedClient: RemotionLambdaClient | null = null;

function ensureProcessFallback() {
  const globalScope = globalThis as Record<string, unknown>;
  const processRef = ((globalScope.process as ProcessLike | undefined) ??= {} as ProcessLike);
  processRef.env ??= {};
  processRef.versions ??= { node: "22.0.0" };
  processRef.version ??= "v22.0.0";
  processRef.release ??= { name: "node" };
  processRef.emitWarning ??= () => undefined;
}

export function loadRemotionLambdaClient(): RemotionLambdaClient {
  if (cachedClient) return cachedClient;
  ensureProcessFallback();
  cachedClient = remotionLambdaClient as RemotionLambdaClient;
  return cachedClient;
}
