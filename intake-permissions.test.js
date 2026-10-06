const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const permissions = require('./intake-permissions');
const handlers = { line: require('./line-intake'), facebook: require('./facebook-intake'), instagram: require('./instagram-intake') };
const channels = ['line', 'facebook', 'instagram'];
const catalog = require('./public/intake-accounts').accounts;
const accountKeys = channel => catalog[channel].map(item => item.key);
const defaultAccount = channel => channel === 'line' ? 'gfs-line-249izgyn' : accountKeys(channel)[0];
const member = intakePermissions => ({ role: 'sales', is_active: true, intakePermissions });

test('channel grants deny missing or malformed values and manage implies view', () => {
  const denied = permissions.normalizeIntakePermissions(null);
  for (const channel of channels) {
    assert.equal(denied[channel].view, false); assert.equal(denied[channel].manage, false);
    assert.deepEqual(Object.keys(denied[channel].accounts), accountKeys(channel));
    assert.ok(Object.values(denied[channel].accounts).every(grant => !grant.view && !grant.manage));
  }
  const normalized = permissions.normalizeIntakePermissions({ line: { view: 'true', manage: 1 }, facebook: { manage: true } });
  assert.equal(normalized.line.view, false); assert.equal(normalized.line.manage, false);
  assert.ok(Object.values(normalized.facebook.accounts).every(grant => grant.view && grant.manage));
  assert.ok(Object.values(permissions.validateIntakePermissions({ instagram: { manage: true } }).instagram.accounts).every(grant => grant.view && grant.manage));
  for (const value of [null, [], { youtube: {} }, { line: [] }, { line: { view: 'true' } }, { line: { delete: true } }]) {
    assert.throws(() => permissions.validateIntakePermissions(value), error => error.status === 400);
  }
});

test('only active members can exercise explicit grants for the matching channel and operation', () => {
  const grant = { facebook: { view: true } };
  assert.equal(permissions.canAccessIntake(member(grant), 'facebook'), true);
  assert.equal(permissions.canAccessIntake(member(grant), 'facebook', 'manage'), false);
  assert.equal(permissions.canAccessIntake(member(grant), 'line'), false);
  for (const role of ['manager', 'sales', 'member']) assert.equal(permissions.canAccessIntake({ ...member(grant), role }, 'facebook'), true);
  for (const invalid of [null, { ...member(grant), is_active: false }, { ...member(grant), is_active: 'true' }, { ...member(grant), role: 'unknown' }]) {
    assert.equal(permissions.canAccessIntake(invalid, 'facebook'), false);
    assert.throws(() => permissions.requireIntakeAccess(invalid, 'facebook'), error => error.status === 403);
  }
  for (const channel of channels) {
    assert.equal(permissions.canAccessIntake({ role: 'admin', is_active: true }, channel, 'manage'), true);
    assert.equal(permissions.canAccessIntake({ role: 'admin', is_active: false }, channel, 'view'), false);
  }
  assert.equal(permissions.canAccessIntake({ role: 'admin', is_active: true }, 'unknown'), false);
  assert.equal(permissions.canAccessIntake({ role: 'admin', is_active: true }, 'line', 'delete'), false);
});

test('permission reads fail closed when the database is unavailable or returns the wrong shape', async () => {
  for (const result of [{ error: Error('offline') }, { data: null }, { data: [] }]) {
    await assert.rejects(permissions.readIntakePermissions({ rpc: async () => result }), error => error.status === 503);
  }
  const result = await permissions.readIntakePermissions({ rpc: async name => {
    assert.equal(name, 'get_current_crm_intake_permissions');
    return { data: { instagram: { manage: true } } };
  } });
  assert.ok(Object.values(result.instagram.accounts).every(grant => grant.view && grant.manage));
});

test('account grants are authoritative and aggregate flags cannot grant a different page', () => {
  for (const channel of channels) {
    const [allowed, denied] = accountKeys(channel);
    const membership = member({ [channel]: { view: true, manage: true, accounts: { [allowed]: { view: true } } } });
    assert.equal(permissions.canAccessIntake(membership, channel, 'view'), true);
    assert.equal(permissions.canAccessIntake(membership, channel, 'manage'), false);
    assert.equal(permissions.canAccessIntake(membership, channel, 'view', allowed), true);
    assert.equal(permissions.canAccessIntake(membership, channel, 'manage', allowed), false);
    assert.equal(permissions.canAccessIntake(membership, channel, 'view', denied), false);
    assert.equal(permissions.canAccessIntake({ role: 'admin', is_active: true }, channel, 'view', 'unknown'), false);
    assert.throws(() => permissions.validateIntakePermissions({ [channel]: { accounts: { unknown: { view: true } } } }), error => error.status === 400);
  }
});

function readClient() {
  const calls = [];
  const client = {
    from(table) {
      calls.push(table);
      return {
        select() { return this; }, eq() { return this; }, order() { return this; },
        range: async () => ({ data: [{ id: 'contact', display_name: null, account_key: defaultAccount(table.replace('_intake_contacts','')) }], count: 1 }),
        maybeSingle: async () => ({ data: { id: 'contact', account_key: defaultAccount(table.replace('_intake_contacts','')) } }),
        update() { assert.fail('read-only grants must never write profile fields'); },
      };
    },
    rpc: async (name, input) => {
      calls.push({ name, input });
      return { data: name.includes('daily_summary') ? { new: 1, total: 1, imported: 0 } : { status: 'dismissed' } };
    },
  };
  return { client, calls };
}

for (const channel of channels) {
  test(`${channel} API allows only its own view grant and rejects mutations before touching storage`, async t => {
    const previousFetch = global.fetch;
    const previousToken = process.env.LINE_GFS_CHANNEL_ACCESS_TOKEN;
    process.env.LINE_GFS_CHANNEL_ACCESS_TOKEN = 'synthetic-profile-token';
    global.fetch = async url => {
      assert.ok(String(url).includes('/health'), 'a read-only LINE request must not fetch profiles');
      return { ok: true, json: async () => ({ configured: false }) };
    };
    t.after(() => { global.fetch = previousFetch; if (previousToken === undefined) delete process.env.LINE_GFS_CHANNEL_ACCESS_TOKEN; else process.env.LINE_GFS_CHANNEL_ACCESS_TOKEN = previousToken; });
    const view = member({ [channel]: { view: true } });
    const { client, calls } = readClient();
    const result = await handlers[channel].getIntake(client, view, { date: '2026-10-06' });
    assert.equal(result.success, true);
    assert.equal(calls.length, 2);
    const blockedClient = { from: () => assert.fail('forbidden query'), rpc: () => assert.fail('forbidden mutation') };
    await assert.rejects(handlers[channel].getIntake(blockedClient, member({ [channels.find(c => c !== channel)]: { manage: true } }), {}), error => error.status === 403);
    for (const decision of ['create', 'link', 'dismiss']) {
      await assert.rejects(handlers[channel].resolveIntake(blockedClient, view, { decision, replied: true, customerName: 'Test', customerId: 'C1' }), error => error.status === 403);
    }
    const manager = member({ [channel]: { manage: true } });
    const managed = await handlers[channel].resolveIntake(client, manager, { id: 'contact', decision: 'dismiss' });
    assert.equal(managed.success, true);
    if (channel !== 'line') {
      await assert.rejects(handlers[channel].refreshNames(view, {}, 'Bearer fixture', async () => assert.fail('forbidden refresh')), error => error.status === 403);
    }
  });
}

function browser(channel, grants = { view: true, manage: false }) {
  const title = channel[0].toUpperCase() + channel.slice(1);
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      let content = '';
      elements.set(id, {
        id, attributes: {}, value: id.endsWith('-decision') ? 'dismiss' : id.endsWith('-date') ? '2026-10-06' : '', disabled: false, checked: false,
        classList: { hidden: true, add(key) { this[key] = true; }, remove(key) { this[key] = false; }, toggle(key, value) { this[key] = value; }, contains(key) { return this[key] === true; } },
        setAttribute(key, value) { this.attributes[key] = value; }, getAttribute(key) { return this.attributes[key]; },
        set textContent(value) { content = String(value); }, get textContent() { return content; },
        set innerHTML(value) { content = String(value); }, get innerHTML() { return content; },
        reset() {}, scrollIntoView() {},
      });
    }
    return elements.get(id);
  }
  const requests = [];
  let fetchImpl;
  const tabs = accountKeys(channel).map((account, index) => {
    const tab = element(`${channel}-tab-${index}`); tab.dataset = { account }; tab.attributes['aria-selected'] = String(index === 0); tab.focus = () => { context.focusedTab = tab; };
    return tab;
  });
  element(`${channel}-intake-tabs`).querySelectorAll = () => tabs;
  element(`${channel}-intake-account`).value = defaultAccount(channel);
  const rows = [{ id: 'contact', display_name: 'Visible channel contact', status: 'pending', first_seen_at: '2026-10-06T00:00:00Z', line_user_id: 'line-id', facebook_user_id: 'facebook-id', instagram_user_id: 'instagram-id' }];
  const response = (account = element(`${channel}-intake-account`).value) => ({ ok: true, json: async () => ({ success: true, accountKey: account, contacts: rows.map(row => ({ ...row, account_key: account })), page: 0, total: 1, enabled: true, summary: { new: 1, total: 1, imported: 0 } }) });
  const allowed = (operation, account) => {
    if (Object.hasOwn(context.grants, 'accounts')) {
      const values = account ? [context.grants.accounts[account]] : Object.values(context.grants.accounts);
      return values.some(grant => operation === 'manage' ? grant?.manage === true : grant?.view === true || grant?.manage === true);
    }
    return operation === 'manage' ? context.grants.manage : context.grants.view || context.grants.manage;
  };
  const context = vm.createContext({
    document: { getElementById: element }, config: { crmApiUrl: 'https://crm.example/api' }, URL,
    crmScopeVersion: 1, scopeKey: 'first-user', grants,
    getCrmScopeKey: () => context.scopeKey + JSON.stringify(context.grants),
    canViewIntakeChannel: (key, account) => key === channel && allowed('view', account),
    canManageIntakeChannel: (key, account) => key === channel && allowed('manage', account),
    IntakeDrawer: { open() {}, close() {}, showError() {} },
    crmFetch: async (url, options) => { requests.push({ url, options }); return fetchImpl ? fetchImpl(url, options) : response(); },
    escapeHtml: value => String(value), renderIntakeCustomerTag: () => '', renderIntakeDailyGroups: (data, render) => data.map(render).join(''),
    loadReferralSources: async () => [], getReferralSourceOptions: () => '',
    showSuccessToast: () => { context.toasts++; }, toasts: 0,
  });
  vm.runInContext(fs.readFileSync(`public/${channel}-intake.js`, 'utf8'), context);
  return {
    context, requests, response, tabs, element: suffix => element(`${channel}-intake-${suffix}`),
    load: () => context[`load${title}Intake`](0), select: () => context[`select${title}Intake`](0),
    save: () => context[`save${title}Intake`](), reset: () => context[`reset${title}Intake`](),
    selectAccount: tab => context[`select${title}Account`](tab),
    setFetch: implementation => { fetchImpl = implementation; },
  };
}

for (const channel of channels) {
  if (channel !== 'line') {
    test(`${channel} profile refresh controls and handlers are absent from the released UI`, () => {
      const title = channel[0].toUpperCase() + channel.slice(1);
      const page = browser(channel);
      assert.equal(page.context[`refresh${title}Names`], undefined);
      const html = fs.readFileSync('public/index.html', 'utf8');
      assert.doesNotMatch(html, new RegExp(`${channel}-intake-refresh-names|refresh${title}Names\\s*\\(`));
      const script = fs.readFileSync(`public/${channel}-intake.js`, 'utf8');
      assert.doesNotMatch(script, new RegExp(`refresh${title}Names|refresh-names`));
    });
  }
  test(`${channel} API rejects another account before health/queries and resolves only the contact's stored account`, async t => {
    const [allowed, denied] = accountKeys(channel);
    const membership = member({ [channel]: { view: true, manage: true, accounts: { [allowed]: { manage: true } } } });
    const previousFetch = global.fetch;
    let healthCalls = 0;
    global.fetch = async () => { healthCalls++; return { ok: true, json: async () => ({ configured: false }) }; };
    t.after(() => { global.fetch = previousFetch; });
    let selectedAccount = allowed;
    let queryCalls = 0; let mutationCalls = 0;
    const client = {
      from(table) {
        queryCalls++; assert.equal(table, `${channel}_intake_contacts`);
        return {
          select() { return this; }, eq() { return this; }, order() { return this; },
          range: async () => ({ data: [], count: 0 }),
          maybeSingle: async () => ({ data: { id: 'contact', account_key: selectedAccount } }),
        };
      },
      rpc: async name => { if (!name.includes('daily_summary')) mutationCalls++; return { data: name.includes('daily_summary') ? { total: 0, new: 0, imported: 0 } : { status: 'dismissed' } }; },
    };
    await assert.rejects(handlers[channel].getIntake(client, membership, { account: denied, date: '2026-10-06' }), error => error.status === 403);
    assert.equal(queryCalls, 0); assert.equal(healthCalls, 0);
    await handlers[channel].getIntake(client, membership, { account: allowed, date: '2026-10-06' });
    assert.equal(queryCalls, 1);
    const mutation = { id: 'contact', account: allowed, decision: 'dismiss' };
    await handlers[channel].resolveIntake(client, membership, mutation); assert.equal(mutationCalls, 1);
    selectedAccount = denied;
    await assert.rejects(handlers[channel].resolveIntake(client, membership, mutation), error => error.status === 403);
    await assert.rejects(handlers[channel].resolveIntake(client, membership, { id: 'contact', decision: 'dismiss' }), error => error.status === 403);
    assert.equal(mutationCalls, 1);
    const before = queryCalls;
    await assert.rejects(handlers[channel].resolveIntake(client, membership, { ...mutation, account: denied }), error => error.status === 403);
    assert.equal(queryCalls, before);
    if (channel !== 'line') {
      await assert.rejects(handlers[channel].refreshNames(membership, { account: denied, users: [] }, 'Bearer fixture', async () => assert.fail('must not forward an unauthorized account')), error => error.status === 403);
    }
  });

  test(`${channel} view-only UI shows rows with disabled mutations and blocks direct calls`, async () => {
    const page = browser(channel);
    await page.load();
    assert.match(page.element('list').innerHTML, /Visible channel contact/);
    assert.match(page.element('list').innerHTML, /disabled aria-disabled="true"/);
    assert.doesNotMatch(page.element('list').innerHTML, /onclick="select/);
    assert.match(page.element('list').innerHTML, /title="มีสิทธิ์ดูข้อมูลอย่างเดียว"/);
    assert.equal(page.element('save').disabled, true);
    page.select(); await page.save();
    assert.equal(page.element('form').classList.hidden, true);
    assert.equal(page.requests.length, 1);
    page.context.grants = { view: false, manage: false };
    await page.load();
    assert.equal(page.requests.length, 1);
    assert.equal(page.element('list').innerHTML, '');
  });

  test(`${channel} UI discards pending responses after switching to another authorized user`, async () => {
    const page = browser(channel, { view: true, manage: true });
    let release;
    page.setFetch(() => new Promise(resolve => { release = resolve; }));
    const pending = page.load();
    page.context.scopeKey = 'second-user'; page.context.crmScopeVersion++;
    page.reset();
    release(page.response()); await pending;
    assert.equal(page.element('list').innerHTML, '');
    assert.equal(page.element('summary').innerHTML, '');
    assert.equal(page.element('status').textContent, '');
  });

  test(`${channel} UI lets managers select and save, but suppresses success after grants change`, async () => {
    const page = browser(channel, { view: true, manage: true });
    await page.load(); page.select();
    assert.equal(page.element('form').classList.hidden, false);
    let release;
    page.setFetch(() => new Promise(resolve => { release = resolve; }));
    const pending = page.save();
    assert.equal(JSON.parse(page.requests[1].options.body).action, `resolve${channel[0].toUpperCase() + channel.slice(1)}Intake`);
    page.context.grants = { view: true, manage: false }; page.context.crmScopeVersion++;
    page.reset();
    release(page.response()); await pending;
    assert.equal(page.requests.length, 2);
    assert.equal(page.context.toasts, 0);
    assert.equal(page.element('form').classList.hidden, true);
    assert.equal(page.element('save').disabled, true);
  });

  test(`${channel} UI filters account tabs, chooses an authorized default and rejects denied tab selection`, async () => {
    const keys = accountKeys(channel); const allowed = keys[1];
    const page = browser(channel, { accounts: { [allowed]: { view: true } } });
    await page.load();
    assert.equal(page.element('account').value, allowed);
    assert.equal(new URL(page.requests[0].url).searchParams.get('account'), allowed);
    for (const tab of page.tabs) {
      assert.equal(tab.hidden, tab.dataset.account !== allowed);
      assert.equal(tab.disabled, tab.dataset.account !== allowed);
    }
    assert.match(page.element('list').innerHTML, /Visible channel contact/);
    await page.selectAccount(page.tabs.find(tab => tab.dataset.account !== allowed));
    assert.equal(page.requests.length, 1); assert.equal(page.element('account').value, allowed);
    page.select(); await page.save(); assert.equal(page.requests.length, 1);
  });

  test(`${channel} account switching clears selected contact and account-only revocation suppresses pending results`, async () => {
    const [first, second] = accountKeys(channel);
    const page = browser(channel, { accounts: { [first]: { manage: true }, [second]: { view: true } } });
    page.element('account').value = first;
    await page.load(); page.select(); assert.equal(page.element('form').classList.hidden, false);
    await page.selectAccount(page.tabs.find(tab => tab.dataset.account === second));
    assert.equal(page.element('form').classList.hidden, true); assert.equal(page.element('save').disabled, true);
    const before = page.requests.length; await page.save(); assert.equal(page.requests.length, before);
    let release;
    page.setFetch(() => new Promise(resolve => { release = resolve; }));
    const pending = page.load();
    page.context.grants = { accounts: { [first]: { manage: true } } };
    release(page.response(second)); await pending;
    assert.equal(page.element('list').innerHTML, ''); assert.equal(page.element('summary').innerHTML, '');
  });

  test(`${channel} UI rejects a response from another account before rendering contacts or summary`, async () => {
    const [first, other] = accountKeys(channel);
    const page = browser(channel, { accounts: { [first]: { manage: true } } });
    page.setFetch(() => page.response(other));
    await page.load();
    assert.equal(page.element('list').innerHTML, ''); assert.equal(page.element('summary').innerHTML, '');
    assert.match(page.element('status').textContent, /บัญชีรายชื่อไม่ตรง/);
  });
}
