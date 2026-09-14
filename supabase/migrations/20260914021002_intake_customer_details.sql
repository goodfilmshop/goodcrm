create or replace function public.resolve_intake_with_details(p_platform text,p_id uuid,p_decision text,p_name text,p_customer text,p_details jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; v_phone text; v_email text; v_link text; v_gender text; pair record;
begin
 if not exists(select 1 from public.crm_members where user_id=auth.uid() and is_active and role='admin') then raise exception 'Forbidden'; end if;
 if p_details is null or jsonb_typeof(p_details)<>'object' then raise exception 'Invalid details'; end if;
 if p_decision='create' then
  for pair in select * from jsonb_each(p_details) loop
   if jsonb_typeof(pair.value)<>'string' or length(pair.value #>> '{}')>5000 then raise exception 'Invalid field'; end if;
  end loop;
  v_gender:=coalesce(nullif(p_details->>'gender',''),'ไม่ระบุ');
  v_phone:=regexp_replace(coalesce(p_details->>'phone',''),'[ ()-]','','g');
  if v_phone like '+66%' then v_phone:='0'||substr(v_phone,4); end if;
  v_email:=nullif(trim(p_details->>'email'),''); v_link:=nullif(trim(p_details->>'chat_link'),'');
  if v_gender not in ('ไม่ระบุ','หญิง','ชาย') then raise exception 'Invalid gender'; end if;
  if v_phone<>'' and v_phone !~ '^(0[689][0-9]{8}|02[0-9]{7}|0[3-7][0-9]{7})$' then raise exception 'Invalid phone'; end if;
  if v_email is not null and (length(v_email)>254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then raise exception 'Invalid email'; end if;
  if v_link is not null and (length(v_link)>2000 or v_link !~ '^https?://[^[:space:]]+$') then raise exception 'Invalid chat link'; end if;
  if length(coalesce(p_details->>'contact_handle',''))>200 or length(coalesce(p_details->>'referral_source',''))>200 then raise exception 'Field too long'; end if;
 end if;
 if p_platform='line' then result:=public.resolve_line_intake(p_id,p_decision,p_name,p_customer);
 elsif p_platform='facebook' then result:=public.resolve_facebook_intake(p_id,p_decision,p_name,p_customer);
 else raise exception 'Invalid platform'; end if;
 if p_decision='create' and not coalesce((result->>'alreadyResolved')::boolean,false) then
  update public.customers set gender=v_gender, phone=nullif(v_phone,''),email=v_email,chat_link=v_link,
   contact_handle=coalesce(nullif(trim(p_details->>'contact_handle'),''),contact_handle),
   referral_source=nullif(trim(p_details->>'referral_source'),''),
   remarks=concat_ws(E'\n',nullif(remarks,''),nullif(trim(p_details->>'remarks'),'')),updated_by=auth.uid()
  where legacy_cust_id=result->>'customerId';
 end if;
 return result;
end;
$$;
revoke all on function public.resolve_intake_with_details(text,uuid,text,text,text,jsonb) from public,anon;
grant execute on function public.resolve_intake_with_details(text,uuid,text,text,text,jsonb) to authenticated;
