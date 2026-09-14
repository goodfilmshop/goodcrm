const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { customerWritePayload, customerRecord, saveCustomer, getCustomer, getLeads, lookupCustomer, getLeadDetail } = require('./server');
const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
const body = { customerName: 'Chat customer', phone: '0812345678', contactChannel: 'Line', contactHandle: 'chat_customer' };
const row = { id: 'row-1', legacy_cust_id: 'CUST-260913-ABC', customer_name: body.customerName, phone: body.phone, chat_link: 'https://m.me/chat_customer' };

function customerClient(existing = row) {
  const calls = [];
  const client = {
    calls,
    from(table) {
      let operation = 'read';
      let payload;
      let filter;
      const query = {
        select(columns) { calls.push(['select', table, columns]); return this; },
        insert(value) { operation = 'insert'; payload = value; calls.push(['insert', table, value]); return this; },
        update(value) { operation = 'update'; payload = value; calls.push(['update', table, value]); return this; },
        eq(column, value) { filter = column; calls.push(['eq', column, value]); return this; },
        ilike() { return this; },
        order() { return this; },
        or() { return this; },
        async maybeSingle() { return { data: filter === 'legacy_cust_id' ? existing : null, error: null }; },
        async single() { return { data: { ...existing, ...payload, chat_link: Object.hasOwn(payload, 'chat_link') ? payload.chat_link : existing?.chat_link }, error: null }; },
        async range() { return { data: existing ? [existing] : [], error: null, count: existing ? 1 : 0 }; },
        async limit() { return { data: table === 'customers' && existing ? [existing] : [], error: null }; },
      };
      return query;
    },
  };
  return client;
}

test('customer Link Chat is optional, trimmed, and distinct from the case link', () => {
  assert.equal(Object.hasOwn(customerWritePayload(body, 'user-1'), 'chat_link'), false);
  for (const value of ['', '  ', null]) {
    assert.equal(customerWritePayload({ ...body, customerChatLink: value }, 'user-1').chat_link, null);
  }
  const link = 'https://m.me/ChatCustomer?ref=Hello%20World';
  const payload = customerWritePayload({ ...body, customerChatLink: ` ${link} `, chatLink: 'https://example.com/case' }, 'user-1');
  assert.equal(payload.chat_link, link);
  assert.equal(payload.updated_by, 'user-1');
});

test('customer Link Chat accepts ordinary HTTP(S) URLs and rejects unsafe or malformed values', () => {
  for (const link of ['http://example.com/chat', 'https://line.me/R/ti/p/@example', 'HTTPS://m.me/Customer']) {
    assert.equal(customerWritePayload({ ...body, customerChatLink: link }, 'user').chat_link, link);
  }
  for (const link of ['javascript:alert(1)', 'data:text/html,test', 'file:///C:/private', '/chat', 'm.me/customer',
    'https://', 'https://example.com/a b', 'https://user:password@example.com/chat', 'https://example.com/' + 'a'.repeat(2048)]) {
    assert.throws(() => customerWritePayload({ ...body, customerChatLink: link }, 'user'),
      error => error.status === 400 && error.code === 'INVALID_CUSTOMER_CHAT_LINK');
  }
});

test('saving a new customer stores and returns the optional customer link', async () => {
  const client = customerClient({ ...row, chat_link: null });
  const link = 'https://line.me/R/ti/p/@new';
  const result = await saveCustomer(client, 'user-1', { ...body, customerChatLink: link });
  assert.equal(result.success, true);
  assert.equal(result.updated, false);
  assert.equal(result.customerChatLink, link);
  const write = client.calls.find(call => call[0] === 'insert')[2];
  assert.equal(write.chat_link, link);
  assert.equal(write.created_by, 'user-1');
});

test('editing, clearing, and omitted-field updates keep customer Link Chat consistent', async () => {
  for (const [field, expected, writesLink] of [
    [{ customerChatLink: 'https://m.me/updated' }, 'https://m.me/updated', true],
    [{ customerChatLink: '' }, '', true],
    [{}, row.chat_link, false],
  ]) {
    const client = customerClient();
    const result = await saveCustomer(client, 'editor-1', { ...body, customerId: row.legacy_cust_id, ...field });
    assert.equal(result.updated, true);
    assert.equal(result.customerChatLink, expected);
    const write = client.calls.find(call => call[0] === 'update')[2];
    assert.equal(Object.hasOwn(write, 'chat_link'), writesLink);
    assert.equal(Object.hasOwn(write, 'created_by'), false);
  }
});

test('customer records, detail, list, and lookup all round-trip the customer chat link', async () => {
  assert.equal(customerRecord(row).customerChatLink, row.chat_link);
  assert.equal(customerRecord({}).customerChatLink, '');
  const client = customerClient();
  assert.equal((await getCustomer(client, row.legacy_cust_id)).customer.customerChatLink, row.chat_link);
  assert.equal((await getLeadDetail(client, row.legacy_cust_id)).lead['Link Chat'], row.chat_link);
  assert.equal((await getLeads(client, {})).leads[0]['Link Chat'], row.chat_link);
  const matches = await lookupCustomer(client, { customerName: 'Chat', phone: body.phone });
  assert.equal(matches.nameMatches[0].customerChatLink, row.chat_link);
  assert.equal(matches.phoneMatches[0].customerChatLink, row.chat_link);
  for (const call of client.calls.filter(call => call[0] === 'select' && call[1] === 'customers')) {
    assert.ok(call[2].split(', ').includes('chat_link'), call[2]);
  }
});

function frontendFunction(name, nextName, context) {
  const start = html.search(new RegExp(`(?:async\\s+)?function ${name}\\(`));
  const nextOffset = html.slice(start + 1).search(new RegExp(`(?:async\\s+)?function ${nextName}\\(`));
  const end = nextOffset < 0 ? -1 : start + 1 + nextOffset;
  assert.ok(start >= 0 && end > start);
  vm.runInContext(html.slice(start, end), context);
}

test('customer chat links are safely escaped and open in a separate tab', () => {
  const context = vm.createContext({ URL,
    escapeTimelineValue: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  });
  frontendFunction('getSafeCaseLink', 'getSafeLocationLink', context);
  const result = context.renderCustomerChatLinkIcon('https://m.me/customer?ref=a&other=b');
  assert.match(result, /class="customer-profile-chat"/);
  assert.match(result, /aria-label="เปิดแชทลูกค้า"/);
  assert.match(result, /fa-solid fa-comments" aria-hidden="true"/);
  assert.doesNotMatch(result, /<dt>|Link Chat|>เปิดแชท/);
  assert.match(result, /href="https:\/\/m.me\/customer\?ref=a&amp;other=b"/);
  assert.match(result, /target="_blank" rel="noopener noreferrer"/);
  for (const link of ['', null, 'javascript:alert(1)', 'data:text/html,<img src=x>']) {
    assert.equal(context.renderCustomerChatLinkIcon(link), '');
  }
});

test('the optional customer field has desktop/mobile layout and save validation', () => {
  const input = html.match(/<input[^>]*id="customerChatLink"[^>]*>/)?.[0];
  assert.ok(input);
  assert.match(input, /type="url"/);
  assert.match(input, /maxlength="2048"/);
  assert.doesNotMatch(input, /\brequired\b/);
  assert.match(html, /Link Chat <span[^>]*>\(ไม่บังคับ\)<\/span>/);
  assert.match(html, /grid-template-areas:"name gender" "phone channel" "email chat"/);
  assert.match(html, /grid-template-areas:"name" "gender" "phone" "channel" "email" "chat"/);
  assert.match(html, /grid-template-areas:"referral handle"/);
  assert.match(html, /grid-template-areas:"referral" "handle"/);
  assert.match(html, /validateSectionFields\(\['customerName', 'referralDate', 'phone', 'email', 'customerChatLink'\]\)/);
  assert.match(html, /data\.customerChatLink \|\| ""/);
});

test('customer form removes the three section headings, preserves controls and slides from the right', () => {
  const basic = html.match(/<section class="customer-form-panel customer-basic-panel"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  const source = html.match(/<section class="customer-form-panel customer-source-panel"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  const notes = html.match(/<section class="customer-form-panel customer-notes-panel customer-notes-field"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(basic && source && notes);
  for (const id of ['customerName', 'phone', 'email', 'contactChannel', 'customerChatLink']) {
    assert.ok(basic.includes(`id="${id}"`));
    assert.equal(html.split(`id="${id}"`).length - 1, 1);
  }
  for (const id of ['referralDate', 'contactHandle']) {
    assert.ok(source.includes(`id="${id}"`));
    assert.equal(html.split(`id="${id}"`).length - 1, 1);
  }
  assert.ok(notes.includes('id="customerRemarks"'));
  assert.match(html, /customer-basic-panel" aria-label="ข้อมูลลูกค้า"/);
  assert.match(html, /customer-source-panel" aria-label="ที่มาของลูกค้า"/);
  assert.match(html, /customer-notes-field" aria-label="หมายเหตุ"/);
  for (const panel of [basic, source, notes]) {
    assert.doesNotMatch(panel, /<header\b|<h4\b|customer-panel-heading|customer-panel-icon/);
  }
  assert.doesNotMatch(html, /customerBasicHeading|customerSourceHeading|customerNotesHeading/);
  assert.doesNotMatch(html, /ข้อมูลพื้นฐานของลูกค้า|ข้อมูลการรับรู้และช่องทางที่ติดต่อเข้ามา|ข้อมูลเพิ่มเติมเกี่ยวกับลูกค้า/);
  assert.match(notes, /<label for="customerRemarks"[^>]*>หมายเหตุ<\/label>/);
  assert.equal((basic.match(/class="gender-option /g) || []).length, 3);
  assert.equal((basic.match(/class="channel-btn /g) || []).length, 8);
  assert.ok(basic.indexOf('id="contactChannel"') < basic.indexOf('id="email"'), 'keyboard order follows the reference rows');
  const styles = html.split('/* Grouped customer form:')[1].split('/* Compact spacing')[0];
  assert.match(styles, /justify-content:flex-end/);
  assert.match(styles, /width:min\(700px, 100%\)/);
  assert.match(styles, /animation:customer-drawer-in/);
  assert.doesNotMatch(styles, /animation:customer-popup-in/);
  assert.match(styles, /#leadForm #customerPopupTitle \{ font-size:24px/);
  assert.match(styles, /customer-popup-fields label \{ font-size:14px/);
  assert.doesNotMatch(styles, /customer-panel-heading|customer-panel-icon/);
  assert.match(styles, /@media \(max-width: 640px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test('customer profile puts a conditional chat icon immediately before Edit and removes the old detail field', async () => {
  const content = { innerHTML: '', querySelectorAll: () => [] };
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const context = vm.createContext({ URL, escapeTimelineValue: escape, displaySheetValue: escape,
    leadDetailRequestId: 0, allLeads: [], setActiveDetailSource() {}, formatSheetDate: () => 'Recorded date',
    document: { getElementById: id => id === 'leadDetailContent' ? content : null, querySelectorAll: () => [] },
    renderLeadStatusTimeline: () => '', renderLeadCases: () => '', refreshLeadCardInvoiceLinks() {}, openLeadDetailDrawer() {},
  });
  frontendFunction('getSafeCaseLink', 'getSafeLocationLink', context);
  frontendFunction('viewLeadDetail', 'closeLeadDetailModal', context);
  for (const link of ['https://m.me/customer?ref=a&other=b', '', null, 'javascript:alert(1)']) {
    await context.viewLeadDetail('CUST-001', '', { Cust_ID: 'CUST-001', 'Link Chat': link, 'ไทม์ไลน์สถานะ': [] });
    assert.doesNotMatch(content.innerHTML, /<dt>Link Chat<\/dt>/);
    const header = content.innerHTML.match(/<header class="customer-profile-header">([\s\S]*?)<\/header>/)?.[1];
    assert.ok(header);
    assert.match(header, /id="editCustomerFromDrawerButton"/);
    if (link?.startsWith('https://')) {
      assert.match(header, /class="customer-profile-chat"[\s\S]*?<\/a>\s*<button type="button" id="editCustomerFromDrawerButton"/);
      assert.equal(content.innerHTML.match(/class="customer-profile-chat"/g)?.length, 1);
      assert.match(header, /href="https:\/\/m.me\/customer\?ref=a&amp;other=b"/);
    } else {
      assert.doesNotMatch(content.innerHTML, /class="customer-profile-chat"/);
    }
  }
});

test('form serialization keeps the customer and case chat links separate', () => {
  const nodes = new Map();
  const getElementById = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', dataset: {} });
    return nodes.get(id);
  };
  getElementById('customerChatLink').value = ' https://m.me/customer ';
  getElementById('caseChatLink').value = 'https://m.me/case';
  const context = vm.createContext({ document: { getElementById, querySelector: () => null },
    savedSections: {}, syncCaseInitialStatus() {}, getCaseNextFollowUpAt: () => '', isRestrictedSalesUser: () => false,
  });
  frontendFunction('getFormValues', 'loadSectionWorkflow', context);
  const values = context.getFormValues();
  assert.equal(values.customerChatLink, 'https://m.me/customer');
  assert.equal(values.chatLink, 'https://m.me/case');
});

test('loading a customer for editing restores or clears Link Chat', () => {
  const nodes = new Map();
  const context = vm.createContext({ document: {
    getElementById: id => { if (!nodes.has(id)) nodes.set(id, { value: '' }); return nodes.get(id); },
    querySelectorAll: () => [], querySelector: () => null,
  }, formatThaiPhone: value => value, renderReferralSourceSelect() {}, getCustomerRemarksForEdit: () => '',
  toggleChannelDetails() {}, clearCustomerLookup() {}, persistSectionWorkflow() {}, saveCurrentDraftSilently() {}, updateSectionSaveButtons() {},
  });
  frontendFunction('loadCustomerRecord', 'lookupCustomers', context);
  context.loadCustomerRecord({ custId: row.legacy_cust_id, customerChatLink: row.chat_link }, { suppressFeedback: true });
  assert.equal(nodes.get('customerChatLink').value, row.chat_link);
  context.loadCustomerRecord({ custId: row.legacy_cust_id }, { suppressFeedback: true });
  assert.equal(nodes.get('customerChatLink').value, '');
});
