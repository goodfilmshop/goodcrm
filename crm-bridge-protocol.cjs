const crypto = require('node:crypto');

function validSecret(secret) { return typeof secret === 'string' && secret.length >= 32; }
function signature(secret, method, target, timestamp, nonce, body) {
  const parts=[method,target,timestamp,nonce];
  if(method==='POST')parts.push(crypto.createHash('sha256').update(body).digest('hex'));
  return crypto.createHmac('sha256', secret).update(parts.join('\n')).digest('hex');
}
function sign(secret, target, {method='GET',body=''}={}) {
  if (!validSecret(secret)) throw new Error('CRM bridge is not configured');
  if(!['GET','POST'].includes(method))throw new Error('Unsupported bridge method');
  const timestamp = String(Date.now()), nonce = crypto.randomBytes(24).toString('hex');
  return { 'x-crm-time': timestamp, 'x-crm-nonce': nonce, 'x-crm-signature': signature(secret, method, target, timestamp, nonce,body) };
}
function verifier(secret,{method='GET'}={}) {
  const seen = new Map();
  return req => {
    if (!validSecret(secret) || req.method !== method || !['GET','POST'].includes(method)) return false;
    if(method==='POST'&&!Buffer.isBuffer(req.body))return false;
    const timestamp = req.headers['x-crm-time'], nonce = req.headers['x-crm-nonce'], supplied = req.headers['x-crm-signature'];
    const now = Date.now();
    if (!/^\d{13}$/.test(timestamp || '') || Math.abs(now - Number(timestamp)) > 60000 || !/^[a-f0-9]{48}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(supplied || '')) return false;
    for (const [key, until] of seen) if (until < now) seen.delete(key);
    if (seen.has(nonce) || seen.size >= 10000) return false;
    const expected = signature(secret, method, req.originalUrl || req.url, timestamp, nonce,req.body);
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))) return false;
    seen.set(nonce, now + 120000);
    return true;
  };
}
function endpoint(base, target) {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('CRM bridge requires an HTTPS origin');
  }
  return new URL(target, url);
}
async function request(base, secret, target, fetchImpl = fetch, {timeout=15000,signal}={}) {
  const response = await fetchImpl(endpoint(base, target), { headers: sign(secret, target), redirect: 'error', signal: signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout) });
  if (!response.ok) throw Object.assign(new Error('ไม่สามารถอ่านข้อมูลจากระบบที่เชื่อมต่อได้'), { status: response.status === 404 ? 404 : 503 });
  return response;
}
async function post(base,secret,target,data,fetchImpl=fetch,{signal}={}){
  const body=JSON.stringify(data);
  const response=await fetchImpl(endpoint(base,target),{method:'POST',headers:{...sign(secret,target,{method:'POST',body}),'Content-Type':'application/json'},body,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  if(!response.ok)throw Object.assign(new Error('Bridge response rejected'),{status:response.status});
  return response;
}
module.exports = { validSecret, sign, verifier, endpoint, request,post };
