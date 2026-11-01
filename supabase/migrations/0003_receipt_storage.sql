-- Milestone 3: storage for receipt photos.
--
-- Private bucket; access is enforced entirely by the RLS policies below,
-- scoped by trip membership (same is_trip_member() pattern used on the
-- expense/claim tables in 0001). Object path convention:
--   <trip_id>/<random uuid>.jpg
-- so the trip_id (first path segment) can be checked without a join.

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists "select receipt if trip member" on storage.objects;
create policy "select receipt if trip member"
on storage.objects for select
using (
  bucket_id = 'receipts'
  and public.is_trip_member((storage.foldername(name))[1]::uuid)
);

drop policy if exists "insert receipt if trip member" on storage.objects;
create policy "insert receipt if trip member"
on storage.objects for insert
with check (
  bucket_id = 'receipts'
  and public.is_trip_member((storage.foldername(name))[1]::uuid)
);
