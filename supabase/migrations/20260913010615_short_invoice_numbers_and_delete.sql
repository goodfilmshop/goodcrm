do $migration$
declare definition text;
begin
 select pg_get_functiondef('public.save_crm_invoice(uuid,jsonb,timestamptz)'::regprocedure) into definition;
 if position('''INV-'' || v_company || ''-''' in definition)=0 then raise exception 'Unexpected invoice number generator'; end if;
 definition := replace(definition, '''INV-'' || v_company || ''-''', '''INV-'' || left(v_company,1)');
 execute definition;
end $migration$;
update public.crm_invoices
set invoice_number=regexp_replace(invoice_number,'^INV-(GFS|MHL)-','INV-' || left(company,1)),
snapshot=jsonb_set(snapshot,'{invoiceNumber}',to_jsonb(regexp_replace(invoice_number,'^INV-(GFS|MHL)-','INV-' || left(company,1)))),
updated_at=clock_timestamp()
where invoice_number ~ '^INV-(GFS|MHL)-[0-9]{6}-[0-9]+$';
grant delete on public.crm_invoices to authenticated;
create policy "members delete invoices for accessible cases" on public.crm_invoices
for delete to authenticated using(private.can_access_crm_case_id(case_id));
