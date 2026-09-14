const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeInvoiceSnapshot, saveInvoice, getInvoiceForQuotation } = require('./server');
const { deleteInvoice } = require('./server');
test('invoice deletion checks identity and version, and rejects stale deletion', async () => {
  const filters = [];
  const c = client();
  const from = c.from;
  c.from = table => table !== 'crm_invoices' ? from(table) : {
    delete(){return this}, eq(k,v){filters.push([k,v]);return this}, select(){return this}, async maybeSingle(){return {data:{id:'invoice'}}}
  };
  const body = {caseId:'CASE',historyId:'history',invoiceId:'invoice',expectedUpdatedAt:'2026-09-13T00:00:00Z'};
  assert.equal((await deleteInvoice(c,body)).success,true);
  assert.deepEqual(filters,[['id','invoice'],['source_history_id','history-id'],['updated_at',body.expectedUpdatedAt]]);
  c.from = table => table !== 'crm_invoices' ? from(table) : {delete(){return this},eq(){return this},select(){return this},async maybeSingle(){return {data:null}}};
  await assert.rejects(deleteInvoice(c,body),error=>error.code==='INVOICE_CONFLICT');
  await assert.rejects(deleteInvoice(c,{...body,expectedUpdatedAt:''}));
});
const sample = () => ({ company:'GFS', issueDate:'2026-09-12', dueDate:'2026-10-12', customerName:'Test customer', items:[{description:'Film',quantity:2,unitPrice:100}] });
function client(result = {data:null}) {
  return {
    from(table) { return {select(){return this},eq(){return this},async maybeSingle(){return table==='cases' ? {data:{id:'case-id'}} : table==='lead_follow_up_history' ? {data:{id:'history-id'}} : result}}; },
    async rpc(name,args) { assert.equal(name,'save_crm_invoice'); assert.equal(args.p_history_id,'history-id'); return result; }
  };
}
test('invoice dates, item values and excess discounts are rejected', () => {
  assert.equal(normalizeInvoiceSnapshot(sample()).dueDate,'2026-10-12');
  for (const bad of [{issueDate:'2026-02-30'}, {dueDate:'2026-09-11'}, {items:[]}, {items:[{description:'x',quantity:1,unitPrice:-1}]}]) assert.throws(() => normalizeInvoiceSnapshot({...sample(),...bad}));
  assert.throws(() => normalizeInvoiceSnapshot({...sample(), items:[...sample().items,{description:'discount',isDiscount:true,quantity:1,unitPrice:201}]}));
});
test('invoice API returns authoritative identity and preserves the saved snapshot', async () => {
  const row = {id:'invoice-id',invoice_number:'INV-GFS-260912-0001',updated_at:'2026-09-12T15:00:00Z',snapshot:{...sample(),invoiceNumber:'spoof'}};
  const saved = await saveInvoice(client({data:row}),{caseId:'CASE',historyId:'history-id',invoice:sample()});
  assert.equal(saved.invoice.invoiceNumber,row.invoice_number);
  assert.equal(saved.invoice.invoiceId,row.id);
  const read = await getInvoiceForQuotation(client({data:row}),{caseId:'CASE',historyId:'history-id'});
  assert.deepEqual(read.invoice,saved.invoice);
});
test('invoice API reports stale updates as a conflict', async () => {
  await assert.rejects(saveInvoice(client({error:{code:'40001'}}),{caseId:'CASE',historyId:'history-id',invoice:sample()}),error=>error.code==='INVOICE_CONFLICT');
});
test('inaccessible cases prevent invoice RPC calls', async () => {
  let called = false;
  const denied = {from(){return {select(){return this},eq(){return this},async maybeSingle(){return {data:null}}}},rpc(){called=true}};
  await assert.rejects(saveInvoice(denied,{caseId:'CASE',historyId:'history-id',invoice:sample()}));
  assert.equal(called,false);
});

function printableInvoice(data) {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const context = vm.createContext({
    getQuotationCompanyMeta: company => ({ name: company, englishName: company }),
    DOCUMENT_TEMPLATE_GFS_QUOTATION_FIXED_HEADER_URL: '/assets/gfs-quotation-header-fixed-2026.png'
  });
  const helpers = [
    'escapeTimelineValue', 'quotationAmount', 'formatQuotationAmount', 'formatQuotationDate',
    'quotationImageDisplayWidth', 'isQuotationDiscount', 'calculateCaseQuotationTotals',
    'quotationThaiIntegerText', 'quotationThaiBahtText', 'invoicePrintableDocument'
  ];
  for (const name of helpers) {
    const source = html.match(new RegExp(`^    function ${name}\\([\\s\\S]*?^    \\}`, 'm'));
    assert.ok(source, `Missing printable helper: ${name}`);
    vm.runInContext(source[0], context);
  }
  return context.invoicePrintableDocument(data);
}

test('invoice A4 typography matches the quotation scale and keeps its print layout', () => {
  for (const company of ['GFS', 'MHL']) {
    const html = printableInvoice({ ...sample(), company });
    const rule = selector => {
      const start = html.indexOf(`${selector}{`);
      assert.ok(start >= 0, `Missing style: ${selector}`);
      return html.slice(start, html.indexOf('}', start));
    };
    assert.match(rule('body'), /font-family:Tahoma,"Noto Sans Thai",Arial,sans-serif;font-size:12px;line-height:1\.55/);
    assert.match(rule('.customer'), /font-size:14px/);
    assert.match(rule('.box h3'), /font-size:12px/);
    assert.match(rule('.meta strong'), /font-size:12px/);
    assert.match(rule('td'), /font-size:12px/);
    assert.match(rule('.total div:last-child'), /font-size:15px/);
    assert.match(rule('.invoice-total-words'), /font-size:13px/);
    assert.match(rule('.invoice-total-words'), /font-weight:600/);
    assert.match(rule('.invoice-bank-details'), /font-size:11px/);
    assert.match(rule('.amount'), /font-variant-numeric:tabular-nums/);
    assert.match(html, /@page \{ size:A4 portrait; margin:14mm 13mm;/);
    assert.match(html, /@bottom-center \{ content:"หมายเหตุ : ใบแจ้งหนี้ฉบับนี้ไม่ใช่ใบเสร็จรับเงินหรือใบกำกับภาษี"/);
    assert.match(html, /@media print\{[\s\S]*print-color-adjust:exact/);
  }
});

test('invoice typography preserves billing data, totals, bank accounts and escaped long text', () => {
  const data = { ...sample(), invoiceNumber:'INV-G260913-0002', sourceQuoteNumber:'Q260912-9126FC-02',
    customerName:'คุณกิตติศักดิ์ มีทรัพย์', address:'ที่อยู่ทดสอบ '.repeat(30) + '<script>alert(1)</script>',
    branch:'สำนักงานใหญ่', contactName:'คุณกิตติศักดิ์ มีทรัพย์', contactPhone:'063-920-4840',
    items:[{description:'ค่ามัดจำก่อนติดตั้ง 50%', quantity:1, unit:'งาน', unitPrice:45000}] };
  const html = printableInvoice(data);
  for (const value of [data.invoiceNumber, data.sourceQuoteNumber, data.customerName, data.contactPhone,
    '45,000.00', '3,150.00', '48,150.00', '(สี่หมื่นแปดพันหนึ่งร้อยห้าสิบบาทถ้วน)',
    '414-061888-0', '039-1-89523-6', 'ผู้รับใบแจ้งหนี้', 'ผู้วางบิล / ผู้มีอำนาจลงนาม']) {
    assert.ok(html.includes(value), `Missing invoice content: ${value}`);
  }
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  const discounted = printableInvoice({ ...data, items:[...data.items, {isDiscount:true, description:'ส่วนลด', quantity:1, unitPrice:5000}] });
  for (const value of ['class="discount"', '40,000.00', '2,800.00', '42,800.00']) assert.ok(discounted.includes(value));
});

test('invoice signatures use shorter centred name lines and nine-millimetre handwritten dates', () => {
  for (const company of ['GFS', 'MHL']) {
    const html = printableInvoice({ ...sample(), company });
    assert.equal((html.match(/class="invoice-signature-date"/g) || []).length, 2);
    assert.equal((html.match(/class="invoice-date-writing-line"/g) || []).length, 2);
    assert.equal((html.match(/class="invoice-signature-line"/g) || []).length, 2);
    assert.match(html, /\.invoice-signature-line\{[^}]*width:60mm;max-width:75%[^}]*margin:0 auto 8px/);
    assert.match(html, /\.invoice-date-writing-line\{[^}]*width:42mm;height:9mm;border-bottom:1px dotted/);
    assert.match(html, /\.invoice-signature-date\{[^}]*align-items:flex-end[^}]*margin-top:2mm/);
    assert.match(html, /\.signatures\{[^}]*break-inside:avoid;page-break-inside:avoid/);
    assert.ok(!html.includes('วันที่ ................................'));
  }
});

test('both company invoices use dark green headers with white text and preserve pale panels and quotations', () => {
  for (const company of ['GFS', 'MHL']) {
    const html = printableInvoice({ ...sample(), company });
    assert.match(html, /th\{background:#166534;color:#fff/);
    assert.match(html, /\.invoice-gfs-title\{[^}]*background:#166534;color:#fff/);
    assert.match(html, /\.mark\{[^}]*background:#166534;[^}]*color:#fff/);
    assert.match(html, /\.box\{[^}]*border:1px solid #d4eadb[^}]*background:#fbfefc/);
    assert.match(html, /\.total div:last-child\{[^}]*background:#eefbf2;color:#166534/);
    assert.match(html, /\.invoice-total-words\{[^}]*color:#166534/);
    for (const oldColour of ['#078bca', '#c2410c', '#f0f9ff', '#f8fafc', '#dae3ec', '#dce5ee', '#facc15', '#fef9c3', '#fde68a', '#854d0e', '#422006']) {
      assert.ok(!html.includes(oldColour), `Old invoice colour remains: ${oldColour}`);
    }
  }
  const source = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  assert.match(source, /\.invoice-draft-dialog \.invoice-draft-save \{ background:linear-gradient\(110deg,#d8f5e0,#bbf7d0\); color:#14532d/);
  assert.match(source, /\.invoice-section-icon \{[^}]*color:#166534/);
  assert.match(source, /\.invoice-draft-header h3 \{[^}]*color:#14532d/);
  assert.match(source, /function quotationPrintableDocument\(data\) \{\s*return data.company === 'MHL'\s*\? legacyQuotationPrintableDocument\(data\)\s*: gfsFixedQuotationPrintableDocument\(data\)/);
});

test('invoice bank details use a pale green tone and keep each bank, account and branch on one row', () => {
  const html = printableInvoice(sample());
  assert.match(html, /\.invoice-bank-details\{[^}]*background:#f3fbf5;border:1px solid #d4eadb[^}]*color:#14532d/);
  assert.match(html, /\.invoice-bank-row\{[^}]*grid-template-columns:92px 84px minmax\(0,1fr\)/);
  assert.match(html, /\.invoice-bank-row>span\{white-space:nowrap\}/);
  assert.ok(!html.includes('grid-column:1/-1'));
  assert.ok(html.includes('<span>- ธ.ไทยพาณิชย์</span><span>414-061888-0</span><span>สาขาบิ๊กซี ถนนศรีนครินทร์</span>'));
  assert.ok(html.includes('<span>- ธ.กสิกรไทย</span><span>039-1-89523-6</span><span>สาขาบิ๊กซี ถนนศรีนครินทร์</span>'));
  assert.ok(!printableInvoice({ ...sample(), company:'MHL' }).includes('<section class="invoice-bank-details">'));
});

test('invoice editor, invoice links and issuance status contain no old yellow or blue theme', () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const css = source.slice(source.indexOf('    .invoice-preview-dialog {'), source.indexOf('    .quotation-collapsible > summary {'));
  for (const oldColour of ['#facc15', '#fde047', '#fef9c3', '#fde68a', '#854d0e', '#713f12', '#422006', '#2563eb', '#dbeafe']) {
    assert.ok(!css.includes(oldColour), `Old invoice editor colour remains: ${oldColour}`);
  }
  assert.match(css, /\.invoice-draft-header \{ overflow:hidden; background:radial-gradient\([^\n]*#86efac26/);
  assert.match(source, /"ออกใบแจ้งหนี้": "border-green-200 bg-green-50 text-green-700"/);
  assert.match(source, /invoice-related-panel rounded-2xl border border-green-100 bg-green-50\/40/);
  const createButton = source.match(/<button id="createInvoiceFromQuotationButton"[^>]*>/)?.[0];
  assert.ok(createButton.includes('text-green-700') && createButton.includes('border-green-200'));
  const cardLinks = source.slice(source.indexOf('async function refreshLeadCardInvoiceLinks()'), source.indexOf('function renderLeadCases('));
  assert.ok(cardLinks.includes('border-green-200 bg-green-50'));
  assert.ok(!cardLinks.includes('amber-'));
  const historyButton = source.match(/<button type="button" data-open-invoice-history=[^>]*>/)?.[0];
  assert.ok(historyButton.includes('text-green-700') && !historyButton.includes('amber-'));
});

test('invoice number badges share a green theme and receipt status uses blue', () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const block = source.match(/^    function getLeadCaseStatusTone\(statusValue\) \{[\s\S]*?^    \}/m);
  const context = vm.createContext({ normalizeTimelineStatus: value => String(value || '').trim() });
  vm.runInContext(block[0], context);
  assert.equal(context.getLeadCaseStatusTone('ออกใบแจ้งหนี้'), 'border-green-200 bg-green-50 text-green-700');
  assert.equal(context.getLeadCaseStatusTone('ออกใบเสร็จรับเงิน'), 'border-blue-200 bg-blue-50 text-blue-700');
  assert.equal(context.getLeadCaseStatusTone('ส่งใบเสนอราคา'), 'border-blue-200 bg-blue-50 text-blue-700');
  assert.match(source, /\.invoice-number-label \{ color:#15803d/);
  assert.match(source, /\.invoice-number-link \{ border-color:#bbf7d0; background:#f0fdf4; color:#15803d/);
  assert.match(source, /\.invoice-number-link:hover \{ border-color:#86efac; background:#dcfce7; color:#166534/);
  assert.match(source, /\.invoice-number-link:focus-visible \{ outline:2px solid #22c55e/);
  assert.match(source, /button\.className='invoice-number-link [^']*border-green-200 bg-green-50/);
  assert.match(source, /link\.className = 'invoice-number-link [^']*border-green-200 bg-green-50/);
  assert.match(source, /data-open-invoice-history=[^>]*class="invoice-number-link /);
  assert.match(source, /data-case-invoice-links=[^\n]*invoice-number-label text-green-700/);
});
