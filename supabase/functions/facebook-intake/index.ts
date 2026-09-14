import {createHandler,PAGES} from './handler.mjs';
const url=Deno.env.get('SUPABASE_URL')!;
const key=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const headers={apikey:key,...(key?.startsWith('eyJ')?{Authorization:`Bearer ${key}`} : {}),'Content-Type':'application/json'};
Deno.serve(createHandler({
 getEnv:(name:string)=>Deno.env.get(name),
 persist:async(account:string,events:unknown[])=>{
  const response=await fetch(`${url}/rest/v1/rpc/receive_facebook_intake`,{method:'POST',headers,body:JSON.stringify({p_account:account,p_events:events}),signal:AbortSignal.timeout(5000)});
  if(!response.ok) throw new Error('Storage failed');
 },
 background:(promise:Promise<void>)=>EdgeRuntime.waitUntil(promise),
 enrich:async(page:string,users:string[])=>{
  const token=Deno.env.get('FACEBOOK_PAGE_TOKEN_'+page);
  if(!token) return;
  for(const user of users) {
   try {
    const response=await fetch(`https://graph.facebook.com/v25.0/${user}?fields=first_name,last_name`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(2500)});
    if(!response.ok) continue;
    const profile=await response.json();
    const name=[profile.first_name,profile.last_name].filter(v=>typeof v==='string').join(' ').trim().slice(0,200);
    if(!name) continue;
    await fetch(`${url}/rest/v1/facebook_intake_contacts?account_key=eq.${PAGES[page]}&facebook_user_id=eq.${user}`,{method:'PATCH',headers,body:JSON.stringify({display_name:name}),signal:AbortSignal.timeout(5000)});
   } catch { /* Keep the Page-scoped ID when profile permissions are unavailable. */ }
  }
 }
}));
