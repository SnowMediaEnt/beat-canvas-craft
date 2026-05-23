-- Public bucket files are still served via CDN with their public URL.
-- Drop the broad SELECT policy that allowed listing all object metadata.
DROP POLICY IF EXISTS "render-assets public read" ON storage.objects;