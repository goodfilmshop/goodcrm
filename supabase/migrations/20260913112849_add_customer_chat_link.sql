-- Optional customer-level link, independent from cases.chat_link.
-- Existing rows stay NULL; table grants and row-level policies are unchanged.
alter table public.customers
  add column chat_link text,
  add constraint customers_chat_link_valid check (
    chat_link is null or (
      pg_catalog.char_length(chat_link) <= 2048
      and chat_link ~* '^https?://[^[:space:]]+$'
    )
  );

comment on column public.customers.chat_link is
  'Optional HTTP(S) link to the customer chat; independent from case chat links.';
