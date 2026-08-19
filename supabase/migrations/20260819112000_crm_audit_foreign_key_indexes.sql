-- Foreign-key indexes keep future audit and membership cleanup queries from
-- scanning CRM tables as they grow.

create index if not exists customers_created_by_idx on public.customers (created_by);
create index if not exists customers_updated_by_idx on public.customers (updated_by);
create index if not exists cases_created_by_idx on public.cases (created_by);
create index if not exists cases_updated_by_idx on public.cases (updated_by);
