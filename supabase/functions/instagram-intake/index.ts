import {createHandler} from './handler.mjs';
import {createProfiles} from './profiles.mjs';
const url=Deno.env.get('SUPABASE_URL')!;
const key=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const headers={apikey:key,...(key?.startsWith('eyJ')?{Authorization:`Bearer ${key}`} : {}),'Content-Type':'application/json'};
const profiles=createProfiles({getEnv:(name:string)=>Deno.env.get(name),url,headers});
const webhook=createHandler({
 getEnv:(name:string)=>Deno.env.get(name),
 persist:async(account:string,events:unknown[])=>{
  const response=await fetch(`${url}/rest/v1/rpc/receive_instagram_intake`,{method:'POST',headers,body:JSON.stringify({p_account:account,p_events:events}),signal:AbortSignal.timeout(5000)});
  if(!response.ok) throw new Error('Storage failed');
 },
 background:(promise:Promise<void>)=>EdgeRuntime.waitUntil(promise),
 enrich:async(page:string,users:string[])=>{
  const result=await profiles.enrich(page,users);
  if(Object.keys(result.failures).length) console.warn('Instagram profile lookup',JSON.stringify({page,failures:result.failures}));
 }
});
Deno.serve((request:Request)=>new URL(request.url).pathname.endsWith('/profiles/refresh') ? profiles.refresh(request) : webhook(request));
