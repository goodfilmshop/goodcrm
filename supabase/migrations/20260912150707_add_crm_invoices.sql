create table public.crm_invoices (
 id uuid primary key default gen_random_uuid(),
 source_history_id uuid not null unique references public.lead_follow_up_history(id) on delete restrict,
 case_id uuid not null references public.cases(id) on delete restrict,
 invoice_number text not null unique,
 company text not null check(company in ('GFS','MHL')),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index crm_invoices_case_id_idx on public.crm_invoices(case_id);
create index crm_invoices_created_by_idx on public.crm_invoices(created_by);
alter table public.crm_invoices enable row level security;
revoke all on public.crm_invoices from anon, authenticated;
grant select on public.crm_invoices to authenticated;
create policy "members read invoices for accessible cases" on public.crm_invoices for select to authenticated
 using (private.can_access_crm_case_id(case_id));
create table private.crm_invoice_counters (
 company text not null, issued_day date not null, last_number bigint not null,
 primary key(company,issued_day)
);
revoke all on private.crm_invoice_counters from public, anon, authenticated;
create or replace function public.save_crm_invoice(p_history_id uuid,p_snapshot jsonb,p_expected_updated_at timestamptz default null)
returns public.crm_invoices language plpgsql security definer set search_path = '' as $$
declare
 v_case uuid; v_company text; v_source text; v_case_code text;
 v_invoice public.crm_invoices; v_day date := (clock_timestamp() at time zone 'Asia/Bangkok')::date;
 v_sequence bigint; v_number text;
begin
 select h.case_id, coalesce(h.quotation_snapshot->>'company',c.company),
 coalesce(h.quotation_snapshot->>'quoteNumber',h.quotation_numbers[1]),c.legacy_case_id
 into v_case,v_company,v_source,v_case_code
 from public.lead_follow_up_history h join public.cases c on c.id=h.case_id where h.id=p_history_id;
 if auth.uid() is null or v_case is null or not private.can_access_crm_case_id(v_case) then
   raise exception 'Invoice access denied' using errcode='42501';
 end if;
 if v_source is null or v_company not in ('GFS','MHL') or jsonb_typeof(p_snapshot) is distinct from 'object'
 or coalesce(trim(p_snapshot->>'customerName'),'')='' or jsonb_typeof(p_snapshot->'items') is distinct from 'array' then
   raise exception 'Invalid invoice data' using errcode='22023';
 end if;
 if jsonb_array_length(p_snapshot->'items') not between 1 and 100 then raise exception 'Invalid invoice items' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_history_id::text,0));
 select * into v_invoice from public.crm_invoices where source_history_id=p_history_id for update;
 if found then
   -- Retried creation returns the existing document without overwriting it.
   if p_expected_updated_at is null then return v_invoice; end if;
   if v_invoice.updated_at <> p_expected_updated_at then raise exception 'Invoice was updated by another user' using errcode='40001'; end if;
   update public.crm_invoices set snapshot=p_snapshot || jsonb_build_object('invoiceNumber',v_invoice.invoice_number,'company',v_invoice.company,'sourceQuoteNumber',v_source,'sourceHistoryId',p_history_id,'caseId',v_case_code), updated_at=clock_timestamp()
   where id=v_invoice.id returning * into v_invoice;
   return v_invoice;
 end if;
 if p_expected_updated_at is not null then raise exception 'Invoice not found' using errcode='22023'; end if;
 insert into private.crm_invoice_counters(company,issued_day,last_number) values(v_company,v_day,1)
 on conflict(company,issued_day) do update set last_number=private.crm_invoice_counters.last_number+1 returning last_number into v_sequence;
 v_number := 'INV-' || v_company || '-' || to_char(v_day,'YYMMDD') || '-' || lpad(v_sequence::text,greatest(4,length(v_sequence::text)), '0');
 insert into public.crm_invoices(source_history_id,case_id,invoice_number,company,snapshot,created_by)
 values(p_history_id,v_case,v_number,v_company,p_snapshot || jsonb_build_object('invoiceNumber',v_number,'company',v_company,'sourceQuoteNumber',v_source,'sourceHistoryId',p_history_id,'caseId',v_case_code),auth.uid()) returning * into v_invoice;
 return v_invoice;
end;
$$;
revoke all on function public.save_crm_invoice(uuid,jsonb,timestamptz) from public,anon;
grant execute on function public.save_crm_invoice(uuid,jsonb,timestamptz) to authenticated;
