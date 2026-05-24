import { createServerFn } from "@tanstack/react-start";

export interface CloudRender {
  renderId: string;
  bucketName: string;
  key: string;
  url: string;
  sizeBytes: number;
  lastModified: number;
  fileFormat: "mp4" | "webm";
}

export const listLambdaRenders = createServerFn({ method: "GET" }).handler(
  async (): Promise<CloudRender[]> => {
    const region = process.env.REMOTION_AWS_REGION;
    if (!region) throw new Error("Missing REMOTION_AWS_REGION");
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error("Missing AWS credentials");
    }

    const { S3Client, ListBucketsCommand, ListObjectsV2Command } = await import(
      "@aws-sdk/client-s3"
    );

    const s3 = new S3Client({
      region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const buckets = await s3.send(new ListBucketsCommand({}));
    const remotionBuckets = (buckets.Buckets || [])
      .map((b) => b.Name!)
      .filter((n) => n && n.startsWith("remotionlambda-"));

    const results: CloudRender[] = [];

    for (const bucketName of remotionBuckets) {
      let continuationToken: string | undefined = undefined;
      do {
        const resp: any = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: "renders/",
            ContinuationToken: continuationToken,
          }),
        );
        for (const obj of resp.Contents || []) {
          const key = obj.Key || "";
          // Output files look like renders/{renderId}/out.mp4 (or .webm)
          const m = key.match(/^renders\/([^/]+)\/out\.(mp4|webm)$/);
          if (!m) continue;
          results.push({
            renderId: m[1],
            bucketName,
            key,
            url: `https://${bucketName}.s3.${region}.amazonaws.com/${key}`,
            sizeBytes: obj.Size || 0,
            lastModified: obj.LastModified ? new Date(obj.LastModified).getTime() : 0,
            fileFormat: m[2] as "mp4" | "webm",
          });
        }
        continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (continuationToken);
    }

    results.sort((a, b) => b.lastModified - a.lastModified);
    return results;
  },
);
