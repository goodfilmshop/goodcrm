-- Announcements visible to every active GOOD CRM member.
-- Only CRM administrators and managers can create, update, or delete them.

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (btrim(title) <> ''),
  content text,
  image_path text,
  is_published boolean not null default true,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

create index if not exists announcements_visibility_order_idx
on public.announcements (is_published, published_at desc, created_at desc);

drop trigger if exists announcements_set_updated_at on public.announcements;
create trigger announcements_set_updated_at
before update on public.announcements
for each row execute function private.set_updated_at();

-- Authorization is derived from crm_members, which is synced from the
-- protected employee directory. Do not use user-editable JWT metadata here.
create or replace function private.can_manage_announcements()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.crm_members
    where user_id = (select auth.uid())
      and is_active = true
      and role in ('admin', 'manager')
  );
$$;

revoke all on function private.can_manage_announcements() from public;
grant usage on schema private to authenticated;
grant execute on function private.can_manage_announcements() to authenticated;

grant select, insert, update, delete on public.announcements to authenticated;

alter table public.announcements enable row level security;

create policy "active members can read published announcements"
on public.announcements
for select
to authenticated
using (
  (select private.is_active_crm_member())
  and (is_published or (select private.can_manage_announcements()))
);

create policy "announcement managers can create announcements"
on public.announcements
for insert
to authenticated
with check ((select private.can_manage_announcements()));

create policy "announcement managers can update announcements"
on public.announcements
for update
to authenticated
using ((select private.can_manage_announcements()))
with check ((select private.can_manage_announcements()));

create policy "announcement managers can delete announcements"
on public.announcements
for delete
to authenticated
using ((select private.can_manage_announcements()));

-- Images remain private. Every active CRM member can receive a short-lived
-- signed URL, while uploads and deletions are restricted to announcement
-- managers. The bucket also enforces a 5 MB image-only limit.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'announcement-images',
  'announcement-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "active CRM members can view announcement images"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'announcement-images'
  and (select private.is_active_crm_member())
);

create policy "announcement managers can upload images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'announcement-images'
  and name like 'announcements/%'
  and (select private.can_manage_announcements())
);

create policy "announcement managers can replace images"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'announcement-images'
  and name like 'announcements/%'
  and (select private.can_manage_announcements())
)
with check (
  bucket_id = 'announcement-images'
  and name like 'announcements/%'
  and (select private.can_manage_announcements())
);

create policy "announcement managers can delete images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'announcement-images'
  and name like 'announcements/%'
  and (select private.can_manage_announcements())
);
