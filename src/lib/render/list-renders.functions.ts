import { createServerFn } from "@tanstack/react-start";

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

    const {
      S3Client,
      ListBucketsCommand,
      ListObjectsV2Command,
      GetBucketLocationCommand,
    } = await import("@aws-sdk/client-s3");

    const credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };

    const rootClient = new S3Client({ region: defaultRegion, credentials });
    const buckets = await rootClient.send(new ListBucketsCommand({}));
    const remotionBuckets = (buckets.Buckets || [])
      .map((b) => b.Name!)
      .filter((n) => n && n.startsWith("remotionlambda-"));

    const results: CloudRender[] = [];
    const clients = new Map<string, InstanceType<typeof S3Client>>();
    clients.set(defaultRegion, rootClient);
    const getClient = (region: string) => {
      let c = clients.get(region);
      if (!c) {
        c = new S3Client({ region, credentials });
        clients.set(region, c);
      }
      return c;
    };

    for (const bucketName of remotionBuckets) {
      let region = defaultRegion;
      try {
        const loc = await rootClient.send(
          new GetBucketLocationCommand({ Bucket: bucketName }),
        );
        // LocationConstraint is null/empty for us-east-1, "EU" alias = eu-west-1
        const lc = (loc.LocationConstraint as string) || "us-east-1";
        region = lc === "EU" ? "eu-west-1" : lc;
      } catch {
        // Fall back to bucket-name parse: remotionlambda-<region-without-dashes>-...
        const m = bucketName.match(/^remotionlambda-([a-z]+)(\d)-/);
        if (m) region = `${m[1].replace(/(us|eu|ap|sa|ca|af|me)(east|west|north|south|central|northeast|southeast|northwest|southwest)?/, (_, a, b) => (b ? `${a}-${b}` : a))}-${m[2]}`;
      }

      const client = getClient(region);
      let continuationToken: string | undefined = undefined;
      try {
        do {
          const resp: any = await client.send(
            new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: "renders/",
              ContinuationToken: continuationToken,
            }),
          );
          for (const obj of resp.Contents || []) {
            const key = obj.Key || "";
            const m = key.match(/^renders\/([^/]+)\/out\.(mp4|webm)$/);
            if (!m) continue;
            results.push({
              renderId: m[1],
              bucketName,
              key,
              url: `https://s3.${region}.amazonaws.com/${bucketName}/${key}`,
              sizeBytes: obj.Size || 0,
              lastModified: obj.LastModified ? new Date(obj.LastModified).getTime() : 0,
              fileFormat: m[2] as "mp4" | "webm",
              region,
            });
          }
          continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        } while (continuationToken);
      } catch (err: any) {
        console.error(`[listLambdaRenders] ${bucketName} (${region}):`, err?.message || err);
        // Skip this bucket but keep going.
        continue;
      }
    }

    results.sort((a, b) => b.lastModified - a.lastModified);
    return results;
  },
);
