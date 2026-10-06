const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const permissions = require('./public/intake-permissions');
const html = fs.readFileSync(`${__dirname}/public/index.html`, 'utf8');

function element(initialClasses = '') {
  const classes = new Set(initialClasses.split(/\s+/).filter(Boolean));
  return {
    hidden: false,
    checked: false,
    disabled: false,
    attributes: {},
    textContent: '',
    get className() { return [...classes].join(' '); },
    set className(value) { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(item => classes.add(item)); },
    classList: {
      contains: name => classes.has(name),
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
    },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}

function fixture() {
  const nodes = {};
  for (const channel of permissions.channels) {
    for (const { key } of permissions.accountDefinitions[channel]) {
      for (const action of ['view', 'manage']) nodes[permissions.checkboxId(channel, key, action)] = element();
    }
    nodes[`menu-${channel}-intake`] = element('nav-button');
    nodes[`page-${channel}-intake`] = element('page-container hidden');
  }
  nodes.employeeIntakePermissionsNote = element();
  nodes['menu-reports'] = element('nav-button');
  nodes['page-reports'] = element('page-container hidden');
  nodes['menu-overview'] = element('nav-button');
  nodes['page-overview'] = element('page-container');
  const document = {
    getElementById: id => nodes[id] || null,
    querySelectorAll: selector => Object.entries(nodes)
      .filter(([id]) => selector === '.page-container' ? id.startsWith('page-') : id.startsWith('menu-'))
      .map(([, node]) => node),
  };
  return { nodes, document };
}

const firstAccount = channel => permissions.accountDefinitions[channel][0].key;
const secondAccount = channel => permissions.accountDefinitions[channel][1].key;
const inputId = (channel, action, account = firstAccount(channel)) => permissions.checkboxId(channel, account, action);

test('channel grants default to denied, accept only booleans, and manage always includes view', () => {
  for (const role of ['sales', 'manager', 'member', '']) {
    const normalized = permissions.normalize(null, role);
    for (const channel of permissions.channels) {
      assert.equal(normalized[channel].view, false);
      assert.equal(normalized[channel].manage, false);
      assert.deepEqual(Object.keys(normalized[channel].accounts), permissions.accountDefinitions[channel].map(item => item.key));
      for (const grant of Object.values(normalized[channel].accounts)) assert.deepEqual(grant, { view: false, manage: false });
    }
  }
  const member = { role: 'member', is_active: true, intakePermissions: {
    line: { view: false, manage: true },
    facebook: { view: 'true', manage: 1 },
    instagram: { view: true, manage: false },
  } };
  assert.equal(permissions.canView(member, 'line'), true);
  assert.equal(permissions.canManage(member, 'line'), true);
  assert.equal(permissions.canView(member, 'facebook'), false);
  assert.equal(permissions.canManage(member, 'instagram'), false);
  assert.equal(permissions.canView(member, 'unknown'), false);
  assert.equal(permissions.canView({ ...member, is_active: false }, 'line'), false);
  assert.equal(permissions.canView(null, 'line'), false);
});

test('legacy channel grants expand to every known account while explicit account maps are authoritative', () => {
  const legacy = permissions.normalize({ line: { view: true }, facebook: { manage: true } });
  for (const grant of Object.values(legacy.line.accounts)) assert.deepEqual(grant, { view: true, manage: false });
  for (const grant of Object.values(legacy.facebook.accounts)) assert.deepEqual(grant, { view: true, manage: true });
  const canonical = permissions.normalize({
    line: { view: true, manage: true, accounts: { [secondAccount('line')]: { view: false, manage: true } } },
    facebook: { view: true, manage: true, accounts: {} },
    instagram: { view: true, accounts: null },
  });
  assert.deepEqual(canonical.line.accounts[firstAccount('line')], { view: false, manage: false });
  assert.deepEqual(canonical.line.accounts[secondAccount('line')], { view: true, manage: true });
  assert.equal(canonical.facebook.view, false);
  assert.equal(canonical.facebook.manage, false);
  assert.equal(canonical.instagram.view, false);
  assert.deepEqual(permissions.normalize(canonical), canonical);
});

test('specific account checks deny siblings and foreign or unknown account IDs', () => {
  const member = { role: 'member', is_active: true, intakePermissions: {
    line: { accounts: { [secondAccount('line')]: { view: true } } },
    instagram: { accounts: { [firstAccount('instagram')]: { manage: true } } },
  } };
  assert.equal(permissions.canView(member, 'line'), true);
  assert.equal(permissions.canManage(member, 'line'), false);
  assert.equal(permissions.canView(member, 'line', secondAccount('line')), true);
  assert.equal(permissions.canView(member, 'line', firstAccount('line')), false);
  assert.equal(permissions.canManage(member, 'instagram', firstAccount('instagram')), true);
  for (const account of ['', null, 'unknown-account', firstAccount('facebook')]) {
    assert.equal(permissions.canView(member, 'line', account), false);
    assert.equal(permissions.canManage(member, 'line', account), false);
  }
  assert.equal(permissions.canView({ role: 'admin', is_active: true }, 'line', 'unknown-account'), false);
});

test('members without strict active status or a supported role cannot use supplied channel grants', () => {
  const grants = permissions.normalize(null, 'admin');
  for (const member of [
    { role: 'admin' },
    { role: 'member', intakePermissions: grants },
    { role: 'admin', is_active: false },
    { role: 'admin', is_active: 'true' },
    { role: 'member', is_active: 1, intakePermissions: grants },
    { role: 'staff', is_active: true, intakePermissions: grants },
    { is_active: true, intakePermissions: grants },
  ]) {
    for (const channel of permissions.channels) {
      assert.equal(permissions.canView(member, channel), false);
      assert.equal(permissions.canManage(member, channel), false);
    }
  }
});

test('active admins retain all grants and Instagram-only access does not expose LINE/FB reports', () => {
  for (const channel of permissions.channels) {
    assert.equal(permissions.canView({ role: 'admin', is_active: true }, channel), true);
    assert.equal(permissions.canManage({ role: 'admin', is_active: true }, channel), true);
    assert.equal(permissions.canView({ role: 'admin', is_active: false }, channel), false);
  }
  const member = { role: 'sales', is_active: true, intakePermissions: { instagram: { view: true } } };
  assert.equal(permissions.canViewReports(member), false);
  assert.equal(permissions.canAccessPage(member, 'instagram-intake'), true);
  assert.equal(permissions.canAccessPage(member, 'line-intake'), false);
  assert.equal(permissions.canAccessPage(member, 'leads-list'), true);
});

test('employee checkbox editor normalizes dependencies and preserves a draft across admin role changes', () => {
  const { nodes, document } = fixture();
  permissions.populateEditor(document, { line: { view: true } }, 'member');
  assert.equal(nodes[inputId('line', 'view')].checked, true);
  nodes[inputId('facebook', 'manage', secondAccount('facebook'))].checked = true;
  permissions.changeEditorPermission(document, 'facebook', secondAccount('facebook'), 'manage');
  assert.equal(nodes[inputId('facebook', 'view', secondAccount('facebook'))].checked, true);
  assert.equal(nodes[inputId('facebook', 'view')].checked, false);
  permissions.changeEditorRole(document, 'admin');
  for (const channel of permissions.channels) {
    for (const { key } of permissions.accountDefinitions[channel]) {
      assert.equal(nodes[inputId(channel, 'manage', key)].checked, true);
      assert.equal(nodes[inputId(channel, 'view', key)].disabled, true);
    }
  }
  permissions.changeEditorRole(document, 'manager');
  assert.equal(nodes[inputId('instagram', 'manage')].checked, false);
  assert.equal(nodes[inputId('facebook', 'manage', secondAccount('facebook'))].checked, true);
  const saved = permissions.readEditor(document, 'manager');
  assert.equal(saved.facebook.accounts[secondAccount('facebook')].manage, true);
  assert.equal(saved.facebook.accounts[firstAccount('facebook')].view, false);
  nodes[inputId('facebook', 'view', secondAccount('facebook'))].checked = false;
  permissions.changeEditorPermission(document, 'facebook', secondAccount('facebook'), 'view');
  assert.equal(nodes[inputId('facebook', 'manage', secondAccount('facebook'))].checked, false);
  assert.equal(permissions.readEditor(document, 'manager').line.view, true);
  permissions.populateEditor(document, permissions.normalize(null, 'admin'), 'admin');
  permissions.changeEditorRole(document, 'member');
  assert.equal(permissions.readEditor(document, 'member').line.view, false);
});

test('menu hiding survives navigation class resets and hides a revoked visible page', () => {
  const { document, nodes } = fixture();
  const member = { role: 'member', is_active: true, intakePermissions: { line: { view: true } } };
  permissions.syncNavigation(document, member);
  assert.equal(nodes['menu-line-intake'].hidden, false);
  assert.equal(nodes['menu-facebook-intake'].hidden, true);
  assert.equal(nodes['menu-reports'].hidden, false);
  nodes['menu-facebook-intake'].className = 'w-full flex';
  assert.equal(nodes['menu-facebook-intake'].hidden, true);
  nodes['page-line-intake'].classList.remove('hidden');
  assert.equal(permissions.syncNavigation(document, { role: 'member' }), true);
  assert.equal(nodes['page-line-intake'].classList.contains('hidden'), true);
  assert.match(html, /\[data-intake-permission-menu\]\[hidden\]\s*\{\s*display: none !important;/);
});

const scopeFunction = html.slice(html.indexOf('function getCrmScopeKey('), html.indexOf('function canViewIntakeChannel('));
const permissionCheck = html.slice(html.indexOf('async function refreshCrmPermissionScope('), html.indexOf("window.addEventListener('focus', () => void refreshCrmPermissionScope"));
const switchPageFunction = html.slice(html.indexOf('function switchPage(pageId)'), html.indexOf('function isEmployeeAdministrator()'));

test('direct channel navigation rejects denied grants before loading and reapplies menu visibility after resets', () => {
  const { document, nodes } = fixture();
  let lineLoads = 0;
  const messages = [];
  const member = { role: 'member', is_active: true, intakePermissions: { line: { view: true } } };
  const context = vm.createContext({
    document, IntakePermissions: permissions, currentCrmMember: member,
    requireCrmAccess: () => true, closeAnnouncementImageViewer() {}, closeLeadDetailModal() {}, closeCustomerPopup() {},
    syncIntakePermissionControls: () => permissions.syncNavigation(document, member),
    showToast: message => messages.push(message), isMobileSidebarOpen: false,
    loadLineIntake: () => { lineLoads++; }, loadDashboard() {}, fetchLeadsData() {},
  });
  vm.runInContext(switchPageFunction, context);
  context.switchPage('facebook-intake');
  assert.equal(messages.length, 1);
  assert.equal(nodes['page-overview'].classList.contains('hidden'), false);
  assert.equal(nodes['page-facebook-intake'].classList.contains('hidden'), true);
  context.switchPage('line-intake');
  assert.equal(lineLoads, 1);
  context.switchPage('overview');
  assert.equal(nodes['menu-facebook-intake'].hidden, true);
  assert.equal(nodes['menu-instagram-intake'].classList.contains('hidden'), true);
});

test('permission changes alter the CRM scope key, including view-only to manage changes', () => {
  const context = vm.createContext({ IntakePermissions: permissions, currentAuthUser: { id: 'U1' },
    currentCrmMember: { role: 'member', is_active: true, intakePermissions: { line: { view: true } } }, currentCrmAssignment: null });
  vm.runInContext(scopeFunction, context);
  const before = context.getCrmScopeKey();
  context.currentCrmMember.intakePermissions.line.manage = true;
  assert.notEqual(context.getCrmScopeKey(), before);
  const adminKey = permissions.scopeKey({ role: 'admin', is_active: true });
  assert.equal(adminKey.length, 20);
  assert.equal(adminKey, permissions.scopeKey({ role: 'admin', is_active: true, intakePermissions: { line: { view: false } } }));
  context.currentCrmMember.intakePermissions = permissions.normalize({ line: { view: true } });
  const allAccountsKey = context.getCrmScopeKey();
  context.currentCrmMember.intakePermissions.line.accounts[secondAccount('line')].view = false;
  assert.equal(permissions.canView(context.currentCrmMember, 'line'), true);
  assert.notEqual(context.getCrmScopeKey(), allAccountsKey);
});

test('background health checks refresh the full CRM scope only when grants or roles change', async () => {
  const member = { role: 'member', is_active: true, intakePermissions: permissions.normalize({ line: { view: true } }) };
  let responseMember = member;
  let refreshes = 0;
  let healthChecks = 0;
  const context = vm.createContext({ IntakePermissions: permissions, Date: { now: () => 60000 },
    AbortSignal: { timeout: () => null }, supabaseClient: {}, currentAuthUser: { id: 'U1' },
    currentCrmMember: member, currentCrmAssignment: null, currentAccessToken: 'token',
    crmAccessRequestId: 1, crmPermissionRefreshPromise: null, crmPermissionLastCheckedAt: 0,
    fetch: async () => { healthChecks++; return { ok: true, status: 200, json: async () => ({
      userId: 'U1', membership: responseMember, assignment: null,
    }) }; },
    refreshCrmAccess: async () => { refreshes++; return true; },
  });
  vm.runInContext(scopeFunction + permissionCheck, context);
  await context.refreshCrmPermissionScope({ force: true });
  assert.equal(healthChecks, 1);
  assert.equal(refreshes, 0);
  responseMember = { ...member, intakePermissions: permissions.normalize({ line: {
    accounts: { [firstAccount('line')]: { view: true } },
  } }) };
  assert.equal(permissions.canView(responseMember, 'line'), true);
  await context.refreshCrmPermissionScope({ force: true });
  assert.equal(refreshes, 1);
});

test('permission refresh uses existing cache resets and leaves a revoked intake page', async () => {
  const { document, nodes } = fixture();
  nodes['page-overview'].classList.add('hidden');
  nodes['page-line-intake'].classList.remove('hidden');
  let revokedMember = { role: 'member', is_active: true, intakePermissions: {} };
  let cleared = 0;
  const pages = [];
  const context = vm.createContext({
    document, IntakePermissions: permissions, currentAuthUser: { id: 'U1' },
    currentCrmMember: { role: 'member', is_active: true, intakePermissions: { line: { view: true } } },
    currentCrmAssignment: null, currentAccessToken: 'token', crmAccessRequestId: 0, hasStartedCrm: true,
    crmPermissionLastCheckedAt: 0,
    supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: 'token', user: { id: 'U1' } } } }) } },
    fetch: async () => ({ ok: true, json: async () => ({ userId: 'U1', membership: revokedMember, assignment: null }) }),
    clearCrmScopedData: () => { cleared++; },
    syncIntakePermissionControls: () => permissions.syncNavigation(document, context.currentCrmMember),
    switchPage: page => pages.push(page),
  });
  for (const name of ['syncAnnouncementManagementControls', 'startCrmPermissionUpdates', 'loadAnnouncementUnreadCount',
    'loadCaseNotificationUnreadCounts', 'startCaseNotificationUpdates', 'loadFollowUpTasks', 'startFollowUpTaskUpdates',
    'syncSalespersonScopeControls', 'checkDraft', 'updateCurrentUserDisplay', 'hideAuthGate', 'loadContactTopics', 'loadReferralSources']) {
    context[name] = () => {};
  }
  const refreshFunction = html.slice(html.indexOf('async function refreshCrmAccess('), html.indexOf('async function discardInvalidSession()'));
  vm.runInContext(scopeFunction + refreshFunction, context);
  assert.equal(await context.refreshCrmAccess(), true);
  assert.equal(cleared, 1);
  assert.deepEqual(pages, ['leads-list']);
  assert.equal(nodes['menu-line-intake'].hidden, true);
  context.currentCrmMember = { role: 'member', is_active: true, intakePermissions: permissions.normalize({ line: { view: true } }) };
  revokedMember = { role: 'member', is_active: true, intakePermissions: { line: {
    accounts: { [firstAccount('line')]: { view: true } },
  } } };
  nodes['page-line-intake'].classList.remove('hidden');
  pages.length = 0;
  assert.equal(await context.refreshCrmAccess(), true);
  assert.equal(cleared, 2);
  assert.deepEqual(pages, ['line-intake']);
});

test('employee grants are wired into populate/save and all inline scripts parse', () => {
  assert.match(html, /IntakePermissions\.populateEditor\(document, employee\?\.intakePermissions/);
  assert.match(html, /intakePermissions: IntakePermissions\.readEditor\(document, value\('employeeAccessRole'\)\)/);
  for (const channel of permissions.channels) {
    for (const { key, label } of permissions.accountDefinitions[channel]) {
      for (const action of ['view', 'manage']) {
        assert.ok(html.includes(`id="${permissions.checkboxId(channel, key, action)}"`));
        assert.ok(html.includes(`'${channel}', '${key}', '${action}'`));
      }
      assert.ok(html.includes(label));
    }
  }
  assert.equal([...html.matchAll(/id="employeeIntake-[^"]+-(?:view|manage)"/g)].length, 20);
  assert.ok(html.indexOf('src="/intake-accounts.js"') < html.indexOf('src="/intake-permissions.js"'));
  for (const [, attributes, source] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=/.test(attributes)) new vm.Script(source);
  }
});

test('every local script and stylesheet dependency resolves to a release file or installed vendor asset', () => {
  const publicRoot = path.join(__dirname, 'public');
  const dependencies = new Set();
  for (const [, tag, attributes] of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    if (tag.toLowerCase() === 'link' && !/\brel\s*=\s*["']stylesheet["']/i.test(attributes)) continue;
    const reference = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (!reference || !reference.startsWith('/')) continue;
    dependencies.add(reference.split(/[?#]/, 1)[0]);
  }
  assert.ok(dependencies.size > 0);
  for (const reference of dependencies) {
    const filename = reference === '/vendor/supabase/supabase.js'
      ? path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist', 'umd', 'supabase.js')
      : path.join(publicRoot, reference.slice(1));
    assert.equal(fs.statSync(filename).isFile(), true, `Missing dependency: ${reference}`);
  }
});

test('unregistered magic-link email gets actionable Thai guidance while account creation stays disabled', () => {
  const start = html.indexOf('    function describeMagicLinkError(');
  const end = html.indexOf('    async function initializeAuth()', start);
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end), context);
  for (const error of [{ message: 'Signups not allowed for otp' }, { code: 'user_not_found' }]) {
    const message = context.describeMagicLinkError(error);
    assert.match(message, /ยังไม่มีบัญชี/);
    assert.match(message, /ผู้ดูแล GOOD CRM/);
    assert.doesNotMatch(message, /Signups not allowed/);
  }
  assert.match(html, /shouldCreateUser:\s*false/);
  const authGate = html.slice(html.indexOf('<section id="authGate"'), html.indexOf('</section>', html.indexOf('<section id="authGate"')));
  assert.match(authGate, /src="\/assets\/good-crm-icon-192\.png"/);
  assert.equal(fs.statSync(path.join(__dirname, 'public', 'assets', 'good-crm-icon-192.png')).isFile(), true);
});
