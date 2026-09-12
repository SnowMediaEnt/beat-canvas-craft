# Rendering & AWS setup

Audio Canvas Studio renders videos two ways:

| Path | Where it runs | Output | Needs |
|------|---------------|--------|-------|
| **Browser Recording** | The visitor's browser, real time | MP4 (Chrome/Safari) or WebM, up to 1080p | nothing |
| **Lambda Render** | AWS Lambda via Remotion | MP4 up to 4K, 30–120 fps | AWS keys + access code |

Both use the **same drawing code** (`src/lib/visualizer/*`), so the video is what you saw in the editor.

## Secrets (Lovable → Project → Settings → Secrets)

| Secret | What it is |
|--------|------------|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | An IAM user allowed to invoke the Remotion Lambda function and read/write the `remotionlambda-*` bucket |
| `REMOTION_AWS_REGION` | e.g. `us-east-2` |
| `REMOTION_AWS_FUNCTION_NAME` | e.g. `remotion-render-4-0-465-mem2048mb-disk2048mb-900sec` (must be the same Remotion version as `package.json`: 4.0.465) |
| `REMOTION_AWS_SERVE_URL` | The URL printed by `remotion lambda sites create`, e.g. `https://remotionlambda-useast2-xxxx.s3.us-east-2.amazonaws.com/sites/lyrics-viz/index.html` |
| `RENDER_ACCESS_CODE` | The code you type in Export → Lambda Render. Set your own long random value; the built-in fallback only exists so old links keep working. |
| `LOVABLE_API_KEY` | AI generator / AI lyric alignment (also gated by the access code) |
| `ELEVENLABS_API_KEY` | Lyric auto-sync transcription |

## Check the connection

Open a project → **Export** → **Lambda Render** → enter the access code → **Check**.
The panel verifies credentials, settings, the Lambda function and its Remotion version,
the deployed visualizer bundle (and when it was deployed) and S3 access. Every red row
says what to do.

## When you must redeploy the Lambda bundle

The drawing code runs **inside Lambda from a bundle stored on S3**. Any change to presets,
effects, lyrics or the audio engine needs a redeploy or Lambda keeps rendering the old code.
The app sends `RENDER_ENGINE_VERSION` (`src/lib/visualizer/engine-version.ts`) with every
render and Lambda refuses to render with an older bundle, so you get a clear error instead of
a wrong video.

On a machine with the AWS keys in the environment:

```bash
# once per Remotion version (creates/updates the Lambda function itself)
npm run deploy:lambda-function

# after every drawing-code change (uploads the visualizer bundle to S3)
REMOTION_SITE_NAME=lyrics-viz REMOTION_AWS_REGION=us-east-2 npm run deploy:lambda-site
```

The health panel prints the exact `sites create` command with your site name and region.

### Automatic redeploy (recommended)

`.github/workflows/deploy-lambda-site.yml` runs the same upload on GitHub's servers
whenever drawing code lands on `main`, so nobody has to run a terminal. One-time setup on
GitHub: **Settings → Secrets and variables → Actions → New repository secret**, add
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (the same IAM user Lovable uses). To run it
by hand, open the **Actions** tab, pick **Deploy Lambda site**, and press **Run workflow**.
The run's summary shows the serve URL, which must match `REMOTION_AWS_SERVE_URL` in Lovable.

## Cost & time

The Export dialog estimates workers, file size and time from the same chunking math the
render uses (`src/lib/render/lambda-config.ts`). Heavy presets at 4K/120 fps take longer;
if a render times out, pick 1080p or 60 fps.

**Stop watching** only stops polling — AWS cannot abort a Remotion render once its workers
started. The finished file appears under **Completed** and can be deleted from S3 there.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| "Deployed Lambda bundle is out of date" | run `deploy:lambda-site` |
| Function version mismatch in the health panel | run `deploy:lambda-function` and update `REMOTION_AWS_FUNCTION_NAME` |
| Upload rejected: invalid access code | the browser's stored code differs from `RENDER_ACCESS_CODE` — re-enter it |
| Visualizer barely moves in the MP4 but not in the preview | M4A/AAC source — use **Convert to WAV now** in the Export dialog |
| Download opens in a tab instead of saving | use the "alternate link" under the download button (same-origin proxy) |
