## Goal

Rename the "Recordings" menu to "Completed" and make it the unified place to access both AWS Lambda MP4 renders and browser WebM recordings, so finished cloud renders stay reachable after the export dialog closes.

## Changes

### 1. `src/components/editor/RecordingsDialog.tsx` → rename file to `CompletedDialog.tsx`
- Rename component `RecordingsDialog` → `CompletedDialog`.
- Trigger button label: "Recordings" → "Completed".
- Dialog title: "Saved recordings" → "Completed renders".
- Remove the `kind === "browser"` filter so both `lambda` and `browser` jobs appear; sort by `completedAt || createdAt` desc.
- Per-entry display tweaks:
  - Filename suffix uses `entry.fileFormat` (`.mp4` for lambda, `.webm` for browser) instead of hard-coded `.webm`.
  - Show a small badge ("AWS Render" vs "Browser Recording") based on `entry.kind`.
  - Status badge: "Ready" if a download source exists, else "Processing".
- Download logic for lambda entries: prefer `entry.downloadUrl` (the S3 `outputFile` URL already saved by `ExportDialog`). For browser entries: prefer local asset, fall back to `downloadUrl`. Reuse the existing programmatic `<a download>` click pattern.
- Remove (Trash) just deletes the job record from localStorage; we do not delete the S3 object (out of scope, would require a new server fn).
- Empty state copy: "No completed renders yet."

### 2. `src/components/editor/ExportDialog.tsx`
- Update the helper copy that mentions "the new Recordings menu beside Export" to say "the Completed menu beside Export".
- No other behavior changes; lambda completion already persists `downloadUrl` via `persistJob`, so completed AWS renders will automatically show up in the Completed list.

### 3. Import site (likely `src/routes/editor.$projectId.tsx`)
- Update the import from `RecordingsDialog` to `CompletedDialog` and the JSX usage.

## Non-changes (intentionally out of scope)
- Browser recording feature is left in place. User said "probably won't be using it" but did not ask to remove it; keeping it avoids breaking saved recordings.
- No S3-side delete (would need a server function + AWS perms).
- No re-polling of in-flight lambda jobs from the Completed dialog. If a render is still running when the user closes Export, it will only appear once that session finishes the poll loop. (Can add later if needed.)

## Verification
- Open Completed dialog after a finished AWS render → entry appears with `.mp4`, Download triggers the S3 file.
- Old browser recordings still appear with `.webm` and download from local asset.
- Build passes (rename + import update).
