// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { fileURLToPath } from "node:url";

const processShimPath = fileURLToPath(new URL("./src/lib/render/process-shim.ts", import.meta.url));

// Patch @remotion/lambda(-client) ESM entries: their generated bundle starts with
//   var __require = createRequire(import.meta.url);
// In the Cloudflare worker SSR build, `import.meta.url` evaluates to undefined,
// which makes `createRequire` throw
//   "argument 'path' ... Received 'undefined'"
// the moment our serverFn imports the package. Rewrite to a hardcoded file URL
// so module init succeeds. (The __require shim is only used for vendored CJS
// helpers that are already inlined into the bundle.)
const patchRemotionLambdaCreateRequire = {
  name: "patch-remotion-lambda-createrequire",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!/@remotion[\\/]+lambda(-client)?[\\/]+dist[\\/]+esm[\\/]+index\.mjs$/.test(id)) {
      return null;
    }
    if (!code.includes("createRequire(import.meta.url)")) return null;
    return {
      code: code.replace(
        "createRequire(import.meta.url)",
        'createRequire("file:///worker/remotion-lambda.mjs")',
      ),
      map: null,
    };
  },
};

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  vite: {
    resolve: {
      alias: {
        "node:process": processShimPath,
        process: processShimPath,
      },
    },
    plugins: [patchRemotionLambdaCreateRequire],
  },
});
