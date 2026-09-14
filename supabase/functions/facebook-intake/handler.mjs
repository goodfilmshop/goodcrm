export const PAGES = Object.freeze({'125106670932394':'gfs-fb-125106670932394','101634951180913':'gfs-fb-101634951180913','109607531869658':'mhl-fb-109607531869658'});
export function parseEvents(body, now=Date.now()) {
  if (body?.object !== 'page' || !Array.isArray(body.entry) || body.entry.length > 100) throw new Error('Invalid envelope');
  const groups = new Map(); let count=0;
  for (const entry of body.entry) {
    if (!Object.hasOwn(PAGES,entry?.id)) continue;
    if (!Array.isArray(entry.messaging) || entry.messaging.length>100) throw new Error('Invalid messages');
    for (const event of entry.messaging) {
      if (!event?.message || event.message.is_echo) continue;
      if (++count>1000 || event.recipient?.id!==entry.id || !/^[0-9]{5,30}$/.test(event.sender?.id||'') || typeof event.message.mid!=='string' || !event.message.mid || event.message.mid.length>512 || !Number.isSafeInteger(event.timestamp) || event.timestamp<0 || event.timestamp>now+300000) throw new Error('Invalid event');
      if (!groups.has(entry.id)) groups.set(entry.id,[]);
      groups.get(entry.id).push({eventId:event.message.mid,userId:event.sender.id,at:new Date(event.timestamp).toISOString()});
    }
  }
  return groups;
}
export function createHandler({getEnv,persist,enrich=async()=>{},background=()=>{}}) {
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  return async request=>{
    const url=new URL(request.url);
    const secret=getEnv('FACEBOOK_APP_SECRET');
    const verify=getEnv('FACEBOOK_VERIFY_TOKEN');
    const enabled=getEnv('FACEBOOK_INTAKE_ENABLED')==='true';
    if(request.method==='GET' && url.pathname.endsWith('/health')) return reply({configured:Boolean(secret&&verify&&enabled),pages:Object.keys(PAGES)});
    if(request.method==='GET') {
      if(!verify || url.searchParams.get('hub.mode')!=='subscribe' || url.searchParams.get('hub.verify_token')!==verify) return reply({error:'Forbidden'},403);
      const challenge=url.searchParams.get('hub.challenge');
      return challenge && challenge.length<=256 ? new Response(challenge,{headers:{'Cache-Control':'no-store'}}):reply({error:'Invalid challenge'},400);
    }
    if(request.method!=='POST') return reply({error:'Method not allowed'},405);
    if(!secret||!enabled) return reply({error:'Not configured'},503);
    if(Number(request.headers.get('content-length'))>1048576) return reply({error:'Too large'},413);
    const raw=new Uint8Array(await request.arrayBuffer());
    if(raw.length>1048576) return reply({error:'Too large'},413);
    const signature=request.headers.get('x-hub-signature-256')||'';
    if(!/^sha256=[a-f0-9]{64}$/.test(signature)) return reply({error:'Unauthorized'},401);
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    const bytes=Uint8Array.from(signature.slice(7).match(/../g),v=>parseInt(v,16));
    if(!await crypto.subtle.verify('HMAC',key,bytes,raw)) return reply({error:'Unauthorized'},401);
    let groups;
    try { groups=parseEvents(JSON.parse(new TextDecoder().decode(raw))); } catch {return reply({error:'Invalid payload'},400);}
    try {for(const [page,events] of groups) await persist(PAGES[page],events);} catch {return reply({error:'Storage unavailable'},503);}
    for(const [page,events] of groups) background(enrich(page,[...new Set(events.map(e=>e.userId))]).catch(()=>{}));
    return reply({received:true});
  };
}
