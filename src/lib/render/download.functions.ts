import { createServerFn } from "@tanstack/react-start";
import { AwsClient } from "aws4fetch";
import { z } from "zod";

const ALLOWED_HOST = /^(?:[a-z0-9-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i;
const ALLOWED_BUCKET = /^remotionlambda-[a-z0-9-]+$/i;

const inputSchema = z.object({
  url: z.string().url(),
  filename: z.string().min(1).max(180),
});

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]+/g, "_") || "render.mp4";
}

function decodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeObjectKey(key: string) {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseS3Target(rawUrl: string) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" || !ALLOWED_HOST.test(parsed.hostname)) {
    throw new Error("Only AWS S3 render files can be downloaded.");
  }

  const pathParts = parsed.pathname.split("/").filter(Boolean).map(decodePathSegment);
  const regionMatch = parsed.hostname.match(/(?:^|\.)(?:s3[.-]([a-z0-9-]+))\.amazonaws\.com$/i);
  const defaultRegion = process.env.REMOTION_AWS_REGION || "us-east-1";

  let bucketName = "";
  let objectKey = "";

  if (/^s3(?:[.-]|\.)/i.test(parsed.hostname)) {
    bucketName = pathParts[0] || "";
    objectKey = pathParts.slice(1).join("/");
  } else {
    bucketName = parsed.hostname.split(".")[0] || "";
    objectKey = pathParts.join("/");
  }

  if (!ALLOWED_BUCKET.test(bucketName) || !objectKey) {
    throw new Error("The render file could not be found.");
  }

  return {
    bucketName,
    objectKey,
    region: regionMatch?.[1] || defaultRegion,
  };
}

export const getFreshRenderDownloadUrl = createServerFn({ method: "POST" })
  .inputValidator((input) => inputSchema.parse(input))
  .handler(async ({ data }) => {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = process.env.AWS_SESSION_TOKEN;

    if (!accessKeyId || !secretAccessKey) {
      throw new Error("Missing AWS credentials for download signing.");
    }

    const { bucketName, objectKey, region } = parseS3Target(data.url);
    const signedTarget = new URL(
      `https://s3.${region}.amazonaws.com/${bucketName}/${encodeObjectKey(objectKey)}`,
    );
    signedTarget.searchParams.set(
      "response-content-disposition",
      `attachment; filename=\"${sanitizeFilename(data.filename)}\"`,
    );

    const client = new AwsClient({
      accessKeyId,
      secretAccessKey,
      sessionToken,
      service: "s3",
      region,
    });

    const signed = await client.sign(signedTarget.toString(), {
      method: "GET",
      aws: {
        signQuery: true,
      },
    });

    return signed.url.toString();
  });
