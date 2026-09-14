-- Correct default public-schema grants on existing deployments.

revoke all on table public.announcement_reads from anon;
revoke delete, references, trigger, truncate on table public.announcement_reads from authenticated;
grant select, insert, update on table public.announcement_reads to authenticated;
