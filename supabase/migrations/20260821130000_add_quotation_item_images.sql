-- Private, compressed quotation images. Access is tied to the case folder so
-- sales users can only read and manage images for cases they can access.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'quotation-images',
  'quotation-images',
  false,
  512000,
  array['image/webp']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "members can view accessible quotation images" on storage.objects;
drop policy if exists "members can upload accessible quotation images" on storage.objects;
drop policy if exists "members can delete accessible quotation images" on storage.objects;

create policy "members can view accessible quotation images"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'quotation-images'
  and (storage.foldername(name))[1] = 'cases'
  and array_length(storage.foldername(name), 1) = 2
  and exists (
    select 1
    from public.cases as crm_case
    where regexp_replace(crm_case.legacy_case_id, '[^A-Za-z0-9_-]', '-', 'g') = (storage.foldername(name))[2]
      and (select private.can_access_crm_case(crm_case.salesperson_employee_id))
  )
);

create policy "members can upload accessible quotation images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'quotation-images'
  and (storage.foldername(name))[1] = 'cases'
  and array_length(storage.foldername(name), 1) = 2
  and storage.filename(name) ~ '^[A-Za-z0-9_-]+\.webp$'
  and exists (
    select 1
    from public.cases as crm_case
    where regexp_replace(crm_case.legacy_case_id, '[^A-Za-z0-9_-]', '-', 'g') = (storage.foldername(name))[2]
      and (select private.can_access_crm_case(crm_case.salesperson_employee_id))
  )
);

create policy "members can delete accessible quotation images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'quotation-images'
  and (storage.foldername(name))[1] = 'cases'
  and array_length(storage.foldername(name), 1) = 2
  and exists (
    select 1
    from public.cases as crm_case
    where regexp_replace(crm_case.legacy_case_id, '[^A-Za-z0-9_-]', '-', 'g') = (storage.foldername(name))[2]
      and (select private.can_access_crm_case(crm_case.salesperson_employee_id))
  )
);
