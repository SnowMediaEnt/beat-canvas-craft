insert into storage.buckets (id, name, public) values ('render-assets', 'render-assets', true) on conflict (id) do nothing;
create policy "render-assets public read" on storage.objects for select using (bucket_id = 'render-assets');
create policy "render-assets public write" on storage.objects for insert with check (bucket_id = 'render-assets');