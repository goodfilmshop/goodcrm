import { PAGES } from './handler.mjs';

// Never return Graph messages: they can contain request data or credentials.
export function profileFailure(error) {
  if (error?.code === 190) return 'token-expired';
  if (error?.code === 100 && /nonexisting field|non-existent field/i.test(error?.message || '')) return 'unsupported-profile-fields';
  if ([3, 10, 200].includes(error?.code) || error?.error_subcode === 2018247) return 'permission-denied';
  if (error?.code === 100) return 'profile-unavailable';
  if ([4, 17, 32, 613].includes(error?.code)) return 'rate-limited';
  return 'meta-unavailable';
}

// Conversations already authorized for this Page expose participant names even
// when the separate User Profile API is unavailable. Match the exact PSID and
// Page, never the first participant or an unverified client-supplied name.
export async function lookupConversationName(page, user, token, fetchImpl = fetch) {
  const endpoint = new URL(`https://graph.facebook.com/v25.0/${page}/conversations`);
  endpoint.searchParams.set('platform', 'messenger');
  endpoint.searchParams.set('user_id', user);
  endpoint.searchParams.set('fields', 'participants{id,name}');
  endpoint.searchParams.set('limit', '5');
  const response = await fetchImpl(endpoint.toString(), {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) return { reason: profileFailure(payload.error) };
  const names = new Set();
  for (const thread of Array.isArray(payload.data) ? payload.data : []) {
    const people = thread?.participants?.data;
    if (!Array.isArray(people) || !people.some(person => person.id === page)) continue;
    for (const person of people) {
      if (person.id === user && typeof person.name === 'string' && person.name.trim()) names.add(person.name.trim().slice(0, 200));
    }
  }
  return names.size === 1 ? { name: [...names][0] } : { reason: 'name-unavailable' };
}

export function createProfiles({ getEnv, url, headers, fetchImpl = fetch }) {
  async function enrich(page, users, writeHeaders = headers, onlyMissing = false) {
    if (!Object.hasOwn(PAGES, page)) throw new Error('Invalid page');
    const token = getEnv('FACEBOOK_PAGE_TOKEN_' + page);
    const result = { requested: users.length, updated: 0, failures: {} };
    const fail = reason => { result.failures[reason] = (result.failures[reason] || 0) + 1; };
    if (!token) { result.failures['token-missing'] = users.length; return result; }
    // Bound concurrency so large webhook batches do not exhaust the runtime.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, users.length) }, async () => {
      while (next < users.length) {
        const user = users[next++];
        if (!/^[0-9]{5,30}$/.test(user)) { fail('invalid-user'); continue; }
        try {
          const response = await fetchImpl(`https://graph.facebook.com/v25.0/${user}?fields=first_name,last_name`, {
            headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000),
          });
          const profile = await response.json();
          let reason = !response.ok || profile.error ? profileFailure(profile.error) : 'name-unavailable';
          let name = !response.ok || profile.error ? '' : [profile.first_name, profile.last_name].filter(v => typeof v === 'string').join(' ').trim().slice(0, 200);
          if (!name && ['permission-denied','profile-unavailable','name-unavailable','unsupported-profile-fields'].includes(reason)) {
            const fallback = await lookupConversationName(page, user, token, fetchImpl);
            name = fallback.name || '';
            reason = fallback.reason || reason;
          }
          if (!name) { fail(reason); continue; }
          const filter = onlyMissing ? '&or=(display_name.is.null,display_name.eq.)' : '';
          const saved = await fetchImpl(`${url}/rest/v1/facebook_intake_contacts?account_key=eq.${PAGES[page]}&facebook_user_id=eq.${user}${filter}&select=id`, {
            method: 'PATCH', headers: { ...writeHeaders, Prefer: 'return=representation' },
            body: JSON.stringify({ display_name: name }), signal: AbortSignal.timeout(5000),
          });
          if (!saved.ok) { fail('storage-unavailable'); continue; }
          result.updated += (await saved.json()).length;
        } catch { fail('connection-failed'); }
      }
    }));
    return result;
  }

  async function refresh(request) {
    const reply = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
    if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
    const authorization = request.headers.get('Authorization') || '';
    if (!/^Bearer \S+$/.test(authorization)) return reply({ error: 'Unauthorized' }, 401);
    const userHeaders = { ...headers, Authorization: authorization };
    try {
      const auth = await fetchImpl(`${url}/auth/v1/user`, { headers: userHeaders, signal: AbortSignal.timeout(5000) });
      if (!auth.ok) return reply({ error: 'Unauthorized' }, 401);
      const user = await auth.json();
      if (!user.id) return reply({ error: 'Unauthorized' }, 401);
      const raw = await request.text();
      if (raw.length > 8192) return reply({ error: 'Too large' }, 413);
      let input;
      try { input = JSON.parse(raw); } catch { return reply({ error: 'Invalid request' }, 400); }
      const page = Object.keys(PAGES).find(id => PAGES[id] === input?.account);
      if (!page || !Array.isArray(input.users) || input.users.length > 30 || input.users.some(id => typeof id !== 'string' || !/^[0-9]{5,30}$/.test(id))) return reply({ error: 'Invalid request' }, 400);
      // Read fresh grants with the caller's JWT; the RPC enforces active membership.
      const permissions = await fetchImpl(`${url}/rest/v1/rpc/get_current_crm_intake_permissions`, {
        method: 'POST', headers: { ...userHeaders, 'Content-Type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(5000),
      });
      if (!permissions.ok) return reply({ error: 'Permissions unavailable' }, 503);
      if ((await permissions.json())?.facebook?.accounts?.[input.account]?.manage !== true) return reply({ error: 'Forbidden' }, 403);
      if (getEnv('FACEBOOK_INTAKE_ENABLED') !== 'true') return reply({ error: 'Not configured' }, 503);
      if (!input.users.length) return reply({ success: true, requested: 0, updated: 0, failures: {} });
      // RLS plus account/user filters prevent touching contacts outside this page.
      const contacts = await fetchImpl(`${url}/rest/v1/facebook_intake_contacts?account_key=eq.${PAGES[page]}&facebook_user_id=in.(${[...new Set(input.users)].join(',')})&or=(display_name.is.null,display_name.eq.)&select=facebook_user_id&limit=30`, { headers: userHeaders, signal: AbortSignal.timeout(5000) });
      if (!contacts.ok) return reply({ error: 'Storage unavailable' }, 503);
      const rows = await contacts.json();
      const token = getEnv('FACEBOOK_PAGE_TOKEN_' + page);
      if (token && rows.length) {
        const identityResponse = await fetchImpl('https://graph.facebook.com/v25.0/me?fields=id', { headers:{Authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(4000) });
        const identity = await identityResponse.json();
        const problem = !identityResponse.ok || identity.error ? profileFailure(identity.error) : identity.id !== page ? 'wrong-page-token' : null;
        if (problem) return reply({ success:true, requested:rows.length, updated:0, failures:{[problem]:rows.length} });
      }
      return reply({ success: true, ...await enrich(page, rows.map(row => row.facebook_user_id), userHeaders, true) });
    } catch { return reply({ error: 'Service unavailable' }, 503); }
  }
  return { enrich, refresh };
}
