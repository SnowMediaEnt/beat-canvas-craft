-- Lock down render-assets bucket: keep public read (Lambda needs it),
-- restrict writes to service_role only. Client uploads must go through server.
DROP POLICY IF EXISTS "render-assets public write" ON storage.objects;
DROP POLICY IF EXISTS "render-assets public update" ON storage.objects;
DROP POLICY IF EXISTS "render-assets public delete" ON storage.objects;

CREATE POLICY "render-assets service write"
ON storage.objects FOR INSERT TO service_role
WITH CHECK (bucket_id = 'render-assets');

CREATE POLICY "render-assets service update"
ON storage.objects FOR UPDATE TO service_role
USING (bucket_id = 'render-assets')
WITH CHECK (bucket_id = 'render-assets');

CREATE POLICY "render-assets service delete"
ON storage.objects FOR DELETE TO service_role
USING (bucket_id = 'render-assets');