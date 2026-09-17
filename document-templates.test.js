const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  activateDocumentTemplateVersion,
  canManageDocumentTemplates,
  documentTemplateChecksum,
  documentTemplateVersionRecord,
  documentTemplateVersionLocator,
  isDocumentTemplateStorageError,
  validateDocumentTemplateCompany,
  validateDocumentTemplateDesign,
  validateDocumentTemplateSchemaVersion,
  validateDocumentTemplateType,
} = require('./server');

const crmIndexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const migrationSql = fs.readFileSync(
  path.join(__dirname, 'supabase', 'migrations', '20260822114021_document_template_designer.sql'),
  'utf8'
);
const salespersonContactMigrationSql = fs.readFileSync(
  path.join(__dirname, 'supabase', 'migrations', '20260826120000_add_quotation_salesperson_contact_lookup.sql'),
  'utf8'
);
const adminContactMigrationSql = fs.readFileSync(
  path.join(__dirname, 'supabase', 'migrations', '20260826123000_add_quotation_admin_contact_lookup.sql'),
  'utf8'
);
const gfsQuotationTemplatePath = path.join(__dirname, 'public', 'assets', 'gfs-quotation-2026.png');
const gfsQuotationFixedHeaderPath = path.join(__dirname, 'public', 'assets', 'gfs-quotation-header-fixed-2026.png');

function quotationRendererSource(startMarker, endMarker) {
  const start = crmIndexHtml.indexOf(startMarker);
  const end = crmIndexHtml.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} source must exist`);
  return crmIndexHtml.slice(start, end);
}

function executableQuotationRenderers() {
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }
  const context = {
    DOCUMENT_TEMPLATE_GFS_QUOTATION_FIXED_HEADER_URL: '/assets/gfs-quotation-header-fixed-2026.png',
    getQuotationCompanyMeta(company) { return { code: company, name: `บริษัท ${company}`, englishName: `Company ${company}` }; },
    escapeHtml,
    quotationPrintText(value, fallback = '-') { return escapeHtml(String(value || '').trim() || fallback).replace(/\n/g, '<br>'); },
    quotationAmount(value) { return Number(value) || 0; },
    quotationImageDisplayWidth(value) { return Number(value) || 120; },
    formatQuotationAmount(value) { return Number(value || 0).toFixed(2); },
    formatQuotationDate(value) { return String(value || ''); },
    quotationThaiBahtText(value) { return `จำนวนเงินตัวอักษร ${Number(value).toFixed(2)}`; },
    quotationPrintOptions(value = {}) {
      return {
        showBranch: true, showCreditTerm: true, showPaymentTerms: true,
        showSalesperson: true, showNotes: true, showTotals: true, showTotalInWords: true,
        ...value,
      };
    },
    defaultQuotationNotes() { return 'เงื่อนไขมาตรฐาน'; },
  };
  vm.createContext(context);
  vm.runInContext([
    quotationRendererSource('function isQuotationDiscount(item)', 'function quotationImageCaseFolder('),
    quotationRendererSource('function calculateCaseQuotationTotals(data = getCaseQuotationFormData())', 'function resolveQuotationSalesperson('),
    quotationRendererSource('function legacyQuotationPrintableDocument(data)', 'function quotationPreviewOptionsMarkup('),
  ].join('\n'), context);
  return context;
}

function roundedQuotationFixture(company = 'GFS') {
  return {
    company, quoteNumber: `${company}-ROUND-Q-1`, issueDate: '2026-09-12',
    customerName: 'ลูกค้า <ทดสอบ>', taxId: '1234567890123', address: 'ที่อยู่หน้างาน',
    contactName: 'ผู้ติดต่อ', contactPhone: '0811111111', branch: 'สำนักงานใหญ่',
    creditTerm: '30 วัน', validDays: '15', paymentTerms: 'ชำระตามข้อตกลง',
    salesperson: 'ฝ่ายขาย', signatureSalesperson: 'ผู้เสนอราคา', notes: 'หมายเหตุและเงื่อนไขทดสอบ',
    printOptions: {},
    items: [
      { description: 'ฟิล์มทดสอบ', details: 'รายละเอียดสินค้า', quantity: 2, unit: 'ตรฟ.', unitPrice: 1000 },
      { isDiscount: true, description: 'ส่วนลดพิเศษ', details: 'รายละเอียดส่วนลด', quantity: 1, unit: 'ส่วนลด', unitPrice: 200 },
    ],
  };
}

function lastCssDeclaration(markup, selector, property) {
  const css = markup.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
  let result;
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!rule[1].split(',').some(value => value.trim() === selector)) continue;
    for (const declaration of rule[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (declaration.slice(0, colon).trim() === property) result = declaration.slice(colon + 1).trim();
    }
  }
  return result;
}

function fakeGfsPagedDocument(heights, { hasTable = true } = {}) {
  const listeners = new Map();
  let resolveFonts;
  let rejectFonts;
  const fontsReady = new Promise((resolve, reject) => { resolveFonts = resolve; rejectFonts = reject; });
  class Element {
    constructor(tag, className = '', height = 10) {
      this.tagName = tag.toUpperCase(); this.className = className; this.height = height;
      this.children = []; this.parent = null; this.attributes = {}; this.value = '';
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: name => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
      };
    }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children.forEach(node => { node.parent = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; } }
    cloneNode(deep) {
      const node = new Element(this.tagName, this.className, this.height);
      node.value = this.value; node.attributes = { ...this.attributes };
      node.naturalWidth = this.naturalWidth; node.naturalHeight = this.naturalHeight;
      if (deep) node.append(...this.children.map(child => child.cloneNode(true)));
      return node;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    get textContent() { return this.value + this.children.map(node => node.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this.value = String(value); }
    get tHead() { return this.children.find(node => node.tagName === 'THEAD'); }
    get tBodies() { return this.children.filter(node => node.tagName === 'TBODY'); }
    get rows() { return this.children.filter(node => node.tagName === 'TR'); }
    get cells() { return this.children.filter(node => node.tagName === 'TD'); }
    matches(selector) {
      const [tag, ...classes] = selector.split('.');
      return (!tag || this.tagName === tag.toUpperCase()) && classes.every(name => this.classList.contains(name));
    }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(node => [node, ...node.querySelectorAll('*')]);
      return selector === '*' ? descendants : descendants.filter(node => selector.split(',').some(value => node.matches(value.trim())));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getBoundingClientRect() {
      if (this.classList.contains('gfs-quotation-page-footer')) return { top: 1000, bottom: 1034, height: 34 };
      if (this.classList.contains('gfs-quotation-page')) return { top: 0, bottom: 1045, height: 1045 };
      const height = ['TABLE', 'TBODY'].includes(this.tagName) || this.classList.contains('gfs-quotation-page-content')
        ? this.children.reduce((sum, node) => sum + node.getBoundingClientRect().height, 0) : this.height;
      return { top: 0, bottom: height, height };
    }
  }
  const sheet = new Element('main', 'sheet');
  const header = new Element('header', 'gfs-fixed-quotation-header', 100);
  const quoteNumber = new Element('span', 'gfs-fixed-quotation-number'); quoteNumber.textContent = 'GFS-ORIGINAL-720'; header.append(quoteNumber);
  const info = new Element('section', 'section info', 100);
  const table = new Element('table', 'items');
  const tableHeader = new Element('thead', '', 32);
  const tbody = new Element('tbody');
  const rows = heights.map((height, index) => {
    const row = new Element('tr', 'original-row-class', height);
    const cell = new Element('td'); cell.textContent = `รายการเดิม-${index + 1}`;
    const image = new Element('img'); image.naturalWidth = 1280; image.naturalHeight = 720; image.complete = true;
    image.setAttribute('src', `/original-${index + 1}.png`); image.setAttribute('style', 'width:720px');
    cell.append(image); row.append(cell); return row;
  });
  tbody.append(...rows); table.append(tableHeader, tbody);
  const closing = new Element('div', 'gfs-quotation-closing', 250); closing.textContent = 'ยอดรวมเดิมและลายเซ็น';
  sheet.append(header, info, ...(hasTable ? [table] : []), closing);
  const documentRoot = {
    images: sheet.querySelectorAll('img'),
    fonts: { ready: fontsReady },
    defaultView: {
      addEventListener(type, callback, options) {
        const entries = listeners.get(type) || [];
        entries.push({ callback, options });
        listeners.set(type, entries);
      },
    },
    querySelector(selector) { assert.equal(selector, '.sheet'); return sheet; },
    createElement(tag) { return new Element(tag); },
  };
  return {
    documentRoot, rows, sheet, table, listeners, resolveFonts, rejectFonts,
    dispatch(type) {
      for (const entry of listeners.get(type) || []) {
        entry.callback();
        if (entry.options?.once) listeners.set(type, listeners.get(type).filter(value => value !== entry));
      }
    },
  };
}

function validDesign() {
  return {
    theme: { accentColor: '#0f78ad', fontFamily: 'Sarabun' },
    company: {
      name: 'บริษัท กู๊ดฟิล์ม จำกัด',
      nameEnglish: 'GOODFILM CO., LTD.',
      contact: 'Bangkok\n02-000-0000',
      logoText: 'GFS',
      logoImageUrl: '',
    },
    header: { title: 'Quotation', documentNumberLabel: 'เลขที่ / No.', dateLabel: 'วันที่ / Date' },
    customerSection: {
      visible: true,
      order: 1,
      labels: { customer: 'ลูกค้า', contact: 'ผู้ติดต่อ', telephone: 'โทรศัพท์', address: 'ที่อยู่' },
    },
    itemsTable: {
      visible: true,
      order: 2,
      columns: [
        { key: 'sequence', label: 'ลำดับ', visible: true },
        { key: 'description', label: 'รายการ', visible: true },
        { key: 'quantity', label: 'จำนวน', visible: true },
        { key: 'unit', label: 'หน่วย', visible: true },
        { key: 'unitPrice', label: 'ราคา/หน่วย', visible: true },
        { key: 'amount', label: 'จำนวนเงิน', visible: true },
      ],
    },
    totals: {
      visible: true,
      order: 3,
      labels: { subtotal: 'ยอดรวม', discount: 'ส่วนลด', afterDiscount: 'ยอดหลังส่วนลด', tax: 'ภาษี', grandTotal: 'จำนวนเงินทั้งสิ้น' },
    },
    notes: { visible: true, order: 4, heading: 'หมายเหตุ', text: 'บรรทัดหนึ่ง\nบรรทัดสอง' },
    signatures: {
      visible: true,
      order: 5,
      labels: { preparedBy: 'ผู้จัดทำ', approvedBy: 'ผู้อนุมัติ', customer: 'ผู้รับเอกสาร' },
    },
    footer: { visible: true, order: 6, text: 'GOOD CRM' },
    print: { paperSize: 'A4', orientation: 'portrait', marginMm: 12 },
    canvas: {
      enabled: true,
      preset: 'gfs-quotation-2026',
      backgroundImageUrl: '/assets/gfs-quotation-2026.png',
      width: 1240,
      height: 1754,
      fields: [
        {
          key: 'documentNumber',
          visible: true,
          x: 1030,
          y: 112,
          width: 160,
          height: 28,
          fontSize: 18,
          fontWeight: 600,
          color: '#111827',
          textAlign: 'right',
          lineHeight: 1.2,
        },
      ],
    },
  };
}

test('document template identity values are exact and include all six canonical types', () => {
  assert.equal(validateDocumentTemplateCompany('GFS'), 'GFS');
  assert.equal(validateDocumentTemplateCompany('MHL'), 'MHL');
  assert.throws(() => validateDocumentTemplateCompany('gfs'), { code: 'INVALID_DOCUMENT_TEMPLATE_COMPANY' });
  for (const type of ['quotation', 'invoice', 'receipt', 'tax_invoice', 'work_delivery', 'credit_note']) {
    assert.equal(validateDocumentTemplateType(type), type);
  }
  assert.throws(() => validateDocumentTemplateType('delivery_note'), { code: 'INVALID_DOCUMENT_TEMPLATE_TYPE' });
});

test('schema-v2 design accepts the frontend shape and rejects unknown or executable fields', () => {
  assert.equal(validateDocumentTemplateSchemaVersion(), 2);
  assert.equal(validateDocumentTemplateSchemaVersion(2), 2);
  assert.throws(() => validateDocumentTemplateSchemaVersion(1), { code: 'UNSUPPORTED_DOCUMENT_TEMPLATE_SCHEMA_VERSION' });
  assert.deepEqual(validateDocumentTemplateDesign(validDesign(), 'quotation'), validDesign());
  assert.throws(
    () => validateDocumentTemplateDesign({ ...validDesign(), html: '<b>unsafe</b>' }, 'quotation'),
    { code: 'DOCUMENT_TEMPLATE_DESIGN_FIELD_NOT_ALLOWED' }
  );
  const scripted = validDesign();
  scripted.notes.text = '<script>alert(1)</script>';
  assert.throws(() => validateDocumentTemplateDesign(scripted, 'quotation'), { code: 'DOCUMENT_TEMPLATE_DESIGN_CONTENT_NOT_ALLOWED' });
});

test('canvas backgrounds allow only the approved local asset or credential-free HTTPS raster images', () => {
  const httpsDesign = validDesign();
  httpsDesign.canvas.backgroundImageUrl = 'https://cdn.example.com/templates/quotation.webp?v=2';
  assert.equal(validateDocumentTemplateDesign(httpsDesign, 'quotation').canvas.backgroundImageUrl, httpsDesign.canvas.backgroundImageUrl);

  for (const backgroundImageUrl of [
    '',
    '/assets/another-template.png',
    'http://cdn.example.com/template.png',
    'https://user:secret@cdn.example.com/template.png',
    'https://cdn.example.com/template.svg',
    'data:image/png;base64,AAAA',
  ]) {
    const unsafe = validDesign();
    unsafe.canvas.backgroundImageUrl = backgroundImageUrl;
    assert.throws(
      () => validateDocumentTemplateDesign(unsafe, 'quotation'),
      { code: 'INVALID_DOCUMENT_TEMPLATE_CANVAS_BACKGROUND_URL' }
    );
  }

  const disabled = validDesign();
  disabled.canvas.enabled = false;
  disabled.canvas.backgroundImageUrl = '';
  assert.equal(validateDocumentTemplateDesign(disabled, 'quotation').canvas.backgroundImageUrl, '');
});

test('canvas fields must be exact, unique, and wholly contained by the canvas', () => {
  const duplicate = validDesign();
  duplicate.canvas.fields.push({ ...duplicate.canvas.fields[0] });
  assert.throws(
    () => validateDocumentTemplateDesign(duplicate, 'quotation'),
    { code: 'DUPLICATE_DOCUMENT_TEMPLATE_CANVAS_FIELD' }
  );

  const outOfBounds = validDesign();
  outOfBounds.canvas.fields[0].x = 1100;
  assert.throws(
    () => validateDocumentTemplateDesign(outOfBounds, 'quotation'),
    { code: 'INVALID_DOCUMENT_TEMPLATE_CANVAS_FIELD_BOUNDS' }
  );

  const unknownProperty = validDesign();
  unknownProperty.canvas.fields[0].rotation = 0;
  assert.throws(
    () => validateDocumentTemplateDesign(unknownProperty, 'quotation'),
    { code: 'DOCUMENT_TEMPLATE_DESIGN_FIELD_NOT_ALLOWED' }
  );
});

test('quotation canvas preset cannot be saved on other document types', () => {
  assert.deepEqual(validateDocumentTemplateDesign(validDesign(), 'quotation', 'GFS'), validDesign());
  assert.throws(
    () => validateDocumentTemplateDesign(validDesign(), 'quotation', 'MHL'),
    { code: 'DOCUMENT_TEMPLATE_CANVAS_PRESET_NOT_ALLOWED' }
  );
  assert.throws(
    () => validateDocumentTemplateDesign(validDesign(), 'invoice'),
    { code: 'DOCUMENT_TEMPLATE_CANVAS_PRESET_NOT_ALLOWED' }
  );
  const invoiceDesign = validDesign();
  invoiceDesign.canvas.preset = '';
  assert.equal(validateDocumentTemplateDesign(invoiceDesign, 'invoice').canvas.preset, '');
});

test('required document sections and description column cannot be hidden through the API', () => {
  const noItems = validDesign();
  noItems.itemsTable.visible = false;
  assert.throws(() => validateDocumentTemplateDesign(noItems, 'quotation'), { code: 'DOCUMENT_TEMPLATE_ITEMS_TABLE_REQUIRED' });

  const noTotals = validDesign();
  noTotals.totals.visible = false;
  noTotals.canvas.preset = '';
  assert.throws(() => validateDocumentTemplateDesign(noTotals, 'invoice'), { code: 'DOCUMENT_TEMPLATE_TOTALS_REQUIRED' });
  assert.equal(validateDocumentTemplateDesign(noTotals, 'work_delivery').totals.visible, false);

  const noDescription = validDesign();
  noDescription.itemsTable.columns.find(column => column.key === 'description').visible = false;
  assert.throws(() => validateDocumentTemplateDesign(noDescription, 'quotation'), { code: 'DOCUMENT_TEMPLATE_DESCRIPTION_COLUMN_REQUIRED' });
});

test('template checksums are stable across object key ordering', () => {
  assert.equal(documentTemplateChecksum({ b: 2, a: 1 }), documentTemplateChecksum({ a: 1, b: 2 }));
  assert.notEqual(documentTemplateChecksum({ a: 1 }), documentTemplateChecksum({ a: 2 }));
});

test('stored versions are revalidated and checksum-verified before reaching the frontend', () => {
  const design = validDesign();
  const row = {
    id: 'version-1',
    template_id: 'template-1',
    version_number: 1,
    status: 'draft',
    schema_version: 2,
    design_json: design,
    checksum: documentTemplateChecksum(design),
    change_summary: null,
    created_at: '2026-08-22T00:00:00.000Z',
    created_by: null,
    published_at: null,
    published_by: null,
  };
  assert.deepEqual(documentTemplateVersionRecord(row, '', 'quotation').design, design);
  assert.throws(
    () => documentTemplateVersionRecord({ ...row, checksum: '0'.repeat(64) }, '', 'quotation'),
    { code: 'INVALID_DOCUMENT_TEMPLATE_VERSION_CHECKSUM' }
  );
  const malformed = { ...design, html: '<b>unexpected</b>' };
  assert.throws(
    () => documentTemplateVersionRecord({ ...row, design_json: malformed, checksum: documentTemplateChecksum(malformed) }, '', 'quotation'),
    { code: 'INVALID_DOCUMENT_TEMPLATE_VERSION_RECORD' }
  );
});

test('version locator and role permissions reject ambiguous or unauthorized input', () => {
  assert.equal(canManageDocumentTemplates({ role: 'admin' }), true);
  assert.equal(canManageDocumentTemplates({ role: 'manager' }), true);
  assert.equal(canManageDocumentTemplates({ role: 'sales' }), false);
  assert.deepEqual(documentTemplateVersionLocator({ versionNumber: '7' }), { versionNumber: 7 });
  assert.throws(() => documentTemplateVersionLocator({ versionId: 'x', versionNumber: 1 }), { code: 'AMBIGUOUS_DOCUMENT_TEMPLATE_VERSION' });
  assert.throws(() => documentTemplateVersionLocator({}, true), { code: 'MISSING_DOCUMENT_TEMPLATE_VERSION' });
});

test('missing relation and Data API schema-cache errors are treated as optional capability failures', () => {
  assert.equal(isDocumentTemplateStorageError({ code: '42P01' }), true);
  assert.equal(isDocumentTemplateStorageError({ code: 'PGRST205' }), true);
  assert.equal(isDocumentTemplateStorageError({ code: '42501', message: 'permission denied for table document_templates' }), true);
  assert.equal(isDocumentTemplateStorageError({ code: '42501', message: 'permission denied for table customers' }), false);
});

function publicationClient({ existing = false, insertError = null, updateError = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, 'document_template_publications');
      return {
        select(columns) {
          calls.push({ operation: 'select', columns });
          return this;
        },
        eq(column, value) {
          calls.push({ operation: 'eq', column, value });
          return this;
        },
        async maybeSingle() {
          return { data: existing ? { template_id: 'template-1' } : null, error: null };
        },
        update(payload) {
          calls.push({ operation: 'update', payload });
          return {
            async eq(column, value) {
              calls.push({ operation: 'update-eq', column, value });
              return { error: updateError };
            },
          };
        },
        async insert(payload) {
          calls.push({ operation: 'insert', payload });
          return { error: insertError };
        },
      };
    },
  };
}

test('publication activation inserts the first pointer and updates replacements without upsert', async () => {
  const firstClient = publicationClient();
  await activateDocumentTemplateVersion(
    firstClient,
    'template-1',
    { id: 'version-1', publishedAt: null, publishedBy: null },
    'user-1'
  );
  assert.deepEqual(firstClient.calls.map(call => call.operation), ['select', 'eq', 'insert']);

  const replacementClient = publicationClient({ existing: true });
  await activateDocumentTemplateVersion(
    replacementClient,
    'template-1',
    { id: 'version-2', publishedAt: null, publishedBy: null },
    'user-1'
  );
  assert.deepEqual(replacementClient.calls.map(call => call.operation), ['select', 'eq', 'update', 'update-eq']);
  assert.equal(replacementClient.calls.find(call => call.operation === 'update').payload.current_version_id, 'version-2');
});

test('publication activation retries an insert race as an update', async () => {
  const client = publicationClient({ insertError: { code: '23505', message: 'duplicate key' } });
  await activateDocumentTemplateVersion(
    client,
    'template-1',
    { id: 'version-2', publishedAt: null, publishedBy: null },
    'user-1'
  );
  assert.deepEqual(client.calls.map(call => call.operation), ['select', 'eq', 'insert', 'update', 'update-eq']);
});

test('settings no longer exposes the document template designer', () => {
  assert.doesNotMatch(crmIndexHtml, /id="settings-menu-document-templates"/);
  assert.doesNotMatch(crmIndexHtml, /id="settings-section-document-templates"/);
  for (const action of [
    'getDocumentTemplateDesigner',
    'saveDocumentTemplateDraft',
    'publishDocumentTemplateVersion',
    'restoreDocumentTemplateVersion',
  ]) {
    assert.match(crmIndexHtml, new RegExp(action));
  }
  assert.match(crmIndexHtml, /result\?\.operationCompleted === false/);
  assert.match(crmIndexHtml, /document-template-draft-watermark/);
});

test('GFS quotation template uses the approved raster asset and automatic schema-v2 layout', () => {
  assert.equal(fs.existsSync(gfsQuotationTemplatePath), true);
  assert.ok(fs.statSync(gfsQuotationTemplatePath).size > 200_000);
  assert.equal(fs.existsSync(gfsQuotationFixedHeaderPath), true);
  assert.ok(fs.statSync(gfsQuotationFixedHeaderPath).size > 50_000);
  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(gfsQuotationTemplatePath)).digest('hex'),
    'e08b558c166fbefda1828c7cdbcdd8e4bafb0d9d7e630b5be3746eaa194f0a31'
  );
  assert.match(crmIndexHtml, /const DOCUMENT_TEMPLATE_SCHEMA_VERSION = 2;/);
  assert.match(crmIndexHtml, /const DOCUMENT_TEMPLATE_CANVAS_PRESET_ID = 'gfs-quotation-2026';/);
  assert.match(crmIndexHtml, /const DOCUMENT_TEMPLATE_GFS_QUOTATION_FIXED_HEADER_URL = '\/assets\/gfs-quotation-header-fixed-2026\.png';/);
  assert.match(crmIndexHtml, /src="\$\{escapeHtml\(canvas\.backgroundImageUrl\)\}"/);
  assert.match(crmIndexHtml, /const useAutomaticGfsLayout = presetAllowed;/);
  assert.match(crmIndexHtml, /const editable = false;/);
  assert.match(crmIndexHtml, /schemaVersion: DOCUMENT_TEMPLATE_SCHEMA_VERSION/);
  assert.match(crmIndexHtml, /image\.decode\(\)/);
});

test('document template confirmations use the Good CRM modal instead of browser confirm dialogs', () => {
  assert.match(crmIndexHtml, /id="documentTemplateConfirmModal"/);
  assert.match(crmIndexHtml, /aria-labelledby="documentTemplateConfirmTitle"/);
  assert.match(crmIndexHtml, /function openDocumentTemplateConfirmation/);
  assert.match(crmIndexHtml, /function resolveDocumentTemplateConfirmation/);
  assert.match(crmIndexHtml, /กลับไปบันทึก/);
  assert.match(crmIndexHtml, /ละทิ้งและเปลี่ยน/);

  const selectionStart = crmIndexHtml.indexOf('async function changeDocumentTemplateSelection');
  const selectionEnd = crmIndexHtml.indexOf('function isSafeDocumentTemplateLogoUrl', selectionStart);
  const publishStart = crmIndexHtml.indexOf('async function publishDocumentTemplateVersion');
  const publishEnd = crmIndexHtml.indexOf('async function copyDocumentTemplateFromOtherCompany', publishStart);
  assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
  assert.ok(publishStart >= 0 && publishEnd > publishStart);
  assert.doesNotMatch(crmIndexHtml.slice(selectionStart, selectionEnd), /window\.confirm/);
  assert.doesNotMatch(crmIndexHtml.slice(publishStart, publishEnd), /window\.confirm/);
});

test('quotation deletion uses the Good CRM confirmation modal', () => {
  const deleteStart = crmIndexHtml.indexOf('async function deleteCaseQuotationHistory');
  const deleteEnd = crmIndexHtml.indexOf('async function renderCaseDetailEditor', deleteStart);
  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
  const quotationDeletion = crmIndexHtml.slice(deleteStart, deleteEnd);

  assert.match(quotationDeletion, /await openDocumentTemplateConfirmation\(\{/);
  assert.match(quotationDeletion, /tone: 'rose'/);
  assert.match(quotationDeletion, /confirmLabel: 'ลบใบเสนอราคา'/);
  assert.doesNotMatch(quotationDeletion, /window\.confirm/);
});

test('quotation preview preserves the contact display returned by the CRM API', () => {
  const contactStart = crmIndexHtml.indexOf('async function fetchQuotationPersonnelContact');
  const contactEnd = crmIndexHtml.indexOf('async function hydrateQuotationSalespersonContact', contactStart);
  assert.ok(contactStart >= 0 && contactEnd > contactStart);
  const personnelContact = crmIndexHtml.slice(contactStart, contactEnd);

  assert.match(personnelContact, /const display = String\(result\.display \|\| ''\)\.trim\(\) \|\| quotationPersonnelDisplay\(fullName, phone\);/);
  assert.match(personnelContact, /display\n      };/);
});

test('live GFS quotation printing uses the fixed header with a flexible body while MHL retains its existing layout', () => {
  const mhlRendererStart = crmIndexHtml.indexOf('function legacyQuotationPrintableDocument');
  const gfsRendererStart = crmIndexHtml.indexOf('function gfsFlexibleQuotationPrintableDocument');
  const fixedHeaderStart = crmIndexHtml.indexOf('function gfsFixedQuotationHeaderMarkup');
  const fixedHeaderEnd = crmIndexHtml.indexOf('function gfsPlaceTermsBelowItems', fixedHeaderStart);
  const previewRendererStart = crmIndexHtml.indexOf('function renderCaseQuotationPreviewDocument');
  const previewRendererEnd = crmIndexHtml.indexOf('async function openCaseQuotationPrintPreview', previewRendererStart);
  const printPreviewStart = crmIndexHtml.indexOf('async function openCaseQuotationPrintPreview');
  const printPreviewEnd = crmIndexHtml.indexOf('function closeCaseQuotationPrintPreview', printPreviewStart);
  assert.ok(mhlRendererStart >= 0 && gfsRendererStart > mhlRendererStart);
  assert.ok(fixedHeaderStart >= 0 && fixedHeaderEnd > fixedHeaderStart);
  assert.ok(previewRendererStart >= 0 && previewRendererEnd > previewRendererStart);
  assert.ok(printPreviewStart >= 0 && printPreviewEnd > printPreviewStart);
  const mhlRenderer = crmIndexHtml.slice(mhlRendererStart, gfsRendererStart);
  const gfsRenderer = crmIndexHtml.slice(gfsRendererStart, previewRendererStart);
  const fixedHeader = crmIndexHtml.slice(fixedHeaderStart, fixedHeaderEnd);
  const previewRenderer = crmIndexHtml.slice(previewRendererStart, previewRendererEnd);
  const printPreview = crmIndexHtml.slice(printPreviewStart, printPreviewEnd);
  assert.match(mhlRenderer, /<tr class="discount-row">/);
  assert.match(mhlRenderer, /\.items tr\.discount-row td\{[^}]*background:#fff1f2;color:#dc2626/);
  assert.match(mhlRenderer, /class="discount-icon center"><svg/);
  assert.match(gfsRenderer, /\*หมายเหตุและเงื่อนไข/);
  assert.match(gfsRenderer, /quotationPrintOptions\(data\.printOptions\)/);
  assert.match(gfsRenderer, /showBranch/);
  assert.match(gfsRenderer, /showCreditTerm/);
  assert.match(gfsRenderer, /showNotes/);
  assert.match(gfsRenderer, /showTotals/);
  assert.match(gfsRenderer, /showTotalInWords/);
  assert.match(gfsRenderer, /infoValue\('ฝ่ายขาย \/ Sales Person', data\.salesperson\)/);
  assert.match(gfsRenderer, /max-height:480px/);
  assert.match(gfsRenderer, /const infoValue = \(label, value\) => \{/);
  assert.match(gfsRenderer, /return content \? `<span class="label">\$\{label\}<\/span><span class="value">\$\{quotationPrintText\(content, ''\)\}<\/span>` : '';/);
  assert.match(gfsRenderer, /const hasDiscount = totals\.discount > 0/);
  assert.match(gfsRenderer, /const roundedTableStyles = /);
  assert.match(gfsRenderer, /const a4LayoutStyles = /);
  assert.match(gfsRenderer, /\$\{headerStyles\}\$\{signatureStyles\}\$\{roundedTableStyles\}\$\{a4LayoutStyles\}<\/style>/);
  assert.match(gfsRenderer, /hasDiscount \? `<tr class="discount">/);
  assert.match(gfsRenderer, /total-words" style="font-size:13px;line-height:1\.3;text-align:center"/);
  assert.match(gfsRenderer, /<h3 style="font-size:12px;line-height:1\.3">\*หมายเหตุและเงื่อนไข/);
  assert.match(gfsRenderer, /const notesMarkup = printOptions\.showNotes/);
  assert.match(gfsRenderer, /<p class="gfs-terms-line" style="font-size:11px;line-height:1\.35">\$\{quotationPrintText\(line, ''\) \|\| '<br>'\}/);
  assert.match(gfsRenderer, /\.sheet\{display:block;min-height:0;width:190mm;max-width:none\}/);
  assert.match(gfsRenderer, /\.gfs-fixed-quotation-header\{margin-bottom:3px\}\.section\{margin-top:4px\}/);
  assert.match(gfsRenderer, /\.gfs-fixed-quotation-document\{top:64\.5%;right:4\.6%;width:21%;height:35%;gap:4px;padding:4px 5px\}/);
  assert.match(gfsRenderer, /\.gfs-fixed-quotation-number\{font-size:13px;line-height:1\.1;letter-spacing:-\.15px\}/);
  assert.match(gfsRenderer, /\.gfs-fixed-quotation-date\{font-size:9px;line-height:1\.2\}/);
  assert.match(gfsRenderer, /\.signatures\{margin-top:16px!important\}/);
  assert.match(gfsRenderer, /\.items th:nth-child\(1\)\{width:7%!important\}/);
  assert.match(gfsRenderer, /\.items th:nth-child\(2\)\{width:52%!important\}/);
  assert.match(gfsRenderer, /\.items th:nth-child\(4\)\{width:7%!important\}/);
  assert.match(gfsRenderer, /\.items th:nth-child\(5\)\{width:10%!important\}/);
  assert.match(gfsRenderer, /\.items th:nth-child\(6\)\{width:14%!important\}/);
  assert.match(gfsRenderer, /\.items td \.muted\{display:inline-block;margin-top:2px;line-height:1\.5\}/);
  assert.match(gfsRenderer, /\.signature\{position:relative;height:122px!important\}/);
  assert.match(gfsRenderer, /position:absolute;right:0;bottom:8px;left:0/);
  assert.match(gfsRenderer, /signature-date/);
  assert.match(gfsRenderer, /วันที่ \/ Date \$\{signatureDate\}/);
  assert.match(crmIndexHtml, /function gfsFixedQuotationPrintableDocument/);
  assert.match(crmIndexHtml, /function gfsPlaceTermsBelowItems/);
  assert.match(crmIndexHtml, /gfs-fixed-quotation-header/);
  assert.match(crmIndexHtml, /gfs-fixed-quotation-document\{position:absolute;top:66%;right:2\.4%;display:flex;width:16%/);
  assert.match(crmIndexHtml, /gfs-fixed-quotation-number\{font-size:15px;line-height:1;letter-spacing:-\.3px;white-space:nowrap;text-overflow:ellipsis\}/);
  assert.match(crmIndexHtml, /gfs-fixed-quotation-date\{font-size:7\.5px/);
  assert.match(fixedHeader, /gfs-fixed-quotation-number">\$\{quotationPrintText\(data\.quoteNumber, '-'\)\}/);
  assert.match(fixedHeader, /gfs-fixed-quotation-date">\$\{formatQuotationDate\(data\.issueDate\)\}/);
  assert.doesNotMatch(fixedHeader, /เลขที่|วันที่/);
  assert.match(crmIndexHtml, /gfs-post-table-layout\{display:grid;grid-template-columns:minmax\(0,1fr\) 72mm/);
  assert.match(crmIndexHtml, /gfs-post-table-layout\.is-without-totals\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(crmIndexHtml, /const termsMarkup = termsMatch\?\.\[0\] \|\| '';/);
  assert.match(crmIndexHtml, /<div class="gfs-terms-area">\$\{totalWordsMarkup\}\$\{termsMarkup\}<\/div>/);
  assert.match(crmIndexHtml, /const hasSupportingContent = Boolean\(String\(totalWordsMarkup\)\.trim\(\) \|\| termsMarkup\);/);
  assert.doesNotMatch(crmIndexHtml, /if \(!termsMatch\) \{/);
  assert.match(crmIndexHtml, /gfs-post-table-layout \.terms\{margin-top:0;border-top:0;padding-top:8px\}/);
  assert.match(crmIndexHtml, /gfs-terms-area \.total-words\{width:100%;margin:0 0 8px;padding:7px 10px;border:1px solid #93c5fd;border-left:4px solid #0284c7;border-radius:4px;background:#e0f2fe/);
  assert.match(crmIndexHtml, /gfs-summary-area \.totals\{width:100%;margin-left:0;font-size:12px\}/);
  assert.match(crmIndexHtml, /gfs-summary-area \.totals \.grand\{font-size:15px\}/);
  assert.doesNotMatch(crmIndexHtml, /gfs-summary-area \.total-words/);
  assert.match(crmIndexHtml, /gfsFixedQuotationPrintableDocument\(data\)/);
  assert.match(crmIndexHtml, /function quotationPrintableDocument\(data\)[\s\S]*data\.company === 'MHL'/);
  assert.match(previewRenderer, /const printableDocument = normalizeQuotationPrintableTable\(quotationPrintableDocument\(printableData\)\)/);
  assert.doesNotMatch(previewRenderer, /gfsQuotationCanvasPrintableDocument/);
  assert.match(previewRenderer, /frame\.srcdoc = printableDocument/);
  assert.doesNotMatch(previewRenderer, /frame\.focus/);
  assert.match(crmIndexHtml, /renderCaseQuotationPreviewOptions\(data\)/);
  assert.match(printPreview, /openCaseDocumentPreview\(printableData,/);
  assert.match(printPreview, /openCaseDocumentPreview\(printableData, 'quotation'\)/);
  assert.match(crmIndexHtml, /normalizeQuotationPrintableTable\(quotationPrintableDocument\(data\)\)/);
  assert.match(crmIndexHtml, /const quotationImageMaxDisplayWidth = 720/);
  assert.match(crmIndexHtml, /สำหรับซื้อสินค้าพร้อมติดตั้ง/);
  assert.match(crmIndexHtml, /caseQuotationPreviewShowNotes/);
  assert.match(crmIndexHtml, /caseQuotationPreviewShowTotals/);
  assert.match(crmIndexHtml, /แสดงยอดสรุป/);
  assert.match(crmIndexHtml, /const DEFAULT_QUOTATION_CREDIT_TERM = '30 วัน';/);
  assert.match(crmIndexHtml, /caseQuotationPreviewCreditTerm" value="\$\{escapeTimelineValue\(data\?\.creditTerm \|\| DEFAULT_QUOTATION_CREDIT_TERM\)\}/);
  assert.match(crmIndexHtml, /caseQuotationPreviewSalesperson/);
  assert.match(crmIndexHtml, /หมายเหตุและเงื่อนไข/);
  assert.match(crmIndexHtml, /แสดงพนักงานขาย/);
  assert.match(crmIndexHtml, /function resolveQuotationSalesperson/);
  assert.match(crmIndexHtml, /caseQuotationPreviewValidDays/);
  assert.match(crmIndexHtml, /caseQuotationPreviewPaymentTerms/);
  assert.match(crmIndexHtml, /validDays: value\('caseQuotationPreviewValidDays', base\.validDays\)/);
  assert.match(crmIndexHtml, /paymentTerms: value\('caseQuotationPreviewPaymentTerms', base\.paymentTerms\)/);
  assert.match(crmIndexHtml, /function renderCaseQuotationPreviewOptions/);
  assert.match(crmIndexHtml, /function hydrateQuotationSalespersonContact/);
  assert.match(crmIndexHtml, /getCaseSalespersonContact/);
  assert.match(crmIndexHtml, /getCaseAdminContact/);
  assert.match(crmIndexHtml, /signature-contact/);
  assert.match(crmIndexHtml, /function quotationPersonnelDisplay/);
  assert.match(crmIndexHtml, /function fetchQuotationPersonnelContact/);
  assert.match(crmIndexHtml, /return name && telephone \? `\$\{name\} \(\$\{telephone\}\)` : name;/);
  assert.match(crmIndexHtml, /salesperson: salespersonContact\.display \|\| fallbackSalesperson/);
  assert.match(crmIndexHtml, /signatureSalesperson: signatureContact\.display \|\| signatureFallback/);
  assert.match(salespersonContactMigrationSql, /private\.get_case_salesperson_contact/);
  assert.match(salespersonContactMigrationSql, /membership\.role <> 'sales'/);
  assert.match(salespersonContactMigrationSql, /revoke all on function public\.get_case_salesperson_contact\(uuid\)/);
  assert.match(adminContactMigrationSql, /private\.get_case_admin_contact/);
  assert.match(adminContactMigrationSql, /crm_case\.admin_name/);
  assert.match(adminContactMigrationSql, /revoke all on function public\.get_case_admin_contact\(uuid\)/);
});

test('GFS quotation output rounds info, items, and totals after the shared table normalizer', () => {
  const renderers = executableQuotationRenderers();
  const document = renderers.normalizeQuotationPrintableTable(renderers.quotationPrintableDocument(roundedQuotationFixture()));
  for (const selector of ['.section.info', '.items', '.totals']) {
    assert.equal(lastCssDeclaration(document, selector, 'border-radius'), '10px', `${selector} should have effective rounded GFS corners`);
    assert.equal(lastCssDeclaration(document, selector, 'overflow'), selector === '.items' ? 'visible' : 'hidden', `${selector} should preserve rounded corners without clipping a multi-page item table`);
  }
  const cornerCells = [
    ['.items thead tr:first-child th:first-child', 'border-top-left-radius'],
    ['.items thead tr:first-child th:last-child', 'border-top-right-radius'],
    ['.items tbody tr:last-child td:first-child', 'border-bottom-left-radius'],
    ['.items tbody tr:last-child td:last-child', 'border-bottom-right-radius'],
    ['.totals tr:first-child td:first-child', 'border-top-left-radius'],
    ['.totals tr:first-child td:last-child', 'border-top-right-radius'],
    ['.totals tr:last-child td:first-child', 'border-bottom-left-radius'],
    ['.totals tr:last-child td:last-child', 'border-bottom-right-radius'],
  ];
  for (const [selector, property] of cornerCells) {
    assert.equal(lastCssDeclaration(document, selector, property), '9px', 'colored corner cells should fit inside the 10px border edge');
  }
  assert.match(document, /\.items\{width:100%;margin-top:10px;border:1px solid #cbd5e1;border-collapse:separate;border-spacing:0/);
  assert.match(document, /\.items td\{height:42px;padding:7px 6px;vertical-align:top;border:0;border-right:1px solid #d7e0eb/);
  assert.match(document, /<header class="gfs-fixed-quotation-header">/);
  assert.equal(lastCssDeclaration(document, '.signature', 'border-radius'), '10px');
  assert.equal(lastCssDeclaration(document, '.signature', 'overflow'), undefined, 'signature content must not be clipped');
  assert.equal(lastCssDeclaration(document, '.signature', 'position'), 'relative');
  assert.equal(lastCssDeclaration(document, '.signature', 'height'), '122px!important');
  assert.equal(lastCssDeclaration(document, '.signature .signature-line', 'position'), 'relative');
  assert.equal(lastCssDeclaration(document, '.signature .signature-line', 'height'), '1px');
  assert.equal(lastCssDeclaration(document, '.signature .signature-line', 'margin-top'), '48px');
  assert.match(document, /<strong>ลูกค้าลงชื่ออนุมัติ \/ Customer Signature<\/strong>/);
  assert.match(document, /<strong>ผู้เสนอราคา \/ Sales Person<\/strong>/);
  assert.match(document, /<span class="signature-contact">ผู้เสนอราคา<\/span>/);
  assert.match(document, /<div class="signature-date">วันที่ \/ Date 2026-09-12<\/div>/);
  assert.equal((document.match(/<div class="signature-line">/g) || []).length, 2);
});

test('GFS customer signoff adds expanded signing space and a blank date line without changing salesperson data', () => {
  const renderers = executableQuotationRenderers();
  const data = {
    ...roundedQuotationFixture(),
    salesperson: 'ฝ่ายขายเดิม (081-999-9999)',
    signatureSalesperson: 'คุณ <ผู้เสนอราคา> (081-222-3333)',
  };
  const originalData = JSON.stringify(data);
  const rawDocument = renderers.quotationPrintableDocument(data);
  const document = renderers.normalizeQuotationPrintableTable(rawDocument);
  assert.equal(renderers.normalizeQuotationPrintableTable(document), document, 'normalizing a GFS quotation twice must not duplicate or rewrite signoff markup');
  assert.equal(JSON.stringify(data), originalData, 'the blank customer date must not mutate the saved quotation issue date or salesperson');

  const signatures = document.match(/<section class="signatures">([\s\S]*?)<\/section>/)?.[1] || '';
  const salespersonStart = signatures.indexOf('<div class="signature"><strong>ผู้เสนอราคา / Sales Person</strong>');
  assert.ok(salespersonStart > 0, 'GFS should retain separate customer and salesperson signature boxes');
  const customer = signatures.slice(0, salespersonStart);
  const salesperson = signatures.slice(salespersonStart);

  assert.match(customer, /^<div class="signature"><strong>ลูกค้าลงชื่ออนุมัติ \/ Customer Signature<\/strong>/);
  assert.doesNotMatch(customer, /ผู้ยอมรับใบเสนอราคา/);
  assert.match(customer, /<div class="signature-date signature-customer-date"><span>วันที่ \/ Date<\/span><span class="signature-date-writing-line" aria-hidden="true"><\/span><\/div>/);
  assert.doesNotMatch(customer, /2026-09-12|signature-contact|081-222-3333/, 'the customer date area must remain blank for handwriting');
  assert.equal((customer.match(/<div class="signature-line">/g) || []).length, 1);
  assert.equal((signatures.match(/<span class="signature-date-writing-line"/g) || []).length, 1, 'only the customer box should receive a blank date-writing line');

  assert.equal(lastCssDeclaration(document, '.signature', 'height'), '122px!important');
  assert.equal(lastCssDeclaration(document, '.signature .signature-line', 'margin-top'), '48px');
  assert.equal(lastCssDeclaration(document, '.signature .signature-customer-date', 'display'), 'flex');
  assert.equal(lastCssDeclaration(document, '.signature .signature-customer-date', 'align-items'), 'flex-end');
  assert.equal(lastCssDeclaration(document, '.signature .signature-customer-date', 'justify-content'), 'center');
  assert.equal(lastCssDeclaration(document, '.signature-date-writing-line', 'width'), '120px');
  assert.equal(lastCssDeclaration(document, '.signature-date-writing-line', 'max-width'), '55%');
  assert.equal(lastCssDeclaration(document, '.signature-date-writing-line', 'height'), '18px');
  assert.equal(lastCssDeclaration(document, '.signature-date-writing-line', 'border-bottom'), '1px dotted #5e6876');

  assert.match(document, /<span class="value">ฝ่ายขายเดิม \(081-999-9999\)<\/span>/);
  assert.match(salesperson, /<span class="signature-contact">คุณ &lt;ผู้เสนอราคา&gt; \(081-222-3333\)<\/span>/);
  assert.match(salesperson, /<div class="signature-date">วันที่ \/ Date 2026-09-12<\/div>/);
  assert.doesNotMatch(salesperson, /signature-customer-date|signature-date-writing-line/);
});

test('GFS-only rounded table styles do not alter the MHL quotation layout', () => {
  const renderers = executableQuotationRenderers();
  const data = roundedQuotationFixture('MHL');
  const mhlDocument = renderers.normalizeQuotationPrintableTable(renderers.quotationPrintableDocument(data));
  const existingMhlDocument = renderers.normalizeQuotationPrintableTable(renderers.legacyQuotationPrintableDocument(data));
  assert.equal(mhlDocument, existingMhlDocument);
  assert.equal(renderers.normalizeQuotationPrintableTable(mhlDocument), mhlDocument, 'the existing MHL quotation normalizer remains idempotent');
  assert.equal(lastCssDeclaration(mhlDocument, '.section.info', 'border-radius'), undefined);
  assert.equal(lastCssDeclaration(mhlDocument, '.items', 'border-radius'), undefined);
  assert.equal(lastCssDeclaration(mhlDocument, '.totals', 'border-radius'), '10px', 'MHL retains its pre-existing rounded totals panel');
  assert.equal(lastCssDeclaration(mhlDocument, '.signature', 'border-radius'), undefined, 'MHL signature boxes remain unchanged');
  assert.equal(lastCssDeclaration(mhlDocument, '.signature', 'height'), '70px', 'the GFS signing-space increase must not resize MHL signature boxes');
  assert.equal(lastCssDeclaration(mhlDocument, '.signature-line', 'margin'), '25px auto 0');
  assert.match(mhlDocument, /<strong>ผู้ยอมรับใบเสนอราคา \/ Customer Signature<\/strong>/);
  assert.doesNotMatch(mhlDocument, /ลูกค้าลงชื่ออนุมัติ|signature-customer-date|signature-date-writing-line/, 'the new customer heading and blank date line are GFS-only');
  assert.doesNotMatch(mhlDocument, /\.items thead tr:first-child th:first-child|gfs-fixed-quotation-header/);
  const normalizer = quotationRendererSource('function normalizeQuotationPrintableTable(markup)', 'function quotationPreviewOptionsMarkup(');
  assert.doesNotMatch(normalizer, /roundedTableStyles|border-radius:10px/);
});

test('rounded GFS printing preserves all body fields, discount rows, totals, and normalization behavior', () => {
  const renderers = executableQuotationRenderers();
  for (const company of ['GFS', 'MHL']) {
    const data = roundedQuotationFixture(company);
    const originalData = JSON.stringify(data);
    const rawDocument = renderers.quotationPrintableDocument(data);
    const normalizedDocument = renderers.normalizeQuotationPrintableTable(rawDocument);
    const body = markup => markup.match(/<body>([\s\S]*?)<\/body>/)?.[1] || '';
    assert.equal(body(normalizedDocument), body(rawDocument), 'table normalization and rounding must not rewrite quotation data');
    assert.equal(JSON.stringify(data), originalData, 'rendering must not mutate the saved quotation');
    assert.match(normalizedDocument, /ลูกค้า &lt;ทดสอบ&gt;/);
    for (const value of [
      'ฟิล์มทดสอบ', 'รายละเอียดสินค้า', 'ส่วนลดพิเศษ', 'รายละเอียดส่วนลด',
      '1234567890123', '0811111111', 'ที่อยู่หน้างาน',
      '2000.00', '200.00', '1800.00', '126.00', '1926.00',
    ]) {
      assert.ok(body(normalizedDocument).includes(value), `${company} must preserve ${value}`);
    }
    assert.match(normalizedDocument, /<tr class="discount-row">/);
    assert.match(normalizedDocument, /<tr class="grand">/);
    assert.match(normalizedDocument, /print-color-adjust:exact/);
  }
});

test('GFS A4 output uses paged block flow, repeats item headers, and keeps ordinary image rows together', () => {
  const renderers = executableQuotationRenderers();
  const document = renderers.normalizeQuotationPrintableTable(renderers.quotationPrintableDocument(roundedQuotationFixture()));
  assert.equal(lastCssDeclaration(document, '.sheet', 'display'), 'block', 'flex page stretching must not participate in table pagination');
  assert.equal(lastCssDeclaration(document, '.sheet', 'min-height'), '0');
  assert.equal(lastCssDeclaration(document, '.sheet', 'height'), undefined, 'the document must grow to multiple pages rather than use a fixed A4 clipping box');
  assert.equal(lastCssDeclaration(document, '.sheet', 'overflow'), undefined);
  assert.equal(lastCssDeclaration(document, '.sheet', 'width'), '190mm');
  assert.equal(lastCssDeclaration(document, '.sheet', 'max-width'), 'none');
  assert.equal(lastCssDeclaration(document, '@page', 'size'), 'A4');
  assert.equal(lastCssDeclaration(document, '@page', 'margin'), '0', 'physical GFS pages use their own padding instead of browser page margins that shrink the full-width header');
  assert.equal(lastCssDeclaration(document, '.sheet.is-paginated', 'width'), '210mm');
  assert.equal(lastCssDeclaration(document, '.gfs-quotation-page', 'height'), '296.5mm', 'physical A4 pages reserve a half-millimeter print safety gap');
  assert.equal(lastCssDeclaration(document, '.gfs-quotation-page', 'width'), '210mm');
  assert.equal(lastCssDeclaration(document, '.gfs-quotation-page', 'padding'), '10mm', '190mm body content and original large image widths remain unchanged inside the full physical page');
  assert.equal(lastCssDeclaration(document, '.gfs-quotation-page', 'break-inside'), 'avoid', 'an explicitly measured physical page must keep its top padding and continuation heading together');
  assert.equal(lastCssDeclaration(document, '.gfs-quotation-page', 'page-break-inside'), 'avoid');
  assert.equal(lastCssDeclaration(document, '.gfs-quotation-page-footer', 'height'), '4mm');
  assert.equal(lastCssDeclaration(document, '.gfs-quotation-page-footer', 'position'), 'absolute');
  assert.equal(lastCssDeclaration(document, '.gfs-quotation-page-footer', 'bottom'), '4mm', 'numbered continuation footer is anchored close to the physical paper bottom');
  assert.equal(lastCssDeclaration(document, '.gfs-quotation-page-footer', 'left'), '10mm');
  assert.equal(lastCssDeclaration(document, '.gfs-quotation-page-footer', 'right'), '10mm');
  assert.equal(lastCssDeclaration(document, '.gfs-quotation-page', 'break-after'), 'page');
  assert.equal(lastCssDeclaration(document, '.gfs-quotation-page:last-child', 'break-after'), 'auto');
  assert.equal(lastCssDeclaration(document, '.items', 'table-layout'), 'fixed');
  assert.equal(lastCssDeclaration(document, '.items', 'overflow'), 'visible');
  assert.equal(lastCssDeclaration(document, '.items', 'break-inside'), undefined, 'the complete table must be allowed to continue onto another page');
  assert.equal(lastCssDeclaration(document, '.items thead', 'display'), 'table-header-group');
  for (const selector of ['.gfs-fixed-quotation-header', '.section.info', '.items tbody tr', '.gfs-quotation-closing', '.totals', '.signatures', '.footer']) {
    assert.equal(lastCssDeclaration(document, selector, 'break-inside'), 'avoid', `${selector} should remain together when it fits a page`);
    assert.equal(lastCssDeclaration(document, selector, 'page-break-inside'), 'avoid', `${selector} should support legacy print pagination`);
  }
  assert.equal(lastCssDeclaration(document, '.signatures', 'margin-top'), '16px!important', 'signature positioning must not stretch the preceding table with auto flex space');
  for (const selector of ['.info .value', '.items td:nth-child(2)', '.gfs-post-table-layout .terms p']) {
    assert.equal(lastCssDeclaration(document, selector, 'overflow-wrap'), 'anywhere');
  }
  assert.equal(lastCssDeclaration(document, '.gfs-post-table-layout .terms p', 'orphans'), '3');
  assert.equal(lastCssDeclaration(document, '.gfs-post-table-layout .terms p', 'widows'), '3');
  assert.doesNotMatch(document, /gfs-quotation-print-page|gfs-quotation-canvas/, 'live printing must not fall back to a fixed-height canvas');
  const mhlDocument = renderers.normalizeQuotationPrintableTable(renderers.quotationPrintableDocument(roundedQuotationFixture('MHL')));
  assert.equal(lastCssDeclaration(mhlDocument, '@page', 'margin'), '12mm', 'GFS physical-page geometry must not change MHL printing');
  assert.equal(lastCssDeclaration(mhlDocument, '.gfs-quotation-page', 'width'), undefined);
  assert.equal(lastCssDeclaration(mhlDocument, '.sheet.is-paginated', 'width'), undefined);
});

test('GFS restores original large stacked item images without compact caps or changing saved widths and sources', () => {
  const renderers = executableQuotationRenderers();
  const data = roundedQuotationFixture();
  data.items = [120, 720].map((imageDisplayWidth, index) => ({
    description: `รายการรูป ${index + 1} <ทดสอบ>`, details: `รายละเอียดรูป ${index + 1}\nข้อความครบถ้วน`,
    quantity: 1, unit: 'ชุด', unitPrice: 1000, imageDisplayWidth,
    imagePreviewUrl: `https://example.test/image-${index + 1}.png?value=<original>&size=large`,
  }));
  const originalData = JSON.stringify(data);
  const document = renderers.normalizeQuotationPrintableTable(renderers.quotationPrintableDocument(data));
  assert.equal(lastCssDeclaration(document, '.items img', 'width'), undefined, 'saved inline image width must remain authoritative');
  assert.equal(lastCssDeclaration(document, '.items img', 'height'), 'auto');
  assert.equal(lastCssDeclaration(document, '.items img', 'max-width'), '100%', 'only the original description-cell width limits large pictures');
  assert.equal(lastCssDeclaration(document, '.items img', 'max-height'), '480px', 'retain the original large illustration height');
  assert.equal(lastCssDeclaration(document, '.items img', 'object-fit'), 'contain', 'the whole illustration must remain visible rather than being cropped');
  assert.equal(lastCssDeclaration(document, '.gfs-item-description.has-image', 'display'), 'block', 'pictures must be stacked below text, not placed in a tiny side column');
  assert.equal(lastCssDeclaration(document, '.gfs-item-description.has-image', 'grid-template-columns'), undefined);
  assert.equal(lastCssDeclaration(document, '.gfs-item-text', 'min-width'), '0');
  const css = document.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
  assert.doesNotMatch(css, /--quotation-image-width|140px|160px|width:auto!important/, 'compact-image layout must not remain in the rendered stylesheet');
  const itemTable = document.match(/<table class="items">([\s\S]*?)<\/table>/)?.[1] || '';
  const rows = Array.from((itemTable.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || '').matchAll(/<tr>([\s\S]*?)<\/tr>/g), match => match[1]);
  assert.equal(rows.length, 2);
  for (const [index, row] of rows.entries()) {
    const width = data.items[index].imageDisplayWidth;
    const imageStyle = row.match(/<img[^>]*style="([^"]*)"/)?.[1] || '';
    assert.match(imageStyle, new RegExp(`(?:^|;)width:${width}px(?:;|$)`));
    assert.ok(row.includes(`รายการรูป ${index + 1} &lt;ทดสอบ&gt;`));
    assert.ok(row.includes(`รายละเอียดรูป ${index + 1}<br>ข้อความครบถ้วน`));
    assert.ok(row.includes(`src="https://example.test/image-${index + 1}.png?value=&lt;original&gt;&amp;size=large"`));
    assert.match(row, /<div class="gfs-item-description has-image"><div class="gfs-item-text">[\s\S]*?<\/div><img /, 'block-layout illustrations follow the full description text');
    assert.equal((row.match(/<img /g) || []).length, 1, 'description, detail, image, and prices should belong to the same printable row');
    assert.ok(row.includes('1000.00'));
  }
  assert.equal(JSON.stringify(data), originalData, 'A4 sizing is display-only and must not rewrite saved image widths');
  const mhlData = { ...data, company: 'MHL' };
  const mhlDocument = renderers.normalizeQuotationPrintableTable(renderers.quotationPrintableDocument(mhlData));
  assert.equal(mhlDocument, renderers.normalizeQuotationPrintableTable(renderers.legacyQuotationPrintableDocument(mhlData)));
  assert.equal(lastCssDeclaration(mhlDocument, '.items img', 'max-height'), undefined, 'MHL image sizing retains its original inline-only behavior');
  assert.equal(lastCssDeclaration(mhlDocument, '.items tbody tr', 'break-inside'), undefined);
  assert.doesNotMatch(mhlDocument, /--quotation-image-width|gfs-quotation-closing|gfs-item-description|gfs-item-text/);
  assert.match(mhlDocument, /style="display:block;width:720px;max-width:100%;height:auto;margin-top:7px/);
});

test('GFS multi-page-sized image quotations retain every item, discount, amount, and closing section', () => {
  const renderers = executableQuotationRenderers();
  const data = roundedQuotationFixture();
  data.items = Array.from({ length: 12 }, (_, index) => ({
    description: `รายการต่อเนื่อง-${index + 1}`, details: `รายละเอียดไม่ตัด-${index + 1}\nบรรทัดเพิ่มเติม-${index + 1}`,
    quantity: 2, unit: 'ตรฟ.', unitPrice: 1000, imageDisplayWidth: 720,
    imagePreviewUrl: `https://example.test/large-item-${index + 1}.png`,
  })).concat(data.items[1]);
  const originalData = JSON.stringify(data);
  const rawDocument = renderers.quotationPrintableDocument(data);
  const document = renderers.normalizeQuotationPrintableTable(rawDocument);
  const body = markup => markup.match(/<body>([\s\S]*?)<\/body>/)?.[1] || '';
  assert.equal(body(document), body(rawDocument), 'table normalization must not cut any continued quotation content');
  assert.equal(JSON.stringify(data), originalData);
  const itemTable = document.match(/<table class="items">([\s\S]*?)<\/table>/)?.[1] || '';
  const itemBody = itemTable.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || '';
  assert.equal((itemBody.match(/<tr(?: class="discount-row")?>/g) || []).length, 13);
  assert.equal((itemBody.match(/<img /g) || []).length, 12);
  for (let index = 1; index <= 12; index += 1) {
    assert.ok(itemBody.includes(`รายการต่อเนื่อง-${index}</strong>`));
    assert.ok(itemBody.includes(`รายละเอียดไม่ตัด-${index}<br>บรรทัดเพิ่มเติม-${index}</span>`));
    assert.ok(itemBody.includes(`src="https://example.test/large-item-${index}.png"`));
  }
  const closing = document.match(/<div class="gfs-quotation-closing">([\s\S]*?)<\/main>/)?.[1] || '';
  assert.equal((document.match(/<div class="gfs-quotation-closing">/g) || []).length, 1);
  assert.ok(closing, 'totals, terms, signature, and footer must share the final keep-together section');
  for (const value of ['24000.00', '200.00', '23800.00', '1666.00', '25466.00', 'หมายเหตุและเงื่อนไขทดสอบ', 'ผู้เสนอราคา', 'Company GFS']) {
    assert.ok(closing.includes(value), `continued document must retain ${value}`);
  }
  assert.match(itemBody, /<tr class="discount-row">/);
  assert.match(closing, /<table class="totals">/);
  assert.match(closing, /<section class="terms">/);
  assert.match(closing, /<section class="signatures">/);
  assert.match(closing, /<footer class="footer">/);
  assert.doesNotMatch(itemBody, /gfs-quotation-closing/, 'continued item rows must not be trapped inside a single closing block');
});

test('GFS final keep-together wrapper respects all totals, words, and notes print options', () => {
  const renderers = executableQuotationRenderers();
  for (const showTotals of [true, false]) {
    for (const showTotalInWords of [true, false]) {
      for (const showNotes of [true, false]) {
        const data = roundedQuotationFixture();
        data.printOptions = { showTotals, showTotalInWords, showNotes };
        const document = renderers.quotationPrintableDocument(data);
        const closing = document.match(/<div class="gfs-quotation-closing">([\s\S]*?)<\/main>/)?.[1] || '';
        assert.equal((document.match(/<div class="gfs-quotation-closing">/g) || []).length, 1);
        assert.equal(closing.includes('<table class="totals">'), showTotals);
        assert.equal(closing.includes('<p class="total-words"'), showTotalInWords);
        assert.equal(closing.includes('<section class="terms">'), showNotes);
        assert.equal((closing.match(/<section class="signatures">/g) || []).length, 1);
        assert.equal((closing.match(/<footer class="footer">/g) || []).length, 1);
        assert.match(document, /<table class="items">/, 'the item table remains visible independently of summary options');
      }
    }
  }
});

test('GFS multiline notes keep every term and blank line in order with escaped text and pagination guards', () => {
  const renderers = executableQuotationRenderers();
  const data = roundedQuotationFixture();
  data.notes = 'เงื่อนไขแรก\r\n\r\n<script>alert("ทดสอบ")</script> & รายละเอียด\rเงื่อนไขยาว ' + 'ข้อความครบถ้วน '.repeat(80) + '\n\nเงื่อนไขสุดท้าย\n';
  const originalData = JSON.stringify(data);
  const document = renderers.normalizeQuotationPrintableTable(renderers.quotationPrintableDocument(data));
  const terms = document.match(/<section class="terms">([\s\S]*?)<\/section>/)?.[1] || '';
  const paragraphs = Array.from(terms.matchAll(/<p class="gfs-terms-line" style="font-size:11px;line-height:1\.35">([\s\S]*?)<\/p>/g), match => match[1]);
  const expectedLines = data.notes.replace(/\r\n?/g, '\n').split('\n').map(line => renderers.quotationPrintText(line, '') || '<br>');
  assert.deepEqual(paragraphs, expectedLines, 'every original term and blank line must survive newline normalization without truncation or reordering');
  assert.equal(paragraphs.filter(line => line === '<br>').length, 3, 'including a trailing blank line preserves the original note spacing');
  assert.equal(paragraphs[2], '&lt;script&gt;alert(&quot;ทดสอบ&quot;)&lt;/script&gt; &amp; รายละเอียด');
  assert.doesNotMatch(terms, /<script>|\r/);
  assert.equal(lastCssDeclaration(document, '.gfs-terms-line', 'break-inside'), 'avoid', 'one newline-delimited term should not fragment across pages when it fits');
  assert.equal(lastCssDeclaration(document, '.gfs-terms-line', 'page-break-inside'), 'avoid');
  assert.equal(lastCssDeclaration(document, '.terms h3', 'break-after'), 'avoid', 'the terms heading must stay with its first term');
  assert.equal(lastCssDeclaration(document, '.terms h3', 'page-break-after'), 'avoid');
  assert.equal(JSON.stringify(data), originalData, 'formatting notes for printing must not mutate the saved quotation');
  data.printOptions = { showNotes: false };
  assert.doesNotMatch(renderers.quotationPrintableDocument(data), /<section class="terms">|<p class="gfs-terms-line"/);
  data.printOptions = {};
  data.notes = '';
  assert.match(renderers.quotationPrintableDocument(data), /<p class="gfs-terms-line"[^>]*>เงื่อนไขมาตรฐาน<\/p>/);
});

test('GFS measured pages reserve footer space, repeat item headers, and repaginate the original source without duplication', async () => {
  const renderers = executableQuotationRenderers();
  const dom = fakeGfsPagedDocument([500, 500, 100]);
  const ready = renderers.prepareGfsQuotationA4Document(dom.documentRoot);
  dom.resolveFonts();
  await ready;
  const inspect = () => {
    const pages = dom.sheet.querySelectorAll('.gfs-quotation-page');
    assert.equal(pages.length, 2);
    assert.deepEqual(pages.map(page => page.querySelector('.gfs-quotation-page-number').textContent), ['หน้า 1/2', 'หน้า 2/2']);
    assert.deepEqual(pages.map(page => page.querySelector('.gfs-quotation-page-status').textContent), ['มีข้อมูลต่อหน้าถัดไป', 'สิ้นสุดใบเสนอราคา']);
    assert.equal(pages[0].querySelectorAll('.gfs-fixed-quotation-header').length, 1);
    assert.equal(pages[1].querySelectorAll('.gfs-fixed-quotation-header').length, 0);
    assert.equal(pages[1].querySelector('.gfs-quotation-continuation-heading').textContent, 'ใบเสนอราคา (ต่อ) · GFS-ORIGINAL-720');
    assert.deepEqual(pages.map(page => page.querySelectorAll('thead').length), [1, 1]);
    assert.equal(dom.sheet.querySelectorAll('.original-row-class').length, 3, 'every original row appears once across the page tables');
    assert.equal(dom.sheet.querySelectorAll('.gfs-quotation-closing').length, 1);
    assert.equal(pages[1].querySelector('.gfs-quotation-closing').textContent, 'ยอดรวมเดิมและลายเซ็น');
    for (const page of pages) {
      assert.ok(page.querySelector('.gfs-quotation-page-content').getBoundingClientRect().bottom <= page.querySelector('.gfs-quotation-page-footer').getBoundingClientRect().top - 8, 'content must fit the measured budget above its reserved footer');
    }
    for (const [index, image] of dom.sheet.querySelectorAll('img').entries()) {
      assert.equal(image.attributes.src, `/original-${index + 1}.png`);
      assert.equal(image.attributes.style, 'width:720px');
      assert.equal(image.attributes.width, '1280');
      assert.equal(image.attributes.height, '720', 'cloned images retain their intrinsic ratio without shrinking saved display width');
    }
  };
  inspect();
  dom.dispatch('beforeprint');
  inspect();
  dom.dispatch('beforeprint');
  inspect();
});

test('GFS page readiness is shared and waits for images and fonts while tolerating rejection or missing APIs', async () => {
  const renderers = executableQuotationRenderers();
  const dom = fakeGfsPagedDocument([100]);
  let resolveImage;
  dom.documentRoot.images[0].decode = () => new Promise(resolve => { resolveImage = resolve; });
  const ready = renderers.prepareGfsQuotationA4Document(dom.documentRoot);
  assert.equal(ready, dom.documentRoot.defaultView.__gfsQuotationA4Ready);
  assert.equal(renderers.prepareGfsQuotationA4Document(dom.documentRoot), ready, 'concurrent preview/print callers must await one shared preparation');
  assert.equal(dom.listeners.get('beforeprint').length, 1);
  assert.equal(dom.sheet.classList.contains('is-paginated'), false);
  dom.resolveFonts();
  await Promise.resolve();
  assert.equal(dom.sheet.classList.contains('is-paginated'), false, 'loaded fonts must not trigger pagination before image ratios settle');
  resolveImage();
  await ready;
  assert.equal(dom.sheet.classList.contains('is-paginated'), true);
  const rejected = fakeGfsPagedDocument([100]);
  rejected.documentRoot.images[0].decode = () => Promise.reject(new Error('image unavailable'));
  const rejectedReady = renderers.prepareGfsQuotationA4Document(rejected.documentRoot);
  rejected.rejectFonts(new Error('fonts unavailable'));
  await assert.doesNotReject(rejectedReady);
  assert.equal(rejected.sheet.classList.contains('is-paginated'), true);
  const optional = fakeGfsPagedDocument([100]);
  delete optional.documentRoot.fonts;
  delete optional.documentRoot.defaultView;
  await assert.doesNotReject(renderers.prepareGfsQuotationA4Document(optional.documentRoot));
  assert.equal(optional.sheet.classList.contains('is-paginated'), true);
  const empty = fakeGfsPagedDocument([100], { hasTable: false });
  empty.resolveFonts();
  await assert.doesNotReject(renderers.prepareGfsQuotationA4Document(empty.documentRoot));
  assert.equal(empty.sheet.classList.contains('is-paginated'), false);
  await assert.doesNotReject(renderers.prepareGfsQuotationA4Document({ querySelector() { return null; } }));
});

test('only GFS embeds a self-contained escaped explicit-page script without old oversized or compact-image CSS', async () => {
  const renderers = executableQuotationRenderers();
  const data = roundedQuotationFixture();
  data.notes = '</script><script>untrusted()</script>';
  const document = renderers.normalizeQuotationPrintableTable(renderers.quotationPrintableDocument(data));
  const scripts = Array.from(document.matchAll(/<script data-gfs-quotation-pagination>([\s\S]*?)<\/script>/g), match => match[1]);
  assert.equal(scripts.length, 1);
  assert.equal((document.match(/<script\b/g) || []).length, 1, 'quotation text must never inject another executable script');
  assert.equal(scripts[0].includes('untrusted'), false);
  assert.match(document, /&lt;\/script&gt;&lt;script&gt;untrusted\(\)&lt;\/script&gt;/);
  const fixedSource = quotationRendererSource('function gfsFixedQuotationPrintableDocument(data)', 'function quotationPrintableDocument(data)');
  assert.ok(fixedSource.includes('<' + String.fromCharCode(92) + '/script></body>'), 'the application HTML must escape the generated closing script tag');
  const dom = fakeGfsPagedDocument([100]);
  dom.resolveFonts();
  await assert.doesNotReject(vm.runInNewContext(scripts[0], { document: dom.documentRoot }), 'embedded preparation must not depend on CRM globals or external modules');
  assert.equal(dom.sheet.querySelectorAll('.gfs-quotation-page').length, 1);
  assert.equal(lastCssDeclaration(document, '.items tbody tr', 'break-inside'), 'avoid');
  assert.equal(lastCssDeclaration(document, '.items .gfs-item-text .muted', 'display'), 'block', 'long detail text needs a block override specific enough to beat the original .items td .muted inline-block rule');
  assert.doesNotMatch(document, /gfs-item-oversized|160px|140px/, 'obsolete oversized-class and tiny side-column policies must be removed');
  const mhlDocument = renderers.quotationPrintableDocument({ ...data, company: 'MHL' });
  assert.doesNotMatch(mhlDocument, /data-gfs-quotation-pagination|prepareGfsQuotationA4Document|gfs-item-oversized/);
});

test('quotation preview waits for explicit page readiness and ignores an older or cleared frame document', async () => {
  for (const state of ['current', 'replaced', 'cleared', 'MHL']) {
    const context = executableQuotationRenderers();
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const originalDocument = { defaultView: state === 'MHL' ? {} : { __gfsQuotationA4Ready: ready } };
    const frame = { contentDocument: originalDocument, srcdoc: '' };
    const button = { disabled: false, innerHTML: '' };
    context.document = { getElementById(id) { return id === 'caseQuotationPreviewFrame' ? frame : button; } };
    vm.runInContext(quotationRendererSource('function renderCaseQuotationPreviewDocument(printableData)', 'async function openCaseQuotationPrintPreview(data)'), context);
    context.renderCaseQuotationPreviewDocument(roundedQuotationFixture(state === 'MHL' ? 'MHL' : 'GFS'));
    assert.equal(button.disabled, true);
    const loading = frame.onload();
    if (state !== 'MHL') {
      await Promise.resolve();
      assert.equal(button.disabled, true, 'iframe load alone is not enough before measured pages finish');
    }
    if (state === 'replaced') frame.contentDocument = { defaultView: {} };
    if (state === 'cleared') frame.srcdoc = '';
    resolveReady();
    await loading;
    assert.equal(button.disabled, state === 'replaced' || state === 'cleared', `${state}: only the same populated document may enable its Print control`);
  }
});

test('quotation printing waits for page preparation and never prints an older or cleared document', async () => {
  for (const state of ['current', 'replaced', 'cleared', 'MHL']) {
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const originalDocument = { defaultView: state === 'MHL' ? {} : { __gfsQuotationA4Ready: ready } };
    const calls = [];
    const frame = { srcdoc: 'populated quotation', contentDocument: originalDocument, contentWindow: { focus() { calls.push('focus'); }, print() { calls.push('print'); } } };
    const button = { disabled: false };
    const context = {
      document: { getElementById(id) { return id === 'caseQuotationPreviewFrame' ? frame : button; } },
      async waitForCaseQuotationPreviewAssets() { calls.push('assets'); },
      showToast() { assert.fail('a valid print frame should not produce a missing-document toast'); },
    };
    vm.createContext(context);
    vm.runInContext(quotationRendererSource('async function printCaseQuotationPreview()', 'async function saveCaseQuotation(event)'), context);
    const printing = context.printCaseQuotationPreview();
    assert.equal(button.disabled, true);
    if (state !== 'MHL') {
      await Promise.resolve();
      assert.deepEqual(calls, ['assets']);
    }
    if (state === 'replaced') frame.contentDocument = { defaultView: {} };
    if (state === 'cleared') frame.srcdoc = '';
    resolveReady();
    await printing;
    assert.deepEqual(calls, state === 'current' || state === 'MHL' ? ['assets', 'focus', 'print'] : ['assets']);
    assert.equal(button.disabled, state === 'replaced', 'completion of an older print must not reenable a newer document control');
  }
});

test('quotation saving times out cleanly and does not misreport a completed save as a failure', () => {
  const saveStart = crmIndexHtml.indexOf('async function saveCaseQuotation');
  const saveEnd = crmIndexHtml.indexOf('async function deleteCaseQuotationHistory', saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  const quotationSave = crmIndexHtml.slice(saveStart, saveEnd);

  assert.match(quotationSave, /const \{ response, result \} = await fetchJsonWithTimeout\(config\.crmApiUrl/);
  assert.match(quotationSave, /let quotationSaved = false;/);
  assert.match(quotationSave, /quotationSaved = true;/);
  assert.match(quotationSave, /if \(quotationSaved\) \{/);
  assert.match(quotationSave, /บันทึก.*แล้ว แต่ไม่สามารถรีเฟรชหน้าจอได้/);
});

test('migration seeds the fixed matrix and keeps existing CRM tables untouched', () => {
  const seedRows = migrationSql.match(/\('(GFS|MHL)', '(quotation|invoice|receipt|tax_invoice|work_delivery|credit_note)',/g) || [];
  assert.equal(seedRows.length, 12);
  assert.match(migrationSql, /schema_version integer not null default 2/i);
  assert.match(migrationSql, /check \(schema_version = 2\)/i);
  assert.match(migrationSql, /jsonb_typeof\(design_json -> 'canvas'\) = 'object'/i);
  assert.match(migrationSql, /alter table public\.document_templates enable row level security;/i);
  assert.match(migrationSql, /alter table public\.document_template_versions enable row level security;/i);
  assert.match(migrationSql, /alter table public\.document_template_publications enable row level security;/i);
  assert.doesNotMatch(migrationSql, /alter table public\.(?:cases|customers|lead_follow_up_history)\b/i);
});
