-- Store the on-hand quantity shown in the source inventory and its unit.
-- The source contains repeated SKU values for distinct variants, so retain SKU
-- as a searchable value instead of enforcing global SKU uniqueness.

alter table public.crm_products
  add column if not exists stock numeric(12, 2) not null default 0
    constraint crm_products_stock_non_negative check (stock >= 0),
  add column if not exists unit text not null default 'ม้วน'
    constraint crm_products_unit_not_blank check (btrim(unit) <> '');

drop index if exists public.crm_products_sku_normalized_unique;

create index if not exists crm_products_sku_normalized_idx
on public.crm_products (lower(btrim(sku)));
