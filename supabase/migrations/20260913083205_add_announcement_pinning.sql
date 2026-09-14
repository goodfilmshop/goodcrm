-- Existing announcement SELECT/UPDATE RLS policies protect pin state:
-- active members can read published posts; only managers/admins can update.
alter table public.announcements
  add column if not exists is_pinned boolean not null default false;

comment on column public.announcements.is_pinned is
  'Pinned announcements appear first, without changing their publication date.';
