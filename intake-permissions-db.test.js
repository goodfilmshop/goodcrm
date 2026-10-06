'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const migrationPath = 'supabase/migrations/20261006053617_add_employee_intake_permissions.sql';
const ids = {
  admin:'11111111-1111-4111-8111-111111111111',
  viewer:'22222222-2222-4222-8222-222222222222',
  manager:'33333333-3333-4333-8333-333333333333',
  inactive:'44444444-4444-4444-8444-444444444444',
  outsider:'55555555-5555-4555-8555-555555555555',
  inactiveAdmin:'66666666-6666-4666-8666-666666666666',
};
const accounts = {
  line:'gfs-line-249izgyn',facebook:'gfs-fb-125106670932394',instagram:'gfs-ig-17841402497215021',
};
const denied = {view:false,manage:false};
const full = {view:true,manage:true};

test('PostgreSQL: intake grants protect table access, RPCs and employee permissions', async t => {
  const db = new PGlite(); t.after(() => db.close());
  // Auth JWT adapter only. Run the real intake, employee and customer RLS migrations
  // unchanged; this harness does not certify GoTrue or webhook transport.
  await db.exec(`create role authenticated; create role anon; create role service_role bypassrls;
    create schema auth; create publication supabase_realtime;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon,service_role;
    grant execute on function auth.uid() to authenticated,anon,service_role;`);
  for (const filename of [
    '20260819075808_initial_crm_schema.sql',
    '20260819105231_add_employee_management.sql',
    '20260819131000_add_lead_follow_up_history.sql',
    '20260819131001_add_customer_email.sql',
    '20260820135915_restrict_sales_case_visibility.sql',
    '20260913093152_add_line_gfs_intake.sql',
    '20260913105100_line_intake_customer_display_defaults.sql',
    '20260913105921_allow_line_intake_customer_deletion.sql',
    '20260913120531_add_goodfilm_line_intake.sql',
    '20260913121333_add_mhl_line_intake.sql',
    '20260913112849_add_customer_chat_link.sql',
    '20260913133031_add_facebook_intake.sql',
    '20260914021002_intake_customer_details.sql',
    '20260917075626_add_maholan_line_intake.sql',
    '20261006045531_add_instagram_intake.sql',
  ]) await db.exec(fs.readFileSync(`supabase/migrations/${filename}`,'utf8'));
  for (const [key,id] of Object.entries(ids)) {
    await db.query('insert into auth.users values($1,$2)',[id,`${key}@example.invalid`]);
  }
  await db.query(`insert into public.crm_members(user_id,display_name,role,is_active)
    values($1,'Synthetic admin','admin',true),($2,'Synthetic inactive admin','admin',false)`,[ids.admin,ids.inactiveAdmin]);
  for (const key of ['viewer','manager','inactive']) {
    await db.query(`insert into public.crm_employees(nickname,email,access_role,status)
      values($1,$2,$3,$4)`,[`Synthetic ${key}`,`${key}@example.invalid`,key==='manager'?'manager':'sales',key==='inactive'?'inactive':'active']);
  }
  // Exercise replacement of every overload, not only the currently deployed arity.
  await db.exec(`create function public.resolve_line_intake(p_id uuid,p_decision text,p_name text,p_customer text,p_extra text)
    returns jsonb language plpgsql security invoker set search_path='' as $$
    begin
      if not exists(select 1 from public.crm_members where user_id=auth.uid() and is_active and role='admin') then raise exception 'Forbidden'; end if;
      return public.resolve_line_intake(p_id,p_decision,p_name,p_customer);
    end;$$;`);
  await db.exec(fs.readFileSync(migrationPath,'utf8'));
  await db.exec(fs.readFileSync('supabase/migrations/20261006061618_allow_dismissed_intake_admission.sql','utf8'));
  const login = async id => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id || ''}',false);`);
  const effective = async () => (await db.query('select public.get_current_crm_intake_permissions() as grants')).rows[0].grants;
  const grant = async (id,permissions) => {
    await login(ids.admin);
    const result = await db.query('update public.crm_employees set intake_permissions=$1 where member_user_id=$2 returning intake_permissions',[permissions,id]);
    assert.equal(result.rows.length,1);
    return result.rows[0].intake_permissions;
  };
  const makeContact = async (channel,suffix,account=accounts[channel]) => {
    await db.exec('reset role');
    const uid = channel==='line' ? `U${String(suffix).padStart(32,'0')}` : String(100000 + suffix);
    const row = (await db.query(`insert into public.${channel}_intake_contacts(account_key,${channel}_user_id,first_seen_at,last_seen_at)
      values($1,$2,'2026-10-06T00:00:00Z','2026-10-06T00:00:00Z') returning id`,[account,uid])).rows[0];
    await db.query(`insert into public.${channel}_intake_days values($1,'2026-10-06')`,[row.id]);
    return row.id;
  };
  const contactIds = {};
  for (const channel of Object.keys(accounts)) contactIds[channel] = await makeContact(channel,1);
  const resolve = async (channel,id,decision='dismiss',name=null) =>
    (await db.query(`select public.resolve_${channel}_intake($1,$2,$3,$4) as result`,[id,decision,name,null])).rows[0].result;
  const summary = async channel => (await db.query(`select public.${channel}_intake_daily_summary($1,$2) as result`,[accounts[channel],'2026-10-06'])).rows[0].result;

  await t.test('admins retain full access; existing employees start with no channel grants',async () => {
    await login(ids.admin);
    assert.deepEqual(await effective(),{line:full,facebook:full,instagram:full});
    for (const channel of Object.keys(accounts)) {
      assert.equal((await db.query(`select * from public.${channel}_intake_contacts`)).rows.length,1);
      assert.equal((await summary(channel)).total,1);
    }
    await login(ids.viewer);
    assert.deepEqual(await effective(),{line:denied,facebook:denied,instagram:denied});
    assert.equal((await db.query('select * from public.crm_employees')).rows.length,0);
    assert.equal((await db.query('select * from public.line_intake_contacts')).rows.length,0);
  });

  await t.test('manage implies view and malformed privilege JSON is rejected',async () => {
    assert.deepEqual(await grant(ids.manager,{facebook:{manage:true}}),{facebook:full});
    await login(ids.admin);
    for (const malformed of [[],null,{other:{view:true}},{line:true},{line:{view:'true'}},{line:{view:true,extra:true}}]) {
      await assert.rejects(db.query('update public.crm_employees set intake_permissions=$1 where member_user_id=$2',[malformed,ids.viewer]),e=>e.code==='23514');
    }
    await login(ids.manager);
    assert.deepEqual(await effective(),{line:denied,facebook:full,instagram:denied});
    for (const operation of ['other',null]) {
      assert.equal((await db.query('select private.can_access_intake($1,$2) as allowed',['line',operation])).rows[0].allowed,false);
    }
    await login(ids.admin);
    assert.equal((await db.query('select private.can_access_intake($1,$2) as allowed',[null,'view'])).rows[0].allowed,false);
    assert.equal((await db.query('select private.can_access_intake($1,$2) as allowed',['line',null])).rows[0].allowed,false);
  });

  await t.test('read-only grant reveals only its channel, days and summary; direct writes/RPCs fail',async () => {
    await grant(ids.viewer,{line:{view:true,manage:false}}); await login(ids.viewer);
    assert.deepEqual(await effective(),{line:{view:true,manage:false},facebook:denied,instagram:denied});
    assert.equal((await db.query('select * from public.line_intake_contacts')).rows.length,1);
    assert.equal((await db.query('select * from public.line_intake_days')).rows.length,1);
    assert.equal((await summary('line')).total,1);
    assert.equal((await db.query("update public.line_intake_contacts set status='dismissed' returning id")).rows.length,0);
    assert.equal((await db.query('select * from public.facebook_intake_contacts')).rows.length,0);
    assert.equal((await db.query('select * from public.facebook_intake_days')).rows.length,0);
    for (const channel of Object.keys(accounts)) {
      await assert.rejects(resolve(channel,contactIds[channel]),e=>e.code==='42501');
      if (channel!=='line') await assert.rejects(summary(channel),e=>e.code==='42501');
    }
    await assert.rejects(db.query('select public.resolve_intake_with_details($1,$2,$3,$4,$5,$6)',['line',contactIds.line,'dismiss',null,null,{}]),e=>e.code==='42501');
    await assert.rejects(db.query('select public.resolve_instagram_with_details($1,$2,$3,$4,$5)',[contactIds.instagram,'dismiss',null,null,{}]),e=>e.code==='42501');
    await assert.rejects(db.query('select public.resolve_line_intake($1,$2,$3,$4,$5)',[contactIds.line,'dismiss',null,null,'extra']),e=>e.code==='42501');
  });

  await t.test('only administrators can edit employee grants; no user can self-grant',async () => {
    await login(ids.viewer);
    assert.equal((await db.query('update public.crm_employees set intake_permissions=$1 where member_user_id=$2 returning id',[{instagram:full},ids.viewer])).rows.length,0);
    await assert.rejects(db.query('insert into public.crm_employees(nickname,email,intake_permissions) values($1,$2,$3)',['Forged employee','forged@example.invalid',{instagram:full}]),e=>e.code==='42501');
    assert.deepEqual((await effective()).instagram,denied);
  });

  await t.test('channel managers can resolve their channel but cannot cross channels',async () => {
    await login(ids.manager);
    const facebookResult = (await db.query('select public.resolve_intake_with_details($1,$2,$3,$4,$5,$6) as result',
      ['facebook',contactIds.facebook,'dismiss',null,null,{}])).rows[0].result;
    assert.deepEqual(facebookResult,{status:'dismissed'});
    await assert.rejects(resolve('line',contactIds.line),e=>e.code==='42501');
    assert.equal((await db.query("update public.instagram_intake_contacts set status='dismissed' returning id")).rows.length,0);
    for (const channel of ['line','instagram']) {
      await grant(ids.manager,{[channel]:full}); await login(ids.manager);
      const result = channel==='line'
        ? (await db.query('select public.resolve_line_intake($1,$2,$3,$4,$5) as result',[contactIds.line,'dismiss',null,null,'extra'])).rows[0].result
        : (await db.query('select public.resolve_instagram_with_details($1,$2,$3,$4,$5) as result',[contactIds.instagram,'dismiss',null,null,{}])).rows[0].result;
      assert.deepEqual(result,{status:'dismissed'});
    }
  });

  await t.test('sales can create a customer via a granted resolver with caller ownership and details',async () => {
    const id = await makeContact('line',2);
    await grant(ids.viewer,{line:full}); await login(ids.viewer);
    const result = (await db.query('select public.resolve_intake_with_details($1,$2,$3,$4,$5,$6) as result',[
      'line',id,'create','Synthetic new customer',null,{gender:'หญิง',contact_handle:'Synthetic handle',remarks:'Synthetic remarks'},
    ])).rows[0].result;
    assert.equal(result.status,'imported');
    const customer = (await db.query('select * from public.customers where legacy_cust_id=$1',[result.customerId])).rows[0];
    assert.equal(customer.created_by,ids.viewer);
    assert.equal(customer.updated_by,ids.viewer);
    assert.equal(customer.gender,'หญิง');
    assert.equal(customer.contact_handle,'Synthetic handle');
    assert.match(customer.remarks,/GFS LINE OA/);
    assert.match(customer.remarks,/Synthetic remarks/);
    assert.equal((await resolve('line',id,'create','Synthetic retry')).alreadyResolved,true);
  });

  await t.test('delegated direct PATCH cannot forge provenance, audit or an inaccessible customer link',async () => {
    const lineId = await makeContact('line',3);
    const facebookId = await makeContact('facebook',3);
    const instagramId = await makeContact('instagram',3);
    await db.exec('reset role');
    const hiddenCustomer = (await db.query(`insert into public.customers(legacy_cust_id,customer_name,created_by)
      values('SYNTHETIC-HIDDEN','Synthetic hidden customer',$1) returning id`,[ids.admin])).rows[0].id;
    await grant(ids.viewer,{line:full,facebook:full,instagram:full}); await login(ids.viewer);
    assert.equal((await db.query('select id from public.customers where id=$1',[hiddenCustomer])).rows.length,0);
    assert.equal((await db.query('update public.line_intake_contacts set display_name=$1 where id=$2 returning id',['Synthetic profile',lineId])).rows.length,1);
    for (const mutation of [
      "id=gen_random_uuid()", "account_key='gfs-line-095jvuls'", "line_user_id='U88888888888888888888888888888888'",
      "first_seen_at=now()", "last_seen_at=now()",
      "status='dismissed'", `status='dismissed',resolved_at=now(),resolved_by='${ids.manager}'`,
      `status='dismissed',resolved_at='2000-01-01T00:00:00Z',resolved_by='${ids.viewer}'`,
    ]) await assert.rejects(db.query(`update public.line_intake_contacts set ${mutation} where id=$1`,[lineId]),e=>e.code==='42501');
    await assert.rejects(db.query(`update public.line_intake_contacts set status='imported',customer_id=$1,
      resolved_by=$2,resolved_at=now() where id=$3`,[hiddenCustomer,ids.viewer,lineId]),e=>e.code==='42501');
    await assert.rejects(db.query('select public.resolve_line_intake($1,$2,$3,$4)',
      [lineId,'link',null,'SYNTHETIC-HIDDEN']),e=>/Customer not found/.test(e.message));
    await assert.rejects(db.query("update public.facebook_intake_contacts set facebook_user_id='888888888' where id=$1",[facebookId]),e=>e.code==='42501');
    await assert.rejects(db.query("update public.instagram_intake_contacts set instagram_user_id='888888888' where id=$1",[instagramId]),e=>e.code==='42501');
    assert.equal((await db.query('update public.instagram_intake_contacts set display_name=$1,username=$2 where id=$3 returning id',
      ['Synthetic IG profile','synthetic-profile',instagramId])).rows.length,1);
    await assert.rejects(db.query('update public.instagram_intake_contacts set username=$1 where id=$2',['X'.repeat(101),instagramId]),e=>e.code==='23514');
    await assert.rejects(db.query('update public.line_intake_contacts set display_name=$1 where id=$2',['X'.repeat(201),lineId]),e=>e.code==='23514');
    const ownCustomer = (await db.query(`insert into public.customers(legacy_cust_id,customer_name,created_by)
      values('SYNTHETIC-OWN','Synthetic own customer',$1) returning id`,[ids.viewer])).rows[0].id;
    const linked = (await db.query('select public.resolve_line_intake($1,$2,$3,$4) as result',
      [lineId,'link',null,'SYNTHETIC-OWN'])).rows[0].result;
    assert.equal(linked.status,'imported');
    await assert.rejects(db.query(`update public.line_intake_contacts set status='dismissed',customer_id=null,
      resolved_at=now(),resolved_by=$1 where id=$2`,[ids.viewer,lineId]),e=>e.code==='42501');
    // Existing customer deletion unlinks the imported contact through the FK action.
    await login(ids.admin);
    await db.query('delete from public.customers where id=$1',[ownCustomer]);
    const orphan = (await db.query('select status,customer_id from public.line_intake_contacts where id=$1',[lineId])).rows[0];
    assert.deepEqual(orphan,{status:'imported',customer_id:null});
  });

  await t.test('dismissed LINE/FB can be admitted or linked once, with permissions and atomic rollback',async () => {
    for (const channel of ['line','facebook']) {
      const id = await makeContact(channel,20);
      const linkId = await makeContact(channel,21);
      await login(ids.admin);
      await resolve(channel,id);
      await resolve(channel,linkId);
      await grant(ids.viewer,{[channel]:{view:true,manage:false}});
      await login(ids.viewer);
      await assert.rejects(resolve(channel,id,'create','Denied'),e=>e.code==='42501');
      await grant(ids.viewer,{[channel]:full}); await login(ids.viewer);
      const before = Number((await db.query('select count(*) as n from public.customers')).rows[0].n);
      const result = (await db.query('select public.resolve_intake_with_details($1,$2,$3,$4,$5,$6) as result',
        [channel,id,'create','Synthetic reconsidered',null,{gender:'ไม่ระบุ',email:'reconsidered@example.invalid'}])).rows[0].result;
      assert.equal(result.status,'imported');
      const customer = (await db.query('select email from public.customers where legacy_cust_id=$1',[result.customerId])).rows[0];
      assert.equal(customer.email,'reconsidered@example.invalid');
      assert.equal((await resolve(channel,id,'create','Duplicate')).alreadyResolved,true);
      assert.equal(Number((await db.query('select count(*) as n from public.customers')).rows[0].n),before+1);
      await assert.rejects(db.query('select public.resolve_intake_with_details($1,$2,$3,$4,$5,$6)',
        [channel,linkId,'link',null,'MISSING-SYNTHETIC',{}]),/Customer not found/);
      assert.equal((await db.query(`select status from public.${channel}_intake_contacts where id=$1`,[linkId])).rows[0].status,'dismissed');
      const linked = (await db.query('select public.resolve_intake_with_details($1,$2,$3,$4,$5,$6) as result',
        [channel,linkId,'link',null,result.customerId,{}])).rows[0].result;
      assert.equal(linked.customerId,result.customerId);
      assert.equal(Number((await db.query('select count(*) as n from public.customers')).rows[0].n),before+1);
      await assert.rejects(db.query(`update public.${channel}_intake_contacts set status='pending',customer_id=null,
        resolved_at=now(),resolved_by=$1 where id=$2`,[ids.viewer,id]),e=>e.code==='42501');
    }
  });

  await t.test('revocation and inactive membership/employee take effect without JWT refresh',async () => {
    await grant(ids.viewer,{}); await login(ids.viewer);
    assert.deepEqual((await effective()).line,denied);
    assert.equal((await db.query('select * from public.line_intake_contacts')).rows.length,0);
    await grant(ids.viewer,{line:full});
    await db.exec(`reset role; update public.crm_members set is_active=false where user_id='${ids.viewer}';`);
    await login(ids.viewer);
    assert.deepEqual((await effective()).line,denied);
    await assert.rejects(resolve('line',contactIds.line),e=>e.code==='42501');
    await db.exec(`reset role; update public.crm_members set is_active=true where user_id='${ids.viewer}';
      update public.crm_employees set status='inactive' where member_user_id='${ids.viewer}';
      update public.crm_members set is_active=true where user_id='${ids.viewer}';`);
    await login(ids.viewer);
    assert.deepEqual((await effective()).line,denied);
    for (const key of ['inactive','inactiveAdmin','outsider']) {
      await login(ids[key]); assert.deepEqual(await effective(),{line:denied,facebook:denied,instagram:denied});
      await assert.rejects(summary('line'),e=>e.code==='42501');
    }
  });

  await t.test('anonymous callers are revoked and service-role webhook ingestion is preserved',async () => {
    await login(null);
    assert.deepEqual(await effective(),{line:denied,facebook:denied,instagram:denied});
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select public.get_current_crm_intake_permissions()'),e=>e.code==='42501');
    await assert.rejects(db.query("select private.can_access_intake('line','view')"),e=>e.code==='42501');
    await db.exec('reset role; set role service_role');
    for (const channel of Object.keys(accounts)) {
      const userId = channel==='line' ? `U${'9'.repeat(32)}` : '999999999';
      await db.query(`select public.receive_${channel}_intake($1,$2)`,[accounts[channel],[{userId,eventId:`synthetic-${channel}`,at:'2026-10-06T00:00:00Z'}]]);
      assert.equal((await db.query(`select * from public.${channel}_intake_events`)).rows.length,1);
      await db.query(`update public.${channel}_intake_contacts set display_name='Webhook profile' where ${channel}_user_id=$1`,[userId]);
    }
    await db.exec('reset role');
    const routines = (await db.query(`select proname,prosecdef,proconfig from pg_proc
      where proname in ('can_access_intake','get_current_crm_intake_permissions','resolve_line_intake','resolve_facebook_intake','resolve_instagram_intake','resolve_intake_with_details','resolve_instagram_with_details')`)).rows;
    assert.equal(routines.find(r=>r.proname==='can_access_intake').prosecdef,true);
    assert.ok(routines.filter(r=>r.proname!=='can_access_intake').every(r=>r.prosecdef===false));
    assert.ok(routines.every(r=>r.proconfig.includes('search_path=""')));
  });

  const accountKeys = {
    line:['gfs-line-249izgyn','gfs-line-095jvuls','mhl-line-320opqkc','car-line-fkq6145q'],
    facebook:['gfs-fb-125106670932394','gfs-fb-101634951180913','mhl-fb-109607531869658'],
    instagram:['gfs-ig-17841402497215021','mhl-ig-17841421260722221','car-ig-17841458662245781'],
  };
  const canonical = (grants={}) => Object.fromEntries(Object.entries(accountKeys).map(([channel,keys])=>[
    channel,{...(grants[channel] || denied),accounts:Object.fromEntries(keys.map(key=>[key,grants[channel] || denied]))},
  ]));
  const summaryAccount = async (channel,account) => (await db.query(
    `select public.${channel}_intake_daily_summary($1,$2) as result`,[account,'2026-10-06'])).rows[0].result;
  const specific = async (channel,operation,account) => (await db.query(
    'select private.can_access_intake($1,$2,$3) as allowed',[channel,operation,account])).rows[0].allowed;

  await t.test('account migration expands only existing legacy channel grants and keeps admin access',async () => {
    await db.exec(`reset role; update public.crm_employees set status='active' where member_user_id='${ids.viewer}';`);
    await grant(ids.viewer,{line:full,facebook:{view:true,manage:false}});
    await db.exec('reset role');
    await db.exec(fs.readFileSync('supabase/migrations/20261006111911_add_intake_account_permissions.sql','utf8'));
    await login(ids.viewer);
    assert.deepEqual(await effective(),canonical({line:full,facebook:{view:true,manage:false}}));
    await login(ids.admin);
    assert.deepEqual(await effective(),canonical({line:full,facebook:full,instagram:full}));
    for (const channel of Object.keys(accountKeys)) {
      for (const key of accountKeys[channel]) assert.equal(await specific(channel,'manage',key),true);
    }
    assert.equal(await specific('line','view','unregistered-oa'),false);
    assert.equal(await specific('line','view',accountKeys.facebook[0]),false);
    assert.equal(await specific('line','manage',null),false);
  });

  await t.test('explicit account maps override aggregate flags and validate exact account keys and booleans',async () => {
    const saved = await grant(ids.viewer,{line:{view:true,manage:true,accounts:{[accountKeys.line[0]]:{view:true,manage:false}}}});
    assert.equal(saved.line.manage,false);
    assert.deepEqual(saved.line.accounts[accountKeys.line[1]],denied);
    await login(ids.viewer);
    assert.deepEqual((await effective()).line,saved.line);
    assert.equal(await specific('line','manage',accountKeys.line[0]),false);
    assert.equal(await specific('line','view',accountKeys.line[1]),false);
    await login(ids.admin);
    for (const malformed of [
      {line:{accounts:[]}}, {line:{accounts:{unknown:{view:true}}}},
      {line:{accounts:{[accountKeys.facebook[0]]:full}}},
      {line:{accounts:{[accountKeys.line[0]]:{manage:'true'}}}},
      {line:{accounts:{[accountKeys.line[0]]:{view:true,extra:true}}}},
    ]) await assert.rejects(db.query('update public.crm_employees set intake_permissions=$1 where member_user_id=$2',
      [malformed,ids.viewer]),e=>e.code==='23514');
    const empty = await grant(ids.viewer,{line:{view:true,manage:true,accounts:{}}});
    assert.deepEqual(empty,canonical());
  });

  const scopedIds = {};
  await t.test('same-platform page grants isolate reads, days, summaries and every resolver wrapper',async () => {
    for (const [channel,keys] of Object.entries(accountKeys)) {
      const viewId = await makeContact(channel,40,keys[0]);
      const manageId = await makeContact(channel,41,keys[1]);
      const deniedId = await makeContact(channel,42,keys[2]);
      scopedIds[channel] = {viewId,manageId,deniedId};
      await grant(ids.viewer,{[channel]:{view:true,manage:true,accounts:{
        [keys[0]]:{view:true,manage:false},[keys[1]]:{manage:true},
      }}}); await login(ids.viewer);
      assert.equal((await db.query('select private.can_access_intake($1,$2) as allowed',[channel,'manage'])).rows[0].allowed,true);
      assert.equal(await specific(channel,'manage',keys[0]),false);
      assert.equal(await specific(channel,'manage',keys[1]),true);
      assert.deepEqual((await db.query(`select distinct account_key from public.${channel}_intake_contacts order by account_key`)).rows.map(r=>r.account_key),[keys[0],keys[1]].sort());
      assert.equal((await db.query(`select * from public.${channel}_intake_days where contact_id=$1`,[deniedId])).rows.length,0);
      assert.ok((await summaryAccount(channel,keys[0])).total>0);
      assert.ok((await summaryAccount(channel,keys[1])).total>0);
      await assert.rejects(summaryAccount(channel,keys[2]),e=>e.code==='42501');
      assert.equal((await db.query(`update public.${channel}_intake_contacts set display_name='Forbidden profile' where id=$1 returning id`,[viewId])).rows.length,0);
      assert.equal((await db.query(`update public.${channel}_intake_contacts set display_name='Allowed profile' where id=$1 returning id`,[manageId])).rows.length,1);
      await assert.rejects(resolve(channel,viewId),e=>e.code==='42501');
      await assert.rejects(resolve(channel,deniedId),e=>e.code==='42501');
      if (channel==='line') await assert.rejects(db.query('select public.resolve_line_intake($1,$2,$3,$4,$5)',
        [viewId,'dismiss',null,null,'extra']),e=>e.code==='42501');
      const rpc = channel==='instagram' ? 'select public.resolve_instagram_with_details($1,$2,$3,$4,$5) as result'
        : 'select public.resolve_intake_with_details($1,$2,$3,$4,$5,$6) as result';
      const args = id => channel==='instagram' ? [id,'dismiss',null,null,{}] : [channel,id,'dismiss',null,null,{}];
      await assert.rejects(db.query(rpc,args(viewId)),e=>e.code==='42501');
      assert.deepEqual((await db.query(rpc,args(manageId))).rows[0].result,{status:'dismissed'});
      // Changing the request's platform cannot make another table's ID accessible.
      const fakePlatform = channel==='line' ? 'facebook' : 'line';
      await assert.rejects(db.query('select public.resolve_intake_with_details($1,$2,$3,$4,$5,$6)',
        [fakePlatform,deniedId,'dismiss',null,null,{}]),e=>e.code==='42501');
      await login(ids.admin);
      assert.equal((await db.query(`select status from public.${channel}_intake_contacts where id=$1`,[viewId])).rows[0].status,'pending');
      assert.equal((await db.query(`select status from public.${channel}_intake_contacts where id=$1`,[deniedId])).rows[0].status,'pending');
    }
    const guarded = (await db.query(`select proname,pg_get_functiondef(oid) as ddl from pg_proc
      where proname in ('resolve_line_intake','resolve_facebook_intake','resolve_instagram_intake','resolve_intake_with_details','resolve_instagram_with_details')`)).rows;
    assert.ok(guarded.every(r=>r.ddl.includes('private.require_intake_contact_manage')));
  });

  await t.test('forged account PATCH is blocked; account revocation is immediate and cannot be self-granted',async () => {
    const keys = accountKeys.line;
    await grant(ids.viewer,{line:{accounts:{[keys[0]]:full,[keys[1]]:full}}}); await login(ids.viewer);
    await assert.rejects(db.query('update public.line_intake_contacts set account_key=$1 where id=$2',[keys[1],scopedIds.line.viewId]),e=>e.code==='42501');
    // The first OA remains view-only while only the second OA's grant is revoked.
    await grant(ids.viewer,{line:{accounts:{[keys[0]]:{view:true,manage:false}}}}); await login(ids.viewer);
    assert.equal(await specific('line','view',keys[0]),true);
    assert.equal(await specific('line','view',keys[1]),false);
    await assert.rejects(summaryAccount('line',keys[1]),e=>e.code==='42501');
    await assert.rejects(resolve('line',scopedIds.line.manageId),e=>e.code==='42501');
    assert.equal((await db.query('update public.crm_employees set intake_permissions=$1 where member_user_id=$2 returning id',
      [{line:{accounts:{[keys[1]]:full}}},ids.viewer])).rows.length,0);
    assert.equal(await specific('line','view',keys[1]),false);
  });

  await t.test('account-specific permission preserves dismissed LINE and Facebook admission',async () => {
    for (const channel of ['line','facebook']) {
      const account = accountKeys[channel][1];
      await grant(ids.viewer,{[channel]:{accounts:{[account]:full}}}); await login(ids.viewer);
      const created = (await db.query('select public.resolve_intake_with_details($1,$2,$3,$4,$5,$6) as result',
        [channel,scopedIds[channel].manageId,'create','Synthetic scoped reconsidered',null,{}])).rows[0].result;
      assert.equal(created.status,'imported');
      assert.equal((await resolve(channel,scopedIds[channel].manageId,'create','Synthetic scoped retry')).alreadyResolved,true);
    }
  });

  await t.test('account grants still require active membership and employee; anonymous denied and service webhooks work',async () => {
    await grant(ids.viewer,{instagram:{accounts:{[accountKeys.instagram[2]]:full}}});
    await db.exec(`reset role; update public.crm_members set is_active=false where user_id='${ids.viewer}';`);
    await login(ids.viewer);
    assert.deepEqual(await effective(),canonical());
    await db.exec(`reset role; update public.crm_members set is_active=true where user_id='${ids.viewer}';
      update public.crm_employees set status='inactive' where member_user_id='${ids.viewer}';
      update public.crm_members set is_active=true where user_id='${ids.viewer}';`);
    await login(ids.viewer); assert.deepEqual(await effective(),canonical());
    await login(ids.inactiveAdmin); assert.deepEqual(await effective(),canonical());
    await login(null); assert.deepEqual(await effective(),canonical());
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select public.get_current_crm_intake_permissions()'),e=>e.code==='42501');
    await assert.rejects(db.query('select private.can_access_intake($1,$2,$3)',['line','view',accountKeys.line[0]]),e=>e.code==='42501');
    await db.exec('reset role; set role service_role');
    for (const channel of Object.keys(accountKeys)) {
      const account = accountKeys[channel].at(-1);
      const userId = channel==='line' ? `U${'7'.repeat(32)}` : '777777777';
      await db.query(`select public.receive_${channel}_intake($1,$2)`,[account,[{userId,eventId:`scoped-synthetic-${channel}`,at:'2026-10-06T00:00:00Z'}]]);
      assert.equal((await db.query(`select * from public.${channel}_intake_contacts where account_key=$1 and ${channel}_user_id=$2`,[account,userId])).rows.length,1);
    }
    await db.exec('reset role');
  });
});
