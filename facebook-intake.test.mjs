import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createHandler,parseEvents} from './supabase/functions/facebook-intake/handler.mjs';
import {createProfiles,lookupConversationName} from './supabase/functions/facebook-intake/profiles.mjs';
import facebookIntake from './facebook-intake.js';
const page='125106670932394', user='123456789012345';
const payload=()=>({object:'page',entry:[{id:page,messaging:[{sender:{id:user},recipient:{id:page},timestamp:Date.now(),message:{mid:'test-event',text:'private message'}}]}]});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});
const profileSettings={url:'https://database.example',headers:{apikey:'server-key'},getEnv:name=>name==='FACEBOOK_INTAKE_ENABLED'?'true':'page-secret'};

test('Facebook cancels an oversized streamed body without buffering the rest',async()=>{
 let pulled=0,cancelled=false;
 const stream=new ReadableStream({pull(controller){pulled++;controller.enqueue(new Uint8Array(262144));},cancel(){cancelled=true;}},{highWaterMark:0});
 const handler=createHandler({getEnv:name=>name==='FACEBOOK_INTAKE_ENABLED'?'true':'synthetic-secret',persist:async()=>assert.fail('oversize body must not persist')});
 const response=await handler(new Request('https://local.example/webhook',{method:'POST',body:stream,duplex:'half'}));
 assert.equal(response.status,413);assert.equal(cancelled,true);assert.equal(pulled,5);
});

test('Facebook names use the correct page token and update only its matching contact',async()=>{
 const requests=[];
 const profiles=createProfiles({...profileSettings,fetchImpl:async(url,options)=>{
  requests.push({url,options});
  return url.startsWith('https://graph.facebook.com') ? json({first_name:'ชื่อ',last_name:'เฟซบุ๊ก'}) : json([{id:'contact'}]);
 }});
 const result=await profiles.enrich(page,[user]);
 assert.equal(result.updated,1);
 assert.equal(requests[0].options.headers.Authorization,'Bearer page-secret');
 assert.equal(requests[1].options.method,'PATCH');
 assert.match(requests[1].url,new RegExp('account_key=eq.gfs-fb-'+page));
 assert.match(requests[1].url,new RegExp('facebook_user_id=eq.'+user));
 assert.deepEqual(JSON.parse(requests[1].options.body),{display_name:'ชื่อ เฟซบุ๊ก'});
});

test('Facebook profile failures preserve contacts and never expose Graph error messages or tokens',async()=>{
 for(const [code,reason] of [[190,'token-expired'],[3,'permission-denied'],[10,'permission-denied'],[100,'profile-unavailable'],[613,'rate-limited']]) {
  let calls=0;
  const profiles=createProfiles({...profileSettings,fetchImpl:async()=>{calls++;return json({error:{code,message:'private page-secret'}},400);}});
  const result=await profiles.enrich(page,[user]);
  assert.equal(calls,[3,10,100].includes(code)?2:1);assert.equal(result.updated,0);assert.equal(result.failures[reason],1);
  assert.equal(JSON.stringify(result).includes('page-secret'),false);
 }
});

test('Conversation fallback matches both the Page and exact sender, never participant order',async()=>{
 const request=async people=>lookupConversationName(page,user,'secret',async endpoint=>{
  const url=new URL(endpoint);assert.equal(url.searchParams.get('user_id'),user);
  assert.equal(url.searchParams.get('fields'),'participants{id,name}');
  return json({data:[{participants:{data:people}}]});
 });
 assert.deepEqual(await request([{id:page,name:'Page name'},{id:user,name:'Actual Facebook name'}]),{name:'Actual Facebook name'});
 assert.equal((await request([{id:page,name:'Page name'},{id:'999999',name:'Wrong person'}])).name,undefined);
 assert.equal((await request([{id:'999999',name:'Wrong page'},{id:user,name:'Wrong context'}])).name,undefined);
});

test('Profile denial recovers the actual conversation name without overwriting a concurrent name',async()=>{
 let patched=false;
 const profiles=createProfiles({...profileSettings,fetchImpl:async(endpoint,options)=>{
  if(endpoint.includes('/conversations?')) return json({data:[{participants:{data:[{id:page,name:'Page'},{id:user,name:'Actual name'}]}}]});
  if(endpoint.startsWith('https://graph.facebook.com')) return json({error:{code:100}},400);
  assert.match(endpoint,/facebook_user_id=eq\.123456789012345/);assert.match(endpoint,/or=\(display_name.is.null,display_name.eq.\)/);
  assert.deepEqual(JSON.parse(options.body),{display_name:'Actual name'});patched=true;return json([{id:'contact'}]);
 }});
 assert.deepEqual(await profiles.enrich(page,[user],profileSettings.headers,true),{requested:1,updated:1,failures:{}});
 assert.equal(patched,true);
});

test('Facebook profile storage failures are not reported as successful names',async()=>{
 const profiles=createProfiles({...profileSettings,fetchImpl:async url=>url.startsWith('https://graph.facebook.com')?json({first_name:'Name'}):json({},403)});
 const result=await profiles.enrich(page,[user]);
 assert.equal(result.updated,0);assert.equal(result.failures['storage-unavailable'],1);
});

function refreshRequest(input={account:'gfs-fb-'+page,users:[user]},authorization='Bearer user-session') {
 return new Request('https://example.com/profiles/refresh',{method:'POST',headers:{Authorization:authorization},body:JSON.stringify(input)});
}

test('Facebook name refresh rejects anonymous, invalid and ungranted sessions before reading contacts',async()=>{
 let calls=0;
 let profiles=createProfiles({...profileSettings,fetchImpl:async()=>{calls++;return json({},401);}});
 assert.equal((await profiles.refresh(refreshRequest(undefined,''))).status,401);assert.equal(calls,0);
 assert.equal((await profiles.refresh(refreshRequest())).status,401);assert.equal(calls,1);
 profiles=createProfiles({...profileSettings,fetchImpl:async url=>url.includes('/auth/v1/user')?json({id:'user-id'}):json([])});
 assert.equal((await profiles.refresh(refreshRequest())).status,403);
});

test('Facebook refresh uses authenticated RLS, skips named contacts, and guards concurrent writes',async()=>{
 const calls=[];
 const profiles=createProfiles({...profileSettings,fetchImpl:async(url,options)=>{
  calls.push({url,options});
  if(url.includes('/auth/v1/user')) return json({id:'admin-id'});
  if(url.includes('/rpc/get_current_crm_intake_permissions')) return json({facebook:{view:true,manage:true,accounts:{['gfs-fb-'+page]:{view:true,manage:true}}}});
  if(url.includes('/me?fields=id')) return json({id:page});
  if(url.startsWith('https://graph.facebook.com')) return json({first_name:'FB',last_name:'Name'});
  if(options.method==='PATCH') return json([{id:'contact'}]);
  return json([{facebook_user_id:user}]);
 }});
 const response=await profiles.refresh(refreshRequest({account:'gfs-fb-'+page,users:[user,'987654321']}));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{success:true,requested:1,updated:1,failures:{}});
 const database=calls.filter(call=>call.url.includes('/facebook_intake_contacts?'));
 assert.equal(database.length,2);
 for(const call of database) {
  assert.equal(call.options.headers.Authorization,'Bearer user-session');
  assert.match(call.url,/or=\(display_name.is.null,display_name.eq.\)/);
 }
 assert.equal(calls.filter(call=>call.url.startsWith('https://graph.facebook.com')).length,2);
});

test('Facebook refresh validates page and bounded user IDs before Graph lookup',async()=>{
 let calls=0;
 const profiles=createProfiles({...profileSettings,fetchImpl:async url=>{calls++;return url.includes('/auth/v1/user')?json({id:'admin-id'}):json({facebook:{view:true,manage:true,accounts:{['gfs-fb-'+page]:{view:true,manage:true}}}});}});
 for(const input of [{account:'untrusted',users:[user]},{account:'gfs-fb-'+page,users:['1&other=eq.x']},{account:'gfs-fb-'+page,users:Array(31).fill(user)}]) {
  calls=0;assert.equal((await profiles.refresh(refreshRequest(input))).status,400);assert.equal(calls,1);
 }
});

test('Facebook refresh refuses a token belonging to another page before profile lookup',async()=>{
 const calls=[];
 const profiles=createProfiles({...profileSettings,fetchImpl:async url=>{
  calls.push(url);
  if(url.includes('/auth/v1/user')) return json({id:'admin-id'});
  if(url.includes('/rpc/get_current_crm_intake_permissions')) return json({facebook:{view:true,manage:true,accounts:{['gfs-fb-'+page]:{view:true,manage:true}}}});
  if(url.includes('/me?fields=id')) return json({id:'101634951180913'});
  return json([{facebook_user_id:user}]);
 }});
 const result=await (await profiles.refresh(refreshRequest())).json();
 assert.equal(result.updated,0);assert.equal(result.failures['wrong-page-token'],1);
 assert.equal(calls.filter(url=>url.startsWith('https://graph.facebook.com')).length,1);
});

test('Facebook CRM name refresh requires active manage access and forwards only selected identifiers',async()=>{
 let calls=0;
 const fetchImpl=async(url,options)=>{calls++;assert.equal(options.headers.Authorization,'Bearer session');assert.deepEqual(JSON.parse(options.body),{account:'gfs-fb-'+page,users:[user]});return json({success:true});};
 const input={account:'gfs-fb-'+page,users:[user],extra:'not-forwarded'};
 await assert.rejects(()=>facebookIntake.refreshNames({role:'sales',is_active:true},input,'Bearer session',fetchImpl));
 assert.equal(calls,0);
 await assert.rejects(()=>facebookIntake.refreshNames({role:'admin',is_active:false},input,'Bearer session',fetchImpl));
 assert.equal(calls,0);
 assert.deepEqual(await facebookIntake.refreshNames({role:'admin',is_active:true},input,'Bearer session',fetchImpl),{success:true});
 assert.deepEqual(await facebookIntake.refreshNames({role:'sales',is_active:true,intakePermissions:{facebook:{manage:true}}},input,'Bearer session',fetchImpl),{success:true});
});

test('Facebook Edge refresh trusts fresh caller-scoped grants and fails closed before Graph or contacts',async()=>{
 for(const [grants,status] of [[{facebook:{view:true}},403],[{instagram:{manage:true}},403],[{facebook:{manage:'true'}},403],[{facebook:{manage:true}},403],[{facebook:{manage:true,accounts:{['gfs-fb-'+page]:{view:true}}}},403],[{facebook:{accounts:{'gfs-fb-101634951180913':{manage:true}}}},403],[{facebook:{accounts:{['gfs-fb-'+page]:{manage:true}}}},200],[null,503]]) {
  const calls=[];
  const profiles=createProfiles({...profileSettings,fetchImpl:async(url,options)=>{
   calls.push(url);
   if(url.includes('/auth/v1/user')) return json({id:'delegated-user'});
   assert.match(url,/\/rpc\/get_current_crm_intake_permissions$/);
   assert.equal(options.method,'POST');assert.equal(options.body,'{}');assert.equal(options.headers.Authorization,'Bearer user-session');
   return json(grants,grants===null?503:200);
  }});
  const request=refreshRequest({account:'gfs-fb-'+page,users:[],intakePermissions:{facebook:{manage:true}}});
  assert.equal((await profiles.refresh(request)).status,status);assert.equal(calls.length,2);
 }
});
test('Facebook parser isolates pages, strips content and excludes outbound echoes',()=>{
 const b=payload();b.entry[0].messaging.push({...b.entry[0].messaging[0],message:{mid:'echo',is_echo:true}});
 b.entry.push({id:'999999',messaging:b.entry[0].messaging});
 const groups=parseEvents(b);assert.equal(groups.size,1);assert.equal(groups.get(page).length,1);assert.equal(JSON.stringify([...groups]).includes('private'),false);
 b.entry[0].messaging[0].recipient.id='111111';assert.throws(()=>parseEvents(b));
});
test('Facebook webhook requires correct raw-body HMAC and durable storage',async()=>{
 const env={FACEBOOK_APP_SECRET:'test-secret',FACEBOOK_VERIFY_TOKEN:'test-verify',FACEBOOK_INTAKE_ENABLED:'true'};
 let calls=0,fail=false;
 const h=createHandler({getEnv:n=>env[n],persist:async(account,events)=>{calls++;assert.equal(account,'gfs-fb-'+page);assert.equal(events[0].userId,user);if(fail)throw Error();}});
 const raw=JSON.stringify(payload());const sig='sha256='+createHmac('sha256',env.FACEBOOK_APP_SECRET).update(raw).digest('hex');
 const req=(body=raw,signature=sig)=>new Request('https://example.com/facebook-intake',{method:'POST',body,headers:{'x-hub-signature-256':signature}});
 assert.equal((await h(req(raw,'bad'))).status,401);assert.equal(calls,0);
 assert.equal((await h(req(raw+' '))).status,401);
 assert.equal((await h(req())).status,200);assert.equal(calls,1);
 fail=true;assert.equal((await h(req())).status,503);
 env.FACEBOOK_INTAKE_ENABLED='false';assert.equal((await h(req())).status,503);
 assert.equal((await h(new Request('https://example.com?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=123'))).status,403);
 assert.equal(await (await h(new Request('https://example.com?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=123'))).text(),'123');
});

test('Facebook standby messages reach the correct MHL/CAR accounts with normal messaging in the same batch',async()=>{
 const env={FACEBOOK_APP_SECRET:'standby-test-secret',FACEBOOK_INTAKE_ENABLED:'true'};
 const b=payload();
 for(const pageId of ['101634951180913','109607531869658']) {
  const event={sender:{id:user},recipient:{id:pageId},timestamp:Date.now(),message:{mid:'standby-'+pageId,text:'private standby text'}};
  b.entry.push({id:pageId,standby:[event,{...event,sender:{id:pageId},recipient:{id:user},message:{mid:'outbound',is_echo:true}},{sender:{id:user},recipient:{id:pageId},read:{watermark:Date.now()}}]});
 }
 const saved=[];
 const h=createHandler({getEnv:n=>env[n],persist:async(account,events)=>saved.push({account,events})});
 const raw=JSON.stringify(b);
 const signature='sha256='+createHmac('sha256',env.FACEBOOK_APP_SECRET).update(raw).digest('hex');
 const request=sig=>new Request('https://example.com/facebook-intake',{method:'POST',body:raw,headers:{'x-hub-signature-256':sig}});
 assert.equal((await h(request('sha256'+'=0'.padEnd(65,'0')))).status,401);
 assert.equal(saved.length,0);
 assert.equal((await h(request(signature))).status,200);
 assert.deepEqual(saved.map(r=>r.account),['gfs-fb-125106670932394','gfs-fb-101634951180913','mhl-fb-109607531869658']);
 assert.deepEqual(saved.map(r=>r.events.length),[1,1,1]);
 assert.equal(JSON.stringify(saved).includes('private'),false);
 assert.equal(saved[1].events[0].eventId,'standby-101634951180913');
});

test('Facebook validates standby recipients, timestamps and bounds just like normal inbound messages',()=>{
 const b=payload();b.entry[0].standby=b.entry[0].messaging;delete b.entry[0].messaging;
 assert.equal(parseEvents(b).get(page).length,1);
 b.entry[0].standby[0].recipient.id='101634951180913';assert.throws(()=>parseEvents(b));
 b.entry[0].standby[0].recipient.id=page;
 b.entry[0].standby[0].timestamp=Date.now()+600000;assert.throws(()=>parseEvents(b));
 b.entry[0].standby=Array(101).fill({});assert.throws(()=>parseEvents(b));
 b.entry[0].standby={};assert.throws(()=>parseEvents(b));
 b.entry[0].messaging=payload().entry[0].messaging;assert.throws(()=>parseEvents(b));
 b.entry[0].standby=[];assert.equal(parseEvents(b).get(page).length,1);
 b.entry[0].messaging=[];b.entry[0].standby=[{read:{watermark:Date.now()}}];assert.equal(parseEvents(b).size,0);
});
