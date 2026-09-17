-- Dedicated read capability. No service-role key, base-table grants, or CRM writes.
-- Apply separately from unrelated CRM migrations. Configure the private key afterwards.
begin;
create schema if not exists private;
create table private.storage_bridge_config (
 id integer primary key check (id=1), secret text not null check (length(secret)>=32)
);
create table private.storage_bridge_nonces (
 nonce text primary key, expires_at timestamptz not null
);
revoke all on private.storage_bridge_config,private.storage_bridge_nonces from public,anon,authenticated;
alter table private.storage_bridge_config enable row level security;
alter table private.storage_bridge_nonces enable row level security;

create function public.storage_bridge_snapshot(request_time text,request_nonce text,request_signature text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 bridge_key text; expected bytea; supplied bytea; difference integer:=0; i integer;
 employee_rows jsonb; case_rows jsonb;
begin
 if coalesce(request_time,'') !~ '^\d{13}$' or coalesce(request_nonce,'') !~ '^[a-f0-9]{48}$' or coalesce(request_signature,'') !~ '^[a-f0-9]{64}$' then
  raise exception 'Bridge authentication failed' using errcode='42501';
 end if;
 if abs(extract(epoch from clock_timestamp())*1000-request_time::numeric)>60000 then
  raise exception 'Bridge authentication failed' using errcode='42501';
 end if;
 select secret into bridge_key from private.storage_bridge_config where id=1;
 if bridge_key is null then raise exception 'Bridge unavailable' using errcode='42501'; end if;
 expected:=extensions.hmac('GET'||chr(10)||'/rpc/storage_bridge_snapshot'||chr(10)||request_time||chr(10)||request_nonce,bridge_key,'sha256');
 supplied:=decode(request_signature,'hex');
 for i in 0..31 loop difference:=difference | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
 if difference<>0 then raise exception 'Bridge authentication failed' using errcode='42501'; end if;
 delete from private.storage_bridge_nonces where expires_at<clock_timestamp();
 begin
  insert into private.storage_bridge_nonces values(request_nonce,clock_timestamp()+interval '2 minutes');
 exception when unique_violation then raise exception 'Bridge authentication failed' using errcode='42501';
 end;
 if (select count(*) from public.cases where status in ('นัดวัดพื้นที่','นัดคิวติดตั้ง'))>10000 or (select count(*) from public.crm_employees)>10000 then
  raise exception 'Bridge snapshot limit exceeded';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.nickname,'active',e.status='active') order by e.id),'[]'::jsonb)
 into employee_rows from public.crm_employees e;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',c.id,'caseRef',c.legacy_case_id,'customerId',c.customer_id,'customer',cu.customer_name,'phone',cu.phone,
  'company',c.company,'status',c.status,'location',c.site_address,'mapLink',c.location_url,'notes',c.job_details,
  'date',case when f.current_status=c.status and f.next_follow_up_at is not null then to_char(f.next_follow_up_at at time zone 'Asia/Bangkok','YYYY-MM-DD') else '' end,
  'queueType',case when f.current_status=c.status and f.next_follow_up_at is not null then case c.status when 'นัดวัดพื้นที่' then 'measurement' when 'นัดคิวติดตั้ง' then 'installation' end else null end,
  'updatedAt',c.updated_at,'adminEmployeeId',coalesce(a.id,''),'salesEmployeeId',coalesce(c.salesperson_employee_id::text,'')
 ) order by c.id),'[]'::jsonb) into case_rows
 from public.cases c join public.customers cu on cu.id=c.customer_id
 left join lateral (select current_status,next_follow_up_at from public.lead_follow_up_history where case_id=c.id order by followed_at desc,created_at desc,id desc limit 1) f on true
 left join lateral (select case when count(*)=1 then min(e.id::text) else '' end as id from public.crm_employees e where e.status='active' and btrim(e.nickname)=btrim(c.admin_name)) a on true
 where c.status in ('นัดวัดพื้นที่','นัดคิวติดตั้ง');
 return jsonb_build_object('version',1,'generatedAt',clock_timestamp(),'employees',employee_rows,'cases',case_rows);
end;
$$;
revoke all on function public.storage_bridge_snapshot(text,text,text) from public,anon,authenticated;
-- HMAC is mandatory inside the fixed, non-dynamic function. No broad SELECT grants.
grant execute on function public.storage_bridge_snapshot(text,text,text) to anon;
comment on function public.storage_bridge_snapshot(text,text,text) is 'Read-only Storage export capability; HMAC + 60s expiry + nonce protection; no CRM mutations or auth account data.';
commit;
