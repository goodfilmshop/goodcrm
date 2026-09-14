-- Preserve intake identity, deduplication and historical daily/import counts.
-- An imported contact with no customer_id means the linked customer was deleted.
-- Do not reopen the queue or automatically recreate the customer on later messages.
set local lock_timeout = '5s';
alter table public.line_intake_contacts
  drop constraint line_intake_contacts_customer_id_fkey,
  add constraint line_intake_contacts_customer_id_fkey
    foreign key (customer_id) references public.customers(id) on delete set null;
