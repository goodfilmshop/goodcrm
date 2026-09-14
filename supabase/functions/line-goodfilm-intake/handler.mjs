const ACCOUNT = 'gfs-line-095jvuls';
const MAX_BYTES = 256 * 1024;
const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function verifySignature(raw, signature, secret) {
  if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(signature || '')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(signature), c => c.charCodeAt(0)), raw);
}

async function limitedBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) throw new Error('too-large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('too-large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  return raw;
}

export function createHandler({ getEnv, persist, resolveDestination, enrich = async () => {}, background = () => {} }) {
  return async request => {
    const secret = getEnv('LINE_GOODFILM_BRIDGE_SECRET');
    let destination = getEnv('LINE_GOODFILM_BOT_USER_ID');
    if (!destination && resolveDestination && secret && getEnv('LINE_GOODFILM_INTAKE_ENABLED') === 'true') {
      try { destination = await resolveDestination(); } catch { destination = undefined; }
    }
    const configured = getEnv('LINE_GOODFILM_INTAKE_ENABLED') === 'true' && Boolean(secret) && /^U[0-9a-f]{32}$/.test(destination || '');
    if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/health')) return reply(200, {configured, account:'@095jvuls', ...(configured ? {botUserId:destination} : {})});
    if (request.method !== 'POST') return reply(405, {error:'Method not allowed'});
    if (!configured) return reply(503, {error:'Intake not configured'});
    let raw;
    try { raw = await limitedBody(request); } catch { return reply(413,{error:'Payload too large'}); }
    if (!await verifySignature(raw,request.headers.get('x-goodcrm-signature'),secret)) return reply(401,{error:'Invalid signature'});
    let events;
    try {
      const body = JSON.parse(new TextDecoder().decode(raw));
      if (body.destination !== destination || !Array.isArray(body.events) || body.events.length > 100) throw new Error();
      events = body.events.filter(e => e?.type === 'message' && e.source?.type === 'user').map(e => {
        if (!/^U[0-9a-f]{32}$/.test(e.source.userId || '') || typeof e.webhookEventId !== 'string' || !e.webhookEventId || e.webhookEventId.length > 128 || !Number.isSafeInteger(e.timestamp) || e.timestamp < 0 || e.timestamp > Date.now()+300000) throw new Error();
        return {eventId:e.webhookEventId,userId:e.source.userId,at:new Date(e.timestamp).toISOString()};
      });
    } catch { return reply(400,{error:'Invalid LINE event'}); }
    if (events.length === 0) return reply(200,{received:true});
    try {
      await persist(ACCOUNT,events);
    } catch { return reply(503,{error:'Persistence unavailable'}); }
    // Profile enrichment never prevents durable receipt or causes message retries.
    background(enrich(ACCOUNT,[...new Set(events.map(e => e.userId))]).catch(() => {}));
    return reply(200,{received:true});
  };
}
