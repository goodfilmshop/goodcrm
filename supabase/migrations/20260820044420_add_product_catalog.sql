-- Product catalog: each SKU represents one sellable size within a
-- Brand -> Type -> Series -> Model hierarchy.

create table if not exists public.crm_products (
  id uuid primary key default gen_random_uuid(),
  sku text not null,
  brand text not null,
  product_type text not null,
  series text not null,
  model text not null,
  size text not null,
  stock numeric(12, 2) not null default 0 check (stock >= 0),
  unit text not null default 'ม้วน' check (btrim(unit) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint crm_products_sku_not_blank check (btrim(sku) <> ''),
  constraint crm_products_brand_not_blank check (btrim(brand) <> ''),
  constraint crm_products_type_not_blank check (btrim(product_type) <> ''),
  constraint crm_products_series_not_blank check (btrim(series) <> ''),
  constraint crm_products_model_not_blank check (btrim(model) <> ''),
  constraint crm_products_size_not_blank check (btrim(size) <> '')
);

create index if not exists crm_products_sku_normalized_idx
on public.crm_products (lower(btrim(sku)));

create unique index if not exists crm_products_variant_normalized_unique
on public.crm_products (
  lower(btrim(brand)),
  lower(btrim(product_type)),
  lower(btrim(series)),
  lower(btrim(model)),
  lower(btrim(size))
);

create index if not exists crm_products_created_by_idx
on public.crm_products (created_by);

create index if not exists crm_products_updated_by_idx
on public.crm_products (updated_by);

drop trigger if exists crm_products_set_updated_at on public.crm_products;
create trigger crm_products_set_updated_at
before update on public.crm_products
for each row execute function private.set_updated_at();

grant select, insert, update, delete on public.crm_products to authenticated;

alter table public.crm_products enable row level security;

create policy "admins can read product catalog"
on public.crm_products
for select
to authenticated
using ((select private.is_crm_admin()));

create policy "admins can create products"
on public.crm_products
for insert
to authenticated
with check ((select private.is_crm_admin()));

create policy "admins can update products"
on public.crm_products
for update
to authenticated
using ((select private.is_crm_admin()))
with check ((select private.is_crm_admin()));

create policy "admins can delete products"
on public.crm_products
for delete
to authenticated
using ((select private.is_crm_admin()));
