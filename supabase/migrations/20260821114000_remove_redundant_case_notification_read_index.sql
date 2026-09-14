-- The primary key starts with user_id and already covers the receipt lookup.
drop index if exists public.case_notification_reads_user_read_at_idx;
