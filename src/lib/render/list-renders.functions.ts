import { createServerFn } from "@tanstack/react-start";
import { AwsClient } from "aws4fetch";
import { z } from "zod";
import { REMOTION_OUTPUT_PREFIX, parseBucketAndRegion } from "./lambda-config";

export interface CloudRender {
  renderId: string;
  bucketName: string;
  key: string;
  url: string;
  sizeBytes: number;
  lastModified: number;
  fileFormat: "mp4" | "webm";
  region: string;
}

function parseXmlTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function extractTag(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1];
}

/**
 * Lists finished renders in the configured Remotion bucket. Requires the
 * render access code: every visitor used to be able to enumerate (and
 * download) every render in the AWS account.
 */
export const listLambdaRenders = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ accessCode: z.string() }).parse(input))
  .handler(async ({ data }): Promise<CloudRender[]> => {
    const expected = process.env.RENDER_ACCESS_CODE || "2650562";
    if (data.accessCode !== expected) {
      throw new Error("Invalid access code.");
    }
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = process.env.AWS_SESSION_TOKEN;
    const defaultRegion = process.env.REMOTION_AWS_REGION || "us-east-1";
    const serveUrl = process.env.REMOTION_AWS_SERVE_URL || "";
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("Missing AWS credentials");
    }
    const parsed = parseBucketAndRegion(serveUrl, defaultRegion);
    if (!parsed) throw new Error("Could not determine the Remotion S3 bucket from REMOTION_AWS_SERVE_URL");
    const { bucketName, region } = parsed;

    const aws = new AwsClient({ accessKeyId, secretAccessKey, sessionToken, service: "s3", region });
    const results: CloudRender[] = [];
    let continuationToken: string | undefined;
    do {
      const params = new URLSearchParams({ "list-type": "2", prefix: REMOTION_OUTPUT_PREFIX });
      if (continuationToken) params.set("continuation-token", continuationToken);
      const url = `https://${bucketName}.s3.${region}.amazonaws.com/?${params.toString()}`;
      const res = await aws.fetch(url, { method: "GET" });
      if (!res.ok) {
        throw new Error(`Could not list renders (S3 ${res.status}). Check the IAM policy allows s3:ListBucket on ${bucketName}.`);
      }
      const xml = await res.text();
      for (const c of parseXmlTags(xml, "Contents")) {
        const key = extractTag(c, "Key") || "";
        const match = key.match(/^renders\/([^/]+)\/out\.(mp4|webm)$/);
        if (!match) continue;
        const size = Number(extractTag(c, "Size") || "0");
        const lastModified = extractTag(c, "LastModified");
        results.push({
          renderId: match[1],
          bucketName,
          key,
          url: `https://${bucketName}.s3.${region}.amazonaws.com/${key}`,
          sizeBytes: size,
          lastModified: lastModified ? new Date(lastModified).getTime() : 0,
          fileFormat: match[2] as "mp4" | "webm",
          region,
        });
      }
      const isTruncated = extractTag(xml, "IsTruncated") === "true";
      continuationToken = isTruncated ? extractTag(xml, "NextContinuationToken") : undefined;
    } while (continuationToken);

    results.sort((a, b) => b.lastModified - a.lastModified);
    return results;
  });
