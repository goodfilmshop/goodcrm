-- Keep the billing branch with each case so subsequent quotation drafts use
-- the same tax-invoice information that was recorded at case creation.
alter table public.cases
  add column if not exists billing_branch text;

comment on column public.cases.billing_branch is
  'Branch for billing and quotation documents, for example สำนักงานใหญ่ or a branch number.';
