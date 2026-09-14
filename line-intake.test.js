const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { validSignature, inboundEvents, createWebhook, requireIntakeAdmin, resolveIntake } = require('./line-intake');
const secret = 'test-secret';
const destination = 'U' + 'a'.repeat(32);
const user = 'U' + 'b'.repeat(32);
const body = { destination, events: [{ type:'message', webhookEventId:'event-1', timestamp:Date.now(), source:{type:'user', userId:user}, message:{type:'text',text:'do not persist me'} }] };
const sign = raw => crypto.createHmac('sha256',secret).update(raw).digest('base64');
test('intake account selection permits only the two configured GFS accounts',()=>{
  const {intakeAccount}=require('./line-intake');
  assert.equal(intakeAccount().basicId,'@249izgyn');
  assert.equal(intakeAccount('gfs-line-095jvuls').endpoint,'line-goodfilm-intake');
  for(const key of ['unknown','__proto__','constructor']) assert.throws(()=>intakeAccount(key));
});

test('LINE customer defaults use the entered name and both OA handles without backfilling existing customers', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20260913105100_line_intake_customer_display_defaults.sql'), 'utf8');
  assert.match(sql, /create or replace function public\.resolve_line_intake\(p_id uuid, p_decision text, p_name text, p_customer text\)/);
  assert.match(sql, /values\(legacy,trim\(p_name\),now\(\),'LINE',trim\(p_name\),'GFS LINE OA @249izgyn \/ @3mfilm'/);
  assert.ok(!sql.includes("'LINE',item.line_user_id"));
  assert.ok(!/update\s+public\.customers/i.test(sql));
  assert.match(sql, /security invoker set search_path = ''/);
  assert.match(sql, /role='admin'/);
  assert.match(sql, /where id=p_id for update/);
  assert.match(sql, /item\.status <> 'pending'/);
  assert.match(sql, /revoke all on function public\.resolve_line_intake\(uuid,text,text,text\) from public, anon/);
});
test('signature verifies original bytes, rejects tampering and malformed input', () => {
  const raw = Buffer.from(JSON.stringify(body));
  assert.equal(validSignature(raw, sign(raw), secret), true);
  assert.equal(validSignature(Buffer.concat([raw,Buffer.from(' ')]), sign(raw), secret), false);
  for (const value of ['', 'bad', sign(raw).slice(1), '=']) assert.equal(validSignature(raw,value,secret),false);
});
test('only one-to-one inbound messages count; no message content persists', () => {
  const entries = inboundEvents({...body,events:[...body.events,{type:'follow',source:{type:'user',userId:user}},{type:'message',source:{type:'group'}}]},destination);
  assert.deepEqual(Object.keys(entries[0]),['eventId','userId','at']);
  assert.equal(entries.length,1);
  assert.throws(() => inboundEvents(body,'wrong'));
  assert.throws(() => inboundEvents({...body,events:[{...body.events[0],timestamp:NaN}]},destination));
});
test('pilot intake permissions and human reply confirmation are required', async () => {
  for (const member of [null,{role:'sales',is_active:true},{role:'admin',is_active:false}]) assert.throws(() => requireIntakeAdmin(member));
  let calls=0;
  const client = {rpc: async()=>{calls++;return {data:{status:'imported'}};}};
  await assert.rejects(resolveIntake(client,{role:'admin',is_active:true},{decision:'create',customerName:'Name'}));
  assert.equal(calls,0);
  await resolveIntake(client,{role:'admin',is_active:true},{id:'test',decision:'create',customerName:'Name',replied:true});
  assert.equal(calls,1);
});
test('webhook requires configuration and signature, acknowledges only committed data', async t => {
  let databaseError = false;
  const calls=[];
  const env={LINE_GFS_INTAKE_ENABLED:'true',LINE_GFS_CHANNEL_SECRET:secret,LINE_GFS_BOT_USER_ID:destination};
  const app=express();
  app.post('/hook',express.raw({type:'application/json'}),createWebhook({env,getClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return {error:databaseError};}})}));
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  await new Promise(resolve=>server.once('listening',resolve));
  const raw=JSON.stringify(body);
  const send=signature=>fetch(`http://127.0.0.1:${server.address().port}/hook`,{method:'POST',headers:{'content-type':'application/json','x-line-signature':signature},body:raw});
  assert.equal((await send('bad')).status,401);
  assert.equal(calls.length,0);
  assert.equal((await send(sign(raw))).status,200);
  assert.equal(JSON.stringify(calls).includes('do not persist me'),false);
  databaseError=true;
  assert.equal((await send(sign(raw))).status,503);
  env.LINE_GFS_INTAKE_ENABLED='false';
  assert.equal((await send(sign(raw))).status,503);
});
