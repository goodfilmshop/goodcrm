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

export function createProfiles({ getEnv, url, headers, fetchImpl = fetch }) {
  async function enrich(page, users, writeHeaders = headers, onlyMissing = false) {
    if (!Object.hasOwn(PAGES, page)) throw new Error('Invalid page');
    const token = getEnv('INSTAGRAM_PAGE_TOKEN_' + page);
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
          const response = await fetchImpl(`https://graph.facebook.com/v25.0/${user}?fields=name,username`, {
            headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000),
          });
          const profile = await response.json();
          if (!response.ok || profile.error) { fail(profileFailure(profile.error)); continue; }
          const username = typeof profile.username === 'string' ? profile.username.trim().slice(0,100) : '';
          const name = (typeof profile.name === 'string' ? profile.name.trim() : username).slice(0,200);
          if (!name && !username) { fail('name-unavailable'); continue; }
          const filter = onlyMissing ? '&or=(display_name.is.null,display_name.eq.)' : '';
          const saved = await fetchImpl(`${url}/rest/v1/instagram_intake_contacts?account_key=eq.${PAGES[page]}&instagram_user_id=eq.${user}${filter}&select=id`, {
            method: 'PATCH', headers: { ...writeHeaders, Prefer: 'return=representation' },
            body: JSON.stringify({ display_name: name || username, username: username || null }), signal: AbortSignal.timeout(5000),
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
      if ((await permissions.json())?.instagram?.accounts?.[input.account]?.manage !== true) return reply({ error: 'Forbidden' }, 403);
      if (getEnv('INSTAGRAM_INTAKE_ENABLED') !== 'true') return reply({ error: 'Not configured' }, 503);
      if (!input.users.length) return reply({ success: true, requested: 0, updated: 0, failures: {} });
      // RLS plus account/user filters prevent touching contacts outside this page.
      const contacts = await fetchImpl(`${url}/rest/v1/instagram_intake_contacts?account_key=eq.${PAGES[page]}&instagram_user_id=in.(${[...new Set(input.users)].join(',')})&or=(display_name.is.null,display_name.eq.)&select=instagram_user_id&limit=30`, { headers: userHeaders, signal: AbortSignal.timeout(5000) });
      if (!contacts.ok) return reply({ error: 'Storage unavailable' }, 503);
      const rows = await contacts.json();
      const token = getEnv('INSTAGRAM_PAGE_TOKEN_' + page);
      if (token && rows.length) {
        const identityResponse = await fetchImpl(`https://graph.facebook.com/v25.0/${page}?fields=id,username`, { headers:{Authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(4000) });
        const identity = await identityResponse.json();
        const problem = !identityResponse.ok || identity.error ? profileFailure(identity.error) : identity.id !== page ? 'wrong-page-token' : null;
        if (problem) return reply({ success:true, requested:rows.length, updated:0, failures:{[problem]:rows.length} });
      }
      return reply({ success: true, ...await enrich(page, rows.map(row => row.instagram_user_id), userHeaders, true) });
    } catch { return reply({ error: 'Service unavailable' }, 503); }
  }
  return { enrich, refresh };
}
