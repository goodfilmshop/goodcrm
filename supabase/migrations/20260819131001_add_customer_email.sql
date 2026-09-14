alter table if exists public.customers
  add column if not exists email text;
