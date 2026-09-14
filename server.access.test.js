const test = require('node:test');
const assert = require('node:assert/strict');

test('frontend API version requirements match the server for case creation and editing', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const frontend = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const version = server.match(/const CRM_API_VERSION = '([^']+)'/);
  assert.ok(version, 'server must declare its API version');
  for (const name of ['requiredCrmApiVersion', 'requiredCaseDetailApiVersion']) {
    const requirement = frontend.match(new RegExp(`const ${name} = '([^']+)'`));
    assert.ok(requirement, `${name} must declare the required version`);
    assert.equal(requirement[1], version[1], `${name} must match the server before release`);
  }
});

const {
  crmAssignmentRecord,
  isRestrictedCrmSales,
  scopeCaseAssignment,
  requireCaseAssignmentManager,
  requireGeneralTaskCreator,
  isPhoneUniqueViolation,
  customerLeadMetrics,
  getCaseSalespersonContact,
  getCaseAdminContact,
  generalTaskRecord,
  generalTaskWritePayload,
  siteTypeRecord,
  siteTypeWritePayload,
  normalizeQuotationSnapshot,
  quotationCountForHistory,
  quotationListRecords,
  validateCaseStatus,
  caseRecord,
  getCases,
  deleteCase,
  evaluationMeasurementPayload,
  getLeadFollowUps,
  getLeadDetail,
  ordinaryFollowUpAt,
  effectiveCaseFollowUpAt,
  caseWritePayload,
  createCaseAppointment,
  createLeadFollowUp,
} = require('./server');

test('ordinary follow-up deadlines are three Bangkok calendar days later at midnight', () => {
  assert.equal(ordinaryFollowUpAt('2026-08-31T16:59:59.000Z'), '2026-09-02T17:00:00.000Z');
  assert.equal(ordinaryFollowUpAt('2026-08-31T17:00:00.000Z'), '2026-09-03T17:00:00.000Z');
  assert.equal(ordinaryFollowUpAt('2026-12-30T01:00:00.000Z'), '2027-01-01T17:00:00.000Z');
  assert.equal(ordinaryFollowUpAt(new Date('2028-02-27T01:00:00.000Z')), '2028-02-29T17:00:00.000Z');
  assert.equal(ordinaryFollowUpAt('not-a-date'), '');
  assert.equal(ordinaryFollowUpAt(null), '');
});

test('ordinary follow-up policy keeps only an optional selected Bangkok time, not its date', () => {
  assert.equal(ordinaryFollowUpAt('2026-09-14T05:00:00.000Z', '2030-01-01T15:41:22+07:00'),
    '2026-09-17T08:41:22.000Z');
  assert.equal(ordinaryFollowUpAt('2026-09-14T05:00:00.000Z', '2026-08-20T22:30:00.000Z'),
    '2026-09-16T22:30:00.000Z');
  assert.throws(() => ordinaryFollowUpAt('2026-09-14T05:00:00.000Z', 'not-a-date'),
    error => error.code === 'INVALID_FOLLOW_UP_DATE');
});

test('new ordinary cases receive a schedule while appointments keep explicit dates and final cases need none', () => {
  const activityAt = new Date('2026-09-14T05:00:00.000Z');
  for (const jobStatus of ['รอดำเนินการ', 'ติดต่อสอบถาม', 'ส่งใบเสนอราคา', 'ชำระเงินครบ']) {
    const result = caseWritePayload({ jobStatus }, 'customer-1', 'member-1', activityAt);
    assert.equal(result.nextFollowUpAt, '2026-09-16T17:00:00.000Z');
    assert.equal(result.casePayload.status, jobStatus);
    assert.equal(result.casePayload.recorded_at, activityAt.toISOString());
  }
  assert.equal(caseWritePayload({ jobStatus: 'ติดต่อสอบถาม', nextFollowUpAt: '2030-01-01T14:15:00+07:00' },
    'customer-1', 'member-1', activityAt).nextFollowUpAt, '2026-09-17T07:15:00.000Z');
  for (const jobStatus of ['เลื่อนคิว', 'นัดวัดพื้นที่', 'เซ็นต์สัญญา', 'เลื่อนนัด', 'นัดคิวติดตั้ง', 'แก้ไขงาน', 'เก็บซิลิโคลน']) {
    assert.equal(caseWritePayload({ jobStatus, nextFollowUpAt: '2026-10-01T14:15:00+07:00' },
      'customer-1', 'member-1', activityAt).nextFollowUpAt, '2026-10-01T07:15:00.000Z');
    assert.throws(() => caseWritePayload({ jobStatus }, 'customer-1', 'member-1', activityAt),
      error => error.code === 'MISSING_NEXT_FOLLOW_UP_DATE');
  }
  for (const jobStatus of ['ยกเลิก', 'ปิดงาน']) {
    assert.equal(caseWritePayload({ jobStatus }, 'customer-1', 'member-1', activityAt).nextFollowUpAt, null);
  }
});

test('effective ordinary deadlines include legacy cases without history and preserve saved times', () => {
  assert.equal(effectiveCaseFollowUpAt({ status: 'ติดต่อสอบถาม', recorded_at: '2026-09-14T05:00:00.000Z', latest_follow_up: [] }),
    '2026-09-16T17:00:00.000Z');
  assert.equal(effectiveCaseFollowUpAt({ status: 'รอดำเนินการ', recorded_at: 'bad', created_at: '2026-09-14T05:00:00.000Z' }),
    '2026-09-16T17:00:00.000Z');
  assert.equal(effectiveCaseFollowUpAt({
    status: 'ติดตามครั้งที่ 1', recorded_at: '2026-09-01T05:00:00.000Z',
    latest_follow_up: [{ followed_at: '2026-09-14T05:00:00.000Z', next_follow_up_at: '2030-01-01T14:15:00+07:00' }],
  }), '2026-09-17T07:15:00.000Z');
  assert.equal(effectiveCaseFollowUpAt({
    status: 'ติดตามครั้งที่ 1', created_at: '2026-09-01T05:00:00.000Z',
    latest_follow_up: { followed_at: 'bad', created_at: '2026-09-14T05:00:00.000Z', next_follow_up_at: 'bad' },
  }), '2026-09-16T17:00:00.000Z');
});

test('reopened ordinary cases use the newer saved state date and ignore arbitrary metadata timestamps', () => {
  const row = {
    status: 'ติดต่อสอบถาม', recorded_at: '2026-09-14T05:00:00.000Z', updated_at: '2030-01-01T00:00:00.000Z',
    latest_follow_up: [{ current_status: 'ยกเลิก', followed_at: '2026-09-01T05:00:00.000Z', next_follow_up_at: '2026-09-01T05:00:00.000Z' }],
  };
  assert.equal(effectiveCaseFollowUpAt(row), '2026-09-17T05:00:00.000Z');
});

test('effective dates never invent appointments or terminal tasks and do not postpone legacy deadlines', () => {
  const explicitAt = '2026-10-01T07:15:00.000Z';
  const row = Object.freeze({
    status: 'นัดคิวติดตั้ง', recorded_at: '2026-09-14T05:00:00.000Z',
    latest_follow_up: Object.freeze([Object.freeze({ next_follow_up_at: explicitAt })]),
  });
  assert.equal(effectiveCaseFollowUpAt(row), explicitAt);
  for (const current_status of ['ติดต่อสอบถาม', 'ยกเลิก']) {
    assert.equal(effectiveCaseFollowUpAt({ ...row, latest_follow_up: [{ current_status, next_follow_up_at: explicitAt }] }), '');
  }
  assert.equal(effectiveCaseFollowUpAt({ ...row, latest_follow_up: [{ current_status: 'นัดคิวติดตั้ง', next_follow_up_at: explicitAt }] }), explicitAt);
  assert.equal(effectiveCaseFollowUpAt({ status: 'นัดคิวติดตั้ง', recorded_at: '2026-09-14T05:00:00.000Z' }), '');
  for (const status of ['ยกเลิก', 'ปิดงาน']) {
    assert.equal(effectiveCaseFollowUpAt({ ...row, status }), '');
  }
  const overdue = Object.freeze({ status: 'ติดต่อสอบถาม', recorded_at: '2026-08-01T05:00:00.000Z' });
  assert.equal(effectiveCaseFollowUpAt(overdue), '2026-08-03T17:00:00.000Z');
  assert.equal(effectiveCaseFollowUpAt(overdue), '2026-08-03T17:00:00.000Z');
  assert.equal(effectiveCaseFollowUpAt({ status: 'ติดต่อสอบถาม', latest_follow_up: [{ next_follow_up_at: explicitAt }] }), explicitAt);
  assert.equal(effectiveCaseFollowUpAt({ status: 'ติดต่อสอบถาม' }), '');
  assert.equal(effectiveCaseFollowUpAt({ status: 'ติดต่อสอบถาม', latest_follow_up: [{ next_follow_up_at: 'bad' }] }), '');
});

function newCaseScheduleClient(insertError = null) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(['from', table]);
      return { async insert(payload) { calls.push(['insert', payload]); return { error: insertError }; } };
    },
    async rpc(name, args) { calls.push(['rpc', name, args]); return { data: true, error: null }; },
  };
}

test('new case saves ordinary scheduling separately from contact and preserves appointment history', async () => {
  const client = newCaseScheduleClient();
  await createCaseAppointment(client, 'member-1', { id: 'case-1', status: 'ติดต่อสอบถาม' }, '2026-09-16T17:00:00.000Z', '2026-09-14T16:59:59.999Z');
  const saved = client.calls.find(call => call[0] === 'insert')[1];
  assert.equal(saved.case_id, 'case-1');
  assert.equal(saved.activity_type, 'follow_up');
  assert.equal(saved.notes, 'กำหนดติดตามอัตโนมัติทุก 3 วันจากการสร้างเคส');
  assert.equal(saved.next_follow_up_at, '2026-09-16T17:00:00.000Z');
  assert.equal(saved.followed_at, '2026-09-14T16:59:59.999Z');
  assert.equal(saved.contact_channel, undefined);
  const appointment = newCaseScheduleClient();
  await createCaseAppointment(appointment, 'member-1', { id: 'case-2', status: 'นัดคิวติดตั้ง' }, '2026-10-01T07:15:00.000Z');
  const appointmentSaved = appointment.calls.find(call => call[0] === 'insert')[1];
  assert.equal(appointmentSaved.activity_type, 'appointment');
  assert.equal(appointmentSaved.notes, 'กำหนดนัดหมายจากการสร้างเคส: นัดคิวติดตั้ง');
  assert.equal(appointmentSaved.next_follow_up_at, '2026-10-01T07:15:00.000Z');
  const final = newCaseScheduleClient();
  await createCaseAppointment(final, 'member-1', { id: 'case-3', status: 'ปิดงาน' }, null);
  assert.deepEqual(final.calls, []);
});

test('failed new-case follow-up scheduling uses existing rollback instead of leaving an unscheduled case', async t => {
  t.mock.method(console, 'error', () => {});
  const client = newCaseScheduleClient({ code: '42501', message: 'permission denied' });
  await assert.rejects(createCaseAppointment(client, 'member-1', { id: 'case-1', status: 'ติดต่อสอบถาม' },
    '2026-09-16T17:00:00.000Z'), error => error.status === 503 && error.code === 'CASE_FOLLOW_UP_SAVE_FAILED');
  assert.deepEqual(client.calls.find(call => call[0] === 'rpc'), ['rpc', 'rollback_new_crm_case', { p_case_id: 'case-1' }]);
});

function followUpWriteClient(status = 'ติดต่อสอบถาม') {
  const calls = [];
  const caseRow = { id: 'case-1', legacy_case_id: 'CASE-001', status, recorded_at: '2026-09-01T00:00:00.000Z' };
  return {
    calls,
    from(table) {
      calls.push(['from', table]);
      let payload;
      const query = {
        select() { return this; }, eq() { return this; },
        update(value) { calls.push(['update', value]); Object.assign(caseRow, value); return this; },
        insert(value) { payload = value; calls.push(['insert', value]); return this; },
        async maybeSingle() { return { data: caseRow, error: null }; },
        async single() { return { data: { ...payload, id: 'history-1', created_at: payload.followed_at }, error: null }; },
      };
      assert.ok(['cases', 'lead_follow_up_history'].includes(table));
      return query;
    },
  };
}

test('ordinary follow-up writes accept no date and reschedule from each new contact rather than an old submitted date', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-14T05:00:00.000Z') });
  const client = followUpWriteClient();
  const first = await createLeadFollowUp(client, 'member-1', { caseId: 'CASE-001', notes: 'ติดตามลูกค้า' });
  assert.equal(first.followUp.nextFollowUpAt, ordinaryFollowUpAt(first.followUp.followedAt));
  assert.equal(first.followUp.nextFollowUpAt, '2026-09-16T17:00:00.000Z');
  t.mock.timers.tick(4 * 24 * 60 * 60 * 1000);
  const second = await createLeadFollowUp(client, 'member-1', {
    caseId: 'CASE-001', notes: 'ติดตามครั้งถัดไป', status: 'ติดตามครั้งที่ 1', nextFollowUpAt: '2030-01-01T14:15:00+07:00',
  });
  assert.equal(second.followUp.nextFollowUpAt, ordinaryFollowUpAt(second.followUp.followedAt, '2030-01-01T14:15:00+07:00'));
  assert.equal(second.followUp.nextFollowUpAt, '2026-09-21T07:15:00.000Z');
  assert.equal(client.calls.filter(call => call[0] === 'insert').length, 2);
  assert.equal(second.statusChanged, true);
});

test('appointment follow-up writes preserve specified dates and validate before any mutation', async () => {
  const client = followUpWriteClient('นัดคิวติดตั้ง');
  const result = await createLeadFollowUp(client, 'member-1', {
    caseId: 'CASE-001', notes: 'นัดทีมติดตั้ง', nextFollowUpAt: '2026-10-01T14:15:00+07:00',
  });
  assert.equal(result.followUp.nextFollowUpAt, '2026-10-01T07:15:00.000Z');
  for (const nextFollowUpAt of [undefined, 'bad']) {
    const missing = followUpWriteClient();
    await assert.rejects(createLeadFollowUp(missing, 'member-1', {
      caseId: 'CASE-001', notes: 'นัดทีมติดตั้ง', status: 'นัดคิวติดตั้ง', nextFollowUpAt,
    }), error => ['MISSING_NEXT_FOLLOW_UP_DATE', 'INVALID_FOLLOW_UP_DATE'].includes(error.code));
    assert.equal(missing.calls.some(call => ['insert', 'update'].includes(call[0])), false);
  }
  const malformed = followUpWriteClient();
  await assert.rejects(createLeadFollowUp(malformed, 'member-1', { caseId: 'CASE-001', notes: 'ติดตาม', nextFollowUpAt: 'bad' }),
    error => error.code === 'INVALID_FOLLOW_UP_DATE');
  assert.equal(malformed.calls.some(call => ['insert', 'update'].includes(call[0])), false);
});

test('terminal follow-up writes need no client deadline but retain the timestamp required by existing history constraints', async () => {
  for (const status of ['ยกเลิก', 'ปิดงาน']) {
    const client = followUpWriteClient();
    const result = await createLeadFollowUp(client, 'member-1', { caseId: 'CASE-001', notes: 'จบเคส', status });
    assert.equal(result.followUp.nextFollowUpAt, result.followUp.followedAt);
    assert.equal(result.status, status);
  }
});

test('case list reads derive overdue legacy schedules consistently without writing or modifying history', async () => {
  const row = Object.freeze({
    legacy_case_id: 'CASE-LEGACY', status: 'ติดต่อสอบถาม', recorded_at: '2026-08-01T05:00:00.000Z',
    customers: Object.freeze({ legacy_cust_id: 'CUST-001', customer_name: 'ลูกค้าทดสอบ' }),
    latest_follow_up: Object.freeze([]),
  });
  const operations = [];
  const embeddedOrders = [];
  const client = {
    from(table) {
      operations.push(['from', table]);
      return {
        select(columns) { operations.push(['select', columns]); return this; },
        order(column, options) {
          if (options?.referencedTable === 'latest_follow_up') embeddedOrders.push([column, options.ascending]);
          return this;
        },
        limit() { return this; },
        async range() { operations.push(['range']); return { data: [row], error: null, count: 1 }; },
      };
    },
  };
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const result = await getCases(client, { page: 1, pageSize: 20 });
    assert.equal(result.cases[0].nextFollowUpAt, '2026-08-03T17:00:00.000Z');
    assert.equal(result.cases[0].nextFollowUpAt, caseRecord(row).nextFollowUpAt);
    assert.equal(result.cases[0].latestFollowUpStatus, '');
  }
  assert.deepEqual(operations.map(operation => operation[0]), ['from', 'select', 'range', 'from', 'select', 'range']);
  assert.match(operations[1][1], /recorded_at, created_at/);
  assert.match(operations[1][1], /latest_follow_up:lead_follow_up_history\([^)]*followed_at, created_at/);
  assert.deepEqual(row.latest_follow_up, []);
  assert.deepEqual(embeddedOrders, [
    ['followed_at', false], ['created_at', false], ['id', false],
    ['followed_at', false], ['created_at', false], ['id', false],
  ]);
});

function customerDetailClient(customer, creatorResult = { data: null, error: null }) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(['from', table]);
      return {
        select(columns) {
          if (table === 'customers') assert.ok(columns.split(', ').includes('created_by'));
          return this;
        },
        eq(column, value) { calls.push(['eq', column, value]); return this; },
        order(column, options) { calls.push(['order', column, options]); return this; },
        async maybeSingle() { return { data: customer, error: null }; },
        async limit() { return { data: [], error: null }; },
      };
    },
    rpc(name, args) {
      calls.push(['rpc', name, args]);
      return { async maybeSingle() { return creatorResult; } };
    },
  };
}

test('lead detail chooses the same latest follow-up as case lists, tasks, and queues', async () => {
  const client = customerDetailClient({ id: 'customer-1', legacy_cust_id: 'CUST-001' });
  await getLeadDetail(client, 'CUST-001');
  assert.deepEqual(client.calls
    .filter(call => call[0] === 'order' && call[2]?.referencedTable === 'latest_follow_up')
    .map(call => [call[1], call[2].ascending]),
  [['followed_at', false], ['created_at', false], ['id', false]]);
});

test('customer detail shows the original creator name while preserving the recorded date', async () => {
  const customer = {
    id: 'customer-row-1', legacy_cust_id: 'CUST-001', customer_name: 'Customer',
    created_by: 'original-creator', updated_by: 'different-editor', recorded_at: '2026-09-13T05:41:00Z',
  };
  const client = customerDetailClient(customer, { data: { display_name: ' ผู้เพิ่มลูกค้า ' }, error: null });
  const result = await getLeadDetail(client, 'CUST-001');
  assert.equal(result.lead['บันทึกโดย'], 'ผู้เพิ่มลูกค้า');
  assert.equal(result.lead['วันที่บันทึก'], customer.recorded_at);
  assert.deepEqual(client.calls.find(call => call[0] === 'rpc'),
    ['rpc', 'get_customer_creator', { p_customer_id: customer.id }]);
  assert.equal(result.lead.created_by, undefined);
  assert.equal(result.lead.updated_by, undefined);
});

test('legacy customer detail does not invent a creator or query the account directory', async () => {
  const client = customerDetailClient({ id: 'customer-row-1', legacy_cust_id: 'CUST-001', created_by: null });
  const result = await getLeadDetail(client, 'CUST-001');
  assert.equal(result.lead['บันทึกโดย'], '');
  assert.ok(client.calls.every(call => call[0] !== 'rpc' && call[1] !== 'crm_members'));
});

test('customer detail handles an unavailable creator name without exposing account identifiers', async () => {
  for (const data of [null, { display_name: ' ' }]) {
    const client = customerDetailClient({ id: 'customer-row-1', created_by: 'original-creator' }, { data, error: null });
    const result = await getLeadDetail(client, 'CUST-001');
    assert.equal(result.lead['บันทึกโดย'], '');
  }
});

test('customer creator lookup never runs when the customer is inaccessible', async () => {
  const client = customerDetailClient(null);
  await assert.rejects(getLeadDetail(client, 'CUST-001'), error => error.code === 'CUSTOMER_NOT_FOUND');
  assert.ok(client.calls.every(call => call[0] !== 'rpc'));
});

test('customer creator lookup propagates access errors instead of guessing a name', async () => {
  const client = customerDetailClient({ id: 'customer-row-1', created_by: 'original-creator' },
    { data: null, error: { code: '42501', message: 'permission denied' } });
  await assert.rejects(getLeadDetail(client, 'CUST-001'), error => error.code === 'CRM_ROW_ACCESS_FORBIDDEN');
});

test('customer profile replaces only the upper recorded-date field with the creator', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const html = fs.readFileSync(require('node:path').join(__dirname, 'public', 'index.html'), 'utf8');
  const start = html.indexOf('async function viewLeadDetail(');
  const end = html.indexOf('function closeLeadDetailModal(', start);
  const content = { innerHTML: '', querySelectorAll: () => [] };
  const context = vm.createContext({
    leadDetailRequestId: 0, allLeads: [], setActiveDetailSource() {},
    displaySheetValue: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    formatSheetDate: () => '13 ก.ย. 2569 12:41',
    renderCustomerChatLinkIcon: () => '',
    document: { getElementById: id => id === 'leadDetailContent' ? content : null, querySelectorAll: () => [] },
    renderLeadStatusTimeline: () => '', renderLeadCases: () => '',
    refreshLeadCardInvoiceLinks() {}, openLeadDetailDrawer() {},
  });
  vm.runInContext(html.slice(start, end), context);
  for (const [creator, expected] of [['ผู้เพิ่ม <ลูกค้า>', 'ผู้เพิ่ม &lt;ลูกค้า&gt;'], ['', 'ไม่ระบุ']]) {
    await context.viewLeadDetail('CUST-001', '', {
      Cust_ID: 'CUST-001', 'บันทึกโดย': creator, 'วันที่บันทึก': '2026-09-13T05:41:00Z', 'ไทม์ไลน์สถานะ': [],
    });
    assert.match(content.innerHTML, /<dt>บันทึกโดย<\/dt>/);
    assert.ok(content.innerHTML.includes(expected));
    assert.doesNotMatch(content.innerHTML, /<dt>วันที่บันทึก<\/dt>/);
    assert.match(content.innerHTML, /บันทึกเมื่อ 13 ก\.ย\. 2569 12:41/);
    assert.doesNotMatch(content.innerHTML, /ผู้เพิ่ม <ลูกค้า>/);
  }
});

function caseDeletionClient(result) {
  const calls = [];
  const query = {
    delete() { calls.push(['delete']); return this; },
    eq(column, value) { calls.push(['eq', column, value]); return this; },
    select(columns) { calls.push(['select', columns]); return this; },
    async maybeSingle() { calls.push(['maybeSingle']); return result; },
  };
  return {
    calls,
    from(table) { calls.push(['from', table]); return query; },
  };
}

for (const constraint of ['crm_invoices_case_id_fkey', 'crm_invoices_source_history_id_fkey']) {
  for (const field of ['message', 'details']) {
    test(`case deletion reports a safe invoice conflict for ${constraint} in ${field}`, async () => {
      const client = caseDeletionClient({
        data: null,
        error: { code: '23503', [field]: `violates foreign key constraint "${constraint}" on table "crm_invoices"` },
      });

      await assert.rejects(deleteCase(client, { role: 'manager' }, { caseId: 'CASE-001' }), error => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'CASE_HAS_INVOICES');
        assert.equal(error.message, 'ไม่สามารถลบเคสนี้ได้ เนื่องจากมีใบแจ้งหนี้อยู่ ใบแจ้งหนี้และข้อมูลเดิมยังคงอยู่');
        assert.deepEqual(error.details, {});
        assert.doesNotMatch(error.message, /crm_invoices|foreign key|23503/);
        return true;
      });
      assert.deepEqual(client.calls, [
        ['from', 'cases'], ['delete'], ['eq', 'legacy_case_id', 'CASE-001'],
        ['select', 'legacy_case_id'], ['maybeSingle'],
      ]);
    });
  }
}

test('case deletion keeps other database errors on their existing error paths', async t => {
  t.mock.method(console, 'error', () => {});
  for (const databaseError of [
    { code: '23503', message: 'violates foreign key constraint "other_case_id_fkey" on table "crm_invoices"' },
    { code: '23503', message: 'violates foreign key constraint "crm_invoices_case_id_fkey_other"' },
    { code: '23503', message: 'violates foreign key constraint "other_crm_invoices_source_history_id_fkey"' },
    { code: '23505', message: 'constraint "crm_invoices_case_id_fkey"' },
  ]) {
    await assert.rejects(
      deleteCase(caseDeletionClient({ data: null, error: databaseError }), { role: 'admin' }, { caseId: 'CASE-001' }),
      error => error.status === 503 && error.code === 'DATABASE_UNAVAILABLE' && error.message === 'ไม่สามารถลบเคสได้'
    );
  }
  await assert.rejects(
    deleteCase(caseDeletionClient({ data: null, error: { code: '42501', message: 'permission denied' } }), { role: 'admin' }, { caseId: 'CASE-001' }),
    error => error.status === 403 && error.code === 'CRM_ROW_ACCESS_FORBIDDEN'
  );
});

test('case deletion rejects unauthorized roles without issuing a database query', async () => {
  for (const membership of [null, { role: 'sales' }, { role: 'staff' }]) {
    const client = caseDeletionClient({ data: { legacy_case_id: 'CASE-001' }, error: null });
    await assert.rejects(
      deleteCase(client, membership, { caseId: 'CASE-001' }),
      error => error.status === 403 && error.code === 'CASE_DELETE_FORBIDDEN'
    );
    assert.deepEqual(client.calls, []);
  }
});

test('case deletion preserves missing-id and case-not-found errors', async () => {
  const missingIdClient = caseDeletionClient({ data: null, error: null });
  await assert.rejects(
    deleteCase(missingIdClient, { role: 'manager' }, { caseId: '  ' }),
    error => error.status === 400 && error.code === 'MISSING_CASE_ID'
  );
  assert.deepEqual(missingIdClient.calls, []);
  await assert.rejects(
    deleteCase(caseDeletionClient({ data: null, error: null }), { role: 'manager' }, { caseId: 'CASE-001' }),
    error => error.status === 404 && error.code === 'CASE_NOT_FOUND'
  );
});

test('case deletion without invoices preserves the successful response for managers and admins', async () => {
  for (const role of ['manager', 'admin']) {
    const client = caseDeletionClient({ data: { legacy_case_id: 'CASE-001' }, error: null });
    const result = await deleteCase(client, { role }, { caseId: ' CASE-001 ' });
    assert.equal(result.success, true);
    assert.equal(result.caseId, 'CASE-001');
    assert.ok(result.apiVersion);
    assert.deepEqual(client.calls, [
      ['from', 'cases'], ['delete'], ['eq', 'legacy_case_id', 'CASE-001'],
      ['select', 'legacy_case_id'], ['maybeSingle'],
    ]);
  }
});

test('getCases fetches only the requested server page and returns total pagination', async () => {
  const calls = [];
  const query = {
    select(columns, options) {
      calls.push(['select', columns, options]);
      return this;
    },
    order(column, options) {
      calls.push(['order', column, options]);
      return this;
    },
    limit(value, options) {
      calls.push(['limit', value, options]);
      return this;
    },
    range(from, to) {
      calls.push(['range', from, to]);
      return Promise.resolve({
        data: [{
          legacy_case_id: 'CASE-041',
          recorded_at: '2026-08-27T03:00:00.000Z',
          customers: { legacy_cust_id: 'CUST-001', customer_name: 'ลูกค้าทดสอบ', phone: '0812345678' },
          lead_follow_up_history: [{ count: 0 }],
          quotation_history: [],
          latest_follow_up: [],
        }],
        error: null,
        count: 45,
      });
    },
  };
  const client = {
    from(table) {
      assert.equal(table, 'cases');
      return query;
    },
  };

  const result = await getCases(client, { page: '2', pageSize: '20' });

  assert.deepEqual(calls.find(([name]) => name === 'range'), ['range', 20, 39]);
  assert.deepEqual(result.pagination, { page: 2, pageSize: 20, total: 45, totalPages: 3 });
  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].caseId, 'CASE-041');
});

test('case records include saved billing branch information', () => {
  const record = caseRecord({
    legacy_case_id: 'CASE-001',
    billing_name: 'บริษัท ตัวอย่าง จำกัด',
    billing_address: '99/9 ถนนสุขุมวิท',
    billing_branch: '00001',
    tax_id: '0105559999999',
    customers: { legacy_cust_id: 'CUST-001', customer_name: 'ลูกค้าตัวอย่าง', phone: '0812345678' },
  });

  assert.equal(record.billingName, 'บริษัท ตัวอย่าง จำกัด');
  assert.equal(record.billingAddress, '99/9 ถนนสุขุมวิท');
  assert.equal(record.billingBranch, '00001');
  assert.equal(record.taxId, '0105559999999');
});

test('case history includes the case creation entry counted by the case list', async () => {
  const client = {
    from(table) {
      if (table === 'crm_invoices') {
        return {
          select() { return this; },
          eq(column, value) {
            assert.equal(column, 'case_id');
            assert.equal(value, 'case-row-1');
            return this;
          },
          async order() { return { data: [], error: null }; },
        };
      }
      if (table === 'cases') {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() {
            return {
              data: {
                id: 'case-row-1',
                legacy_case_id: 'CASE-001',
                created_at: '2026-08-26T10:20:00.000Z',
                recorded_at: '2026-08-26T10:20:00.000Z',
                topic: 'นัดสำรวจหน้างาน',
                status: 'นัดวัดพื้นที่',
              },
              error: null,
            };
          },
        };
      }

      assert.equal(table, 'lead_follow_up_history');
      return {
        select() { return this; },
        eq() { return this; },
        order() { return this; },
        limit() {
          return Promise.resolve({
            data: [{
              id: 'history-1',
              followed_at: '2026-08-26T10:21:00.000Z',
              contact_channel: '',
              outcome: '',
              notes: 'กำหนดนัดหมายจากการสร้างเคส: นัดวัดพื้นที่',
              next_follow_up_at: '2026-08-27T03:00:00.000Z',
              previous_status: '',
              current_status: 'นัดวัดพื้นที่',
              quotation_numbers: [],
              quotation_snapshot: null,
              created_at: '2026-08-26T10:21:00.000Z',
            }],
            error: null,
          });
        },
      };
    },
  };

  const result = await getLeadFollowUps(client, 'CASE-001');

  assert.equal(result.followUps.length, 2);
  assert.deepEqual(result.followUps.map(entry => entry.id), ['history-1', 'case-created:CASE-001']);
  assert.equal(result.followUps[1].outcome, 'เพิ่มเคสใหม่');
  assert.equal(result.followUps[1].notes, 'เพิ่มเคสใหม่: นัดสำรวจหน้างาน');
  assert.equal(result.followUps[1].status, 'นัดวัดพื้นที่');
  assert.equal(result.followUps[1].isInitial, true);
});

test('evaluation measurements accept valid values only for the evaluation status', () => {
  assert.deepEqual(
    evaluationMeasurementPayload('ประเมินราคา', { evaluationPanelCount: '12', evaluationAreaSqM: '35.50' }),
    { evaluationPanelCount: 12, evaluationAreaSqM: 35.5 }
  );
  assert.deepEqual(
    evaluationMeasurementPayload('ติดตามครั้งที่ 1', { evaluationPanelCount: '12', evaluationAreaSqM: '35.50' }),
    { evaluationPanelCount: null, evaluationAreaSqM: null }
  );
  assert.throws(
    () => evaluationMeasurementPayload('ประเมินราคา', { evaluationPanelCount: '1.5', evaluationAreaSqM: '35' }),
    error => error.code === 'INVALID_EVALUATION_PANEL_COUNT'
  );
  assert.throws(
    () => evaluationMeasurementPayload('ประเมินราคา', { evaluationPanelCount: '2', evaluationAreaSqM: '-1' }),
    error => error.code === 'INVALID_EVALUATION_AREA'
  );
});

test('site type payload normalizes its name and validates display order', () => {
  assert.deepEqual(
    siteTypeWritePayload({ name: '  อาคาร   สำนักงาน  ', sortOrder: '25', isActive: 'false' }, 'user-123'),
    {
      name: 'อาคาร สำนักงาน',
      is_active: false,
      sort_order: 25,
      updated_by: 'user-123',
    }
  );
  assert.throws(
    () => siteTypeWritePayload({ name: 'บ้าน', sortOrder: '-1' }, 'user-123'),
    (error) => error.code === 'INVALID_SITE_TYPE_SORT_ORDER' && error.status === 400
  );
});

test('site type records expose safe default values and usage counts', () => {
  assert.deepEqual(
    siteTypeRecord({ id: 'type-1', name: 'บ้าน', is_active: false, sort_order: 30, usage_count: 4 }),
    {
      id: 'type-1',
      name: 'บ้าน',
      isActive: false,
      sortOrder: 30,
      usageCount: 4,
      createdAt: '',
      updatedAt: '',
    }
  );
});

test('quotation salesperson contact returns the full name and business phone for the accessible case', async () => {
  const calls = [];
  const query = {
    select() { return this; },
    eq(column, value) {
      calls.push([column, value]);
      return this;
    },
    async maybeSingle() {
      return { data: { id: 'case-row-id', legacy_case_id: 'CASE-001', salesperson: 'เจ' }, error: null };
    },
  };
  const client = {
    from(table) {
      assert.equal(table, 'cases');
      return query;
    },
    async rpc(name, args) {
      assert.equal(name, 'get_case_salesperson_contact');
      assert.deepEqual(args, { p_case_id: 'case-row-id' });
      return { data: [{ full_name: 'เจษฎา โนนะ', phone: '062-092-6886' }], error: null };
    },
  };

  const result = await getCaseSalespersonContact(client, 'CASE-001');
  assert.deepEqual(calls, [['legacy_case_id', 'CASE-001']]);
  assert.equal(result.display, 'เจษฎา โนนะ (062-092-6886)');
});

test('quotation admin contact returns the full name and business phone for the accessible case', async () => {
  const calls = [];
  const query = {
    select() { return this; },
    eq(column, value) {
      calls.push([column, value]);
      return this;
    },
    async maybeSingle() {
      return { data: { id: 'case-row-id', legacy_case_id: 'CASE-001', admin_name: 'แอดมินเจ' }, error: null };
    },
  };
  const client = {
    from(table) {
      assert.equal(table, 'cases');
      return query;
    },
    async rpc(name, args) {
      assert.equal(name, 'get_case_admin_contact');
      assert.deepEqual(args, { p_case_id: 'case-row-id' });
      return { data: [{ full_name: 'เจษฎา โนนะ', phone: '062-092-6886' }], error: null };
    },
  };

  const result = await getCaseAdminContact(client, 'CASE-001');
  assert.deepEqual(calls, [['legacy_case_id', 'CASE-001']]);
  assert.equal(result.display, 'เจษฎา โนนะ (062-092-6886)');
});

test('quotation snapshot retains per-document notes and visibility choices', () => {
  const snapshot = normalizeQuotationSnapshot({
    company: 'GFS',
    quoteNumber: ' Q-20260825-001 ',
    issueDate: '2026-08-25',
    validDays: '15',
    customerName: 'บริษัทตัวอย่าง จำกัด',
    branch: 'สำนักงานใหญ่',
    creditTerm: '30 วัน',
    salesperson: 'ผู้ดูแลระบบ',
    salespersonSource: 'admin',
    signatureSalesperson: 'คุณสุภาภรณ์ (080-000-0000)',
    signatureSalespersonSource: 'admin',
    paymentTerms: 'ชำระเงินตามที่ตกลง',
    notes: 'ราคานี้รวมภาษีมูลค่าเพิ่มแล้ว',
    printOptions: {
      showNotes: false,
      showSalesperson: false,
      showTotals: false,
      showTotalInWords: true,
    },
    items: [{ description: 'ฟิล์มกรองแสง', quantity: 1, unit: 'งาน', unitPrice: 1000 }],
  });

  assert.equal(snapshot.branch, 'สำนักงานใหญ่');
  assert.equal(snapshot.creditTerm, '30 วัน');
  assert.equal(snapshot.salespersonSource, 'admin');
  assert.equal(snapshot.signatureSalesperson, 'คุณสุภาภรณ์ (080-000-0000)');
  assert.equal(snapshot.signatureSalespersonSource, 'admin');
  assert.equal(snapshot.notes, 'ราคานี้รวมภาษีมูลค่าเพิ่มแล้ว');
  assert.deepEqual(snapshot.printOptions, {
    showBranch: false,
    showCreditTerm: false,
    showPaymentTerms: true,
    showTotals: false,
    showTotalInWords: true,
    showNotes: false,
    showSalesperson: false,
  });
});

test('quotation snapshot accepts the same 720 px item image width offered by the form', () => {
  const snapshot = normalizeQuotationSnapshot({
    company: 'GFS',
    quoteNumber: 'Q-20260828-001',
    issueDate: '2026-08-28',
    validDays: '15',
    customerName: 'บริษัทตัวอย่าง จำกัด',
    items: [{
      description: 'ฟิล์มกรองแสง',
      quantity: 1,
      unit: 'งาน',
      unitPrice: 1000,
      imagePath: 'cases/CASE-001/example.webp',
      imageDisplayWidth: 720,
    }],
  });

  assert.equal(snapshot.items[0].imageDisplayWidth, 720);
  assert.throws(
    () => normalizeQuotationSnapshot({
      company: 'GFS',
      quoteNumber: 'Q-20260828-002',
      issueDate: '2026-08-28',
      validDays: '15',
      customerName: 'บริษัทตัวอย่าง จำกัด',
      items: [{
        description: 'ฟิล์มกรองแสง',
        quantity: 1,
        unit: 'งาน',
        unitPrice: 1000,
        imagePath: 'cases/CASE-001/example.webp',
        imageDisplayWidth: 721,
      }],
    }),
    error => error.code === 'INVALID_QUOTATION_SNAPSHOT'
  );
});

test('crmAssignmentRecord maps database snake_case fields to the server assignment shape', () => {
  assert.deepEqual(
    crmAssignmentRecord({
      employee_id: '  employee-123  ',
      salesperson_name: '  test  ',
      restricted: true,
      ignored_field: 'not exposed',
    }),
    {
      employeeId: 'employee-123',
      salespersonName: 'test',
      restricted: true,
    }
  );
  assert.equal(crmAssignmentRecord(null), null);
});

test('isRestrictedCrmSales only accepts an explicit true restriction flag', () => {
  assert.equal(isRestrictedCrmSales({ restricted: true }), true);
  assert.equal(isRestrictedCrmSales({ restricted: false }), false);
  assert.equal(isRestrictedCrmSales({ restricted: 'true' }), false);
  assert.equal(isRestrictedCrmSales(null), false);
});

test('general tasks can be created without an assignee', () => {
  assert.deepEqual(
    generalTaskWritePayload({
      title: 'ตรวจงานก่อนมอบหมาย',
      assignedTo: '   ',
      description: 'งานใหม่',
      customerName: 'คุณทดสอบ',
      customerPhone: '081-234-5678',
      siteAddress: '99 ถนนตัวอย่าง',
      location: 'https://maps.google.com/?q=13.7563,100.5018',
      province: 'กรุงเทพมหานคร',
      taskOwner: 'แอดมินทดสอบ',
      status: 'pending',
    }, 'user-123'),
    {
      title: 'ตรวจงานก่อนมอบหมาย',
      description: 'งานใหม่',
      contact_name: 'คุณทดสอบ',
      contact_phone: '081-234-5678',
      site_address: '99 ถนนตัวอย่าง',
      location_url: 'https://maps.google.com/?q=13.7563,100.5018',
      province: 'กรุงเทพมหานคร',
      task_owner: 'แอดมินทดสอบ',
      due_at: null,
      assigned_to: null,
      status: 'pending',
      updated_by: 'user-123',
    }
  );
});

test('generalTaskRecord uses empty strings for nullable fields returned by the database', () => {
  assert.deepEqual(
    generalTaskRecord({ id: 'task-1', title: 'งานยังไม่มอบหมาย', assigned_to: null }),
    {
      id: 'task-1',
      title: 'งานยังไม่มอบหมาย',
      description: '',
      customerName: '',
      customerPhone: '',
      siteAddress: '',
      location: '',
      province: '',
      taskOwner: '',
      dueAt: '',
      assignedTo: '',
      status: 'pending',
      completionNote: '',
      completedAt: '',
      createdAt: '',
      updatedAt: '',
    }
  );
});

test('requireGeneralTaskCreator allows every active CRM role to add a general task', () => {
  for (const role of ['admin', 'manager', 'sales', 'member']) {
    assert.doesNotThrow(() => requireGeneralTaskCreator({ role, is_active: true }));
  }
});

test('requireGeneralTaskCreator rejects inactive and unsupported roles', () => {
  for (const membership of [
    { role: 'sales', is_active: false },
    { role: 'viewer', is_active: true },
    { role: 'manager', is_active: false },
  ]) {
    assert.throws(
      () => requireGeneralTaskCreator(membership),
      error => error.code === 'GENERAL_TASK_CREATE_FORBIDDEN' && error.status === 403
    );
  }
});

test('validateCaseStatus rejects the removed other status', () => {
  assert.doesNotThrow(() => validateCaseStatus('ติดต่อสอบถาม'));
  assert.throws(
    () => validateCaseStatus('อื่นๆ'),
    (error) => {
      assert.equal(error.code, 'INVALID_CASE_STATUS');
      assert.equal(error.status, 400);
      return true;
    }
  );
});

test('scopeCaseAssignment overrides a restricted sales payload with the canonical salesperson', () => {
  const maliciousPayload = {
    caseId: 'CASE-001',
    salesperson: 'another salesperson',
    status: 'ติดต่อสอบถาม',
  };

  assert.deepEqual(
    scopeCaseAssignment(maliciousPayload, {
      restricted: true,
      salespersonName: 'test',
    }),
    {
      caseId: 'CASE-001',
      salesperson: 'test',
      status: 'ติดต่อสอบถาม',
    }
  );
  assert.equal(maliciousPayload.salesperson, 'another salesperson');
});

test('scopeCaseAssignment does not override a nonrestricted payload', () => {
  const payload = { caseId: 'CASE-002', salesperson: 'chosen salesperson' };
  const result = scopeCaseAssignment(payload, {
    restricted: false,
    salespersonName: 'test',
  });

  assert.strictEqual(result, payload);
  assert.equal(result.salesperson, 'chosen salesperson');
});

test('quotationListRecords exposes one document per saved quotation number with the case salesperson nickname', () => {
  const records = quotationListRecords({
    id: 'history-1',
    followed_at: '2026-08-21T08:00:00.000Z',
    quotation_numbers: ['Q-001', 'Q-OLD'],
    quotation_snapshot: {
      quoteNumber: 'Q-001',
      company: 'GFS',
      customerName: 'ลูกค้าตัวอย่าง',
      salesperson: 'อิ่มมา',
      items: []
    },
    cases: {
      id: 'internal-case-id',
      legacy_case_id: 'CASE-001',
      company: 'MHL',
      admin_name: 'แอดมินตัวอย่าง',
      salesperson: 'ฝ่ายขายเดิม',
      topic: 'ติดตั้งฟิล์ม',
      site_address: '99 ถนนสุขุมวิท กรุงเทพมหานคร',
      customers: {
        id: 'internal-customer-id',
        legacy_cust_id: 'CUST-001',
        customer_name: 'ชื่อลูกค้าเดิม'
      }
    }
  });

  assert.deepEqual(records, [
    {
      quoteNumber: 'Q-001',
      caseId: 'CASE-001',
      customerId: 'CUST-001',
      customerName: 'ลูกค้าตัวอย่าง',
      salesperson: 'ฝ่ายขายเดิม',
      admin: 'แอดมินตัวอย่าง',
      company: 'GFS',
      topic: 'ติดตั้งฟิล์ม',
      siteAddress: '99 ถนนสุขุมวิท กรุงเทพมหานคร',
      followedAt: '2026-08-21T08:00:00.000Z',
      quotationSnapshot: {
        quoteNumber: 'Q-001',
        company: 'GFS',
        customerName: 'ลูกค้าตัวอย่าง',
        salesperson: 'อิ่มมา',
        items: []
      }
    },
    {
      quoteNumber: 'Q-OLD',
      caseId: 'CASE-001',
      customerId: 'CUST-001',
      customerName: 'ลูกค้าตัวอย่าง',
      salesperson: 'ฝ่ายขายเดิม',
      admin: 'แอดมินตัวอย่าง',
      company: 'GFS',
      topic: 'ติดตั้งฟิล์ม',
      siteAddress: '99 ถนนสุขุมวิท กรุงเทพมหานคร',
      followedAt: '2026-08-21T08:00:00.000Z',
      quotationSnapshot: null
    }
  ]);
});

test('scopeCaseAssignment rejects restricted sales accounts without a linked employee identity', () => {
  assert.throws(
    () => scopeCaseAssignment({ salesperson: 'attacker supplied' }, {
      restricted: true,
      salespersonName: '   ',
    }),
    (error) => {
      assert.equal(error.code, 'SALES_EMPLOYEE_NOT_LINKED');
      assert.equal(error.status, 403);
      return true;
    }
  );
});

test('requireCaseAssignmentManager forbids restricted sales reassignment', () => {
  assert.throws(
    () => requireCaseAssignmentManager({ restricted: true }),
    (error) => {
      assert.equal(error.code, 'CASE_REASSIGNMENT_FORBIDDEN');
      assert.equal(error.status, 403);
      return true;
    }
  );
});

test('requireCaseAssignmentManager permits nonrestricted users', () => {
  assert.doesNotThrow(() => requireCaseAssignmentManager({ restricted: false }));
  assert.doesNotThrow(() => requireCaseAssignmentManager(null));
});

test('isPhoneUniqueViolation detects the customer phone unique constraint', () => {
  assert.equal(
    isPhoneUniqueViolation({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      details: 'Key (phone_normalized)=(0812345678) already exists.',
    }),
    true
  );
  assert.equal(
    isPhoneUniqueViolation({
      code: '23505',
      message: 'duplicate key value violates unique constraint "customers_phone_normalized_unique"',
    }),
    true
  );
  assert.equal(
    isPhoneUniqueViolation({ code: '23505', message: 'duplicate email address' }),
    false
  );
  assert.equal(
    isPhoneUniqueViolation({ code: '42501', message: 'phone_normalized permission denied' }),
    false
  );
});

test('quotationCountForHistory counts distinct saved quotation numbers only', () => {
  assert.equal(
    quotationCountForHistory([
      { quotation_numbers: ['QT-001', ' QT-002 '] },
      { quotation_numbers: ['QT-001', '', null] },
      { quotation_numbers: null },
    ]),
    2
  );
  assert.equal(quotationCountForHistory(null), 0);
});

test('customerLeadMetrics returns distinct quotation totals and ordered company tags', () => {
  assert.deepEqual(
    customerLeadMetrics([
      {
        company: 'mhl',
        quotation_history: [
          { quotation_numbers: ['QT-002', 'QT-001'] },
          { quotation_numbers: ['QT-001'] },
        ],
      },
      {
        company: ' GFS ',
        quotation_history: [{ quotation_numbers: ['QT-003'] }],
      },
      {
        company: 'GFS',
        quotation_history: [],
      },
    ]),
    {
      companies: ['GFS', 'MHL'],
      quotationCount: 3,
    }
  );
  assert.deepEqual(customerLeadMetrics(null), { companies: [], quotationCount: 0 });
});
