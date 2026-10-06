const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { getIntakeReport, reportMonth } = require('./intake-reports');
const admin = { role: 'admin', is_active: true };

test('month calendar includes 28, 29, 30 and 31 days and rolls December correctly', () => {
  for (const [month, length] of [['2026-02', 28], ['2028-02', 29], ['2026-09', 30], ['2026-10', 31]]) {
    const period = reportMonth(month);
    assert.equal(period.dates.length, length);
    assert.equal(period.dates[0], `${month}-01`);
    assert.equal(period.dates.at(-1), `${month}-${length}`);
  }
  assert.equal(reportMonth('2026-12').next, '2027-01-01');
});

test('unauthorized and invalid month requests never query the database', async () => {
  const client = { from: () => assert.fail('must not query'), rpc: () => assert.fail('must not query') };
  for (const member of [null, { role: 'manager', is_active: true }, { role: 'admin', is_active: false }]) {
    await assert.rejects(getIntakeReport(client, member, { month: '2026-09' }), error => error.status === 403);
  }
  for (const month of ['2026-13', '2026-00', '2026-9', '2026-09-01', ['2026-09'], null, '', '0000-01']) {
    await assert.rejects(getIntakeReport(client, admin, { month }));
  }
});

const activity = (key, day, first, id) => ({ day, contact_id: id, contact: { account_key: key, first_seen_at: first } });
function database(tables = {}, failTable = '') {
  const calls = [];
  return { calls, from(table) {
    let filters = [];
    const query = {
      select(fields, options) { assert.equal(options.count, 'exact'); return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      in(key, values) { filters.push(row => values.includes(key === 'contact.account_key' ? row.contact?.account_key : row[key])); return query; },
      gte(key, value) { filters.push(row => key === 'resolved_at' ? Date.parse(row[key]) >= Date.parse(value) : row[key] >= value); return query; },
      lt(key, value) { filters.push(row => key === 'resolved_at' ? Date.parse(row[key]) < Date.parse(value) : row[key] < value); return query; },
      order() { return query; },
      async range(start, end) {
        calls.push({ table, start, end });
        if (table === failTable) return { error: { message: 'unavailable' } };
        const data = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
        // Simulate a server cap smaller than the requested page size.
        return { data: data.slice(start, Math.min(end + 1, start + 2)), count: data.length };
      },
    };
    return query;
  } };
}

test('monthly report counts Thai days, returning contacts, independent imports and all accounts without truncation', async () => {
  const client = database({
    line_intake_days: [
      activity('gfs-line-249izgyn', '2026-09-01', '2026-08-31T17:00:00Z', '1'),
      activity('gfs-line-249izgyn', '2026-09-02', '2026-08-31T17:00:00Z', '1'),
      activity('gfs-line-095jvuls', '2026-09-01', '2026-08-31T16:59:59Z', '2'),
      activity('mhl-line-320opqkc', '2026-09-30', '2026-09-30T16:59:59Z', '3'),
      activity('car-line-fkq6145q', '2026-10-01', '2026-09-30T17:00:00Z', '4'),
    ],
    line_intake_contacts: [
      { id: 'a', account_key: 'gfs-line-249izgyn', status: 'imported', resolved_at: '2026-08-31T17:00:00Z' },
      { id: 'b', account_key: 'gfs-line-249izgyn', status: 'imported', resolved_at: '2026-08-31T16:59:59Z' },
      { id: 'c', account_key: 'gfs-line-249izgyn', status: 'imported', resolved_at: '2026-09-30T17:00:00Z' },
      { id: 'd', account_key: 'gfs-line-249izgyn', status: 'dismissed', resolved_at: '2026-09-01T00:00:00Z' },
      { id: 'e', account_key: 'car-line-fkq6145q', status: 'imported', resolved_at: '2026-09-03T00:00:00Z' },
    ],
    facebook_intake_days: [
      activity('gfs-fb-101634951180913', '2026-09-01', '2026-09-01T00:00:00Z', '5'),
      activity('mhl-fb-109607531869658', '2026-09-01', '2026-08-01T00:00:00Z', '6'),
    ],
  });
  const result = await getIntakeReport(client, admin, { month: '2026-09' });
  assert.equal(result.days.length, 30);
  assert.ok(result.days.every(day => day.accounts.length === 7));
  const row = (day, key) => result.days[day - 1].accounts.find(account => account.key === key);
  assert.equal(row(1, 'gfs-line-249izgyn').new, 1);
  assert.equal(row(1, 'gfs-line-249izgyn').imported, 1);
  assert.equal(row(2, 'gfs-line-249izgyn').returning, 1);
  assert.equal(row(1, 'gfs-line-095jvuls').returning, 1);
  assert.equal(row(30, 'mhl-line-320opqkc').new, 1);
  assert.equal(row(3, 'car-line-fkq6145q').total, 0);
  assert.equal(row(3, 'car-line-fkq6145q').imported, 1);
  assert.equal(row(1, 'gfs-fb-101634951180913').company, 'MHL');
  assert.equal(row(1, 'mhl-fb-109607531869658').company, 'CAR');
  assert.ok(client.calls.some(call => call.table === 'line_intake_days' && call.start === 2));
  assert.equal(result.days.flatMap(day => day.accounts).reduce((sum, row) => sum + row.total, 0), 6);
});

test('empty months retain every day and failures never become zero-filled reports', async () => {
  const result = await getIntakeReport(database(), admin, { month: '2026-10' });
  assert.equal(result.days.length, 31);
  assert.ok(result.days.flatMap(day => day.accounts).every(row => row.total === 0 && row.imported === 0));
  await assert.rejects(getIntakeReport(database({}, 'facebook_intake_days'), admin, { month: '2026-10' }), error => error.status === 503);
});

test('existing daily API remains compatible', async () => {
  const result = await getIntakeReport({ rpc: async () => ({ data: { new: 2, total: 5, imported: 8 } }) }, admin, { date: '2026-09-23' });
  assert.equal(result.rows.length, 6);
  assert.equal(result.rows.find(row => row.company === 'GFS' && row.channel === 'LINE').total, 10);
});

test('delegated report reads query and return only granted channels', async () => {
  const membership = { role: 'sales', is_active: true, intakePermissions: { line: { view: true } } };
  const client = database();
  const result = await getIntakeReport(client, membership, { month: '2026-10' });
  assert.ok(result.days.every(day => day.accounts.length === 4 && day.accounts.every(account => account.channel === 'LINE')));
  assert.ok(client.calls.every(call => call.table.startsWith('line_')));
  const rpcCalls = [];
  const daily = await getIntakeReport({ rpc: async name => {
    rpcCalls.push(name); return { data: { new: 1, total: 2, imported: 0 } };
  } }, membership, { date: '2026-10-06' });
  assert.ok(rpcCalls.every(name => name === 'line_intake_daily_summary'));
  assert.ok(daily.rows.every(row => row.channel === 'LINE'));
  await assert.rejects(getIntakeReport(client, { role: 'sales', is_active: true,
    intakePermissions: { instagram: { view: true } } }, { month: '2026-10' }), error => error.status === 403);
});

test('single-page report excludes other pages in the same channel from queries and totals', async () => {
  const key = 'gfs-fb-101634951180913';
  const membership = { role: 'sales', is_active: true, intakePermissions: { facebook: {
    view: true, manage: true, accounts: { [key]: { view: true, manage: false } },
  } } };
  const client = database({ facebook_intake_days: [
    activity(key, '2026-10-06', '2026-10-06T01:00:00Z', 'allowed'),
    activity('gfs-fb-125106670932394', '2026-10-06', '2026-10-06T01:00:00Z', 'denied'),
  ] });
  const monthly = await getIntakeReport(client, membership, { month: '2026-10' });
  assert.ok(monthly.days.every(day => day.accounts.length === 1 && day.accounts[0].key === key));
  assert.equal(monthly.days[5].accounts[0].total, 1);
  const rpcKeys = [];
  const daily = await getIntakeReport({ rpc: async (name, input) => {
    rpcKeys.push(input.p_account); return { data: { new: 1, total: 1, imported: 0 } };
  } }, membership, { date: '2026-10-06' });
  assert.deepEqual(rpcKeys, [key]);
  assert.deepEqual(daily.rows.map(row => row.company), ['MHL']);
});

function browserHarness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', options: [{value:''},{value:'LINE'},{value:'FB'}], textContent: '', innerHTML: '', scrollLeft: 0, focus() { this.focused = true; },
      setAttribute() {},
    });
    return elements.get(id);
  };
  let isAdmin = true;
  let grants = [];
  let accountGrants = null;
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: element }, URL, Intl, Date,
    window: { canViewIntakeChannel: (channel, account) => isAdmin
      || (accountGrants ? account ? accountGrants[channel]?.includes(account) : accountGrants[channel]?.length > 0 : grants.includes(channel)) },
    isEmployeeAdministrator: () => isAdmin, escapeHtml: value => String(value),
    config: { crmApiUrl: 'http://localhost/api/crm' },
    crmFetch: url => new Promise(resolve => requests.push({ url, resolve })),
  });
  vm.runInContext(fs.readFileSync(require.resolve('./public/intake-reports.js'), 'utf8'), context);
  return { context, requests, element: suffix => element(`intake-report-${suffix}`),
    grant: channels => { isAdmin = false; grants = channels; accountGrants = null; },
    grantAccounts: value => { isAdmin = false; accountGrants = value; }, revoke: () => { isAdmin = false; grants = []; accountGrants = null; } };
}
async function response(month) {
  const result = await getIntakeReport(database(), admin, { month });
  const account = result.days[0].accounts.find(row => row.company === 'GFS' && row.channel === 'FB');
  account.new = 2; account.total = 3; account.returning = 1;
  const line = result.days[0].accounts.find(row => row.key === 'gfs-line-095jvuls');
  line.new = 4; line.total = 5; line.returning = 1;
  const returning = result.days[14].accounts.find(row => row.company === 'GFS' && row.channel === 'FB');
  returning.total = 1; returning.returning = 1;
  result.days.at(-1).accounts.find(row => row.company === 'MHL' && row.channel === 'LINE').imported = 1;
  return { ok: true, json: async () => result };
}

test('active dates expand LINE and FB immediately after the date and collapse independently', async () => {
  const h = browserHarness();
  h.element('month').value = '2026-10';
  const pending = h.context.loadIntakeReport();
  h.requests[0].resolve(await response('2026-10'));
  await pending;
  assert.equal((h.element('head').innerHTML.match(/toggleIntakeReportDay\(/g) || []).length, 3);
  assert.doesNotMatch(h.element('head').innerHTML, /วันที่ 2026-10-02/);
  assert.equal((h.element('body').innerHTML.match(/<tr /g) || []).length, 12);
  assert.doesNotMatch(h.element('head').innerHTML, /report-channel-column/);
  h.element('scroll').scrollLeft = 120;
  h.context.toggleIntakeReportDay(0, 'report-toggle-0');
  assert.equal(h.element('scroll').scrollLeft, 120);
  assert.match(h.element('head').innerHTML, /aria-expanded="true"/);
  const first = h.element('head').innerHTML;
  assert.ok(first.indexOf('LINE วันที่ 2026-10-01') > first.indexOf('ยุบช่องทาง วันที่ 2026-10-01'));
  assert.ok(first.indexOf('FB วันที่ 2026-10-01') > first.indexOf('LINE วันที่ 2026-10-01'));
  assert.ok(first.indexOf('ขยายช่องทาง วันที่ 2026-10-15') > first.indexOf('FB วันที่ 2026-10-01'));
  assert.match(h.element('body').innerHTML, /GFS คนทักทั้งหมด LINE วันที่ 2026-10-01: 5/);
  assert.match(h.element('body').innerHTML, /GFS คนทักทั้งหมด FB วันที่ 2026-10-01: 3/);
  assert.match(h.element('body').innerHTML, /GFS คนทักทั้งหมด วันที่ 2026-10-01: 8/);
  h.context.toggleIntakeReportDay(14);
  assert.equal((h.element('head').innerHTML.match(/report-channel-column/g) || []).length, 4);
  assert.match(h.element('body').innerHTML, /GFS คนทักทั้งหมด FB วันที่ 2026-10-15: 1/);
  h.context.toggleIntakeReportDay(0);
  assert.equal((h.element('head').innerHTML.match(/report-channel-column/g) || []).length, 2);
  assert.doesNotMatch(h.element('head').innerHTML, /LINE วันที่ 2026-10-01/);
  assert.match(h.element('head').innerHTML, /LINE วันที่ 2026-10-15/);
  h.context.toggleIntakeReportDay(14);
  assert.doesNotMatch(h.element('head').innerHTML, /report-channel-column/);
});

test('filters hide inactive days and expanded channels respect the selected channel', async () => {
  const h = browserHarness();
  const pending = h.context.loadIntakeReport();
  h.requests[0].resolve(await response('2026-10'));
  await pending;
  h.context.toggleIntakeReportDay(0);
  h.element('channel').value = 'LINE';
  h.context.renderIntakeReport();
  assert.match(h.element('head').innerHTML, /LINE วันที่ 2026-10-01/);
  assert.doesNotMatch(h.element('head').innerHTML, /FB วันที่ 2026-10-01/);
  assert.match(h.element('body').innerHTML, /GFS คนทักทั้งหมด วันที่ 2026-10-01: 5/);
  h.element('company').value = 'MHL';
  h.context.renderIntakeReport();
  assert.equal((h.element('head').innerHTML.match(/toggleIntakeReportDay\(/g) || []).length, 1);
  assert.match(h.element('head').innerHTML, /toggleIntakeReportDay\(30, this.id\)/);
  h.context.toggleIntakeReportDay(30);
  assert.match(h.element('body').innerHTML, /MHL คัดเข้า CRM LINE วันที่ 2026-10-31: 1/);
  h.element('company').value = 'CAR';
  h.context.renderIntakeReport();
  assert.match(h.element('body').innerHTML, /ไม่มีข้อมูลในเดือนนี้/);
  assert.match(h.element('status').textContent, /มีข้อมูล 0 วัน/);
});

test('late responses, month changes and logout cannot restore stale results or expansions', async () => {
  const h = browserHarness();
  const first = h.context.loadIntakeReport();
  const second = h.context.loadIntakeReport();
  h.requests[1].resolve(await response('2026-10'));
  await second;
  h.context.toggleIntakeReportDay(0);
  h.requests[0].resolve(await response('2026-09'));
  await first;
  assert.match(h.element('status').textContent, /10\/2026/);
  assert.match(h.element('head').innerHTML, /LINE วันที่ 2026-10-01/);
  const third = h.context.loadIntakeReport();
  h.requests[2].resolve(await response('2026-09'));
  await third;
  assert.doesNotMatch(h.element('head').innerHTML, /report-channel-column/);
  const fourth = h.context.loadIntakeReport();
  h.context.resetIntakeReport(); h.revoke();
  h.requests[3].resolve(await response('2026-10'));
  await fourth;
  assert.equal(h.element('status').textContent, '');
});

test('report columns and totals exclude a channel even if a stale response contains it', async () => {
  const h = browserHarness();
  h.grant(['line']);
  const pending = h.context.loadIntakeReport();
  h.requests[0].resolve(await response('2026-10'));
  await pending;
  h.context.toggleIntakeReportDay(0);
  assert.doesNotMatch(h.element('head').innerHTML, /FB วันที่/);
  assert.match(h.element('body').innerHTML, /GFS คนทักทั้งหมด วันที่ 2026-10-01: 5/);
  assert.equal(h.element('channel').options.find(option => option.value === 'FB').disabled, true);
});

test('report render excludes a denied same-company LINE OA from a stale response', async () => {
  const h = browserHarness();
  h.grantAccounts({ line: ['gfs-line-249izgyn'] });
  const pending = h.context.loadIntakeReport();
  h.requests[0].resolve(await response('2026-10')); await pending;
  h.context.toggleIntakeReportDay(0);
  assert.doesNotMatch(h.element('body').innerHTML, /GFS คนทักทั้งหมด วันที่ 2026-10-01: 5/);
  assert.doesNotMatch(h.element('body').innerHTML, /rowgroup.*MHL/);
});
