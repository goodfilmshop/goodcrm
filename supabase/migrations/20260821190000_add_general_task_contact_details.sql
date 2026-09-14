-- Store optional contact and location details for general tasks shown in the measurement queue.
alter table public.general_tasks
  add column if not exists contact_name text,
  add column if not exists contact_phone text,
  add column if not exists site_address text,
  add column if not exists location_url text;

comment on column public.general_tasks.contact_name is
  'Optional contact name for a general task.';

comment on column public.general_tasks.contact_phone is
  'Optional contact phone number for a general task.';

comment on column public.general_tasks.site_address is
  'Optional site or delivery address for a general task.';

comment on column public.general_tasks.location_url is
  'Optional map URL or location text for a general task.';
