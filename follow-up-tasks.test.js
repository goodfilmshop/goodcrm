const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  bangkokDateKey,
  getFollowUpTasks,
  isFollowUpTaskRecord,
  sortFollowUpTaskRecords,
  summarizeFollowUpTasks,
} = require('./server');

const crmIndexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

test('editable case status fields have prominent styling and accessible native labels without affecting filters', () => {
  for (const id of ['caseJobStatus', 'leadFollowUpStatus']) {
    const statusSelect = crmIndexHtml.match(new RegExp(`<select\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert.ok(statusSelect, `${id} remains a native select`);
    assert.match(statusSelect, /\bclass="[^"]*\bcase-status-select\b/);
    assert.match(statusSelect, /\brequired\b/);
    assert.doesNotMatch(statusSelect, /\brole=/);
    const statusLabel = crmIndexHtml.match(new RegExp(`<label\\b[^>]*\\bfor="${id}"[^>]*>[\\s\\S]*?<\\/label>`))?.[0];
    assert.ok(statusLabel, `${id} has an explicitly associated label`);
    assert.match(statusLabel, /\bcase-status-label\b/);
    assert.match(statusLabel, /สถานะงาน/);
    assert.match(statusLabel, /fa-circle-dot[^>]*\baria-hidden="true"/);
  }
  for (const id of ['casesStatusFilter', 'legacyJobStatus']) {
    const unstyledSelect = crmIndexHtml.match(new RegExp(`<select\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert.ok(unstyledSelect);
    assert.doesNotMatch(unstyledSelect, /\bcase-status-select\b/);
  }
  const lockedStatus = crmIndexHtml.match(/<div\b[^>]*\bid="caseDetailStatus"[^>]*>/)?.[0];
  assert.ok(lockedStatus);
  assert.match(lockedStatus, /\baria-readonly="true"/);
  assert.doesNotMatch(lockedStatus, /\bcase-status-select\b/);
  assert.match(crmIndexHtml.match(/<select\b[^>]*\bid="caseJobStatus"[^>]*>/)[0], /\bonchange="syncCaseNextFollowUpFields\(\)"/);
  assert.match(crmIndexHtml, /getElementById\("leadFollowUpStatus"\)\?\.addEventListener\("change",\s*\(\)\s*=>\s*\{[^}]*syncLeadNextFollowUpField\(\)/);
});

test('prominent status styling is narrowly scoped and includes strong keyboard focus and disabled states', () => {
  const styles = [...crmIndexHtml.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
  const statusRules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(match => ({ selector: match[1].trim(), declarations: match[2] }))
    .filter(rule => rule.selector.includes('.case-status-select'));
  assert.ok(statusRules.length >= 4, 'status selects have base, hover, focus and disabled rules');
  for (const rule of statusRules) {
    for (const selector of rule.selector.split(',')) {
      assert.match(selector.trim(), /^#(?:page-create-lead #caseJobStatus|leadFollowUpForm #leadFollowUpStatus)\.case-status-select(?::[\s\S]+|\s+option)?$/, 'styles do not leak into status filters or unrelated selects');
    }
  }
  const baseRule = statusRules.find(rule => !rule.selector.includes(':'));
  assert.ok(baseRule);
  assert.match(baseRule.declarations, /min-height:\s*3rem\b/);
  assert.match(baseRule.declarations, /border:\s*2px\s+solid\s+#10b981\s*!important/);
  assert.match(baseRule.declarations, /background[^:]*:\s*linear-gradient\([^;]+\)\s*!important/);
  assert.match(baseRule.declarations, /color:\s*#065f46\b/);
  assert.match(baseRule.declarations, /font-weight:\s*800\b/);
  assert.match(baseRule.declarations, /font-size:\s*1rem\s*!important/);
  assert.doesNotMatch(baseRule.declarations, /\bappearance:\s*none\b/, 'the native select affordance is preserved');
  assert.ok(statusRules.some(rule => rule.selector.includes(':hover')));
  const focusRule = statusRules.find(rule => rule.selector.includes(':focus-visible'));
  assert.ok(focusRule, 'keyboard focus is visible');
  assert.match(focusRule.declarations, /outline:\s*3px\s+solid\s+#047857\b/);
  assert.match(focusRule.declarations, /outline-offset:\s*3px\b/);
  const disabledRule = statusRules.find(rule => rule.selector.includes(':disabled') && !rule.selector.includes(':not('));
  assert.ok(disabledRule);
  assert.match(disabledRule.declarations, /cursor:\s*not-allowed\b/);
});

function followUpScheduleUiForTest(now = '2026-08-31T18:45:00.000Z') {
  const fields = new Map();
  const element = id => {
    if (!fields.has(id)) {
      const listeners = {};
      const field = {
        value: '', dataset: {}, required: false, disabled: false, readOnly: false,
        textContent: '', focusCount: 0, attributes: {}, listeners,
        classList: { toggle(name, value) { this[name] = value; } },
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, callback) { listeners[name] = callback; },
        focus() { this.focusCount += 1; },
      };
      Object.defineProperty(field, 'innerHTML', {
        get() { return this.html || ''; },
        set(html) {
          this.html = html;
          if (id !== 'leadFollowUpDrawerContent') return;
          for (const match of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)) {
            fields.delete(match[1]); // Re-rendering a form creates fresh DOM/cache state.
            const input = element(match[1]);
            input.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
          }
          element('leadFollowUpStatus').value = html.match(/<option value="([^"]*)" selected>/)?.[1] || '';
        },
      });
      fields.set(id, field);
    }
    return fields.get(id);
  };
  const fixedDate = Date.parse(now);
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedDate])); }
    static now() { return fixedDate; }
  }
  const context = vm.createContext({
    Date: TestDate,
    document: { getElementById: element, querySelector() { return null; } },
    activeCaseDetail: null,
    CASE_STATUS_OPTIONS: [],
    openLeadFollowUpDrawer() {}, closeLeadFollowUpDrawer() {}, saveLeadFollowUp() {},
    syncLeadQuotationNumberFields() {}, syncLeadEvaluationFields() {},
    addLeadQuotationNumberField() {}, openLeadFollowUpQuotationComposer() {},
    escapeTimelineValue: value => String(value || ''),
    getCaseDetailOptions: (options, selected) => `<option value="${selected}" selected>${selected}</option>`,
  });
  const constantsStart = crmIndexHtml.indexOf('const CASE_APPOINTMENT_STATUSES');
  const constantsEnd = crmIndexHtml.indexOf('let measurementQueueSearchTerm', constantsStart);
  const normalizeStart = crmIndexHtml.indexOf('function normalizeTimelineStatus(value)');
  const normalizeEnd = crmIndexHtml.indexOf('function deriveCaseStatusStates', normalizeStart);
  const helpersStart = crmIndexHtml.indexOf('function dateTimeLocalToIso(');
  const helpersEnd = crmIndexHtml.indexOf('function normalizeChannel(', helpersStart);
  const renderStart = crmIndexHtml.indexOf('function renderLeadFollowUpForm(');
  const renderEnd = crmIndexHtml.indexOf('async function saveLeadFollowUp(', renderStart);
  vm.runInContext([
    crmIndexHtml.slice(constantsStart, constantsEnd),
    crmIndexHtml.slice(normalizeStart, normalizeEnd),
    crmIndexHtml.slice(helpersStart, helpersEnd),
    crmIndexHtml.slice(renderStart, renderEnd),
  ].join('\n'), context);
  return { context, element, fields };
}

test('three-day defaults use Bangkok calendar days and never override appointment statuses', () => {
  const { context } = followUpScheduleUiForTest(); // 1 September 01:45 Bangkok.
  assert.equal(context.defaultNextFollowUpLocalValue('ติดต่อสอบถาม'), '2026-09-04T00:00');
  assert.equal(context.defaultNextFollowUpLocalValue('ส่งใบเสนอราคา'), '2026-09-04T00:00');
  for (const status of ['เลื่อนคิว', 'นัดวัดพื้นที่', 'เซ็นต์สัญญา', 'เลื่อนนัด', 'นัดคิวติดตั้ง', 'แก้ไขงาน', 'เก็บซิลิโคลน']) {
    assert.equal(context.defaultNextFollowUpLocalValue(status), '', status);
  }
  assert.equal(context.defaultNextFollowUpLocalValue('เซ็นสัญญา'), '');
  assert.equal(context.defaultNextFollowUpLocalValue('ปิดงาน'), '2026-09-01T01:45');
  assert.equal(context.defaultNextFollowUpLocalValue('ยกเลิก'), '2026-09-01T01:45');
  assert.equal(context.toBangkokFollowUpLocalValue('2026-08-31T18:45:00.000Z'), '2026-09-01T01:45');
  assert.equal(context.toBangkokFollowUpLocalValue('invalid'), '');
});

test('new ordinary cases always collect day plus three with an optional editable time', () => {
  const { context, element } = followUpScheduleUiForTest();
  element('caseJobStatus').value = 'ติดต่อสอบถาม';
  context.syncCaseNextFollowUpFields();
  assert.equal(element('caseNextFollowUpScheduleField').classList.hidden, false);
  assert.equal(element('caseNextFollowUpScheduleField').attributes['aria-hidden'], 'false');
  assert.equal(element('caseNextFollowUpDate').value, '2026-09-04');
  assert.equal(element('caseNextFollowUpDate').readOnly, true);
  assert.equal(element('caseNextFollowUpDate').required, false);
  assert.equal(element('caseNextFollowUpTime').disabled, false);
  assert.equal(element('caseNextFollowUpTime').required, false);
  assert.match(element('caseNextFollowUpHelp').textContent, /ทุก 3 วัน/);
  assert.equal(context.getCaseNextFollowUpAt(), '2026-09-03T17:00:00.000Z');
  element('caseNextFollowUpDate').value = '2030-01-01'; // Ignore stale/tampered ordinary dates.
  element('caseNextFollowUpTime').value = '14:30';
  assert.equal(context.getCaseNextFollowUpAt(), '2026-09-04T07:30:00.000Z');
  context.syncCaseNextFollowUpFields();
  assert.equal(element('caseNextFollowUpDate').value, '2026-09-04');
  assert.equal(element('caseNextFollowUpTime').value, '14:30');
});

test('new-case appointments retain the specified date/time through same-status sync and status switches', () => {
  const { context, element } = followUpScheduleUiForTest();
  element('caseJobStatus').value = 'นัดคิวติดตั้ง';
  context.syncCaseNextFollowUpFields();
  assert.equal(element('caseNextFollowUpDate').value, '');
  assert.equal(element('caseNextFollowUpDate').readOnly, false);
  assert.equal(element('caseNextFollowUpDate').required, true);
  element('caseNextFollowUpDate').value = '2026-10-20';
  element('caseNextFollowUpTime').value = '09:15';
  context.syncCaseNextFollowUpFields();
  assert.equal(context.getCaseNextFollowUpAt(), '2026-10-20T02:15:00.000Z');
  element('caseJobStatus').value = 'ติดตามครั้งที่ 1';
  context.syncCaseNextFollowUpFields();
  assert.equal(element('caseNextFollowUpDate').value, '2026-09-04');
  element('caseNextFollowUpTime').value = '15:00';
  element('caseJobStatus').value = 'นัดวัดพื้นที่';
  context.syncCaseNextFollowUpFields();
  assert.equal(element('caseNextFollowUpDate').value, '');
  assert.equal(element('caseNextFollowUpTime').value, '');
  element('caseNextFollowUpDate').value = '2026-11-01';
  element('caseJobStatus').value = 'นัดคิวติดตั้ง';
  context.syncCaseNextFollowUpFields();
  assert.equal(element('caseNextFollowUpDate').value, '2026-10-20');
  assert.equal(element('caseNextFollowUpTime').value, '09:15');
  element('caseJobStatus').value = 'ติดตามครั้งที่ 2';
  context.syncCaseNextFollowUpFields();
  assert.equal(element('caseNextFollowUpTime').value, '15:00');
  context.resetCaseFollowUpScheduleState();
  element('caseNextFollowUpDate').value = '';
  element('caseNextFollowUpTime').value = '';
  element('caseJobStatus').value = 'นัดคิวติดตั้ง';
  context.syncCaseNextFollowUpFields();
  assert.equal(element('caseNextFollowUpDate').value, ''); // A new case cannot inherit the prior appointment cache.
  assert.equal(element('caseNextFollowUpTime').value, '');
  assert.match(crmIndexHtml, /function clearContactCaseForm[^]*?resetCaseFollowUpScheduleState\(\)/);
  assert.match(crmIndexHtml, /function resetForm\(\)\s*\{\s*resetCaseFollowUpScheduleState\(\)/);
  assert.match(crmIndexHtml, /resetCaseFollowUpScheduleState\(\);\s*document\.getElementById\("caseNextFollowUpDate"\)\.value = data\.nextFollowUpDate/);
});

test('opening appointment history preserves every queue-status schedule and isolates successive cases', () => {
  const { context, element } = followUpScheduleUiForTest();
  for (const status of ['เลื่อนคิว', 'นัดวัดพื้นที่', 'เซ็นต์สัญญา', 'เลื่อนนัด', 'นัดคิวติดตั้ง', 'แก้ไขงาน', 'เก็บซิลิโคลน']) {
    context.activeCaseDetail = { caseData: { logId: `CASE-${status}`, status, nextFollowUpAt: '2026-10-20T02:15:00.000Z' } };
    context.renderLeadFollowUpForm();
    assert.equal(element('leadNextFollowUpDate').value, '2026-10-20', status);
    assert.equal(element('leadNextFollowUpTime').value, '09:15', status);
    assert.equal(element('leadNextFollowUpDate').readOnly, false, status);
    assert.equal(element('leadNextFollowUpTime').disabled, false, status);
    assert.equal(context.getLeadNextFollowUpAt(), '2026-10-20T02:15:00.000Z', status);
    context.syncLeadNextFollowUpField();
    assert.equal(element('leadNextFollowUpDate').value, '2026-10-20', status);
  }
  context.activeCaseDetail = { caseData: { logId: 'CASE-NEW', status: 'นัดคิวติดตั้ง', nextFollowUpAt: '' } };
  context.renderLeadFollowUpForm();
  assert.equal(element('leadNextFollowUpDate').value, '');
  assert.equal(element('leadNextFollowUpTime').value, '');
  assert.equal(context.getLeadNextFollowUpAt(), '');
});

test('lead-history ordinary schedules are automatic while appointment drafts survive a return switch', () => {
  const { context, element } = followUpScheduleUiForTest();
  context.activeCaseDetail = { caseData: { logId: 'CASE-A', status: 'ติดตามครั้งที่ 1' } };
  context.renderLeadFollowUpForm();
  assert.equal(element('leadNextFollowUpDate').value, '2026-09-04');
  assert.equal(element('leadNextFollowUpDate').readOnly, true);
  assert.equal(element('leadNextFollowUpTime').disabled, false);
  assert.equal(context.getLeadNextFollowUpAt(), '2026-09-03T17:00:00.000Z');
  element('leadNextFollowUpDate').value = '2030-01-01';
  element('leadNextFollowUpTime').value = '11:40';
  assert.equal(context.getLeadNextFollowUpAt(), '2026-09-04T04:40:00.000Z');
  element('leadFollowUpStatus').value = 'เลื่อนนัด';
  context.syncLeadNextFollowUpField();
  assert.equal(element('leadNextFollowUpDate').value, '');
  element('leadNextFollowUpDate').value = '2026-12-31';
  element('leadNextFollowUpTime').value = '08:30';
  element('leadFollowUpStatus').value = 'ติดตามครั้งที่ 2';
  context.syncLeadNextFollowUpField();
  assert.equal(element('leadNextFollowUpTime').value, '11:40');
  element('leadFollowUpStatus').value = 'เลื่อนนัด';
  context.syncLeadNextFollowUpField();
  assert.equal(element('leadNextFollowUpDate').value, '2026-12-31');
  assert.equal(element('leadNextFollowUpTime').value, '08:30');
});

test('final cases do not get new-case schedules and history retains the existing current timestamp UI', () => {
  const { context, element } = followUpScheduleUiForTest();
  for (const status of ['ยกเลิก', 'ปิดงาน']) {
    element('caseJobStatus').value = status;
    context.syncCaseNextFollowUpFields();
    assert.equal(element('caseNextFollowUpScheduleField').classList.hidden, true);
    assert.equal(context.getCaseNextFollowUpAt(), '');
    context.activeCaseDetail = { caseData: { logId: 'CASE-FINAL', status } };
    context.renderLeadFollowUpForm();
    assert.equal(element('leadNextFollowUpDate').value, '2026-09-01');
    assert.equal(element('leadNextFollowUpTime').value, '01:45');
    assert.equal(element('leadNextFollowUpDate').readOnly, true);
    assert.equal(element('leadNextFollowUpTime').disabled, true);
    assert.equal(context.getLeadNextFollowUpAt(), '2026-08-31T18:45:00.000Z');
  }
});

test('first case uses a supported status and normalizes legacy drafts without changing other statuses', () => {
  const field = { value: '', dataset: {}, disabled: false, required: true };
  const context = vm.createContext({
    document: { getElementById: id => id === 'caseJobStatus' ? field : { classList: { toggle() {} } } },
    syncCaseNextFollowUpFields() {},
  });
  const start = crmIndexHtml.indexOf('function isMeasurementCaseTopic(');
  const end = crmIndexHtml.indexOf('function syncCaseNextFollowUpFields(', start);
  vm.runInContext(crmIndexHtml.slice(start, end), context);
  context.syncCaseInitialStatus(true);
  assert.equal(field.value, 'ติดต่อสอบถาม');
  assert.equal(field.disabled, true);
  assert.equal(field.required, false);
  field.value = 'เพิ่มเคสใหม่';
  context.syncCaseInitialStatus(false);
  assert.equal(field.value, 'ติดต่อสอบถาม');
  assert.equal(field.disabled, false);
  assert.equal(field.required, true);
  field.value = 'ส่งใบเสนอราคา';
  context.syncCaseInitialStatus(false);
  assert.equal(field.value, 'ส่งใบเสนอราคา');
  const statusSelect = crmIndexHtml.match(/<select id="caseJobStatus"[\s\S]*?<\/select>/)[0];
  assert.ok(!statusSelect.includes('value="เพิ่มเคสใหม่"'));
  assert.ok(statusSelect.includes('value="ติดต่อสอบถาม"'));
});
const crmServerSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('measurement topics override initial status, require an appointment and restore status when changed', () => {
  const fields = new Map();
  const element = id => {
    if (!fields.has(id)) fields.set(id, {
      value: '', dataset: {}, required: false, disabled: false,
      classList: { toggle(name, value) { this[name] = value; } }, setAttribute() {},
    });
    return fields.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element },
    statusRequiresCaseAppointment: status => status === 'นัดวัดพื้นที่',
    normalizeTimelineStatus: value => String(value || '').trim(),
    defaultNextFollowUpLocalValue: () => '2026-09-04T00:00',
  });
  const start = crmIndexHtml.indexOf('function isMeasurementCaseTopic(');
  const end = crmIndexHtml.indexOf('function getCaseNextFollowUpAt(', start);
  vm.runInContext(crmIndexHtml.slice(start, end), context);
  for (const topic of ['นัดสำรวจหน้างาน', 'นัดวัดหน้างาน', 'นัดวัดพื้นที่']) {
    element('topic').value = topic;
    context.syncCaseInitialStatus(true);
    assert.equal(element('caseJobStatus').value, 'นัดวัดพื้นที่');
    assert.equal(element('caseNextFollowUpDate').required, true);
    context.syncCaseInitialStatus(); // Reading/saving the draft must retain the override.
    assert.equal(element('caseJobStatus').value, 'นัดวัดพื้นที่');
    element('topic').value = 'สอบถามสินค้า';
    context.syncCaseInitialStatus();
    assert.equal(element('caseJobStatus').value, 'ติดต่อสอบถาม');
    assert.equal(element('caseNextFollowUpDate').required, false);
  }
  context.syncCaseInitialStatus(false);
  element('caseJobStatus').value = 'ประเมินราคา';
  element('topic').value = 'นัดสำรวจหน้างาน';
  context.syncCaseInitialStatus();
  element('topic').value = 'สอบถามสินค้า';
  context.syncCaseInitialStatus();
  assert.equal(element('caseJobStatus').value, 'ประเมินราคา');
});

test('follow-up tasks keep only actionable cases with valid dates and sort due ascending', () => {
  const records = sortFollowUpTaskRecords([
    {
      caseId: 'CASE-LATE',
      status: 'ติดตามครั้งที่ 2',
      latestFollowUpStatus: 'ติดตามครั้งที่ 2',
      nextFollowUpAt: '2026-08-29T03:00:00.000Z',
    },
    {
      caseId: 'CASE-EARLY',
      status: 'ส่งใบเสนอราคา',
      latestFollowUpStatus: 'ส่งใบเสนอราคา',
      nextFollowUpAt: '2026-08-22T03:00:00.000Z',
    },
    {
      caseId: 'CASE-CLOSED',
      status: 'ปิดงาน',
      latestFollowUpStatus: 'ปิดงาน',
      nextFollowUpAt: '2026-08-21T03:00:00.000Z',
    },
    {
      caseId: 'CASE-REOPENED',
      status: 'ติดตามครั้งที่ 1',
      latestFollowUpStatus: 'ยกเลิก',
      nextFollowUpAt: '2026-08-21T03:00:00.000Z',
    },
    {
      caseId: 'CASE-BAD-DATE',
      status: 'ติดตามครั้งที่ 1',
      latestFollowUpStatus: 'ติดตามครั้งที่ 1',
      nextFollowUpAt: 'not-a-date',
    },
  ]);

  assert.deepEqual(records.map(record => record.caseId), ['CASE-REOPENED', 'CASE-EARLY', 'CASE-LATE']);
  assert.equal(isFollowUpTaskRecord(records[0]), true);
});

test('follow-up summary uses Bangkok calendar dates and a seven-day upcoming window', () => {
  const generatedAt = new Date('2026-08-21T05:00:00.000Z'); // 12:00 in Bangkok
  const records = [
    { nextFollowUpAt: '2026-08-20T02:00:00.000Z' }, // 20 Aug Bangkok
    { nextFollowUpAt: '2026-08-20T17:30:00.000Z' }, // 21 Aug Bangkok
    { nextFollowUpAt: '2026-08-21T17:00:00.000Z' }, // 22 Aug Bangkok
    { nextFollowUpAt: '2026-08-28T02:00:00.000Z' }, // 28 Aug Bangkok (+7)
    { nextFollowUpAt: '2026-08-29T02:00:00.000Z' }, // 29 Aug Bangkok (+8)
  ];

  assert.equal(bangkokDateKey('2026-08-20T17:00:00.000Z'), '2026-08-21');
  assert.deepEqual(summarizeFollowUpTasks(records, generatedAt), {
    total: 5,
    overdue: 1,
    today: 1,
    upcoming: 2,
    later: 1,
  });
});

test('getFollowUpTasks paginates all RLS-visible case rows past server row caps', async () => {
  const rawRows = Array.from({ length: 1001 }, (_, index) => ({
    id: String(index).padStart(4, '0'),
    legacy_case_id: `CASE-${String(index).padStart(4, '0')}`,
    status: 'ติดตามครั้งที่ 1',
    admin_name: `แอดมิน ${index}`,
    site_type: 'สำนักงาน',
    site_address: `ที่อยู่ ${index}`,
    province: 'กรุงเทพมหานคร',
    salesperson: '',
    salesperson_employee_id: null,
    customers: {
      legacy_cust_id: `CUST-${index}`,
      customer_name: `ลูกค้า ${index}`,
      phone: `08${String(index).padStart(8, '0')}`,
    },
    latest_follow_up: [{
      current_status: 'ติดตามครั้งที่ 1',
      next_follow_up_at: '2026-08-29T02:00:00.000Z',
      followed_at: '2026-08-20T02:00:00.000Z',
      created_at: '2026-08-20T02:00:00.000Z',
      notes: `ติดตามเคส ${index}`,
      id: `follow-up-${index}`,
    }],
  }));
  const requestedRanges = [];
  const requestedCursors = [];
  const selectedColumns = [];
  const embeddedOrders = [];
  const queryFilters = [];
  const simulatedServerRowCap = 137;
  const client = {
    from(table) {
      assert.equal(table, 'cases');
      let afterId = '';
      return {
        select(columns) {
          selectedColumns.push(columns);
          return this;
        },
        not(column, operator, value) {
          queryFilters.push([column, operator, value]);
          return this;
        },
        order(column, options) {
          if (options?.referencedTable === 'latest_follow_up') embeddedOrders.push(column);
          return this;
        },
        limit() { return this; },
        gt(column, value) {
          assert.equal(column, 'id');
          afterId = value;
          return this;
        },
        async range(from, to) {
          requestedRanges.push([from, to]);
          requestedCursors.push(afterId);
          const eligibleRows = rawRows.filter(row => !afterId || row.id > afterId);
          const responseSize = Math.min(to - from + 1, simulatedServerRowCap);
          return { data: eligibleRows.slice(from, from + responseSize), error: null };
        },
      };
    },
  };

  const result = await getFollowUpTasks(client, new Date('2026-08-21T05:00:00.000Z'));

  assert.equal(result.success, true);
  assert.equal(result.tasks.length, 1001);
  assert.equal(result.tasks[0].caseId, 'CASE-0000');
  assert.equal(result.tasks[0].status, 'ติดตามครั้งที่ 1');
  assert.equal(result.tasks[0].admin, 'แอดมิน 0');
  assert.equal(result.tasks[0].siteType, 'สำนักงาน');
  assert.equal(result.tasks[0].siteAddress, 'ที่อยู่ 0');
  assert.equal(result.tasks[0].province, 'กรุงเทพมหานคร');
  assert.equal(result.tasks[0].latestFollowUpStatus, 'ติดตามครั้งที่ 1');
  assert.equal(result.tasks[0].latestContactDetails, 'ติดตามเคส 0');
  assert.equal(result.tasks[0].nextFollowUpAt, '2026-08-23T02:00:00.000Z');
  assert.deepEqual(result.summary, { total: 1001, overdue: 0, today: 0, upcoming: 1001, later: 0 });
  assert.equal(result.generatedAt, '2026-08-21T05:00:00.000Z');
  assert.ok(requestedRanges.length > 3);
  assert.ok(requestedRanges.every(range => range[0] === 0 && range[1] === 499));
  assert.equal(requestedCursors[0], '');
  assert.equal(requestedCursors.at(-1), '1000');
  assert.match(selectedColumns[0], /latest_follow_up:lead_follow_up_history\(/);
  assert.doesNotMatch(selectedColumns[0], /latest_follow_up:lead_follow_up_history!inner/);
  assert.match(selectedColumns[0], /admin_name[^]*salesperson[^]*salesperson_employee_id/);
  assert.match(selectedColumns[0], /site_type[^]*site_address[^]*province/);
  assert.doesNotMatch(selectedColumns[0], /quotation_history|lead_follow_up_history\(count\)/);
  assert.deepEqual(queryFilters[0], ['status', 'in', '("ยกเลิก","ปิดงาน")']);
  assert.deepEqual(embeddedOrders.slice(0, 3), ['followed_at', 'created_at', 'id']);
});

test('getFollowUpTasks reports an unapplied follow-up migration clearly', async () => {
  const client = {
    from() {
      return {
        select() { return this; },
        not() { return this; },
        order() { return this; },
        limit() { return this; },
        async range() {
          return {
            data: null,
            error: { code: 'PGRST200', message: 'relationship is missing from the schema cache' },
          };
        },
      };
    },
  };

  await assert.rejects(
    () => getFollowUpTasks(client),
    error => error?.status === 503 && error?.code === 'FOLLOW_UP_TABLE_NOT_READY'
  );
});

test('existing ordinary cases without history become actionable without writes while appointment dates and final cases stay intact', async () => {
  const rows = [
    {
      id: '1', legacy_case_id: 'CASE-NO-HISTORY', status: 'ติดต่อสอบถาม',
      recorded_at: '2026-08-31T18:45:00.000Z', latest_follow_up: [],
      customers: { legacy_cust_id: 'CUST-1', customer_name: 'ลูกค้า' },
    },
    {
      id: '2', legacy_case_id: 'CASE-CANCELLED', status: 'ยกเลิก',
      recorded_at: '2026-08-31T18:45:00.000Z', latest_follow_up: [],
    },
    {
      id: '3', legacy_case_id: 'CASE-CLOSED', status: 'ปิดงาน',
      recorded_at: '2026-08-31T18:45:00.000Z',
      latest_follow_up: [{ current_status: 'ติดต่อสอบถาม', next_follow_up_at: '2026-10-01T01:00:00.000Z' }],
    },
    {
      id: '4', legacy_case_id: 'CASE-APPOINTMENT', status: 'นัดคิวติดตั้ง',
      recorded_at: '2026-08-31T18:45:00.000Z',
      latest_follow_up: [{ current_status: 'นัดคิวติดตั้ง', next_follow_up_at: '2026-10-20T02:15:00.000Z' }],
    },
    {
      id: '5', legacy_case_id: 'CASE-APPOINTMENT-UNSCHEDULED', status: 'นัดวัดพื้นที่',
      recorded_at: '2026-08-31T18:45:00.000Z', latest_follow_up: [],
    },
    {
      id: '6', legacy_case_id: 'CASE-REOPENED', status: 'ติดตามครั้งที่ 1',
      recorded_at: '2026-09-02T03:00:00.000Z',
      latest_follow_up: [{ current_status: 'ปิดงาน', followed_at: '2026-08-31T18:45:00.000Z', next_follow_up_at: '2026-08-31T18:45:00.000Z' }],
    },
  ];
  const selectedColumns = [];
  const client = {
    from(table) {
      assert.equal(table, 'cases');
      let afterId = '';
      return {
        select(columns) { selectedColumns.push(columns); return this; },
        not() { return this; }, order() { return this; }, limit() { return this; },
        gt(column, value) { assert.equal(column, 'id'); afterId = value; return this; },
        async range() { return { data: rows.filter(row => !afterId || row.id > afterId), error: null }; },
        insert() { assert.fail('Reading existing case schedules must not insert synthetic history'); },
        update() { assert.fail('Reading existing case schedules must not update history'); },
        delete() { assert.fail('Reading existing case schedules must not delete history'); },
      };
    },
  };
  const result = await getFollowUpTasks(client, new Date('2026-09-10T03:00:00.000Z'));
  assert.deepEqual(result.tasks.map(task => task.caseId), ['CASE-NO-HISTORY', 'CASE-REOPENED', 'CASE-APPOINTMENT']);
  assert.equal(result.tasks[0].nextFollowUpAt, '2026-09-03T17:00:00.000Z');
  assert.equal(result.tasks[1].nextFollowUpAt, '2026-09-04T18:45:00.000Z');
  assert.equal(result.tasks[2].nextFollowUpAt, '2026-10-20T02:15:00.000Z');
  assert.doesNotMatch(selectedColumns[0], /latest_follow_up:lead_follow_up_history!inner/);
  assert.match(selectedColumns[0], /recorded_at[^]*created_at/);
  assert.deepEqual(result.summary, { total: 3, overdue: 2, today: 0, upcoming: 0, later: 1 });
  assert.equal(rows[0].latest_follow_up.length, 0);
});

test('follow-up task center keeps its reminder, refresh, and existing-drawer integration hooks', () => {
  assert.match(crmIndexHtml, /id="followUpTasksBadge"/);
  assert.match(crmIndexHtml, /id="followUpTasksGroups"/);
  assert.match(crmIndexHtml, /searchParams\.set\('action', 'getFollowUpTasks'\)/);
  assert.match(crmIndexHtml, /Array\.isArray\(result\.tasks\)/);
  assert.match(crmIndexHtml, /countFollowUpTasksDueTomorrow\(\)/);
  assert.match(crmIndexHtml, /updateFollowUpTasksBadge\([\s\S]*countFollowUpTasksDueTomorrow\(\)/);
  assert.match(crmIndexHtml, /setInterval\([\s\S]*FOLLOW_UP_TASKS_POLL_INTERVAL_MS/);
  assert.match(crmIndexHtml, /FOLLOW_UP_TASKS_POLL_INTERVAL_MS = 5 \* 60 \* 1000/);
  assert.match(crmIndexHtml, /followUpTasksAbortController && !force/);
  assert.match(crmIndexHtml, /signal: requestController\.signal/);
  assert.match(crmIndexHtml, /visibilitychange[\s\S]*loadFollowUpTasks\(\{ silent: true \}\)/);
  assert.match(crmIndexHtml, /saveLeadFollowUp[\s\S]*loadFollowUpTasks\(\{ force: true, silent: true \}\)/);
  assert.match(crmIndexHtml, /openCaseDetailDrawer\(/);
  assert.match(crmIndexHtml, /openLeadFollowUpForm\(/);
  assert.doesNotMatch(crmIndexHtml, /function followUpTaskToCaseData/);
  assert.match(crmIndexHtml, /โหลดข้อมูลเคสฉบับเต็มไม่สำเร็จ/);
});

test('case detail editor chooses an admin from the active Admin Sale employee list', () => {
  const editorStart = crmIndexHtml.indexOf('async function renderCaseDetailEditor');
  const editorEnd = crmIndexHtml.indexOf('function addLeadQuotationNumberField', editorStart);
  const editorSource = crmIndexHtml.slice(editorStart, editorEnd);

  assert.ok(editorStart >= 0 && editorEnd > editorStart);
  assert.match(editorSource, /<select id="caseDetailAdmin"/);
  assert.doesNotMatch(editorSource, /<input id="caseDetailAdmin"/);
  assert.match(editorSource, /fetchAdminSaleEmployees\("caseDetailAdmin", item\.admin\)/);
  assert.match(crmIndexHtml, /async function fetchAdminSaleEmployees\(selectId = "adminName", fallbackAdmin = ""\)/);
  assert.match(crmIndexHtml, /employeeUrl\.searchParams\.set\("position", "Admin Sale"\)/);
});

test('evaluation status exposes and submits panel-count and square-meter fields', () => {
  const followUpStart = crmIndexHtml.indexOf('function renderLeadFollowUpForm');
  const followUpEnd = crmIndexHtml.indexOf('async function saveLeadFollowUp', followUpStart);
  const followUpSource = crmIndexHtml.slice(followUpStart, followUpEnd);
  const saveEnd = crmIndexHtml.indexOf('async function ', followUpEnd + 1);
  const saveSource = crmIndexHtml.slice(followUpEnd, saveEnd);

  assert.ok(followUpStart >= 0 && followUpEnd > followUpStart && saveEnd > followUpEnd);
  assert.match(followUpSource, /id="leadEvaluationSection"/);
  assert.match(followUpSource, /id="leadEvaluationPanelCount"/);
  assert.match(followUpSource, /id="leadEvaluationAreaSqM"/);
  assert.match(followUpSource, /syncLeadEvaluationFields\(\)/);
  assert.match(crmIndexHtml, /status !== "ประเมินราคา"/);
  assert.match(saveSource, /evaluationPanelCount: status === "ประเมินราคา"/);
  assert.match(saveSource, /evaluationAreaSqM: status === "ประเมินราคา"/);
});

test('follow-up task center renders a stable responsive four-column Kanban board', () => {
  const rendererStart = crmIndexHtml.indexOf('function followUpTaskGroupMeta');
  const rendererEnd = crmIndexHtml.indexOf('async function loadFollowUpTasks', rendererStart);
  const rendererSource = crmIndexHtml.slice(rendererStart, rendererEnd);

  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart);
  assert.doesNotMatch(crmIndexHtml, /aria-label="สรุปงานติดตาม"/);
  assert.doesNotMatch(crmIndexHtml, /followUpTasks(?:Overdue|Today|Upcoming|Later)Count/);
  assert.match(crmIndexHtml, /id="followUpTasksGroups" data-follow-up-kanban/);
  assert.match(crmIndexHtml, /followUpTasksGroups"[^>]*overflow-x-auto[^>]*overscroll-x-contain/);
  assert.match(rendererSource, /grid min-w-\[1120px\] grid-cols-4/);
  assert.match(rendererSource, /const bucketOrder = \['overdue', 'today', 'upcoming', 'later'\]/);
  assert.match(rendererSource, /data-follow-up-kanban-column="\$\{bucket\}"/);
  assert.match(rendererSource, /filteredTasks\.filter\(item => getFollowUpTaskBucket\(item\) === bucket\)/);
  assert.match(rendererSource, /ไม่มีงานในหมวดนี้/);
  assert.doesNotMatch(rendererSource, /if \(!items\.length\) return ''/);
  assert.doesNotMatch(rendererSource, /if \(!filteredTasks\.length\)/);
  assert.match(rendererSource, /data-follow-up-task-card/);
  assert.match(rendererSource, /data-follow-up-task-action="open"/);
  assert.doesNotMatch(rendererSource, /data-follow-up-task-action="record"/);
  assert.doesNotMatch(rendererSource, /draggable\s*=|dragstart|drop\s*\(/i);
  assert.equal(
    (crmIndexHtml.match(/onclick="void handleFollowUpTaskListClick\(event\)"/g) || []).length,
    1
  );
});

test('follow-up task center adds a semantic detailed-list tab without replacing Kanban', () => {
  const rendererStart = crmIndexHtml.indexOf('function renderFollowUpTasks');
  const rendererEnd = crmIndexHtml.indexOf('function handleFollowUpTasksSearch', rendererStart);
  const rendererSource = crmIndexHtml.slice(rendererStart, rendererEnd);
  const listStart = crmIndexHtml.indexOf('function renderFollowUpTaskListView');
  const listEnd = crmIndexHtml.indexOf('function handleFollowUpTasksSearch', listStart);
  const listSource = crmIndexHtml.slice(listStart, listEnd);
  const headers = [
    'สถานะงาน',
    'วันที่',
    'เวลา',
    'บริษัท',
    'ชื่อลูกค้า',
    'เบอร์โทร',
    'ที่อยู่',
    'เลขที่ใบเสนอราคา',
    'ยอดเงินรวม',
    'รายละเอียดการติดต่อ (ล่าสุด)',
    'แอดมิน',
    'ฝ่ายขาย',
  ];

  assert.match(crmIndexHtml, /role="tablist" aria-label="รูปแบบการแสดงงานติดตาม"/);
  assert.match(crmIndexHtml, /id="followUpTasksKanbanTab"[^>]*role="tab"[^>]*aria-selected="true"[^>]*aria-controls="followUpTasksGroups"/);
  assert.match(crmIndexHtml, /id="followUpTasksListTab"[^>]*role="tab"[^>]*aria-selected="false"[^>]*aria-controls="followUpTasksListView"/);
  assert.match(crmIndexHtml, /fa-table-columns[^>]*><\/i><span>การ์ด<\/span>/);
  assert.doesNotMatch(crmIndexHtml, /<span>คัมบัง<\/span>/);
  assert.match(crmIndexHtml, /id="followUpTasksViews" onclick="void handleFollowUpTaskListClick\(event\)"/);
  assert.match(crmIndexHtml, /id="followUpTasksGroups"[^>]*role="tabpanel"[^>]*aria-labelledby="followUpTasksKanbanTab"/);
  assert.match(crmIndexHtml, /id="followUpTasksListView"[^>]*role="tabpanel"[^>]*aria-labelledby="followUpTasksListTab"/);
  assert.match(rendererSource, /if \(followUpTaskView === 'list'\) \{\s*renderFollowUpTaskListView\(filteredTasks, hasActiveFilters\)/);
  assert.match(rendererSource, /const filteredTasks = followUpTasks\.filter\(item => matchesFollowUpTaskFilters\(item\)\)/);
  assert.equal((listSource.match(/<th scope="col"/g) || []).length, 12);
  let previousPosition = -1;
  headers.forEach(header => {
    const position = listSource.indexOf(`>${header}</th>`);
    assert.ok(position > previousPosition, `missing or out-of-order list header: ${header}`);
    previousPosition = position;
  });
  assert.match(listSource, /min-w-\[1680px\]/);
  assert.match(listSource, /text-sm font-normal/);
  assert.match(listSource, /const status = normalizeTimelineStatus\(item\?\.status\) \|\| 'ไม่ระบุสถานะ'/);
  assert.match(listSource, /const statusTone = getLeadCaseStatusTone\(status\)/);
  assert.match(listSource, /item\?\.customerPhone/);
  assert.match(listSource, /getFollowUpTaskSiteAddress\(item\)/);
  assert.match(listSource, /truncate whitespace-nowrap px-2 py-2\.5 text-slate-700" title="\$\{escapeHtml\(siteAddress\)\}"/);
  assert.doesNotMatch(listSource, /item\?\.province/);
  assert.doesNotMatch(listSource, /item\?\.siteType/);
  assert.doesNotMatch(listSource, /item\?\.topic/);
  assert.match(listSource, /item\?\.admin/);
  assert.match(listSource, /item\?\.salesperson/);
  assert.match(listSource, /item\?\.latestContactDetails/);
  assert.match(listSource, /data-follow-up-task-row/);
  assert.match(listSource, /data-follow-up-task-action="open"/);
  assert.match(listSource, /const bucketOrder = \['overdue', 'today', 'upcoming', 'later'\]/);
  assert.match(listSource, /data-follow-up-list-group="\$\{bucket\}"/);
  assert.match(listSource, /bucketItems\.length/);
  assert.match(listSource, /\$\{meta\.label\}/);
});

test('detailed follow-up list lazy-loads quotation documents and keeps the Kanban query lightweight', () => {
  const viewStart = crmIndexHtml.indexOf('function syncFollowUpTaskViewTabs');
  const viewEnd = crmIndexHtml.indexOf('function followUpTaskGroupMeta', viewStart);
  const viewSource = crmIndexHtml.slice(viewStart, viewEnd);

  assert.match(viewSource, /async function ensureFollowUpTaskQuotationData\(\)/);
  assert.match(viewSource, /async function ensureFollowUpTaskCaseData\(\)/);
  assert.match(viewSource, /if \(quotationDataLoaded \|\| followUpTaskQuotationLoading \|\| !followUpTasks\.length\)/);
  assert.match(viewSource, /const loaded = await fetchQuotations\(\)/);
  assert.match(viewSource, /const loaded = await fetchCasesData\(\)/);
  assert.match(viewSource, /await Promise\.all\(\[/);
  assert.match(crmServerSource, /\.not\('quotation_numbers', 'eq', '\{\}'\)/);
  assert.match(crmIndexHtml, /quotationDataLoaded = true/);
});

test('detailed follow-up list falls back to authoritative case data for a missing address', () => {
  const addressStart = crmIndexHtml.indexOf('function getFollowUpTaskSiteAddress');
  const addressEnd = crmIndexHtml.indexOf('function getFollowUpTaskQuotationTotal', addressStart);
  const addressSource = crmIndexHtml.slice(addressStart, addressEnd);
  const context = {
    allCases: [{ caseId: 'CASE-1', siteAddress: '25/7 ถนนสุขุมวิท' }],
  };

  vm.runInNewContext(`${addressSource}\nresult = [
    getFollowUpTaskSiteAddress({ caseId: 'CASE-1', siteAddress: '' }),
    getFollowUpTaskSiteAddress({ caseId: 'CASE-1', siteAddress: 'ที่อยู่จากรายการติดตาม' })
  ];`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), [
    '25/7 ถนนสุขุมวิท',
    'ที่อยู่จากรายการติดตาม',
  ]);
});

test('detailed follow-up list deduplicates quotation numbers and prefers an available snapshot', () => {
  const entriesStart = crmIndexHtml.indexOf('function getFollowUpTaskQuotationEntries');
  const entriesEnd = crmIndexHtml.indexOf('function getFollowUpTaskQuotationTotal', entriesStart);
  const entriesSource = crmIndexHtml.slice(entriesStart, entriesEnd);
  const snapshot = { items: [{ description: 'ฟิล์ม', quantity: 1, unitPrice: 100 }] };
  const context = {
    allQuotations: [
      { caseId: 'CASE-1', quoteNumber: 'QT-001', quotationSnapshot: null },
      { caseId: 'CASE-1', quoteNumber: 'QT-001', quotationSnapshot: snapshot },
      { caseId: 'CASE-1', quoteNumber: 'QT-002', quotationSnapshot: null },
      { caseId: 'CASE-2', quoteNumber: 'QT-999', quotationSnapshot: snapshot },
    ],
  };

  vm.runInNewContext(`${entriesSource}\nresult = getFollowUpTaskQuotationEntries('CASE-1');`, context);
  const result = JSON.parse(JSON.stringify(context.result));
  assert.deepEqual(result.map(entry => entry.quoteNumber), ['QT-001', 'QT-002']);
  assert.deepEqual(result[0].quotationSnapshot, snapshot);
  assert.equal(result[1].quotationSnapshot, null);
});

test('quotation total shown in the follow-up list uses the existing discount and VAT formula', () => {
  const amountStart = crmIndexHtml.indexOf('function quotationAmount');
  const amountEnd = crmIndexHtml.indexOf('function formatQuotationAmount', amountStart);
  const discountStart = crmIndexHtml.indexOf('function isQuotationDiscount');
  const discountEnd = crmIndexHtml.indexOf('function quotationImageCaseFolder', discountStart);
  const totalsStart = crmIndexHtml.indexOf('function calculateCaseQuotationTotals');
  const totalsEnd = crmIndexHtml.indexOf('function updateCaseQuotationTotals', totalsStart);
  const context = {};

  vm.runInNewContext(`${crmIndexHtml.slice(amountStart, amountEnd)}\n${crmIndexHtml.slice(discountStart, discountEnd)}\n${crmIndexHtml.slice(totalsStart, totalsEnd)}\nresult = calculateCaseQuotationTotals({ items: [
    { description: 'สินค้า', quantity: 2, unit: 'ชิ้น', unitPrice: 100 },
    { description: 'ส่วนลด', quantity: 1, unit: 'ส่วนลด', unitPrice: 10, isDiscount: true }
  ] });`, context);
  assert.equal(context.result.subtotal, 200);
  assert.equal(context.result.discount, 10);
  assert.equal(context.result.total, 203.3);
  const listStart = crmIndexHtml.indexOf('function renderFollowUpTaskListView');
  const listEnd = crmIndexHtml.indexOf('function handleFollowUpTasksSearch', listStart);
  const listSource = crmIndexHtml.slice(listStart, listEnd);
  assert.doesNotMatch(listSource, /formatQuotationAmount\(total\)\)\} บาท/);
  assert.match(listSource, /text-right font-bold text-slate-800/);
  assert.match(listSource, /text-right font-bold">ยอดเงินรวม<\/th>/);
});

test('follow-up owner filter composes with search before Kanban bucketing', () => {
  const rendererStart = crmIndexHtml.indexOf('function matchesFollowUpTaskFilters');
  const rendererEnd = crmIndexHtml.indexOf('async function loadFollowUpTasks', rendererStart);
  const rendererSource = crmIndexHtml.slice(rendererStart, rendererEnd);

  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart);
  assert.match(crmIndexHtml, /<label for="followUpTasksOwnerFilter"[^>]*>กรองตามผู้รับผิดชอบ<\/label>/);
  assert.match(crmIndexHtml, /id="followUpTasksOwnerFilter"[^>]*onchange="handleFollowUpTasksOwnerFilter\(\)"[^>]*aria-label="กรองตามผู้รับผิดชอบ"/);
  assert.match(crmIndexHtml, /let followUpTaskOwnerFilter = ''/);
  assert.match(crmIndexHtml, /function getFollowUpTaskOwner\(item\)/);
  assert.match(crmIndexHtml, /key: `admin:name:\$\{normalizeCasesSearchValue\(admin\)\}`/);
  assert.match(crmIndexHtml, /label: `\$\{admin\} \(แอดมิน\)`/);
  assert.match(rendererSource, /getFollowUpTaskSearchText\(item\)\.includes\(normalizedSearch\)/);
  assert.match(rendererSource, /const matchesSearch = [^;]+;/);
  assert.match(rendererSource, /const matchesOwner = !ownerFilter \|\| getFollowUpTaskOwnerKey\(item\) === ownerFilter;/);
  assert.match(rendererSource, /return matchesSearch && matchesOwner;/);
  assert.match(rendererSource, /const filteredTasks = followUpTasks\.filter\(item => matchesFollowUpTaskFilters\(item\)\)/);
  assert.match(rendererSource, /ownerOptions = new Map\(\)/);
  assert.match(rendererSource, /localeCompare\(right\[1\], 'th-TH'\)/);
  assert.match(rendererSource, /new Option\('ผู้รับผิดชอบทั้งหมด', ''\)/);
  assert.match(rendererSource, /isRestrictedSalesUser\(\)[\s\S]*งานของฉัน[\s\S]*select\.disabled = true/);
  assert.match(rendererSource, /ไม่พบงานที่ตรงกับตัวกรอง/);
  assert.match(rendererSource, /function handleFollowUpTasksOwnerFilter\(\)[\s\S]*renderFollowUpTasks\(\)/);
  assert.match(crmIndexHtml, /followUpTaskOwnerFilter = '';[\s\S]{0,700}followUpOwnerFilter\.replaceChildren/);
});

test('follow-up owner uses salesperson first and falls back to admin', () => {
  const ownerStart = crmIndexHtml.indexOf('const FOLLOW_UP_TASK_OWNER_UNASSIGNED');
  const ownerEnd = crmIndexHtml.indexOf('function syncFollowUpTaskOwnerFilterOptions', ownerStart);
  const ownerSource = crmIndexHtml.slice(ownerStart, ownerEnd);
  const context = {
    normalizeCasesSearchValue(value) {
      return String(value || '').trim().toLocaleLowerCase('th-TH');
    },
    getCaseSearchText(value) {
      return Object.values(value || {}).map(item => String(item || '')).join(' ').trim().toLocaleLowerCase('th-TH');
    },
    getFollowUpTaskQuotationEntries() {
      return [];
    },
  };

  assert.ok(ownerStart >= 0 && ownerEnd > ownerStart);
  vm.runInNewContext(`${ownerSource}\nresult = {
    salesperson: getFollowUpTaskOwner({
      salesperson: 'เก็ต', salespersonEmployeeId: 'sales-1', admin: 'ดาว'
    }),
    admin: getFollowUpTaskOwner({
      salesperson: '', salespersonEmployeeId: 'orphan-sales-id', admin: 'ดาว'
    }),
    adminOverAssigned: getFollowUpTaskOwner({
      salesperson: '', admin: 'ดาว', assignedTo: 'ทีมสำรอง', assignedEmployeeId: 'assigned-1'
    }),
    unassigned: getFollowUpTaskOwner({ salesperson: '', admin: '', assignedTo: 'ทีมสำรอง' }),
    searchAdmin: [
      { caseId: 'A', salesperson: 'เก็ต', admin: 'ดาว' },
      { caseId: 'B', salesperson: '', admin: 'ดาว' },
      { caseId: 'C', salesperson: 'แคท', admin: 'ดาว' }
    ].filter(item => matchesFollowUpTaskFilters(item, 'ดาว', '')).map(item => item.caseId),
    searchSales: [
      { caseId: 'A', salesperson: 'เก็ต', admin: 'ดาว' },
      { caseId: 'B', salesperson: '', admin: 'ดาว' }
    ].filter(item => matchesFollowUpTaskFilters(item, 'เก็ต', '')).map(item => item.caseId),
    filterAdmin: [
      { caseId: 'A', salesperson: 'เก็ต', admin: 'ดาว' },
      { caseId: 'B', salesperson: '', admin: 'ดาว' }
    ].filter(item => matchesFollowUpTaskFilters(item, '', 'admin:name:ดาว')).map(item => item.caseId)
  };`, context);
  const result = JSON.parse(JSON.stringify(context.result));

  assert.deepEqual(result.salesperson, { key: 'sales:id:sales-1', label: 'เก็ต', name: 'เก็ต', source: 'salesperson' });
  assert.deepEqual(result.admin, { key: 'admin:name:ดาว', label: 'ดาว (แอดมิน)', name: 'ดาว', source: 'admin' });
  assert.deepEqual(result.adminOverAssigned, { key: 'admin:name:ดาว', label: 'ดาว (แอดมิน)', name: 'ดาว', source: 'admin' });
  assert.deepEqual(result.unassigned, { key: '__unassigned__', label: '', name: '', source: 'unassigned' });
  assert.deepEqual(result.searchAdmin, ['B']);
  assert.deepEqual(result.searchSales, ['A']);
  assert.deepEqual(result.filterAdmin, ['B']);
});

test('follow-up Kanban cards show date, case status, case ID, and customer name', () => {
  const cardStart = crmIndexHtml.indexOf('function renderFollowUpTaskItem');
  const cardEnd = crmIndexHtml.indexOf('function renderFollowUpTasks', cardStart);
  const cardSource = crmIndexHtml.slice(cardStart, cardEnd);
  const datePosition = cardSource.indexOf('data-follow-up-task-date');
  const statusPosition = cardSource.indexOf('data-follow-up-task-status');
  const identityPosition = cardSource.indexOf('data-follow-up-task-identity');

  assert.ok(cardStart >= 0 && cardEnd > cardStart);
  assert.ok(datePosition >= 0 && statusPosition > datePosition && statusPosition < identityPosition);
  assert.match(cardSource, /const status = normalizeTimelineStatus\(item\?\.status\) \|\| 'ไม่ระบุสถานะ'/);
  assert.match(cardSource, /const safeStatus = escapeHtml\(status\)/);
  assert.match(cardSource, /const statusTone = getLeadCaseStatusTone\(status\)/);
  assert.match(cardSource, /aria-label="เปิดรายละเอียดเคส[^\"]*สถานะ \$\{safeStatus\}"/);
  assert.match(cardSource, /data-follow-up-task-status[^>]*aria-hidden="true"[^>]*truncate[^>]*title="\$\{safeStatus\}"/);
  assert.ok(cardSource.indexOf('caseId ||', identityPosition) < cardSource.indexOf('safeCustomerName', identityPosition));
  assert.match(cardSource, /data-follow-up-task-identity[\s\S]*text-xs font-normal text-slate-500/);
  assert.match(cardSource, /data-follow-up-task-identity[\s\S]*text-sm font-normal leading-5 text-slate-700/);
  assert.doesNotMatch(cardSource.slice(identityPosition), /font-black/);
  assert.doesNotMatch(cardSource, /data-follow-up-task-meta|หัวข้อ:|ผู้รับผิดชอบ:/);
  assert.doesNotMatch(cardSource, /const topic =|const owner =/);
  assert.doesNotMatch(cardSource, /latestContactDetails|บันทึกล่าสุด|เปิดเคส|บันทึกผล/);
  assert.doesNotMatch(cardSource, /priority/);
});

test('the whole follow-up card opens authoritative case details accessibly', () => {
  const cardStart = crmIndexHtml.indexOf('function renderFollowUpTaskItem');
  const cardEnd = crmIndexHtml.indexOf('function renderFollowUpTasks', cardStart);
  const cardSource = crmIndexHtml.slice(cardStart, cardEnd);
  const handlerStart = crmIndexHtml.indexOf('async function handleFollowUpTaskListClick');
  const handlerEnd = crmIndexHtml.indexOf('async function loadAnnouncementUnreadCount', handlerStart);
  const handlerSource = crmIndexHtml.slice(handlerStart, handlerEnd);
  const openerStart = crmIndexHtml.indexOf('async function openFollowUpTaskTarget');
  const openerSource = crmIndexHtml.slice(openerStart, handlerStart);

  assert.match(cardSource, /<button type="button" data-follow-up-task-card data-follow-up-task-action="open"/);
  assert.match(cardSource, /data-case-id="\$\{safeCaseId\}" data-customer-id="\$\{safeCustomerId\}"/);
  assert.match(cardSource, /aria-label="เปิดรายละเอียดเคส/);
  assert.match(cardSource, /focus:ring-2/);
  assert.match(handlerSource, /closest\('\[data-follow-up-task-action\]'\)/);
  assert.match(handlerSource, /hasAttribute\('data-follow-up-task-card'\)/);
  assert.match(handlerSource, /trigger\.dataset\.followUpTaskAction/);
  assert.match(handlerSource, /aria-busy/);
  assert.match(crmIndexHtml, /id="addCaseFollowUpButton"/);
  assert.ok(openerStart >= 0 && handlerStart > openerStart);
  assert.ok(openerSource.indexOf('showFollowUpTaskDetailLoading(requestContext, task)') < openerSource.indexOf('await fetchLeadDetail(customerId)'));
  assert.doesNotMatch(openerSource, /fetchCasesData\(/);
  assert.match(openerSource, /await fetchLeadDetail\(customerId\)/);
  assert.doesNotMatch(openerSource, /fetchLeadDetail\(customerId,\s*\{\s*force:\s*true/);
  assert.match(openerSource, /requestId: \+\+followUpTaskDetailRequestId/);
  assert.match(openerSource, /isCurrentFollowUpTaskDetailRequest\(requestContext\)/);
  assert.match(openerSource, /parentLead\?\.\['ไทม์ไลน์สถานะ'\]/);
  assert.match(openerSource, /else openCaseDetailDrawer\(customerId, caseData, parentLead\)/);
  assert.match(crmIndexHtml, /function closeCaseDetailDrawer[\s\S]{0,180}followUpTaskDetailRequestId \+= 1/);
});

test('case detail shows a semantic status timeline based on observed history', () => {
  const pureStart = crmIndexHtml.indexOf('const LEAD_STATUS_STEPS');
  const pureEnd = crmIndexHtml.indexOf('function getSafeCaseLink', pureStart);
  const pureSource = crmIndexHtml.slice(pureStart, pureEnd);
  const rendererStart = crmIndexHtml.indexOf('function renderCaseStatusProgress');
  const rendererEnd = crmIndexHtml.indexOf('function renderCaseContactHistory', rendererStart);
  const rendererSource = crmIndexHtml.slice(rendererStart, rendererEnd);
  const detailStart = crmIndexHtml.indexOf('function renderCaseDetailView');
  const detailEnd = crmIndexHtml.indexOf('function setDeleteCaseConfirmationBusy', detailStart);
  const detailSource = crmIndexHtml.slice(detailStart, detailEnd);
  const layoutMatch = detailSource.match(/<div data-case-detail-layout class="([^"]+)"/);
  const context = {};

  assert.ok(pureStart >= 0 && pureEnd > pureStart);
  vm.runInNewContext(`${pureSource}\nresult = {
    skipped: deriveCaseStatusStates('ติดตามครั้งที่ 2', [
      { previousStatus: 'ติดต่อสอบถาม', status: 'ส่งใบเสนอราคา' },
      { previousStatus: 'ส่งใบเสนอราคา', status: 'ติดตามครั้งที่ 2' }
    ]),
    cancelled: deriveCaseStatusStates('ยกเลิก', [
      { previousStatus: 'ติดตามครั้งที่ 1', status: 'ยกเลิก' }
    ]),
    alias: deriveCaseStatusStates('เซ็นสัญญา', [])
  };`, context);
  const result = JSON.parse(JSON.stringify(context.result));
  const stateOf = (items, status) => items.find(item => item.status === status)?.state;

  assert.equal(stateOf(result.skipped, 'ติดต่อสอบถาม'), 'complete');
  assert.equal(stateOf(result.skipped, 'ส่งใบเสนอราคา'), 'complete');
  assert.equal(stateOf(result.skipped, 'ประเมินราคา'), 'pending');
  assert.equal(stateOf(result.skipped, 'ติดตามครั้งที่ 2'), 'current');
  assert.equal(result.skipped.filter(item => ['current', 'cancelled'].includes(item.state)).length, 1);
  assert.equal(stateOf(result.cancelled, 'ยกเลิก'), 'cancelled');
  assert.equal(stateOf(result.cancelled, 'ประเมินราคา'), 'pending');
  assert.equal(stateOf(result.alias, 'เซ็นต์สัญญา'), 'current');

  assert.ok(layoutMatch);
  assert.match(layoutMatch[1], /\bgrid\b/);
  assert.match(layoutMatch[1], /\bgrid-cols-1\b/);
  assert.match(layoutMatch[1], /\blg:grid-cols-\[[^\]]*minmax\(0,1fr\)[^\]]*\]/);
  assert.match(layoutMatch[1], /\bitems-start\b/);
  assert.match(detailSource, /data-case-detail-status-column class="[^"]*\bmin-w-0\b/);
  assert.match(detailSource, /data-case-detail-main class="[^"]*\bmin-w-0\b/);
  assert.ok(detailSource.indexOf('data-case-detail-status-column') < detailSource.indexOf('data-case-detail-main'));
  assert.match(crmIndexHtml, /id="caseDetailDrawerPanel"[^>]*\bw-full\b[^>]*max-w-\[1\d{3}px\]/);
  assert.doesNotMatch(crmIndexHtml, /id="caseDetailDrawerPanel"[^>]*max-w-\[800px\]/);
  assert.match(detailSource, /id="caseStatusProgress" data-case-detail-status-timeline/);
  assert.equal((detailSource.match(/id="caseStatusProgress"/g) || []).length, 1);
  assert.ok(detailSource.indexOf('id="caseStatusProgress"') < detailSource.indexOf('id="caseContactHistoryList"'));
  assert.match(rendererSource, /aria-current="step"/);
  assert.match(rendererSource, /data-case-status-state="\$\{step\.state\}"/);
  assert.match(rendererSource, /escapeTimelineValue\(step\.status\)/);
  assert.match(rendererSource, /เสร็จแล้ว/);
  assert.match(rendererSource, /รอดำเนินการ/);
  assert.doesNotMatch(rendererSource, /<button[^>]*data-case-status/i);
  assert.match(crmIndexHtml, /loadCaseContactHistory[\s\S]*renderCaseStatusProgress\(\)/);
});

function renderCaseHistoryForTest(followUps) {
  const rendererStart = crmIndexHtml.indexOf('function renderCaseContactHistory(');
  const rendererEnd = crmIndexHtml.indexOf('async function loadCaseContactHistory(', rendererStart);
  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart);
  const list = { innerHTML: '', querySelectorAll() { return []; } };
  const count = { textContent: '' };
  const context = {
    activeCaseDetail: { followUps, followUpsLoaded: true },
    document: {
      getElementById(id) {
        return id === 'caseContactHistoryList' ? list : id === 'caseContactHistoryCount' ? count : null;
      },
    },
    formatSheetDate(value) { return String(value); },
    escapeTimelineValue(value) {
      return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[character]);
    },
  };
  vm.runInNewContext(`${crmIndexHtml.slice(rendererStart, rendererEnd)}\nrenderCaseContactHistory();`, context);
  return { html: list.innerHTML, count: count.textContent };
}

function caseHistoryBadgesForTest(html) {
  return [...html.matchAll(/<span class="rounded-full border px-2 py-0\.5 text-\[12px\] font-semibold [^"]*">([^<]*)<\/span>/g)]
    .map(match => match[1]);
}

test('case history shows identical contact channel and status only once', () => {
  const result = renderCaseHistoryForTest([
    { contactChannel: 'ออกใบแจ้งหนี้', status: 'ออกใบแจ้งหนี้' },
  ]);

  assert.deepEqual(caseHistoryBadgesForTest(result.html), ['ออกใบแจ้งหนี้']);
  assert.equal(result.count, '1 รายการ');
});

test('case history shows identical outcome, contact channel, and status only once', () => {
  const result = renderCaseHistoryForTest([
    { outcome: 'ส่งใบเสนอราคา', contactChannel: 'ส่งใบเสนอราคา', status: 'ส่งใบเสนอราคา' },
  ]);

  assert.deepEqual(caseHistoryBadgesForTest(result.html), ['ส่งใบเสนอราคา']);
});

test('case history trims badge labels and omits blank or nullish labels', () => {
  const result = renderCaseHistoryForTest([
    { outcome: '  ส่งใบเสนอราคา  ', contactChannel: '\tส่งใบเสนอราคา\n', status: '  ' },
    { outcome: null, contactChannel: undefined, status: '\t\n ' },
  ]);

  assert.deepEqual(caseHistoryBadgesForTest(result.html), ['ส่งใบเสนอราคา']);
  assert.equal((result.html.match(/<article\b/g) || []).length, 2);
  assert.equal(result.count, '2 รายการ');
  assert.doesNotMatch(result.html, />(?:null|undefined)<\/span>/);
});

test('case history preserves distinct badge labels in their original order', () => {
  const result = renderCaseHistoryForTest([
    { outcome: 'ตอบกลับแล้ว', contactChannel: 'ออกใบเสนอราคา', status: 'ส่งใบเสนอราคา' },
  ]);

  assert.deepEqual(caseHistoryBadgesForTest(result.html), [
    'ตอบกลับแล้ว', 'ออกใบเสนอราคา', 'ส่งใบเสนอราคา',
  ]);
});

test('case history deduplicates badges per card without collapsing separate history entries', () => {
  const result = renderCaseHistoryForTest([
    { id: 'HISTORY-1', contactChannel: 'ส่งใบเสนอราคา', status: 'ส่งใบเสนอราคา', notes: 'ส่งครั้งแรก' },
    { id: 'HISTORY-2', contactChannel: 'ส่งใบเสนอราคา', status: 'ส่งใบเสนอราคา', notes: 'ส่งครั้งที่สอง' },
  ]);
  const cards = [...result.html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)];

  assert.equal(cards.length, 2);
  cards.forEach(card => assert.deepEqual(caseHistoryBadgesForTest(card[1]), ['ส่งใบเสนอราคา']));
  assert.match(cards[0][1], /ส่งครั้งแรก/);
  assert.match(cards[1][1], /ส่งครั้งที่สอง/);
  assert.equal(result.count, '2 รายการ');
});

test('follow-up card date formatter uses Bangkok time and the Thai calendar', () => {
  const formatterStart = crmIndexHtml.indexOf('function formatFollowUpTaskDate');
  const formatterEnd = crmIndexHtml.indexOf('function formatFollowUpTasksGeneratedAt', formatterStart);
  const formatterSource = crmIndexHtml.slice(formatterStart, formatterEnd);
  const context = {};

  assert.ok(formatterStart >= 0 && formatterEnd > formatterStart);
  vm.runInNewContext(
    `${formatterSource}\nresult = formatFollowUpTaskDate('2026-08-22T13:17:00.000Z');\nresultParts = formatFollowUpTaskDateParts('2026-08-21T17:00:00.000Z');`,
    context
  );
  assert.equal(String(context.result).replace(/\s+/g, ' ').trim(), '22 ส.ค. 2569 20:17 น.');
  assert.deepEqual(JSON.parse(JSON.stringify(context.resultParts)), {
    date: '22 ส.ค. 2569',
    time: '00:00 น.',
  });
});

const caseInvoiceDeletionMessage = 'ไม่สามารถลบเคสนี้ได้ เนื่องจากมีใบแจ้งหนี้ ใบแจ้งหนี้และข้อมูลเดิมจะยังคงอยู่';

function caseDeletionUiForTest() {
  const sourceStarts = [
    crmIndexHtml.indexOf('function setDeleteCaseConfirmationError('),
    crmIndexHtml.indexOf('function setDeleteCaseConfirmationBusy('),
  ];
  assert.ok(sourceStarts.every(start => start >= 0));
  const sourceStart = Math.min(...sourceStarts);
  const sourceEnd = crmIndexHtml.indexOf('function quotationTodayValue(', sourceStart);
  assert.ok(sourceEnd > sourceStart);

  const element = (initialClasses = []) => {
    const classes = new Set(initialClasses);
    return {
      textContent: '',
      innerHTML: '',
      disabled: false,
      attributes: {},
      focusCount: 0,
      focus() { this.focusCount += 1; },
      setAttribute(name, value) { this.attributes[name] = value; },
      classList: {
        contains(name) { return classes.has(name); },
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        toggle(name, force) {
          const add = force === undefined ? !classes.has(name) : force;
          if (add) classes.add(name);
          else classes.delete(name);
          return add;
        },
      },
    };
  };
  const elements = Object.fromEntries([
    'deleteCaseConfirmModal', 'deleteCaseConfirmError', 'deleteCaseConfirmId',
    'deleteCaseConfirmCustomer', 'deleteCaseConfirmTopic', 'confirmDeleteCaseButton',
    'cancelDeleteCaseConfirmButton', 'closeDeleteCaseConfirmButton',
    'deleteCaseConfirmBackdrop', 'deleteCaseDetailButton',
  ].map(id => [id, element(['deleteCaseConfirmModal', 'deleteCaseConfirmError'].includes(id) ? ['hidden'] : [])]));
  elements.deleteCaseDetailButton.innerHTML = 'ลบเคส';
  const calls = [];
  const api = {
    onFetch: null,
    response: {
      ok: false,
      status: 409,
      async json() {
        return { success: false, code: 'CASE_HAS_INVOICES', error: caseInvoiceDeletionMessage };
      },
    },
  };
  const caseData = { logId: 'CASE-INVOICE', customerName: 'ลูกค้าทดสอบ', topic: 'ติดตั้งฟิล์ม' };
  const context = vm.createContext({
    activeCaseDetail: {
      caseData,
      customerId: 'CUSTOMER-1',
      parentLead: { 'ชื่อลูกค้า': 'ลูกค้าทดสอบ' },
    },
    pendingCaseDeletion: null,
    allCases: [{ caseId: 'CASE-INVOICE' }, { caseId: 'CASE-OTHER' }],
    installationQueueCases: [{ caseId: 'CASE-INVOICE' }, { caseId: 'CASE-OTHER' }],
    config: { crmApiUrl: '/api/crm' },
    document: { getElementById: id => elements[id] || null },
    window: { requestAnimationFrame: callback => callback() },
    canDeleteCases: () => true,
    async ensureCurrentCrmApiVersion() { calls.push(['ensureApiVersion']); },
    async crmFetch(url, options) {
      calls.push(['crmFetch', url, JSON.parse(options.body)]);
      api.onFetch?.();
      return api.response;
    },
    renderCasesList() { calls.push(['renderCasesList']); },
    renderMeasurementQueueList() { calls.push(['renderMeasurementQueueList']); },
    renderInstallationQueue() { calls.push(['renderInstallationQueue']); },
    clearLeadCaches() { calls.push(['clearLeadCaches']); },
    closeCaseDetailDrawer() { calls.push(['closeCaseDetailDrawer']); },
    showToast(message) { calls.push(['showToast', message]); },
    showSuccessToast(message) { calls.push(['showSuccessToast', message]); },
    async fetchCasesData() { calls.push(['fetchCasesData']); return true; },
    async fetchLeadsData(options) { calls.push(['fetchLeadsData', options]); },
    async viewLeadDetail(customerId) { calls.push(['viewLeadDetail', customerId]); },
  });
  vm.runInContext(crmIndexHtml.slice(sourceStart, sourceEnd), context);
  return { context, elements, calls, api, caseData };
}

test('case deletion confirmation explains the invoice restriction and exposes accessible inline errors', () => {
  const modalTag = crmIndexHtml.match(/<[^>]+id="deleteCaseConfirmModal"[^>]*>/)?.[0];
  const errorTag = crmIndexHtml.match(/<[^>]+id="deleteCaseConfirmError"[^>]*>/)?.[0];
  const warningStart = crmIndexHtml.indexOf('id="deleteCaseConfirmDescription"');
  const warningEnd = crmIndexHtml.indexOf('id="confirmDeleteCaseButton"', warningStart);
  assert.ok(modalTag && errorTag && warningStart >= 0 && warningEnd > warningStart);
  const describedBy = modalTag.match(/aria-describedby="([^"]*)"/)?.[1].split(/\s+/) || [];
  assert.ok(describedBy.includes('deleteCaseConfirmDescription'));
  assert.ok(describedBy.includes('deleteCaseConfirmError'));
  assert.match(errorTag, /role="alert"/);
  assert.match(errorTag, /aria-live="assertive"/);
  assert.ok(errorTag.match(/class="([^"]*)"/)?.[1].split(/\s+/).includes('hidden'));
  const warningText = crmIndexHtml.slice(warningStart, warningEnd).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(warningText.includes('ประวัติเคสทั้งหมดของรายการนี้จะถูกลบไปด้วย'));
  assert.ok(warningText.includes('หากเคสนี้มีใบแจ้งหนี้ จะไม่สามารถลบเคสได้ ใบแจ้งหนี้และข้อมูลเดิมจะยังคงอยู่'));
});

test('opening case deletion confirmation clears stale errors for every selected case', () => {
  const { context, elements } = caseDeletionUiForTest();
  const error = elements.deleteCaseConfirmError;
  context.setDeleteCaseConfirmationError('ข้อผิดพลาดจากเคสก่อนหน้า');
  assert.equal(error.classList.contains('hidden'), false);
  context.openCaseDeleteConfirmation();
  assert.equal(error.textContent, '');
  assert.equal(error.classList.contains('hidden'), true);
  assert.equal(elements.deleteCaseConfirmModal.classList.contains('hidden'), false);
  assert.equal(elements.deleteCaseConfirmModal.attributes['aria-hidden'], 'false');
  assert.equal(elements.deleteCaseConfirmId.textContent, 'CASE-INVOICE');
  assert.equal(elements.confirmDeleteCaseButton.focusCount, 1);

  context.setDeleteCaseConfirmationError(caseInvoiceDeletionMessage);
  context.closeDeleteCaseConfirmation();
  context.activeCaseDetail.caseData = { logId: 'CASE-NEW', topic: 'เคสใหม่' };
  context.openCaseDeleteConfirmation();
  assert.equal(error.textContent, '');
  assert.equal(error.classList.contains('hidden'), true);
  assert.equal(elements.deleteCaseConfirmId.textContent, 'CASE-NEW');
  assert.equal(context.pendingCaseDeletion.caseId, 'CASE-NEW');
});

test('invoice-blocked deletion keeps the case and documents intact and shows the server explanation inline', async () => {
  const { context, elements, calls, caseData } = caseDeletionUiForTest();
  const originalCases = context.allCases;
  const originalQueue = context.installationQueueCases;
  context.openCaseDeleteConfirmation();
  const pending = context.pendingCaseDeletion;

  await context.deleteActiveCase();

  assert.equal(elements.deleteCaseConfirmError.textContent, caseInvoiceDeletionMessage);
  assert.equal(elements.deleteCaseConfirmError.classList.contains('hidden'), false);
  assert.equal(elements.deleteCaseConfirmModal.classList.contains('hidden'), false);
  assert.equal(context.pendingCaseDeletion, pending);
  assert.equal(context.activeCaseDetail.caseData, caseData);
  assert.equal(context.allCases, originalCases);
  assert.equal(context.installationQueueCases, originalQueue);
  ['confirmDeleteCaseButton', 'cancelDeleteCaseConfirmButton', 'closeDeleteCaseConfirmButton',
    'deleteCaseConfirmBackdrop', 'deleteCaseDetailButton'].forEach(id => assert.equal(elements[id].disabled, false));
  assert.equal(elements.deleteCaseDetailButton.innerHTML, 'ลบเคส');
  assert.deepEqual(calls.map(call => call[0]), ['ensureApiVersion', 'crmFetch', 'showToast']);
  assert.deepEqual(calls[1][2], { action: 'deleteCase', caseId: 'CASE-INVOICE' });
  assert.ok(calls[2][1].includes(caseInvoiceDeletionMessage));
});

test('retry clears the old deletion error before the API request and cancellation remains available after rejection', async () => {
  const { context, elements, api, calls } = caseDeletionUiForTest();
  context.openCaseDeleteConfirmation();
  await context.deleteActiveCase();
  assert.equal(elements.deleteCaseConfirmError.classList.contains('hidden'), false);
  let requestObserved = false;
  api.onFetch = () => {
    requestObserved = true;
    assert.equal(elements.deleteCaseConfirmError.textContent, '');
    assert.equal(elements.deleteCaseConfirmError.classList.contains('hidden'), true);
    assert.equal(elements.confirmDeleteCaseButton.disabled, true);
    assert.equal(elements.cancelDeleteCaseConfirmButton.disabled, true);
  };
  await context.deleteActiveCase();
  assert.equal(requestObserved, true);
  assert.equal(calls.filter(call => call[0] === 'crmFetch').length, 2);
  assert.equal(elements.deleteCaseConfirmError.textContent, caseInvoiceDeletionMessage);
  assert.equal(elements.cancelDeleteCaseConfirmButton.disabled, false);
  context.closeDeleteCaseConfirmation();
  assert.equal(elements.deleteCaseConfirmModal.classList.contains('hidden'), true);
  assert.equal(context.pendingCaseDeletion, null);
});

test('inline case deletion errors are plain text rather than interpreted HTML', () => {
  const { context, elements } = caseDeletionUiForTest();
  const message = '<img src=x onerror=alert(1)> ไม่สามารถลบเคสได้';
  context.setDeleteCaseConfirmationError(message);
  assert.equal(elements.deleteCaseConfirmError.textContent, message);
  assert.equal(elements.deleteCaseConfirmError.innerHTML, '');
  assert.equal(elements.deleteCaseConfirmError.classList.contains('hidden'), false);
  context.setDeleteCaseConfirmationError();
  assert.equal(elements.deleteCaseConfirmError.textContent, '');
  assert.equal(elements.deleteCaseConfirmError.classList.contains('hidden'), true);
});

test('successful case deletion still removes only the selected case and refreshes the existing views', async () => {
  const { context, elements, api, calls } = caseDeletionUiForTest();
  api.response = { ok: true, async json() { return { success: true, caseId: 'CASE-INVOICE' }; } };
  context.openCaseDeleteConfirmation();
  context.setDeleteCaseConfirmationError('ข้อผิดพลาดเก่า');
  await context.deleteActiveCase();

  assert.deepEqual(Array.from(context.allCases, item => item.caseId), ['CASE-OTHER']);
  assert.deepEqual(Array.from(context.installationQueueCases, item => item.caseId), ['CASE-OTHER']);
  assert.equal(context.pendingCaseDeletion, null);
  assert.equal(elements.deleteCaseConfirmModal.classList.contains('hidden'), true);
  assert.equal(elements.deleteCaseConfirmError.classList.contains('hidden'), true);
  assert.equal(elements.deleteCaseConfirmError.textContent, '');
  assert.deepEqual(calls.map(call => call[0]), [
    'ensureApiVersion', 'crmFetch', 'renderCasesList', 'renderMeasurementQueueList',
    'renderInstallationQueue', 'clearLeadCaches', 'closeCaseDetailDrawer',
    'showSuccessToast', 'fetchCasesData', 'fetchLeadsData', 'viewLeadDetail',
  ]);
  assert.equal(calls.at(-1)[1], 'CUSTOMER-1');
});

test('all inline CRM scripts remain syntactically valid', () => {
  const inlineScripts = [...crmIndexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(inlineScripts.length >= 2);
  inlineScripts.forEach((match, index) => {
    assert.doesNotThrow(
      () => new vm.Script(match[1], { filename: `public-index-inline-${index + 1}.js` })
    );
  });
});
