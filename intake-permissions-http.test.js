const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { accounts } = require('./public/intake-accounts');

// Load only the isolated release candidate with synthetic configuration.
// Its .env is absent; no real Supabase or platform request is made.
process.env.SUPABASE_URL = 'https://synthetic-intake.example';
process.env.SUPABASE_PUBLISHABLE_KEY = 'synthetic-publishable-key';
process.env.GEO_RESTRICTION_ENABLED = 'false';
const { app } = require('./server');

function request(server, method, input) {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(input);
    const path = method === 'GET' ? `/api/crm?${new URLSearchParams(input)}` : '/api/crm';
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method,
      headers: { authorization: 'Bearer synthetic-session', ...(method === 'POST' ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}) } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    if (method === 'POST') req.write(encoded);
    req.end();
  });
}

test('HTTP sales access follows seven granted pages and denies CAR pages and all mutations', async t => {
  const deniedAccounts = new Set(['car-line-fkq6145q', 'mhl-fb-109607531869658', 'car-ig-17841458662245781']);
  const allowedGrants = Object.fromEntries(Object.entries(accounts).map(([channel, entries]) => [channel, {
    accounts: Object.fromEntries(entries.map(({ key }) => [key, { view: !deniedAccounts.has(key), manage: false }])),
  }]));
  let grants = allowedGrants;
  const queries = [];
  const healthCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = new URL(typeof url === 'string' ? url : url.url);
    const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });
    assert.equal(target.origin, 'https://synthetic-intake.example');
    if (target.pathname.endsWith('/health')) { healthCalls.push(target.pathname); return json({ configured: false }); }
    const headers = new Headers(options.headers);
    assert.equal(headers.get('authorization'), 'Bearer synthetic-session');
    if (target.pathname === '/auth/v1/user') return json({ id: '11111111-1111-4111-8111-111111111111' });
    if (target.pathname === '/rest/v1/crm_members') return json({ user_id: '11111111-1111-4111-8111-111111111111', display_name: 'Synthetic sales', role: 'sales', is_active: true });
    if (target.pathname === '/rest/v1/rpc/get_current_crm_assignment_identity') return json({ employee_id: '22222222-2222-4222-8222-222222222222', salesperson_name: 'Synthetic sales', restricted: true });
    if (target.pathname === '/rest/v1/rpc/get_current_crm_intake_permissions') return json(grants);
    if (/^\/rest\/v1\/(line|facebook|instagram)_intake_contacts$/.test(target.pathname)) {
      assert.equal(options.method, 'GET', 'read-only sales must never mutate intake tables');
      const account = target.searchParams.get('account_key')?.replace(/^eq\./, '');
      assert.ok(account && !deniedAccounts.has(account));
      queries.push({ table: target.pathname, account });
      return json([{ id: '33333333-3333-4333-8333-333333333333', account_key: account, display_name: 'Synthetic contact', status: 'pending' }], { 'content-range': '0-0/1' });
    }
    if (/^\/rest\/v1\/rpc\/(line|facebook|instagram)_intake_daily_summary$/.test(target.pathname)) {
      const params = JSON.parse(options.body);
      assert.ok(!deniedAccounts.has(params.p_account));
      return json({ new: 1, total: 1, imported: 0 });
    }
    assert.fail(`unexpected external request: ${target.pathname}`);
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });

  let successfulPages = 0;
  for (const [channel, entries] of Object.entries(accounts)) {
    const label = channel[0].toUpperCase() + channel.slice(1);
    for (const { key } of entries) {
      const previousReads = queries.length;
      const previousHealth = healthCalls.length;
      const result = await request(server, 'GET', { action: `get${label}Intake`, account: key, date: '2026-10-06' });
      if (deniedAccounts.has(key)) {
        assert.equal(result.status, 403);
        assert.equal(queries.length, previousReads);
        assert.equal(healthCalls.length, previousHealth);
      } else {
        successfulPages++;
        assert.equal(result.status, 200);
        assert.equal(result.body.accountKey, key);
        assert.equal(result.body.contacts[0].account_key, key);
        assert.match(result.headers['cache-control'], /no-store/);
      }
      const afterRead = queries.length;
      const mutation = await request(server, 'POST', { action: `resolve${label}Intake`, account: key, id: '33333333-3333-4333-8333-333333333333', decision: 'dismiss', intakePermissions: { [channel]: { manage: true } } });
      assert.equal(mutation.status, 403);
      assert.equal(queries.length, afterRead);
    }
    if (channel !== 'line') {
      const refresh = await request(server, 'POST', { action: `refresh${label}Names`, account: entries[0].key });
      assert.equal(refresh.status, 403);
    }
  }
  assert.equal(successfulPages, 7);
  assert.equal(queries.length, 7);

  grants = { line: { accounts: {} }, facebook: { accounts: {} }, instagram: { accounts: {} } };
  const revoked = await request(server, 'GET', { action: 'getInstagramIntake', account: accounts.instagram[0].key, date: '2026-10-06' });
  assert.equal(revoked.status, 403);
  assert.equal(queries.length, 7, 'a fresh permission RPC must reject a revoked page before storage reads');
});
