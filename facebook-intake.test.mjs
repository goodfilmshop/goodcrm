import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createHandler,parseEvents} from './supabase/functions/facebook-intake/handler.mjs';
const page='125106670932394', user='123456789012345';
const payload=()=>({object:'page',entry:[{id:page,messaging:[{sender:{id:user},recipient:{id:page},timestamp:Date.now(),message:{mid:'test-event',text:'private message'}}]}]});
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
