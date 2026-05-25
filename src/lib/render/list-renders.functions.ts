import { createServerFn } from "@tanstack/react-start";

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

export const listLambdaRenders = createServerFn({ method: "GET" }).handler(
  async (): Promise<CloudRender[]> => {
    const defaultRegion = process.env.REMOTION_AWS_REGION || "us-east-1";
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error("Missing AWS credentials");
    }

    const { LambdaClientInternals } = await import("@remotion/lambda-client");

    const remotionBuckets = await LambdaClientInternals.awsImplementation.getBuckets({
      region: defaultRegion,
      forceBucketName: undefined,
      forcePathStyle: false,
      requestHandler: undefined,
    });

    const results: CloudRender[] = [];

    for (const bucket of remotionBuckets) {
      try {
        const objects = await LambdaClientInternals.awsImplementation.listObjects({
          bucketName: bucket.name,
          prefix: REMOTION_RENDER_PREFIX,
          region: bucket.region,
          expectedBucketOwner: undefined,
          continuationToken: undefined,
          forcePathStyle: false,
          requestHandler: undefined,
        });

        for (const obj of objects) {
          const key = obj.Key || "";
          const match = key.match(/^renders\/([^/]+)\/out\.(mp4|webm)$/);
          if (!match) continue;
          results.push({
            renderId: match[1],
            bucketName: bucket.name,
            key,
            url: `https://s3.${bucket.region}.amazonaws.com/${bucket.name}/${key}`,
            sizeBytes: obj.Size || 0,
            lastModified: obj.LastModified ? new Date(obj.LastModified).getTime() : 0,
            fileFormat: match[2] as "mp4" | "webm",
            region: bucket.region,
          });
        }
      } catch (err: any) {
        console.error(`[listLambdaRenders] ${bucket.name} (${bucket.region}):`, err?.message || err);
        continue;
      }
    }

    results.sort((a, b) => b.lastModified - a.lastModified);
    return results;
  },
);
