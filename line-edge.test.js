const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const destination = 'U'+'a'.repeat(32);
const user = 'U'+'b'.repeat(32);
const env = {LINE_GFS_INTAKE_ENABLED:'true',LINE_GFS_CHANNEL_SECRET:'test-secret',LINE_GFS_BOT_USER_ID:destination};
test('Goodfilm bridge isolates account and authenticates metadata forwarding', async () => {
  const {createHandler}=await import('./supabase/functions/line-goodfilm-intake/handler.mjs');
  const config={LINE_GOODFILM_INTAKE_ENABLED:'true',LINE_GOODFILM_BRIDGE_SECRET:'bridge-test-key',LINE_GOODFILM_BOT_USER_ID:destination};
  const calls=[];
  const handler=createHandler({getEnv:n=>config[n],persist:async(...args)=>calls.push(args)});
  const raw=JSON.stringify({destination,events:[{type:'message',webhookEventId:'same-id',timestamp:Date.now(),source:{type:'user',userId:user}}]});
  const signed=()=>new Request('https://example.com/line-goodfilm-intake',{method:'POST',body:raw,headers:{'x-goodcrm-signature':crypto.createHmac('sha256',config.LINE_GOODFILM_BRIDGE_SECRET).update(raw).digest('base64')}});
  assert.equal((await handler(request(raw))).status,401);
  assert.equal((await handler(signed())).status,200);
  assert.equal(calls[0][0],'gfs-line-095jvuls');
  config.LINE_GOODFILM_BOT_USER_ID='U'+'c'.repeat(32);
  assert.equal((await handler(signed())).status,400);
  assert.equal(calls.length,1);
  config.LINE_GOODFILM_INTAKE_ENABLED='false';
  assert.equal((await handler(signed())).status,503);
});
function request(body, signature=true) {
  const raw=typeof body==='string'?body:JSON.stringify(body);
  return new Request('https://example.com/functions/v1/line-gfs-intake',{method:'POST',headers:{'x-line-signature':signature?crypto.createHmac('sha256',env.LINE_GFS_CHANNEL_SECRET).update(raw).digest('base64'):'bad'},body:raw});
}
test('cloud handler rejects unsigned requests and persists only verified metadata',async()=>{
  const {createHandler}=await import('./supabase/functions/line-gfs-intake/handler.mjs');
  const calls=[];
  const handler=createHandler({getEnv:n=>env[n],persist:async(...args)=>calls.push(args)});
  const body={destination,events:[{type:'message',webhookEventId:'evt-1',timestamp:Date.now(),source:{type:'user',userId:user},message:{text:'private text'}}]};
  assert.equal((await handler(request(body,false))).status,401);
  assert.equal(calls.length,0);
  assert.equal((await handler(request({...body,destination:'wrong'}))).status,400);
  assert.equal((await handler(request(body))).status,200);
  assert.equal(calls.length,1);
  assert.equal(JSON.stringify(calls).includes('private text'),false);
  assert.equal((await handler(request('x'.repeat(262145)))).status,413);
});
test('cloud receipt fails closed when unconfigured or database fails; health never contains secrets',async()=>{
  const {createHandler}=await import('./supabase/functions/line-gfs-intake/handler.mjs');
  const disabled=createHandler({getEnv:()=>undefined,persist:async()=>assert.fail('unexpected write')});
  assert.equal((await disabled(request({}))).status,503);
  const health=await disabled(new Request('https://example.com/line-gfs-intake/health'));
  assert.deepEqual(await health.json(),{configured:false,account:'@249izgyn'});
  const failed=createHandler({getEnv:n=>env[n],persist:async()=>{throw new Error('db')}});
  const actual={destination,events:[{type:'message',webhookEventId:'evt-2',timestamp:Date.now(),source:{type:'user',userId:user}}]};
  assert.equal((await failed(request(actual))).status,503);
});
test('cloud handler uses verified bot identity and fails closed on token mismatch',async()=>{
  const {createHandler}=await import('./supabase/functions/line-gfs-intake/handler.mjs');
  let calls=0;
  const failed=createHandler({getEnv:n=>n==='LINE_GFS_BOT_USER_ID'?undefined:env[n],persist:async()=>{calls++},resolveDestination:async()=>{throw new Error('wrong account')}});
  assert.equal((await failed(request({destination,events:[]}))).status,503);
  assert.equal(calls,0);
  const verified=createHandler({getEnv:n=>n==='LINE_GFS_BOT_USER_ID'?undefined:env[n],persist:async()=>{calls++},resolveDestination:async()=>destination});
  assert.equal((await verified(request({destination,events:[]}))).status,200);
  assert.equal(calls,0);
});
