import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createHandler,parseEvents,PAGES} from './supabase/functions/instagram-intake/handler.mjs';
import {createProfiles} from './supabase/functions/instagram-intake/profiles.mjs';
import intake from './instagram-intake.js';
const account='17841458662245781',user='123456789012345';
const event=(id='test-1',time=Date.now())=>({sender:{id:user},recipient:{id:account},timestamp:time,message:{mid:id,text:'private content'}});
const body=()=>({object:'instagram',entry:[{id:account,messaging:[event()]}]});
test('Instagram Edge refresh reads trusted caller-scoped manage grants and ignores payload grants',async()=>{
 for(const [grants,status] of [[{instagram:{view:true}},403],[{facebook:{manage:true}},403],[{instagram:{manage:'true'}},403],[{instagram:{manage:true}},403],[{instagram:{manage:true,accounts:{['car-ig-'+account]:{view:true}}}},403],[{instagram:{accounts:{'gfs-ig-17841402497215021':{manage:true}}}},403],[{instagram:{accounts:{['car-ig-'+account]:{manage:true}}}},200],[null,503]]) {
  const calls=[];
  const profiles=createProfiles({getEnv:()=> 'true',url:'https://db.example',headers:{apikey:'fixture'},fetchImpl:async(url,options)=>{
   calls.push(url);
   if(url.includes('/auth/v1/user')) return new Response(JSON.stringify({id:'delegated-user'}));
   assert.match(url,/\/rpc\/get_current_crm_intake_permissions$/);
   assert.equal(options.method,'POST');assert.equal(options.body,'{}');assert.equal(options.headers.Authorization,'Bearer fixture-session');
   return new Response(JSON.stringify(grants),{status:grants===null?503:200});
  }});
  const request=new Request('https://example/instagram-intake/profiles/refresh',{method:'POST',headers:{Authorization:'Bearer fixture-session'},body:JSON.stringify({account:'car-ig-'+account,users:[],intakePermissions:{instagram:{manage:true}}})});
  assert.equal((await profiles.refresh(request)).status,status);assert.equal(calls.length,2);
 }
});
test('Instagram CRM refresh accepts an active manage grant while rejecting view-only or other channels',async()=>{
 const input={account:'car-ig-'+account,users:[user]};let calls=0;
 const fetchImpl=async(url,options)=>{calls++;assert.equal(options.headers.Authorization,'Bearer fixture-session');assert.deepEqual(JSON.parse(options.body),input);return new Response(JSON.stringify({success:true}));};
 for(const membership of [{role:'sales',is_active:true,intakePermissions:{instagram:{view:true}}},{role:'sales',is_active:true,intakePermissions:{facebook:{manage:true}}},{role:'admin',is_active:false}]) {
  await assert.rejects(()=>intake.refreshNames(membership,input,'Bearer fixture-session',fetchImpl),error=>error.status===403);
 }
 assert.equal(calls,0);
 assert.deepEqual(await intake.refreshNames({role:'sales',is_active:true,intakePermissions:{instagram:{manage:true}}},input,'Bearer fixture-session',fetchImpl),{success:true});
 assert.equal(calls,1);
});
test('Instagram health reports only accounts with a configured credential',async()=>{
 const env={FACEBOOK_APP_SECRET:'fixture',INSTAGRAM_VERIFY_TOKEN:'fixture',INSTAGRAM_INTAKE_ENABLED:'true'};
 const handler=createHandler({getEnv:n=>env[n],persist:async()=>{}});
 const health=()=>handler(new Request('https://example/instagram-intake/health')).then(r=>r.json());
 assert.deepEqual(await health(),{configured:false,accounts:[]});
 env['INSTAGRAM_PAGE_TOKEN_'+account]='fixture';
 assert.deepEqual(await health(),{configured:true,accounts:[account]});
});
test('Instagram separates all three accounts, strips content and ignores outbound/read events',()=>{
 const data=body(); data.entry[0].standby=[{...event('echo'),message:{mid:'echo',is_echo:true}},{read:{watermark:1}}];
 for(const id of Object.keys(PAGES).filter(x=>x!==account))data.entry.push({id,standby:[{...event(id),recipient:{id}}]});
 const groups=parseEvents(data);assert.equal(groups.size,3);assert.equal(JSON.stringify([...groups]).includes('private'),false);
 data.entry[0].messaging[0].recipient.id='99999';assert.throws(()=>parseEvents(data));
 assert.throws(()=>parseEvents({...body(),object:'page'}));
});
test('Instagram verifies raw HMAC and persists before acknowledging; unsigned requests cannot write',async()=>{
 let saved=0;const env={FACEBOOK_APP_SECRET:'synthetic-secret',INSTAGRAM_INTAKE_ENABLED:'true',INSTAGRAM_VERIFY_TOKEN:'verify'};
 const handler=createHandler({getEnv:n=>env[n],persist:async(k,events)=>{saved++;assert.equal(k,'car-ig-'+account);assert.equal(events[0].userId,user);}});
 const raw=JSON.stringify(body()),signature='sha256='+createHmac('sha256',env.FACEBOOK_APP_SECRET).update(raw).digest('hex');
 const req=(s=signature)=>new Request('https://example/instagram-intake',{method:'POST',body:raw,headers:{'x-hub-signature-256':s}});
 assert.equal((await handler(req('invalid'))).status,401);assert.equal(saved,0);
 assert.equal((await handler(req())).status,200);assert.equal(saved,1);
 env.INSTAGRAM_INTAKE_ENABLED='false';assert.equal((await handler(req())).status,503);
});
test('Instagram profile lookup saves name and handle only on its exact account and sender',async()=>{
 const calls=[];const profiles=createProfiles({getEnv:()=> 'fixture-token',url:'https://db.example',headers:{apikey:'fixture'},fetchImpl:async(url,options)=>{
  calls.push({url,options});return new Response(JSON.stringify(url.startsWith('https://graph')?{name:'Real name',username:'tester'}:[{id:'saved'}]));
 }});
 const result=await profiles.enrich(account,[user]);assert.equal(result.updated,1);
 assert.match(calls[0].url,/fields=name,username/);assert.match(calls[1].url,/account_key=eq.car-ig-17841458662245781&instagram_user_id=eq.123456789012345/);
 assert.deepEqual(JSON.parse(calls[1].options.body),{display_name:'Real name',username:'tester'});
 await assert.rejects(()=>intake.getIntake({}, {role:'sales',is_active:true},{}));
});
test('Instagram SQL: duplicate delivery, Bangkok days, RLS and atomic manual promotion',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role authenticated;create role anon;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;
 create table crm_members(user_id uuid,role text,is_active boolean);
 create table customers(id uuid primary key default gen_random_uuid(),legacy_cust_id text unique,customer_name text,recorded_at timestamptz,contact_channel text,contact_handle text,remarks text,created_by uuid,updated_by uuid,gender text,phone text,email text,chat_link text,referral_source text);
 grant select on crm_members to authenticated;grant select,insert,update on customers to authenticated;
 insert into auth.users values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
 insert into crm_members values('11111111-1111-4111-8111-111111111111','admin',true),('22222222-2222-4222-8222-222222222222','sales',true);`);
 await db.exec(fs.readFileSync('supabase/migrations/20261006045531_add_instagram_intake.sql','utf8'));
 const events=[{eventId:'one',userId:user,at:'2026-10-05T17:15:00Z'},{eventId:'two',userId:user,at:'2026-10-05T16:15:00Z'}];
 await db.query('select receive_instagram_intake($1,$2)',[PAGES[account],JSON.stringify(events)]);
 await db.query('select receive_instagram_intake($1,$2)',[PAGES[account],JSON.stringify(events)]);
 assert.equal((await db.query('select count(*)::int n from instagram_intake_events')).rows[0].n,2);
 assert.equal((await db.query('select count(*)::int n from instagram_intake_days')).rows[0].n,2);
 const id=(await db.query('select id from instagram_intake_contacts')).rows[0].id;
 await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);`);
 assert.equal((await db.query('select * from instagram_intake_contacts')).rows.length,0);
 await assert.rejects(()=>db.query("select resolve_instagram_intake($1,'create','No','')",[id]));
 await db.exec(`select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);`);
 const sum=(await db.query("select instagram_intake_daily_summary($1,'2026-10-06') s",[PAGES[account]])).rows[0].s;assert.equal(sum.total,1);assert.equal(sum.new,0);
 await assert.rejects(()=>db.query("select resolve_instagram_with_details($1,'create','Invalid','','{\"phone\":\"invalid\"}')",[id]));
 assert.equal((await db.query('select count(*)::int n from customers')).rows[0].n,0);
 await db.query("select resolve_instagram_with_details($1,'create','Approved','','{\"contact_handle\":\"tester\"}')",[id]);
 await db.query("select resolve_instagram_with_details($1,'create','Approved','','{}')",[id]);
 const rows=(await db.query('select contact_channel,contact_handle from customers')).rows;assert.deepEqual(rows,[{contact_channel:'Instagram',contact_handle:'tester'}]);
 await db.exec('reset role;set role anon');await assert.rejects(()=>db.query('select * from instagram_intake_contacts'));
});
