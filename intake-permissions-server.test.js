const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { readIntakePermissions } = require('./intake-permissions');
const lineIntake = require('./line-intake');
const facebookIntake = require('./facebook-intake');
const instagramIntake = require('./instagram-intake');
const { getIntakeReport } = require('./intake-reports');
const accounts = require('./public/intake-accounts').accounts;
const source = fs.readFileSync(require.resolve('./server'), 'utf8');

function declaration(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `${start} must remain in the server`);
  return source.slice(first, last);
}

function response() {
  return {
    statusCode: 200, headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

function harness({ role = 'sales', active = true, linked = true, grants = {}, permissionError = false } = {}) {
  const state = { grants, permissionError, queries: [], rpcs: [] };
  const client = {
    from(table) {
      const filters = {};
      const query = {
        select() { return query; },
        eq(key, value) { filters[key] = value; return query; },
        order() { return query; },
        async maybeSingle() {
          assert.equal(table, 'crm_members');
          return { data: { user_id: 'synthetic-user', role, is_active: active } };
        },
        async range() {
          state.queries.push({ table, filters });
          return { data: [{ id: 'synthetic-contact', account_key: filters.account_key, status: 'pending' }], count: 1 };
        },
      };
      return query;
    },
    rpc(name, input) {
      state.rpcs.push({ name, input });
      if (name === 'get_current_crm_assignment_identity') return {
        async maybeSingle() { return { data: { restricted: role === 'sales', employee_id: linked ? 'synthetic-employee' : '', salesperson_name: linked ? 'Synthetic employee' : '' } }; },
      };
      if (name === 'get_current_crm_intake_permissions') return Promise.resolve(state.permissionError ? { error: { message: 'unavailable' } } : { data: state.grants });
      if (name.endsWith('_daily_summary')) return Promise.resolve({ data: { new: 1, total: 1, imported: 0 } });
      assert.fail(`unexpected database mutation: ${name}`);
    },
  };
  class CrmRequestError extends Error {
    constructor(status, message, code) { super(message); Object.assign(this, { status, code }); }
  }
  const context = vm.createContext({
    PROJECT_URL: 'https://synthetic.example', PUBLISHABLE_KEY: 'synthetic-publishable-key',
    configuredSupabaseClient: () => client,
    readIntakePermissions,
    fetch: async (url, options) => {
      assert.equal(url, 'https://synthetic.example/auth/v1/user');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-session');
      return { ok: true, json: async () => ({ id: 'synthetic-user' }) };
    },
    console: { error() {} }, CrmRequestError,
    getIntake: lineIntake.getIntake, resolveIntake: lineIntake.resolveIntake,
    facebookIntake, instagramIntake, getIntakeReport,
  });
  vm.runInContext([
    declaration('function isInvalidSessionError(', 'class CrmRequestError'),
    declaration('function text(', 'function isRestrictedCrmSales('),
    declaration('async function handleCrmRequest(', 'app.use(setSecurityHeaders)'),
    'globalThis.middleware = requireCrmMember; globalThis.dispatch = handleCrmRequest;',
  ].join('\n'), context);
  async function request(method, input) {
    const req = { method, query: method === 'GET' ? input : {}, body: method === 'POST' ? input : {}, get: name => name === 'authorization' ? 'Bearer synthetic-session' : '' };
    const res = response();
    let admitted = false;
    await context.middleware(req, res, () => { admitted = true; });
    if (admitted) await context.dispatch(req, res);
    return { req, res, admitted };
  }
  return { state, request };
}

for (const channel of ['line', 'facebook', 'instagram']) {
  const label = channel[0].toUpperCase() + channel.slice(1);
  test(`server admits linked sales read access only to the granted ${channel} account`, async t => {
    let healthCalls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      healthCalls++;
      return { ok: true, json: async () => ({ configured: false }) };
    });
    const allowed = accounts[channel][1].key;
    const denied = accounts[channel][0].key;
    const h = harness({ grants: { [channel]: { accounts: { [allowed]: { view: true, manage: false } } } } });
    const result = await h.request('GET', { action: `get${label}Intake`, account: allowed, date: '2026-10-06' });
    assert.equal(result.admitted, true);
    assert.equal(result.res.statusCode, 200);
    assert.equal(result.res.headers['Cache-Control'], 'no-store, private');
    assert.equal(result.res.body.accountKey, allowed);
    assert.equal(result.req.crmUser.membership.intakePermissions[channel].accounts[allowed].view, true);
    assert.equal(h.state.queries.length, 1);

    const reads = h.state.queries.length;
    const externalReads = healthCalls;
    const refused = await h.request('GET', { action: `get${label}Intake`, account: denied, date: '2026-10-06' });
    assert.equal(refused.res.statusCode, 403);
    assert.equal(h.state.queries.length, reads);
    assert.equal(healthCalls, externalReads);

    const write = await h.request('POST', { action: `resolve${label}Intake`, account: allowed, id: 'synthetic-contact', decision: 'dismiss', intakePermissions: { [channel]: { manage: true } } });
    assert.equal(write.res.statusCode, 403);
    assert.equal(h.state.queries.length, reads);
    if (channel !== 'line') {
      const refresh = await h.request('POST', { action: `refresh${label}Names`, account: allowed });
      assert.equal(refresh.res.statusCode, 403);
      assert.equal(healthCalls, externalReads);
    }

    h.state.grants = { [channel]: { accounts: {} } };
    const revoked = await h.request('GET', { action: `get${label}Intake`, account: allowed, date: '2026-10-06' });
    assert.equal(revoked.res.statusCode, 403);
    assert.equal(revoked.req.crmUser.membership.intakePermissions[channel].accounts[allowed].view, false);
    assert.equal(h.state.queries.length, reads);
  });
}

test('server fails closed when fresh account permissions cannot be read', async () => {
  const h = harness({ permissionError: true });
  const result = await h.request('GET', { action: 'getFacebookIntake', account: accounts.facebook[0].key });
  assert.equal(result.admitted, false);
  assert.equal(result.res.statusCode, 503);
  assert.equal(result.res.body.code, 'INTAKE_ACCESS_UNAVAILABLE');
  assert.equal(h.state.queries.length, 0);
});

test('inactive membership and unlinked sales stay denied before intake permissions', async () => {
  for (const options of [{ active: false }, { linked: false }]) {
    const h = harness(options);
    const result = await h.request('GET', { action: 'getInstagramIntake', account: accounts.instagram[0].key });
    assert.equal(result.admitted, false);
    assert.equal(result.res.statusCode, 403);
    assert.equal(h.state.rpcs.some(call => call.name === 'get_current_crm_intake_permissions'), false);
  }
});

test('active administrators retain view access with empty employee grants', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ configured: false }) }));
  const h = harness({ role: 'admin' });
  const result = await h.request('GET', { action: 'getInstagramIntake', account: accounts.instagram[2].key, date: '2026-10-06' });
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.accountKey, accounts.instagram[2].key);
});
