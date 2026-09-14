-- Additive document-template designer storage.
--
-- All existing CRM tables and non-GFS document renderers remain untouched.
-- GFS quotations have a bundled local canvas fallback; once a manager publishes
-- an immutable version, the publication pointer becomes authoritative.

create table public.document_templates (
  id uuid primary key default gen_random_uuid(),
  company_code text not null,
  document_type text not null,
  display_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint document_templates_company_code_check
    check (company_code in ('GFS', 'MHL')),
  constraint document_templates_document_type_check
    check (
      document_type in (
        'quotation',
        'invoice',
        'receipt',
        'tax_invoice',
        'work_delivery',
        'credit_note'
      )
    ),
  constraint document_templates_display_name_check
    check (pg_catalog.btrim(display_name) <> ''),
  constraint document_templates_company_document_key
    unique (company_code, document_type)
);

comment on table public.document_templates is
  'The 12 independently configurable company/document pairs supported by the document designer.';

comment on column public.document_templates.company_code is
  'Stable company key: GFS or MHL.';

comment on column public.document_templates.document_type is
  'Stable document key used by the renderer and document-number workflow.';

create table public.document_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null
    references public.document_templates(id) on delete restrict,
  version_number bigint not null,
  status text not null default 'draft',
  schema_version integer not null default 2,
  design_json jsonb not null default '{}'::jsonb,
  checksum text not null,
  change_summary text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete set null,
  constraint document_template_versions_version_number_check
    check (version_number > 0),
  constraint document_template_versions_status_check
    check (status in ('draft', 'published', 'archived')),
  constraint document_template_versions_schema_version_check
    check (schema_version = 2),
  constraint document_template_versions_design_json_check
    check (
      jsonb_typeof(design_json) = 'object'
      and pg_catalog.octet_length(design_json::text) <= 65536
      and design_json ?& array[
        'theme',
        'company',
        'header',
        'customerSection',
        'itemsTable',
        'totals',
        'notes',
        'signatures',
        'footer',
        'print',
        'canvas'
      ]
      and jsonb_typeof(design_json -> 'canvas') = 'object'
      and design_json - array[
        'theme',
        'company',
        'header',
        'customerSection',
        'itemsTable',
        'totals',
        'notes',
        'signatures',
        'footer',
        'print',
        'canvas'
      ] = '{}'::jsonb
    ),
  constraint document_template_versions_checksum_check
    check (checksum ~ '^[0-9a-f]{64}$'),
  constraint document_template_versions_status_audit_check
    check (
      (
        status = 'draft'
        and published_at is null
        and published_by is null
        and archived_at is null
        and archived_by is null
      )
      or (
        status = 'published'
        and published_at is not null
        and archived_at is null
        and archived_by is null
      )
      or (
        status = 'archived'
        and archived_at is not null
        and (published_at is not null or published_by is null)
      )
    ),
  constraint document_template_versions_template_version_key
    unique (template_id, version_number),
  constraint document_template_versions_template_id_id_key
    unique (template_id, id)
);

comment on table public.document_template_versions is
  'Append-only document designs. Content is immutable; only controlled lifecycle transitions are allowed.';

comment on column public.document_template_versions.design_json is
  'Renderer-neutral structured design data. Arbitrary HTML and JavaScript are intentionally not stored separately.';

comment on column public.document_template_versions.schema_version is
  'Version of the structured design_json contract, independent of version_number.';

comment on column public.document_template_versions.checksum is
  'Lowercase SHA-256 hex digest supplied by the trusted backend for content identity checks.';

create table public.document_template_publications (
  template_id uuid primary key
    references public.document_templates(id) on delete restrict,
  current_version_id uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  published_at timestamptz not null default now(),
  published_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint document_template_publications_current_version_key
    unique (current_version_id),
  constraint document_template_publications_version_fkey
    foreign key (template_id, current_version_id)
    references public.document_template_versions(template_id, id)
    on delete restrict
);

comment on table public.document_template_publications is
  'The single active immutable version pointer for each company/document template.';

-- The partial uniqueness rule keeps lifecycle state aligned with the single
-- publication pointer: at most one version per template can be published.
create unique index document_template_versions_one_published_idx
on public.document_template_versions (template_id)
where status = 'published';

create index document_template_versions_template_status_version_idx
on public.document_template_versions (template_id, status, version_number desc);

-- Audit foreign keys are indexed so Auth user cleanup does not scan the new
-- tables. Template/version foreign keys are already covered by unique indexes.
create index document_templates_created_by_idx
on public.document_templates (created_by)
where created_by is not null;

create index document_templates_updated_by_idx
on public.document_templates (updated_by)
where updated_by is not null;

create index document_template_versions_created_by_idx
on public.document_template_versions (created_by)
where created_by is not null;

create index document_template_versions_published_by_idx
on public.document_template_versions (published_by)
where published_by is not null;

create index document_template_versions_archived_by_idx
on public.document_template_versions (archived_by)
where archived_by is not null;

create index document_template_publications_created_by_idx
on public.document_template_publications (created_by)
where created_by is not null;

create index document_template_publications_published_by_idx
on public.document_template_publications (published_by)
where published_by is not null;

create index document_template_publications_updated_by_idx
on public.document_template_publications (updated_by)
where updated_by is not null;

-- Serialize version-number allocation on the parent template row. This lets
-- callers omit version_number and avoids duplicate numbers under concurrency.
create or replace function private.assign_document_template_version_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_version_number bigint;
  authenticated_user_id uuid;
begin
  if new.status <> 'draft'
    or new.published_at is not null
    or new.published_by is not null
    or new.archived_at is not null
    or new.archived_by is not null then
    raise check_violation using
      message = 'New document template versions must begin as drafts.',
      constraint = 'document_template_versions_status_audit_check';
  end if;

  perform 1
  from public.document_templates as template
  where template.id = new.template_id
  for update;

  if not found then
    raise foreign_key_violation using
      message = 'Unknown document template.',
      constraint = 'document_template_versions_template_id_fkey';
  end if;

  select coalesce(max(version.version_number), 0) + 1
  into next_version_number
  from public.document_template_versions as version
  where version.template_id = new.template_id;

  if new.version_number is null then
    new.version_number := next_version_number;
  elsif new.version_number <> next_version_number then
    raise check_violation using
      message = 'Document template version_number must be the next sequential number.',
      constraint = 'document_template_versions_version_number_check';
  end if;

  select auth.uid() into authenticated_user_id;
  new.created_at := pg_catalog.clock_timestamp();
  if authenticated_user_id is not null then
    new.created_by := authenticated_user_id;
  end if;

  return new;
end;
$$;

-- Version content is append-only. Publishing/restoring changes only lifecycle
-- state and never rewrites the design that an older document used.
create or replace function private.protect_document_template_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Document template versions are immutable and cannot be deleted.'
      using errcode = '55000';
  end if;

  if row(
    new.id,
    new.template_id,
    new.version_number,
    new.schema_version,
    new.design_json,
    new.checksum,
    new.change_summary,
    new.created_at,
    new.created_by
  ) is distinct from row(
    old.id,
    old.template_id,
    old.version_number,
    old.schema_version,
    old.design_json,
    old.checksum,
    old.change_summary,
    old.created_at,
    old.created_by
  ) then
    raise exception 'Document template version content and creation audit fields are immutable.'
      using errcode = '55000';
  end if;

  if new.status = old.status then
    if row(
      new.published_at,
      new.published_by,
      new.archived_at,
      new.archived_by
    ) is distinct from row(
      old.published_at,
      old.published_by,
      old.archived_at,
      old.archived_by
    ) then
      raise exception 'Lifecycle audit fields may change only with a status transition.'
        using errcode = '55000';
    end if;
    return new;
  end if;

  if not (
    (old.status = 'draft' and new.status in ('published', 'archived'))
    or (old.status = 'published' and new.status = 'archived')
    or (old.status = 'archived' and new.status = 'published')
  ) then
    raise exception 'Invalid document template version status transition: % -> %.',
      old.status,
      new.status
      using errcode = '23514';
  end if;

  if new.status = 'published' then
    if new.published_at is null
      or new.archived_at is not null
      or new.archived_by is not null then
      raise exception 'Published versions require published_at and no archive audit values.'
        using errcode = '23514';
    end if;
  elsif new.status = 'archived' and new.archived_at is null then
    raise exception 'Archived versions require archived_at.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- Prepare publication audit values before the row is written. This function
-- intentionally does not mutate versions: PostgreSQL runs BEFORE INSERT
-- triggers before resolving ON CONFLICT, so lifecycle work belongs in the
-- AFTER trigger below.
create or replace function private.prepare_document_template_publication()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  effective_actor uuid;
  publication_time timestamptz := pg_catalog.clock_timestamp();
begin
  select auth.uid() into effective_actor;

  if tg_op = 'UPDATE' and new.template_id is distinct from old.template_id then
    raise exception 'A document template publication cannot be moved to another template.'
      using errcode = '55000';
  end if;

  effective_actor := coalesce(
    effective_actor,
    new.published_by,
    new.updated_by,
    new.created_by,
    case when tg_op = 'UPDATE' then old.updated_by end,
    case when tg_op = 'UPDATE' then old.published_by end,
    case when tg_op = 'UPDATE' then old.created_by end
  );

  if tg_op = 'INSERT' then
    new.created_at := publication_time;
    new.created_by := effective_actor;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;

  if tg_op = 'INSERT'
    or new.current_version_id is distinct from old.current_version_id then
    new.published_at := publication_time;
    new.published_by := effective_actor;
  elsif tg_op = 'UPDATE' then
    new.published_at := old.published_at;
    new.published_by := old.published_by;
  end if;

  new.updated_at := publication_time;
  new.updated_by := effective_actor;
  return new;
end;
$$;

-- Publication changes are the only authenticated path that advances version
-- lifecycle state. This AFTER trigger sees the operation that ON CONFLICT
-- actually selected. It is security-definer because clients have no direct
-- UPDATE grant on immutable version rows; RLS on the publication row remains
-- the authorization boundary.
create or replace function private.sync_document_template_publication()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  effective_actor uuid := coalesce(new.published_by, new.updated_by, new.created_by);
  publication_time timestamptz := new.published_at;
begin
  if tg_op = 'INSERT'
    or new.current_version_id is distinct from old.current_version_id then
    if tg_op = 'UPDATE' then
      update public.document_template_versions as previous_version
      set status = 'archived',
          archived_at = publication_time,
          archived_by = effective_actor
      where previous_version.template_id = old.template_id
        and previous_version.id = old.current_version_id;

      if not found then
        raise foreign_key_violation using
          message = 'The previous published document template version no longer exists.',
          constraint = 'document_template_publications_version_fkey';
      end if;
    end if;

    update public.document_template_versions as next_version
    set status = 'published',
        published_at = coalesce(next_version.published_at, publication_time),
        published_by = coalesce(next_version.published_by, effective_actor),
        archived_at = null,
        archived_by = null
    where next_version.template_id = new.template_id
      and next_version.id = new.current_version_id;

    if not found then
      raise foreign_key_violation using
        message = 'The selected document template version does not belong to this template.',
        constraint = 'document_template_publications_version_fkey';
    end if;
  end if;

  return new;
end;
$$;

-- These helpers follow the existing private CRM membership pattern. Every
-- security-definer read includes the current Auth identity and active-member
-- check; none trusts editable user_metadata claims.
create or replace function private.can_manage_document_templates()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.crm_members as member
    where member.user_id = (select auth.uid())
      and member.is_active = true
      and member.role in ('admin', 'manager')
  );
$$;

create or replace function private.can_read_document_template(p_template_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.crm_members as member
    where member.user_id = (select auth.uid())
      and member.is_active = true
      and (
        member.role in ('admin', 'manager')
        or exists (
          select 1
          from public.document_templates as template
          join public.document_template_publications as publication
            on publication.template_id = template.id
          where template.id = p_template_id
            and template.is_active = true
        )
      )
  );
$$;

create or replace function private.can_read_document_template_version(p_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.crm_members as member
    where member.user_id = (select auth.uid())
      and member.is_active = true
      and (
        member.role in ('admin', 'manager')
        or exists (
          select 1
          from public.document_template_publications as publication
          join public.document_templates as template
            on template.id = publication.template_id
          where publication.current_version_id = p_version_id
            and template.is_active = true
        )
      )
  );
$$;

revoke all on function private.assign_document_template_version_number()
from public, anon, authenticated, service_role;

revoke all on function private.protect_document_template_version()
from public, anon, authenticated, service_role;

revoke all on function private.prepare_document_template_publication()
from public, anon, authenticated, service_role;

revoke all on function private.sync_document_template_publication()
from public, anon, authenticated, service_role;

revoke all on function private.can_manage_document_templates()
from public, anon, authenticated, service_role;

revoke all on function private.can_read_document_template(uuid)
from public, anon, authenticated, service_role;

revoke all on function private.can_read_document_template_version(uuid)
from public, anon, authenticated, service_role;

grant usage on schema private to authenticated;
grant execute on function private.can_manage_document_templates()
to authenticated;
grant execute on function private.can_read_document_template(uuid)
to authenticated;
grant execute on function private.can_read_document_template_version(uuid)
to authenticated;

create trigger document_template_versions_assign_number
before insert on public.document_template_versions
for each row execute function private.assign_document_template_version_number();

create trigger document_template_versions_protect_history
before update or delete on public.document_template_versions
for each row execute function private.protect_document_template_version();

create trigger document_template_publications_prepare_audit
before insert or update on public.document_template_publications
for each row execute function private.prepare_document_template_publication();

create trigger document_template_publications_sync_lifecycle
after insert or update on public.document_template_publications
for each row execute function private.sync_document_template_publication();

alter table public.document_templates enable row level security;
alter table public.document_template_versions enable row level security;
alter table public.document_template_publications enable row level security;

-- Explicit grants opt these new public-schema tables into the Data API while
-- RLS remains the row-level authorization layer. No DELETE grant is issued.
revoke all privileges on table public.document_templates
from anon, authenticated, service_role;
revoke all privileges on table public.document_template_versions
from anon, authenticated, service_role;
revoke all privileges on table public.document_template_publications
from anon, authenticated, service_role;

grant select on table public.document_templates
to authenticated, service_role;
grant select, insert on table public.document_template_versions
to authenticated, service_role;
grant select, insert, update on table public.document_template_publications
to authenticated, service_role;

create policy "members can read available document templates"
on public.document_templates
for select
to authenticated
using ((select private.can_read_document_template(id)));

create policy "members can read allowed document template versions"
on public.document_template_versions
for select
to authenticated
using ((select private.can_read_document_template_version(id)));

create policy "managers can create document template versions"
on public.document_template_versions
for insert
to authenticated
with check (
  (select private.can_manage_document_templates())
  and status = 'draft'
);

create policy "members can read available document template publications"
on public.document_template_publications
for select
to authenticated
using ((select private.can_read_document_template(template_id)));

create policy "managers can create document template publications"
on public.document_template_publications
for insert
to authenticated
with check ((select private.can_manage_document_templates()));

create policy "managers can update document template publications"
on public.document_template_publications
for update
to authenticated
using ((select private.can_manage_document_templates()))
with check ((select private.can_manage_document_templates()));

-- Seed the complete fixed matrix. There are no published versions initially.
-- GFS quotations use the bundled local canvas fallback; every other pair keeps
-- its existing renderer until a version is explicitly designed and published.
insert into public.document_templates (
  company_code,
  document_type,
  display_name
)
values
  ('GFS', 'quotation', 'ใบเสนอราคา'),
  ('GFS', 'invoice', 'ใบแจ้งหนี้'),
  ('GFS', 'receipt', 'ใบเสร็จรับเงิน'),
  ('GFS', 'tax_invoice', 'ใบกำกับภาษี'),
  ('GFS', 'work_delivery', 'ใบส่งงาน'),
  ('GFS', 'credit_note', 'ใบลดหนี้'),
  ('MHL', 'quotation', 'ใบเสนอราคา'),
  ('MHL', 'invoice', 'ใบแจ้งหนี้'),
  ('MHL', 'receipt', 'ใบเสร็จรับเงิน'),
  ('MHL', 'tax_invoice', 'ใบกำกับภาษี'),
  ('MHL', 'work_delivery', 'ใบส่งงาน'),
  ('MHL', 'credit_note', 'ใบลดหนี้')
on conflict (company_code, document_type) do nothing;
