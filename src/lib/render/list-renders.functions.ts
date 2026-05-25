import { createServerFn } from "@tanstack/react-start";
import { AwsClient } from "aws4fetch";

const REMOTION_RENDER_PREFIX = "renders/";

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

export const listLambdaRenders = createServerFn({ method: "GET" }).handler(
  async (): Promise<CloudRender[]> => {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const defaultRegion = process.env.REMOTION_AWS_REGION || "us-east-1";
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("Missing AWS credentials");
    }

    // ListBuckets must be signed with us-east-1 (global endpoint)
    const awsGlobal = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "us-east-1" });

    // 1) List all buckets
    const listBucketsRes = await awsGlobal.fetch("https://s3.amazonaws.com/", { method: "GET" });
    if (!listBucketsRes.ok) {
      throw new Error(`ListBuckets failed: ${listBucketsRes.status} ${await listBucketsRes.text()}`);
    }
    const bucketsXml = await listBucketsRes.text();
    const bucketBlocks = parseXmlTags(bucketsXml, "Bucket");
    const remotionBuckets = bucketBlocks
      .map((b) => extractTag(b, "Name") || "")
      .filter((name) => name.startsWith("remotionlambda-"));

    const results: CloudRender[] = [];

    for (const bucketName of remotionBuckets) {
      // Determine bucket region
      let region = defaultRegion;
      try {
        const locRes = await aws.fetch(`https://s3.amazonaws.com/${bucketName}?location`, { method: "GET" });
        if (locRes.ok) {
          const locXml = await locRes.text();
          const loc = locXml.match(/<LocationConstraint[^>]*>([^<]*)<\/LocationConstraint>/)?.[1];
          if (loc) region = loc;
          else if (locXml.includes("LocationConstraint")) region = "us-east-1";
        }
      } catch {
        // fall through with default
      }

      // Try to infer region from bucket name (remotionlambda-<region>-<hash>)
      const nameMatch = bucketName.match(/^remotionlambda-([a-z]{2}-[a-z]+-\d)/);
      if (nameMatch) region = nameMatch[1];

      const regionalAws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region });

      try {
        let continuationToken: string | undefined;
        do {
          const params = new URLSearchParams({ "list-type": "2", prefix: REMOTION_RENDER_PREFIX });
          if (continuationToken) params.set("continuation-token", continuationToken);
          const url = `https://${bucketName}.s3.${region}.amazonaws.com/?${params.toString()}`;
          const res = await regionalAws.fetch(url, { method: "GET" });
          if (!res.ok) {
            console.error(`[listLambdaRenders] ${bucketName} list failed:`, res.status, await res.text());
            break;
          }
          const xml = await res.text();
          const contents = parseXmlTags(xml, "Contents");
          for (const c of contents) {
            const key = extractTag(c, "Key") || "";
            const match = key.match(/^renders\/([^/]+)\/out\.(mp4|webm)$/);
            if (!match) continue;
            const size = Number(extractTag(c, "Size") || "0");
            const lastModified = extractTag(c, "LastModified");
            results.push({
              renderId: match[1],
              bucketName,
              key,
              url: `https://s3.${region}.amazonaws.com/${bucketName}/${key}`,
              sizeBytes: size,
              lastModified: lastModified ? new Date(lastModified).getTime() : 0,
              fileFormat: match[2] as "mp4" | "webm",
              region,
            });
          }
          const isTruncated = extractTag(xml, "IsTruncated") === "true";
          continuationToken = isTruncated ? extractTag(xml, "NextContinuationToken") : undefined;
        } while (continuationToken);
      } catch (err: any) {
        console.error(`[listLambdaRenders] ${bucketName} (${region}):`, err?.message || err);
        continue;
      }
    }

    results.sort((a, b) => b.lastModified - a.lastModified);
    return results;
  },
);
