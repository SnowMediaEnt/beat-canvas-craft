import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";

function isServerFunctionRequest(request: Request) {
  const accept = request.headers.get("accept") ?? "";
  return (
    request.headers.has("x-tsr-serverfn") ||
    accept.includes("application/x-tss-framed") ||
    accept.includes("application/x-ndjson")
  );
}

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    const request = globalThis instanceof Object && "__TSS_REQUEST" in globalThis
      ? ((globalThis as Record<string, unknown>).__TSS_REQUEST as Request | undefined)
      : undefined;
    if (request && isServerFunctionRequest(request)) {
      throw error;
    }
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware],
}));
