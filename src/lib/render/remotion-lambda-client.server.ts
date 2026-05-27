import { createRequire } from "node:module";

type ProcessLike = {
  env?: Record<string, string | undefined>;
  versions?: Record<string, string | undefined>;
  version?: string;
  release?: { name?: string };
  emitWarning?: (...args: unknown[]) => void;
};

type RemotionLambdaClient = typeof import("@remotion/lambda-client");

// `import.meta.url` can be undefined in the Cloudflare Worker SSR bundle.
// createRequire throws ERR_INVALID_ARG_VALUE when given undefined, which
// crashes module init and 500s every serverFn that imports this file.
const require = createRequire(
  (typeof import.meta !== "undefined" && import.meta.url) || "file:///worker.js",
);

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

  // Load the CommonJS entry on the server so package exports resolve the
  // `require` condition instead of the ESM `import` condition. The ESM path
  // inside @aws-sdk/core imports `node:process`, which is what breaks in the
  // Lambda render runtime; the CJS path relies on the Node-compatible require
  // shim and works with the runtime's global `process` fallback.
  ensureProcessFallback();
  cachedClient = require("@remotion/lambda-client") as RemotionLambdaClient;
  return cachedClient;
}