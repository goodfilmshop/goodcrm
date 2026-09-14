const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const crmIndexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const pickerStart = crmIndexHtml.indexOf('function openQuotationCasePicker()');
const pickerEnd = crmIndexHtml.indexOf('function handleQuotationSearchInput()', pickerStart);

test('invoice form copies quotation fields into an independent draft without issuing an invoice', () => {
  const start = crmIndexHtml.indexOf('function invoiceDraftFromQuotation(');
  const end = crmIndexHtml.indexOf('async function openInvoiceFromQuotation(', start);
  const context = vm.createContext({ quotationTodayValue: () => '2026-09-12' });
  vm.runInContext(crmIndexHtml.slice(start, end), context);
  const original = { historyId:'q-history', caseId:'case1', quoteNumber:'Q260912-9126FC',
    customerName:'Customer', taxId:'123', address:'Address', contactPhone:'123456789', paymentTerms:'30 days',
    items:[{description:'Film', quantity:432, unitPrice:209, imagePath:'image.webp'}, {isDiscount:true, unitPrice:9999}] };
  const draft = context.invoiceDraftFromQuotation(original);
  assert.equal(draft.invoiceNumber, '');
  assert.equal(draft.historyId, '');
  assert.equal(draft.sourceHistoryId, original.historyId);
  assert.equal(draft.sourceQuoteNumber, original.quoteNumber);
  assert.equal(draft.customerName, original.customerName);
  assert.equal(draft.taxId, original.taxId);
  assert.equal(draft.address, original.address);
  assert.equal(draft.paymentTerms, original.paymentTerms);
  assert.equal(draft.items[0].imagePath, 'image.webp');
  assert.equal(draft.items[1].unitPrice, 9999);
  draft.items[0].quantity = 1;
  assert.equal(original.items[0].quantity, 432);
  assert.match(crmIndexHtml, /id="createInvoiceFromQuotationButton" type="button" class=/);
});

test('duplicating a quotation creates a new unsaved identity and independent images', async () => {
  const source = {
    caseId: 'CASE-260912-3EF', customerId: 'c1', historyId: 'old-history',
    quoteNumber: 'Q260912-9123EF', originalQuoteNumber: 'Q260912-9123EF', company: 'GFS',
    issueDate: '2026-09-11', customerName: 'Customer', address: 'Address',
    removedImagePaths: ['old-deleted-image'], printOptions: { showTaxId: true },
    items: [{ description: 'Film', details: 'Details', quantity: 157, unitPrice: 99, imagePath: 'old/image.webp', imageDisplayWidth: 180 },
      { isDiscount: true, description: 'Discount', quantity: 1, unitPrice: 100 }]
  };
  const copyButton = { disabled: false }, saveButton = { disabled: false };
  const imageBlob = { type: 'image/webp' };
  let opened = 0;
  const context = vm.createContext({
    caseQuotationDraft: source, caseQuotationComposerVersion: 1,
    document: { getElementById: id => id === 'duplicateCaseQuotationButton' ? copyButton : saveButton },
    getCaseQuotationFormData: () => source,
    isQuotationDiscount: item => Boolean(item.isDiscount),
    getQuotationImageUrl: async () => 'https://example.test/image.webp',
    fetch: async () => ({ ok: true, blob: async () => imageBlob }),
    URL: { createObjectURL: () => 'blob:independent-copy' },
    getActiveCaseQuotationNumbers: () => [source.quoteNumber],
    getDefaultQuotationNumber: () => 'Q260912-9123EF-01',
    quotationTodayValue: () => '2026-09-12',
    revokeQuotationImagePreview() {}, revokeQuotationDraftPreviewUrls() {},
    showCaseQuotationDrawer: () => { opened++; context.caseQuotationComposerVersion++; },
    showSuccessToast() {}, showToast: message => assert.fail(message),
  });
  const start = crmIndexHtml.indexOf('async function duplicateCaseQuotation(');
  const end = crmIndexHtml.indexOf('function renderCaseQuotationComposer(', start);
  vm.runInContext(crmIndexHtml.slice(start, end), context);
  await context.duplicateCaseQuotation();
  const copied = context.caseQuotationDraft;
  assert.equal(opened, 1);
  assert.equal(copied.historyId, '');
  assert.equal(copied.originalQuoteNumber, '');
  assert.equal(copied.quoteNumber, 'Q260912-9123EF-01');
  assert.equal(copied.issueDate, '2026-09-12');
  assert.equal(copied.customerName, source.customerName);
  assert.equal(copied.address, source.address);
  assert.equal(copied.removedImagePaths.length, 0);
  assert.equal(copied.items[0].imagePath, '');
  assert.equal(copied.items[0].imageFile, imageBlob);
  assert.equal(copied.items[0].quantity, 157);
  assert.equal(copied.items[0].imageDisplayWidth, 180);
  assert.equal(copied.items[1].unitPrice, 100);
  assert.equal(source.items[0].imagePath, 'old/image.webp');
  assert.equal(source.historyId, 'old-history');
  copied.items[0].description = 'Changed';
  assert.equal(source.items[0].description, 'Film');
});

test('quotation numbers use YYMMDD and increment within the case across dates', () => {
  const start = crmIndexHtml.indexOf('function getDefaultQuotationNumber(');
  const end = crmIndexHtml.indexOf('function updateCachedCaseQuotationNumbers(', start);
  const context = vm.createContext({ quotationTodayValue: () => '2026-09-12' });
  vm.runInContext(crmIndexHtml.slice(start, end), context);
  const number = (existing = [], company = 'GFS') => context.getDefaultQuotationNumber(company, 'CASE-260912-3EF', existing);
  assert.equal(number(), 'Q260912-9123EF');
  assert.equal(number([], 'MHL'), 'Q260912-9123EF');
  assert.equal(number(['Q260912-9123EF']), 'Q260912-9123EF-01');
  assert.equal(number(['Q260912-9123EF', 'Q260912-9123EF-01']), 'Q260912-9123EF-02');
  assert.equal(number(['Q260912-9123EF', 'Q260912-9123EF']), 'Q260912-9123EF-01');
  assert.equal(number(['Q260911-9123EF', 'Q260911-9123EF-04']), 'Q260912-9123EF-05');
  assert.equal(number(['Q-20260912-9123EF']), 'Q260912-9123EF-01');
  assert.equal(number(['Q260912-9123EF-99']), 'Q260912-9123EF-100');
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function flushAsyncHandlers() {
  return new Promise(resolve => setImmediate(resolve));
}

function casePage(rows, page = 1, total = rows.length, totalPages = 1) {
  return {
    response: { ok: true },
    result: {
      success: true,
      apiVersion: 'test-crm-version',
      cases: rows,
      pagination: { page, pageSize: 10, total, totalPages },
      readThroughAt: '2026-09-12T06:00:00.000Z',
    },
  };
}

function createHarness() {
  assert.ok(pickerStart >= 0 && pickerEnd > pickerStart, 'quotation case picker functions must exist');
  const elements = new Map();
  const timers = new Map();
  const requests = [];
  const detailRequests = [];
  const openedDetails = [];
  const openedComposers = [];
  const toasts = [];
  let nextTimerId = 0;
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      const attributes = new Map();
      elements.set(id, {
        id,
        value: '',
        textContent: '',
        innerHTML: '',
        disabled: false,
        dataset: {},
        isConnected: true,
        focused: false,
        classList: {
          add(...names) { names.forEach(name => classes.add(name)); },
          remove(...names) { names.forEach(name => classes.delete(name)); },
          contains(name) { return classes.has(name); },
          toggle(name, force) {
            const added = force === undefined ? !classes.has(name) : force;
            if (added) classes.add(name);
            else classes.delete(name);
            return added;
          },
        },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        removeAttribute(name) { attributes.delete(name); },
        focus() { this.focused = true; },
        contains(candidate) { return candidate === this; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        replaceChildren() {},
        appendChild() {},
      });
    }
    return elements.get(id);
  }
  const context = {
    URL,
    Date,
    console: { error() {}, warn() {} },
    config: { crmApiUrl: 'http://localhost:3000/api/crm' },
    currentCrmMember: { role: 'sales', userId: 'USER-1' },
    crmScopeVersion: 1,
    scopeKey: 'USER-1:sales',
    requiredCrmApiVersion: 'test-crm-version',
    QUOTATION_CASE_PAGE_SIZE: 10,
    quotationCasePicker: {
      open: true, loading: false, selecting: false, rows: [], search: '',
      page: 1, total: 0, totalPages: 1, error: '',
    },
    quotationCasePickerRequestId: 0,
    quotationCaseSelectionRequestId: 0,
    quotationCaseSearchTimer: null,
    quotationCasePickerReturnFocus: null,
    allCases: [{ caseId: 'UNRELATED-CASE' }],
    casesPagination: { page: 9, total: 900, totalPages: 45 },
    casesSearchTerm: 'unrelated list search',
    casesFilters: { status: 'ปิดงาน', admin: 'แอดมินอื่น', salesperson: 'เซลส์อื่น', date: '2026-08-01' },
    document: {
      getElementById: element,
      activeElement: element('previousFocus'),
      body: element('body'),
      contains(candidate) { return candidate?.isConnected === true; },
      querySelectorAll() { return []; },
    },
    getCrmScopeKey() { return context.scopeKey; },
    isCrmPageVisible() { return true; },
    showToast(message) { toasts.push(message); },
    syncBodyScrollLock() {},
    ensureCurrentCrmApiVersion() { return Promise.resolve(true); },
    escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[character]);
    },
    requestAnimationFrame(callback) { callback(); },
    setTimeout(callback) {
      const id = ++nextTimerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    fetchJsonWithTimeout(url, options) {
      const pending = deferred();
      requests.push({ url: new URL(url), options, ...pending });
      return pending.promise;
    },
    fetchLeadDetail(customerId, options) {
      const pending = deferred();
      detailRequests.push({ customerId, options, ...pending });
      return pending.promise;
    },
    openCaseDetailDrawer(...args) { openedDetails.push(args); },
    openCaseQuotationDrawer(options) { openedComposers.push(options); },
    saveCaseQuotation() { throw new Error('Opening a composer must not save a quotation'); },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext([
    quotationFunctionBlock('function normalizeTimelineStatus(value)', 'function deriveCaseStatusStates('),
    quotationFunctionBlock('function getLeadCaseStatusTone(statusValue)', 'function renderLeadCases('),
    quotationFunctionBlock('function uniqueQuotationNumbers(values)', 'function updateCachedCaseQuotationNumbers('),
    crmIndexHtml.slice(pickerStart, pickerEnd),
  ].join('\n'), context);
  const renderPicker = context.renderQuotationCasePicker;
  // These tests exercise request and launch behavior; visual rendering is checked separately.
  context.renderQuotationCasePicker = () => {};
  return {
    context, element, timers, requests, detailRequests, openedDetails, openedComposers, toasts, renderPicker,
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(callback => callback());
    },
  };
}

function quotationFunctionBlock(startMarker, endMarker) {
  const start = crmIndexHtml.indexOf(startMarker);
  const end = crmIndexHtml.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} must have an extractable source block`);
  return crmIndexHtml.slice(start, end);
}

function quotationDraft(company = 'GFS', extra = {}) {
  return {
    caseId: 'CASE-QUOTE-1', customerId: 'CUST-QUOTE-1', company,
    quoteNumber: `${company}-Q-001`, issueDate: '2026-09-12', validDays: '15',
    customerName: 'ลูกค้าทดสอบ', contactName: 'ผู้ติดต่อ', contactPhone: '0811111111',
    address: 'กรุงเทพมหานคร', creditTerm: 'ชำระตามข้อตกลง', printOptions: {},
    items: [{ description: 'ติดฟิล์ม', quantity: 1, unit: 'ตรฟ.', unitPrice: 100 }],
    ...extra,
  };
}

function createQuotationComposerHarness(company = 'GFS', extra = {}) {
  const elements = new Map();
  const renderedIds = new Set();
  const requests = [];
  const toasts = [];
  const successToasts = [];
  const previewDocuments = [];
  const hydrationCalls = [];
  const closures = { quotation: 0, leadFollowUp: 0 };
  let renderedHtml = '';
  let context;
  function makeElement(id) {
    const classes = new Set();
    const listeners = new Map();
    const attributes = new Map();
    return {
      id, value: '', disabled: false, isConnected: true, textContent: '', innerHTML: '',
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, force) {
          const added = force === undefined ? !classes.has(name) : force;
          if (added) classes.add(name);
          else classes.delete(name);
          return added;
        },
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      appendChild() {},
      replaceChildren() {},
      focus() {},
      contains(candidate) { return candidate?.isConnected === true; },
      addEventListener(name, callback) { listeners.set(name, callback); },
      listeners,
    };
  }
  const stableIds = [
    'caseQuotationDrawerContent', 'caseQuotationDrawer', 'caseQuotationPreviewModal',
    'caseQuotationPreviewFrame', 'caseQuotationPreviewNumber', 'body',
  ];
  stableIds.forEach(id => elements.set(id, makeElement(id)));
  const content = elements.get('caseQuotationDrawerContent');
  Object.defineProperty(content, 'innerHTML', {
    get() { return renderedHtml; },
    set(value) {
      renderedIds.forEach(id => {
        const previous = elements.get(id);
        if (previous) previous.isConnected = false;
        elements.delete(id);
      });
      renderedIds.clear();
      renderedHtml = value;
      for (const match of value.matchAll(/\bid="([^"]+)"/g)) {
        renderedIds.add(match[1]);
        elements.set(match[1], makeElement(match[1]));
      }
    },
  });
  elements.get('caseQuotationPreviewModal').classList.add('hidden');
  context = {
    console: { error() {}, warn() {} },
    config: { crmApiUrl: 'http://localhost:3000/api/crm' },
    caseQuotationDraft: quotationDraft(company, extra),
    caseQuotationComposerVersion: 1,
    caseQuotationPreviewData: null,
    activeCaseDetail: { customerId: 'CUST-QUOTE-1', caseData: { logId: 'CASE-QUOTE-1', company }, parentLead: {} },
    allCases: [],
    DEFAULT_QUOTATION_CREDIT_TERM: 'ชำระตามข้อตกลง',
    document: {
      getElementById(id) { return elements.get(id) || null; },
      body: elements.get('body'),
      querySelectorAll() { return []; },
    },
    canDeleteCases() { return false; },
    getQuotationCompanyMeta(code) { return { name: `บริษัท ${code}`, englishName: `Company ${code}`, code }; },
    escapeTimelineValue(value) { return String(value ?? ''); },
    escapeHtml(value) { return String(value ?? ''); },
    quotationAmount(value) { return Number(value) || 0; },
    quotationPrintOptions(value = {}) { return value; },
    quotationTodayValue() { return '2026-09-12'; },
    resolveQuotationSalesperson() { return { name: 'เซลส์', source: 'salesperson' }; },
    resolveQuotationSignatureContact() { return { name: 'เซลส์', source: 'salesperson' }; },
    defaultQuotationNotes() { return 'เงื่อนไข'; },
    createCaseQuotationItemRow() { return {}; },
    updateCaseQuotationTotals() {},
    addCaseQuotationItem() {},
    addCaseQuotationDiscount() {},
    deleteCaseQuotationHistory() {},
    closeCaseQuotationDrawer() {
      closures.quotation += 1;
      context.caseQuotationDraft = null;
      context.caseQuotationComposerVersion += 1;
    },
    closeLeadFollowUpDrawer() { closures.leadFollowUp += 1; },
    getCaseQuotationFormData() { return structuredClone(context.caseQuotationDraft || {}); },
    hydrateQuotationSalespersonContact(data) { hydrationCalls.push(data); return Promise.resolve(data); },
    hydrateQuotationImagePreviews(data) { return Promise.resolve(data); },
    quotationHistorySnapshot(data) { return { ...data }; },
    defaultNextFollowUpLocalValue() { return '2026-09-15T13:00'; },
    dateTimeLocalToIso() { return '2026-09-15T06:00:00.000Z'; },
    ensureCurrentCrmApiVersion() { return Promise.resolve(true); },
    prepareQuotationImagesForSave(data) { return Promise.resolve({ data, uploadedImagePaths: [] }); },
    deleteQuotationImagePaths() { return Promise.resolve(); },
    updateCachedCaseQuotationNumbers() {},
    clearLeadCaches() {},
    renderCaseDetailView() {},
    loadCaseContactHistory() { return Promise.resolve(); },
    fetchCasesData() { return Promise.resolve(); },
    refreshInstallationQueueIfVisible() {},
    fetchQuotations() { return Promise.resolve(); },
    fetchLeadsData() { return Promise.resolve(); },
    setCaseQuotationPreviewOptionsAvailability() {},
    renderCaseQuotationPreviewOptions() {},
    renderCaseQuotationPreviewDocument(data) { previewDocuments.push(data); },
    showToast(message) { toasts.push(message); },
    showSuccessToast(message) { successToasts.push(message); },
    showCaseQuotationDrawer() { context.caseQuotationComposerVersion += 1; context.renderCaseQuotationComposer(); },
    fetchJsonWithTimeout(url, options) {
      const pending = deferred();
      requests.push({ url, options, body: JSON.parse(options.body), ...pending });
      return pending.promise;
    },
  };
  vm.createContext(context);
  const source = [
    quotationFunctionBlock('function canPrintCaseQuotation(data = caseQuotationDraft)', 'function openCaseQuotationDrawer(options = {})'),
    quotationFunctionBlock("function openQuotationHistoryDrawer(followUp, selectedQuoteNumber = '')", 'function showCaseQuotationDrawer('),
    quotationFunctionBlock('async function openCaseQuotationPrintPreview(data)', 'function closeCaseQuotationPrintPreview()'),
    quotationFunctionBlock('async function saveCaseQuotation(event)', 'async function deleteCaseQuotationHistory()'),
  ].join('\n');
  vm.runInContext(source, context);
  // Composer tests exercise the saved-document guard; browser checks cover tab rendering.
  context.openCaseDocumentPreview = (data, initialType) => {
    assert.equal(initialType, 'quotation');
    previewDocuments.push(data);
    context.document.getElementById('caseQuotationPreviewModal').classList.remove('hidden');
    return () => {};
  };
  context.renderCaseQuotationComposer();
  return {
    context, requests, toasts, successToasts, previewDocuments, hydrationCalls, closures,
    html() { return renderedHtml; },
    element(id) { return elements.get(id) || null; },
    save() { return context.saveCaseQuotation({ preventDefault() {} }); },
    savedResponse(id = 'HISTORY-QUOTE-1') {
      return { response: { ok: true }, result: { success: true, followUp: { id, caseId: 'CASE-QUOTE-1' }, updatedAt: '2026-09-12T06:00:00.000Z' } };
    },
  };
}

function createQuotationReportHarness() {
  const openedQuotations = [];
  const openedCases = [];
  function node(tagName) {
    return {
      tagName, children: [], textContent: '', innerHTML: '', className: '',
      style: {}, attributes: {}, listeners: new Map(), colSpan: 1,
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild(child) { this.children.push(child); return child; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(name, callback) { this.listeners.set(name, callback); },
    };
  }
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, node('div'));
      return elements.get(id);
    },
    createElement: node,
  };
  const savedGfs = {
    caseId: 'CASE-REPORT-GFS', customerId: 'CUST-REPORT-GFS', company: 'GFS',
    customerName: 'ลูกค้า GFS', quoteNumber: 'GFS-REPORT-Q-1', followedAt: '2026-09-12T06:00:00.000Z',
    status: 'นัดวัดพื้นที่', quotationSnapshot: { issueDate: '2026-09-12', subtotal: 1000, discount: 100, total: 963 },
  };
  const savedMhl = {
    caseId: 'CASE-REPORT-MHL', customerId: 'CUST-REPORT-MHL', company: 'MHL',
    customerName: 'ลูกค้า MHL', quoteNumber: 'MHL-REPORT-Q-1', followedAt: '2026-09-11T06:00:00.000Z',
    status: 'ปิดงาน', quotationSnapshot: { issueDate: '2026-09-11', subtotal: 2000, discount: 0, total: 2140 },
  };
  const legacy = {
    caseId: 'CASE-REPORT-LEGACY', customerId: 'CUST-REPORT-LEGACY', company: 'GFS',
    customerName: 'ลูกค้าเดิม', quoteNumber: 'LEGACY-REPORT-Q-1', followedAt: '2026-09-10T06:00:00.000Z',
    status: 'ส่งใบเสนอราคา', quotationSnapshot: null,
  };
  const context = {
    document, Date,
    allQuotations: [savedGfs, savedMhl, legacy],
    quotationSearchTerm: '',
    quotationPagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    updateQuotationCompanyUi() {},
    normalizeCasesSearchValue(value) { return String(value || '').trim().toLowerCase(); },
    getQuotationSearchText() { return ''; },
    calculateCaseQuotationTotals(snapshot) { return snapshot; },
    formatQuotationAmount(value) { return Number(value || 0).toFixed(2); },
    formatQuotationDate(value) { return value; },
    formatSheetDate(value) { return value; },
    openQuotationFromList(item) { openedQuotations.push(item); return Promise.resolve(); },
    viewCaseFromList(item) { openedCases.push(item); },
    goToQuotationPage() {},
  };
  vm.createContext(context);
  vm.runInContext(quotationFunctionBlock('function renderQuotationList({ loading = false, error = \'\' } = {})', 'function goToQuotationPage('), context);
  context.renderQuotationList();
  const container = document.getElementById('quotationListContainer');
  const table = container.children[0]?.children.find(child => child.tagName === 'table');
  return { context, document, container, table, savedGfs, savedMhl, legacy, openedQuotations, openedCases };
}

test('quotation report exposes the new creation button and accessible case picker', () => {
  const pageStart = crmIndexHtml.indexOf('id="page-quotations"');
  const pageEnd = crmIndexHtml.indexOf('id="page-', pageStart + 1);
  const page = crmIndexHtml.slice(pageStart, pageEnd);
  assert.ok(pageStart >= 0 && pageEnd > pageStart);
  assert.match(page, /id="createNewQuotationButton"[^>]*onclick="openQuotationCasePicker\(\)"/);
  assert.match(page, /สร้างใบเสนอราคาใหม่/);
  assert.match(page, /aria-haspopup="dialog" aria-controls="quotationCasePickerModal"/);
  assert.match(crmIndexHtml, /id="quotationCasePickerModal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(crmIndexHtml, /id="quotationCasePickerModal"[^>]*aria-labelledby="quotationCasePickerTitle"/);
  assert.match(crmIndexHtml, /document\.addEventListener\('keydown', event => \{\s*if \(quotationCasePicker\.open && event\.key === 'Tab'\) \{\s*handleQuotationCasePickerKeydown\(event\);/);
  assert.match(crmIndexHtml, /<label for="quotationCaseSearchInput"/);
});

test('case picker uses ten cases per page without changing other list page sizes', () => {
  assert.match(crmIndexHtml, /const QUOTATION_CASE_PAGE_SIZE = 10;/);
  assert.match(crmIndexHtml, /const CASES_PAGE_SIZE = 20;/);
  assert.match(crmIndexHtml, /const QUOTATIONS_PAGE_SIZE = 20;/);
});

test('quotation case picker requests its own searched page without mutating case-list state', async () => {
  const harness = createHarness();
  const { context, requests } = harness;
  const originalCases = context.allCases;
  const originalPagination = context.casesPagination;
  const originalFilters = JSON.stringify(context.casesFilters);
  context.quotationCasePicker.search = 'ลูกค้า CASE-42';
  const pending = context.loadQuotationCasePickerPage(2);
  assert.equal(requests.length, 1);
  const { url, options } = requests[0];
  assert.equal(url.searchParams.get('action'), 'getCases');
  assert.equal(url.searchParams.get('scope'), 'list');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('pageSize'), '10');
  assert.equal(url.searchParams.get('search'), 'ลูกค้า CASE-42');
  for (const filter of ['status', 'admin', 'salesperson', 'date']) {
    assert.equal(url.searchParams.has(filter), false, `${filter} must not leak from the case page`);
  }
  assert.equal(options?.cache, 'no-store');
  assert.ok(!options?.method || options.method === 'GET');
  const rows = [{ caseId: 'CASE-42', customerId: 'CUST-42', company: 'MHL' }];
  requests[0].resolve(casePage(rows, 2, 42, 5));
  await pending;
  assert.deepEqual([...context.quotationCasePicker.rows], rows);
  assert.equal(context.quotationCasePicker.page, 2);
  assert.equal(context.quotationCasePicker.total, 42);
  assert.equal(context.quotationCasePicker.totalPages, 5);
  assert.equal(context.quotationCasePicker.loading, false);
  assert.equal(context.allCases, originalCases);
  assert.equal(context.casesPagination, originalPagination);
  assert.equal(JSON.stringify(context.casesFilters), originalFilters);
  assert.equal(context.casesSearchTerm, 'unrelated list search');
});

test('only the latest case-page response can replace picker results', async () => {
  const { context, requests } = createHarness();
  const first = context.loadQuotationCasePickerPage(1);
  const second = context.loadQuotationCasePickerPage(2);
  const latestRows = [{ caseId: 'CASE-NEW', customerId: 'CUST-NEW' }];
  requests[1].resolve(casePage(latestRows, 2, 25, 3));
  await second;
  requests[0].resolve(casePage([{ caseId: 'CASE-OLD' }], 1, 25, 3));
  await first;
  assert.deepEqual([...context.quotationCasePicker.rows], latestRows);
  assert.equal(context.quotationCasePicker.page, 2);
});

test('closing the picker ignores late page success and failure', async () => {
  for (const rejectRequest of [false, true]) {
    const { context, requests, toasts } = createHarness();
    const pending = context.loadQuotationCasePickerPage(1);
    context.closeQuotationCasePicker();
    const closedState = JSON.stringify(context.quotationCasePicker);
    if (rejectRequest) requests[0].reject(new Error('late network error'));
    else requests[0].resolve(casePage([{ caseId: 'CASE-LATE' }]));
    await pending;
    assert.equal(context.quotationCasePicker.open, false);
    assert.equal(JSON.stringify(context.quotationCasePicker), closedState);
    assert.equal(toasts.length, 0);
  }
});

test('case-page results from a previous CRM scope are ignored', async () => {
  for (const scopeProperty of ['crmScopeVersion', 'scopeKey']) {
    const { context, requests } = createHarness();
    const pending = context.loadQuotationCasePickerPage(1);
    context[scopeProperty] = scopeProperty === 'crmScopeVersion' ? 2 : 'USER-2:sales';
    const stateAfterScopeChange = JSON.stringify(context.quotationCasePicker);
    requests[0].resolve(casePage([{ caseId: 'OTHER-USER-CASE' }]));
    await pending;
    assert.equal(JSON.stringify(context.quotationCasePicker), stateAfterScopeChange);
  }
});

test('selecting a case opens the existing composer from authoritative lead detail without saving', async () => {
  const { context, detailRequests, requests, openedDetails, openedComposers } = createHarness();
  context.quotationCasePicker.rows = [{
    caseId: 'CASE-42', customerId: 'CUST-42', company: 'GFS', billingAddress: 'stale address',
  }];
  const fullCase = {
    logId: 'CASE-42', company: 'MHL', billingName: 'ชื่อลูกค้าสำหรับออกเอกสาร',
    billingAddress: 'ที่อยู่ปัจจุบัน', taxId: '1234567890123', jobDetails: 'รายละเอียดงานฉบับเต็ม',
  };
  const lead = { Cust_ID: 'CUST-42', 'ชื่อลูกค้า': 'ลูกค้า', 'ไทม์ไลน์สถานะ': [fullCase] };
  const pending = context.selectQuotationCaseForNewQuote('CASE-42', 'CUST-42');
  assert.equal(detailRequests.length, 1);
  assert.equal(detailRequests[0].customerId, 'CUST-42');
  assert.equal(detailRequests[0].options.force, true);
  detailRequests[0].resolve(lead);
  assert.equal(await pending, true);
  assert.equal(openedDetails.length, 1);
  assert.equal(openedDetails[0][0], 'CUST-42');
  assert.equal(openedDetails[0][1], fullCase);
  assert.equal(openedDetails[0][2], lead);
  assert.equal(openedComposers.length, 1);
  assert.equal(openedComposers[0], undefined, 'reuse the ordinary case composer without a new save mode');
  assert.equal(context.quotationCasePicker.open, false);
  assert.equal(requests.length, 0, 'launching must not send a save or other API mutation');
});

test('cancelled or previous-scope case selection cannot open a composer', async () => {
  for (const invalidate of [
    context => context.closeQuotationCasePicker(),
    context => { context.crmScopeVersion += 1; },
    context => { context.scopeKey = 'USER-2:sales'; },
  ]) {
    const { context, detailRequests, openedDetails, openedComposers, toasts } = createHarness();
    context.quotationCasePicker.rows = [{ caseId: 'CASE-42', customerId: 'CUST-42' }];
    const pending = context.selectQuotationCaseForNewQuote('CASE-42', 'CUST-42');
    invalidate(context);
    detailRequests[0].resolve({ Cust_ID: 'CUST-42', 'ไทม์ไลน์สถานะ': [{ logId: 'CASE-42' }] });
    await pending;
    assert.equal(openedDetails.length, 0);
    assert.equal(openedComposers.length, 0);
    assert.equal(toasts.length, 0);
  }
});

test('missing full case and failed detail request recover without opening or saving', async () => {
  for (const rejectRequest of [false, true]) {
    const { context, detailRequests, requests, openedDetails, openedComposers } = createHarness();
    context.quotationCasePicker.rows = [{ caseId: 'CASE-42', customerId: 'CUST-42' }];
    const pending = context.selectQuotationCaseForNewQuote('CASE-42', 'CUST-42');
    if (rejectRequest) detailRequests[0].reject(new Error('detail unavailable'));
    else detailRequests[0].resolve({ Cust_ID: 'CUST-42', 'ไทม์ไลน์สถานะ': [{ logId: 'CASE-OTHER' }] });
    await pending;
    assert.equal(context.quotationCasePicker.open, true);
    assert.equal(context.quotationCasePicker.selecting, false);
    assert.ok(context.quotationCasePicker.error, 'error should stay visible for retry');
    assert.equal(openedDetails.length, 0);
    assert.equal(openedComposers.length, 0);
    assert.equal(requests.length, 0);
  }
});

test('failed case-page load clears loading and can be retried', async () => {
  const { context, requests } = createHarness();
  const first = context.loadQuotationCasePickerPage(1);
  requests[0].reject(new Error('list unavailable'));
  await first;
  assert.equal(context.quotationCasePicker.loading, false);
  assert.ok(context.quotationCasePicker.error);
  const retry = context.loadQuotationCasePickerPage(1);
  const rows = [{ caseId: 'CASE-RECOVERED', customerId: 'CUST-RECOVERED' }];
  requests[1].resolve(casePage(rows));
  await retry;
  assert.equal(context.quotationCasePicker.error, '');
  assert.equal(context.quotationCasePicker.loading, false);
  assert.deepEqual([...context.quotationCasePicker.rows], rows);
});

test('search is debounced and invalidates the previous request immediately', async () => {
  const harness = createHarness();
  const { context, element, requests, timers } = harness;
  const oldRequest = context.loadQuotationCasePickerPage(3);
  element('quotationCaseSearchInput').value = '  ลูกค้าใหม่  ';
  context.handleQuotationCaseSearchInput();
  assert.equal(context.quotationCasePicker.search, 'ลูกค้าใหม่');
  assert.equal(context.quotationCasePicker.page, 1);
  assert.equal(timers.size, 1);
  assert.equal(requests.length, 1, 'typing must wait for debounce before fetching');
  requests[0].resolve(casePage([{ caseId: 'CASE-OLD', customerId: 'CUST-OLD' }], 3, 30, 3));
  await oldRequest;
  assert.equal(context.quotationCasePicker.rows.length, 0, 'old results must not appear during debounce');
  element('quotationCaseSearchInput').value = '  CASE-FINAL  ';
  context.handleQuotationCaseSearchInput();
  assert.equal(timers.size, 1, 'only the latest search timer may remain');
  harness.runTimers();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url.searchParams.get('search'), 'CASE-FINAL');
  assert.equal(requests[1].url.searchParams.get('page'), '1');
  const rows = [{ caseId: 'CASE-FINAL', customerId: 'CUST-FINAL' }];
  requests[1].resolve(casePage(rows));
  await flushAsyncHandlers();
  assert.deepEqual([...context.quotationCasePicker.rows], rows);
});

test('closing cancels a pending search timer and restores the trigger focus', () => {
  const harness = createHarness();
  const { context, element, requests, timers } = harness;
  const trigger = element('createNewQuotationButton');
  context.quotationCasePickerReturnFocus = trigger;
  element('quotationCaseSearchInput').value = 'ลูกค้า';
  context.handleQuotationCaseSearchInput();
  assert.equal(timers.size, 1);
  context.closeQuotationCasePicker();
  assert.equal(timers.size, 0);
  harness.runTimers();
  assert.equal(requests.length, 0);
  assert.equal(trigger.focused, true);
  assert.equal(element('quotationCasePickerModal').getAttribute('aria-hidden'), 'true');
});

test('a stale selection from a previous picker session cannot disrupt the next selection', async () => {
  const { context, requests, detailRequests, openedDetails, openedComposers } = createHarness();
  context.quotationCasePicker.rows = [{ caseId: 'CASE-OLD', customerId: 'CUST-OLD' }];
  const oldSelection = context.selectQuotationCaseForNewQuote('CASE-OLD', 'CUST-OLD');
  context.closeQuotationCasePicker();
  context.openQuotationCasePicker();
  requests[0].resolve(casePage([{ caseId: 'CASE-NEW', customerId: 'CUST-NEW' }]));
  await flushAsyncHandlers();
  const newSelection = context.selectQuotationCaseForNewQuote('CASE-NEW', 'CUST-NEW');
  assert.equal(detailRequests.length, 2);
  detailRequests[0].reject(new Error('old session detail failure'));
  await oldSelection;
  assert.equal(context.quotationCasePicker.selecting, true);
  assert.equal(context.quotationCasePicker.error, '');
  assert.equal(openedDetails.length, 0);
  detailRequests[1].resolve({ Cust_ID: 'CUST-NEW', 'ไทม์ไลน์สถานะ': [{ logId: 'CASE-NEW', company: 'GFS' }] });
  assert.equal(await newSelection, true);
  assert.equal(openedDetails.length, 1);
  assert.equal(openedDetails[0][0], 'CUST-NEW');
  assert.equal(openedComposers.length, 1);
});

test('selection rejects unknown case/customer pairs and ignores duplicate clicks while busy', async () => {
  const { context, detailRequests, openedComposers } = createHarness();
  context.quotationCasePicker.rows = [{ caseId: 'CASE-42', customerId: 'CUST-42' }];
  assert.equal(await context.selectQuotationCaseForNewQuote('CASE-42', 'CUST-OTHER'), false);
  assert.equal(detailRequests.length, 0);
  const selection = context.selectQuotationCaseForNewQuote('CASE-42', 'CUST-42');
  assert.equal(await context.selectQuotationCaseForNewQuote('CASE-42', 'CUST-42'), false);
  assert.equal(detailRequests.length, 1);
  detailRequests[0].resolve({ Cust_ID: 'CUST-42', 'ไทม์ไลน์สถานะ': [{ logId: 'CASE-42' }] });
  assert.equal(await selection, true);
  assert.equal(openedComposers.length, 1);
});

test('pagination blocks invalid or busy page changes', async () => {
  const { context, requests } = createHarness();
  context.quotationCasePicker.totalPages = 3;
  for (const page of [0, 4, 1.5, '2', NaN]) context.goToQuotationCasePickerPage(page);
  assert.equal(requests.length, 0);
  context.quotationCasePicker.loading = true;
  context.goToQuotationCasePickerPage(2);
  assert.equal(requests.length, 0);
  context.quotationCasePicker.loading = false;
  context.goToQuotationCasePickerPage(2);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.searchParams.get('page'), '2');
  requests[0].resolve(casePage([], 2, 25, 3));
  await flushAsyncHandlers();
});

test('picker renders escaped case labels, both company badges, and a visible error', () => {
  const { context, element, renderPicker } = createHarness();
  context.quotationCasePicker.rows = [
    { caseId: 'CASE-1', customerId: 'CUST-1', customerName: '<img onerror="bad()">', company: 'GFS', topic: '<script>bad()</script>' },
    { caseId: 'CASE-2', customerId: 'CUST-2', customerName: 'ลูกค้า MHL', company: 'MHL' },
  ];
  context.quotationCasePicker.total = 2;
  context.quotationCasePicker.error = 'ลองโหลดใหม่';
  renderPicker();
  const html = element('quotationCasePickerList').innerHTML;
  assert.match(html, />GFS<\/span>/);
  assert.match(html, />MHL<\/span>/);
  assert.match(html, /&lt;img onerror=&quot;bad\(\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img|<script/);
  assert.equal(element('quotationCasePickerError').textContent, 'ลองโหลดใหม่');
  assert.equal(element('quotationCasePickerError').classList.contains('hidden'), false);
});

test('picker rows stay on one line with phone immediately after customer name', () => {
  const { context, element, renderPicker } = createHarness();
  context.quotationCasePicker.rows = [
    {
      caseId: 'CASE-SINGLE-GFS', customerId: 'CUST-GFS', company: 'GFS',
      customerName: 'ลูกค้า GFS', customerPhone: '081-111-1111', topic: 'ติดฟิล์มสำนักงาน', status: 'นัดวัดพื้นที่',
    },
    {
      caseId: 'CASE-SINGLE-MHL', customerId: 'CUST-MHL', company: 'MHL',
      customerName: 'ลูกค้า MHL', customerPhone: '082-222-2222', topic: 'ติดฟิล์มอาคาร', status: 'ต่อรองราคา',
    },
  ];
  renderPicker();
  const rows = element('quotationCasePickerList').innerHTML.match(/<button\b[^>]*data-quotation-case-id=[\s\S]*?<\/button>/g);
  assert.equal(rows?.length, 2);
  for (const [index, row] of rows.entries()) {
    const item = context.quotationCasePicker.rows[index];
    const fields = [
      `>${item.company}</span>`,
      `>${item.customerName}</span>`,
      `>${item.customerPhone}</span>`,
      `>${item.caseId}</span>`,
      `>${item.topic}</span>`,
      `>${item.status}</span>`,
      'เลือกเคส',
    ];
    let previousPosition = -1;
    for (const field of fields) {
      const position = row.indexOf(field);
      assert.ok(position > previousPosition, `${field} must follow the previous field`);
      previousPosition = position;
    }
    assert.match(row, /\bmin-w-max\b/);
    assert.match(row, /\bwhitespace-nowrap\b/);
    assert.match(row, /data-quotation-case-field="customer-name"[^>]*>[^<]*<\/span>\s*<span data-quotation-case-field="customer-phone"/);
    assert.doesNotMatch(row, /<br\b|<div\b|\bflex-wrap\b|\bbreak-words\b|\bwhitespace-normal\b|\bflex-col\b|class="[^"]*\bblock\b/);
    assert.match(row, new RegExp(`title="${item.topic}"`), 'truncated topic should retain its complete title');
    assert.match(row, /class="[^"]*\btruncate\b/);
  }
  const panelTag = crmIndexHtml.match(/<section\b[^>]*id="quotationCasePickerPanel"[^>]*>/)?.[0] || '';
  const listTag = crmIndexHtml.match(/<div\b[^>]*id="quotationCasePickerList"[^>]*>/)?.[0] || '';
  assert.match(panelTag, /\bmax-w-5xl\b/);
  assert.match(listTag, /\boverflow-(?:x-)?auto\b/, 'the list must permit horizontal scrolling on narrow screens');
});

test('picker escapes phone text and displays a dash when no phone is available', () => {
  const { context, element, renderPicker } = createHarness();
  context.quotationCasePicker.rows = [
    {
      caseId: 'CASE-PHONE-ESCAPED', customerId: 'CUST-PHONE-ESCAPED', company: 'GFS',
      customerName: 'ลูกค้าทดสอบ', customerPhone: '08<&"\'1>', topic: 'หัวข้อ',
    },
    {
      caseId: 'CASE-PHONE-MISSING', customerId: 'CUST-PHONE-MISSING', company: 'MHL',
      customerName: 'ลูกค้าไม่มีเบอร์', customerPhone: '', topic: 'หัวข้อ',
    },
  ];
  renderPicker();
  const rows = element('quotationCasePickerList').innerHTML.match(/<button\b[^>]*data-quotation-case-id=[\s\S]*?<\/button>/g);
  assert.equal(rows?.length, 2);
  assert.match(rows[0], />08&lt;&amp;&quot;&#39;1&gt;<\/span>/);
  assert.doesNotMatch(rows[0], /08<&/);
  const namePosition = rows[1].indexOf('>ลูกค้าไม่มีเบอร์</span>');
  const phonePosition = rows[1].indexOf('>-</span>', namePosition);
  const casePosition = rows[1].indexOf('>CASE-PHONE-MISSING</span>');
  assert.ok(namePosition >= 0 && phonePosition > namePosition && casePosition > phonePosition);
});

test('picker status badges display current item status rather than follow-up or snapshot status', () => {
  const { context, element, renderPicker } = createHarness();
  context.quotationCasePicker.rows = [
    {
      caseId: 'CASE-STATUS-GFS', customerId: 'CUST-STATUS-GFS', company: 'GFS',
      customerName: 'ลูกค้า GFS', customerPhone: '0811111111', topic: 'หัวข้อ GFS',
      status: '  นัดวัดพื้นที่  ', latestFollowUpStatus: 'ปิดงาน',
      quotationSnapshot: { status: 'ส่งใบเสนอราคา' }, history: { status: 'ยกเลิก' },
    },
    {
      caseId: 'CASE-STATUS-MHL', customerId: 'CUST-STATUS-MHL', company: 'MHL',
      customerName: 'ลูกค้า MHL', customerPhone: '0822222222', topic: 'หัวข้อ MHL',
      status: 'ต่อรองราคา', latestFollowUpStatus: 'ปิดงาน',
      quotationSnapshot: { status: 'ส่งใบเสนอราคา' }, history: { status: 'ยกเลิก' },
    },
  ];
  renderPicker();
  const rows = element('quotationCasePickerList').innerHTML.match(/<button\b[^>]*data-quotation-case-id=[\s\S]*?<\/button>/g);
  assert.equal(rows?.length, 2);
  for (const [index, row] of rows.entries()) {
    const badge = row.match(/<span\b[^>]*data-quotation-case-field="status"[^>]*>[\s\S]*?<\/span>/)?.[0] || '';
    assert.match(badge, new RegExp(`>${context.quotationCasePicker.rows[index].status.trim()}</span>`));
    assert.match(badge, /aria-label="สถานะปัจจุบัน[^\"]*"/);
    assert.doesNotMatch(badge, /ปิดงาน|ส่งใบเสนอราคา|ยกเลิก/);
    assert.ok(row.indexOf('data-quotation-case-field="status"') > row.indexOf('data-quotation-case-field="topic"'));
    assert.ok(row.indexOf('data-quotation-case-field="status"') < row.indexOf('เลือกเคส'));
  }
});

test('picker escapes hostile current status in visible and accessible labels', () => {
  const { context, element, renderPicker } = createHarness();
  context.quotationCasePicker.rows = [{
    caseId: 'CASE-STATUS-ESCAPED', customerId: 'CUST-STATUS-ESCAPED', company: 'GFS',
    customerName: 'ลูกค้าทดสอบ', status: '<img src=x onerror="bad()"> & \'',
  }];
  renderPicker();
  const html = element('quotationCasePickerList').innerHTML;
  const badge = html.match(/<span\b[^>]*data-quotation-case-field="status"[^>]*>[\s\S]*?<\/span>/)?.[0] || '';
  assert.match(badge, />&lt;img src=x onerror=&quot;bad\(\)&quot;&gt; &amp; &#39;<\/span>/);
  assert.match(badge, /aria-label="สถานะปัจจุบัน[^\"]*&lt;img src=x onerror=&quot;bad\(\)&quot;&gt; &amp; &#39;"/);
  assert.doesNotMatch(badge, /<img\b|onerror="bad\(\)"/);
});

test('missing or blank picker status is explicitly unspecified, never inferred from history', () => {
  for (const status of [undefined, null, '', '   ']) {
    const { context, element, renderPicker } = createHarness();
    context.quotationCasePicker.rows = [{
      caseId: 'CASE-STATUS-MISSING', customerId: 'CUST-STATUS-MISSING', company: 'MHL',
      customerName: 'ลูกค้าไม่มีสถานะ', status, latestFollowUpStatus: 'ปิดงาน',
      quotationSnapshot: { status: 'ส่งใบเสนอราคา' },
    }];
    renderPicker();
    const badge = element('quotationCasePickerList').innerHTML.match(/<span\b[^>]*data-quotation-case-field="status"[^>]*>[\s\S]*?<\/span>/)?.[0] || '';
    assert.match(badge, />ไม่ระบุสถานะ<\/span>/);
    assert.doesNotMatch(badge, /ปิดงาน|ส่งใบเสนอราคา/);
  }
});

test('picker status badges reuse actual known, alias, and neutral status colors', () => {
  const { context, element, renderPicker, requests } = createHarness();
  const statuses = [
    ['ส่งใบเสนอราคา', 'border-blue-200 bg-blue-50 text-blue-700'],
    ['ชำระเงินครบ', 'border-green-200 bg-green-50 text-green-700'],
    ['ติดตั้งเสร็จสิ้น', 'border-emerald-200 bg-emerald-50 text-emerald-700'],
    ['สถานะพิเศษ', 'border-slate-200 bg-slate-50 text-slate-700'],
  ];
  context.quotationCasePicker.rows = statuses.map(([status], index) => ({
    caseId: `CASE-STATUS-TONE-${index}`, customerId: `CUST-STATUS-TONE-${index}`,
    company: index % 2 ? 'MHL' : 'GFS', customerName: `ลูกค้า ${index}`, status,
  }));
  renderPicker();
  const rows = element('quotationCasePickerList').innerHTML.match(/<button\b[^>]*data-quotation-case-id=[\s\S]*?<\/button>/g);
  assert.equal(rows?.length, statuses.length);
  for (const [index, row] of rows.entries()) {
    const badge = row.match(/<span\b[^>]*data-quotation-case-field="status"[^>]*>[\s\S]*?<\/span>/)?.[0] || '';
    assert.ok(badge.includes(statuses[index][1]), 'badge colors should use the existing real status helper');
    assert.ok(badge.includes(`>${statuses[index][0]}</span>`), 'displayed current status must not be changed by style aliases');
  }
  assert.equal(requests.length, 0, 'rendering status must not introduce a new API request');
});

test('picker appends existing saved quotation numbers after current status with trimming and deduplication', () => {
  const { context, element, renderPicker, requests } = createHarness();
  context.quotationCasePicker.rows = [
    {
      caseId: 'CASE-QUOTES-GFS', customerId: 'CUST-QUOTES-GFS', company: 'GFS',
      customerName: 'ลูกค้า GFS', customerPhone: '0811111111', topic: 'หัวข้อ GFS', status: 'ประเมินราคา',
      quotationNumbers: ['  GFS-Q-002  ', 'GFS-Q-001', 'GFS-Q-002', '', ' ', null, ' GFS-Q-001 '],
    },
    {
      caseId: 'CASE-QUOTES-MHL', customerId: 'CUST-QUOTES-MHL', company: 'MHL',
      customerName: 'ลูกค้า MHL', customerPhone: '0822222222', topic: 'หัวข้อ MHL', status: 'ปิดงาน',
      quotationNumbers: [' MHL-Q-001 '],
    },
  ];
  renderPicker();
  const rows = element('quotationCasePickerList').innerHTML.match(/<button\b[^>]*data-quotation-case-id=[\s\S]*?<\/button>/g);
  assert.equal(rows?.length, 2);
  const expectedNumbers = ['GFS-Q-002, GFS-Q-001', 'MHL-Q-001'];
  for (const [index, row] of rows.entries()) {
    const span = row.match(/<span\b[^>]*data-quotation-case-field="quotation-numbers"[^>]*>[\s\S]*?<\/span>/)?.[0] || '';
    assert.ok(span.includes(`>${expectedNumbers[index]}</span>`));
    const visibleText = span.match(/>([\s\S]*?)<\/span>/)?.[1] || '';
    assert.doesNotMatch(visibleText, /ใบเสนอราคา:/, 'visible quotation field should contain codes only');
    assert.ok(row.indexOf('data-quotation-case-field="quotation-numbers"') > row.indexOf('data-quotation-case-field="status"'));
    assert.ok(row.indexOf('data-quotation-case-field="quotation-numbers"') < row.indexOf('เลือกเคส'));
    assert.match(row, /\bwhitespace-nowrap\b/);
    assert.doesNotMatch(row, /<br\b|\bflex-wrap\b|\bbreak-words\b/);
  }
  assert.equal(requests.length, 0, 'existing quotation numbers must not require another API request');
});

test('picker does not invent quotation numbers from status, quotation count, or snapshot', () => {
  for (const quotationNumbers of [undefined, null, [], ['', ' ', null], 'NOT-AN-ARRAY']) {
    const { context, element, renderPicker } = createHarness();
    context.quotationCasePicker.rows = [{
      caseId: 'CASE-NO-QUOTES', customerId: 'CUST-NO-QUOTES', company: 'MHL',
      customerName: 'ลูกค้ายังไม่มีใบเสนอราคา', status: 'ส่งใบเสนอราคา', quotationCount: 7,
      quotationNumbers, quotationSnapshot: { quoteNumber: 'SNAPSHOT-NOT-A-SAVED-LIST-NUMBER' },
    }];
    renderPicker();
    const html = element('quotationCasePickerList').innerHTML;
    assert.doesNotMatch(html, /data-quotation-case-field="quotation-numbers"/);
    assert.doesNotMatch(html, /SNAPSHOT-NOT-A-SAVED-LIST-NUMBER|NOT-AN-ARRAY/);
    assert.match(html, />ส่งใบเสนอราคา<\/span>/, 'current status should remain independently visible');
  }
});

test('picker escapes saved quotation numbers in visible, title, and accessible labels', () => {
  const { context, element, renderPicker } = createHarness();
  context.quotationCasePicker.rows = [{
    caseId: 'CASE-QUOTE-ESCAPED', customerId: 'CUST-QUOTE-ESCAPED', company: 'GFS',
    customerName: 'ลูกค้าทดสอบ', status: 'นัดวัดพื้นที่',
    quotationNumbers: ['Q-<img onerror="bad()"> & \''],
  }];
  renderPicker();
  const span = element('quotationCasePickerList').innerHTML.match(/<span\b[^>]*data-quotation-case-field="quotation-numbers"[^>]*>[\s\S]*?<\/span>/)?.[0] || '';
  const escaped = 'Q-&lt;img onerror=&quot;bad()&quot;&gt; &amp; &#39;';
  assert.ok(span.includes(`>${escaped}</span>`));
  const visibleText = span.match(/>([\s\S]*?)<\/span>/)?.[1] || '';
  assert.doesNotMatch(visibleText, /ใบเสนอราคา:/, 'escaped visible quotation field should contain codes only');
  assert.ok(span.includes(`title="ใบเสนอราคาที่เคยบันทึก: ${escaped}"`));
  assert.ok(span.includes(`aria-label="ใบเสนอราคาที่เคยบันทึก: ${escaped}"`));
  assert.doesNotMatch(span, /<img\b|onerror="bad\(\)"/);
});

test('keyboard focus loops inside the picker and reenters from outside its panel', () => {
  const { context, element } = createHarness();
  const panel = element('quotationCasePickerPanel');
  const first = element('pickerCloseButton');
  const middle = element('quotationCaseSearchInput');
  const last = element('pickerCancelButton');
  const outside = element('createNewQuotationButton');
  const focusable = [first, middle, last];
  panel.querySelectorAll = selector => {
    assert.equal(selector, 'button:not([disabled]), input:not([disabled])');
    return focusable;
  };
  panel.contains = candidate => focusable.includes(candidate);
  function pressKey(activeElement, shiftKey = false, key = 'Tab') {
    focusable.forEach(candidate => { candidate.focused = false; });
    context.document.activeElement = activeElement;
    let prevented = false;
    context.handleQuotationCasePickerKeydown({
      key, shiftKey, preventDefault() { prevented = true; },
    });
    return prevented;
  }
  assert.equal(pressKey(last), true);
  assert.equal(first.focused, true, 'Tab at the last control should wrap to the first');
  assert.equal(pressKey(first, true), true);
  assert.equal(last.focused, true, 'Shift+Tab at the first control should wrap to the last');
  assert.equal(pressKey(middle), false, 'ordinary Tab inside the panel should use browser navigation');
  assert.equal(focusable.some(candidate => candidate.focused), false);
  assert.equal(pressKey(outside), true);
  assert.equal(first.focused, true, 'focus outside the panel should reenter at the first control');
  assert.equal(pressKey(outside, true), true);
  assert.equal(first.focused, true);
  assert.equal(pressKey(last, false, 'ArrowDown'), false);
  assert.equal(focusable.some(candidate => candidate.focused), false);
  context.quotationCasePicker.open = false;
  assert.equal(pressKey(last), false, 'a closed picker must not trap keyboard focus');
});

test('new GFS and MHL quotation composers omit Print and use a two-button footer', () => {
  for (const company of ['GFS', 'MHL']) {
    for (const historyId of [undefined, '', '   ']) {
      const harness = createQuotationComposerHarness(company, { historyId });
      assert.equal(harness.element('printCaseQuotationButton'), null);
      assert.doesNotMatch(harness.html(), /id="printCaseQuotationButton"/);
      const footer = harness.html().match(/<div class="([^"]*)">\s*<button id="cancelCaseQuotationButton"/)?.[1] || '';
      assert.match(footer, /\bsm:grid-cols-2\b/);
      assert.ok(harness.element('saveCaseQuotationButton'));
    }
  }
});

test('saved GFS and MHL history quotation composers keep Print available', () => {
  for (const company of ['GFS', 'MHL']) {
    const harness = createQuotationComposerHarness(company, { historyId: 'HISTORY-EXISTING', originalQuoteNumber: 'OLD-Q-1' });
    assert.ok(harness.element('printCaseQuotationButton'));
    assert.match(harness.html(), /บันทึกการแก้ไข/);
  }
});

test('unsaved quotation preview is guarded even when passed an unrelated saved argument', async () => {
  for (const company of ['GFS', 'MHL']) {
    const harness = createQuotationComposerHarness(company);
    const { context, hydrationCalls, previewDocuments } = harness;
    await context.openCaseQuotationPrintPreview(quotationDraft(company, { historyId: 'FAKE-SAVED-HISTORY' }));
    assert.equal(hydrationCalls.length, 0);
    assert.equal(previewDocuments.length, 0);
    assert.equal(harness.element('caseQuotationPreviewModal').classList.contains('hidden'), true);
    assert.equal(context.caseQuotationDraft.historyId, undefined);
    assert.ok(harness.toasts.length);
  }
});

test('saved quotation preview opens only for the current case and history identity', async () => {
  const harness = createQuotationComposerHarness('MHL', { historyId: 'HISTORY-EXISTING' });
  const { context, previewDocuments } = harness;
  await context.openCaseQuotationPrintPreview(quotationDraft('MHL', { historyId: 'HISTORY-OTHER' }));
  await context.openCaseQuotationPrintPreview(quotationDraft('MHL', { historyId: 'HISTORY-EXISTING', caseId: 'CASE-OTHER' }));
  assert.equal(previewDocuments.length, 0);
  await context.openCaseQuotationPrintPreview(structuredClone(context.caseQuotationDraft));
  assert.equal(previewDocuments.length, 1);
  assert.equal(harness.element('caseQuotationPreviewModal').classList.contains('hidden'), false);
});

test('quotation validation errors never unlock Print or submit a save request', async () => {
  for (const invalid of [
    { quoteNumber: '' }, { customerName: '' }, { customerId: '' },
    { items: [] }, { items: [{ description: '', quantity: 1 }] },
    { items: [{ description: 'ติดฟิล์ม', quantity: 0 }] },
  ]) {
    const harness = createQuotationComposerHarness('GFS', invalid);
    await harness.save();
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.element('printCaseQuotationButton'), null);
    assert.equal(harness.context.caseQuotationDraft.historyId, undefined);
    assert.ok(harness.toasts.length);
  }
});

test('network and rejected quotation save responses keep new Print hidden', async () => {
  const failures = [
    request => request.reject(new Error('network unavailable')),
    request => request.resolve({ response: { ok: false }, result: { success: true, followUp: { id: 'HISTORY-1', caseId: 'CASE-QUOTE-1' } } }),
    request => request.resolve({ response: { ok: true }, result: { success: false, error: 'save rejected' } }),
    request => request.resolve({ response: { ok: true }, result: { success: true, followUp: { id: 'HISTORY-1', caseId: 'CASE-WRONG' } } }),
    request => request.resolve({ response: { ok: true }, result: { success: true, followUp: { caseId: 'CASE-QUOTE-1' } } }),
    request => request.resolve({ response: { ok: true }, result: { success: true, followUp: { id: '  ', caseId: 'CASE-QUOTE-1' } } }),
  ];
  for (const rejectSave of failures) {
    const harness = createQuotationComposerHarness('MHL');
    const pending = harness.save();
    await flushAsyncHandlers();
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].body.action, 'createLeadFollowUp');
    assert.equal(harness.element('printCaseQuotationButton'), null, 'Print must stay hidden while save is pending');
    rejectSave(harness.requests[0]);
    await pending;
    assert.equal(harness.element('printCaseQuotationButton'), null);
    assert.equal(harness.context.caseQuotationDraft.historyId, undefined);
    assert.equal(harness.element('saveCaseQuotationButton').disabled, false);
    assert.ok(harness.toasts.length);
  }
});

test('successful new save unlocks Print and subsequent save uses the update workflow', async () => {
  for (const company of ['GFS', 'MHL']) {
    const harness = createQuotationComposerHarness(company);
    const pending = harness.save();
    await flushAsyncHandlers();
    assert.equal(harness.element('printCaseQuotationButton'), null);
    harness.requests[0].resolve(harness.savedResponse());
    await pending;
    assert.equal(harness.context.caseQuotationDraft.historyId, 'HISTORY-QUOTE-1');
    assert.equal(harness.context.caseQuotationDraft.originalQuoteNumber, `${company}-Q-001`);
    assert.ok(harness.element('printCaseQuotationButton'));
    assert.match(harness.html(), /บันทึกการแก้ไข/);
    const update = harness.save();
    await flushAsyncHandlers();
    assert.equal(harness.requests[1].body.action, 'updateQuotationHistory');
    assert.equal(harness.requests[1].body.historyId, 'HISTORY-QUOTE-1');
    harness.requests[1].resolve(harness.savedResponse());
    await update;
    assert.ok(harness.element('printCaseQuotationButton'));
  }
});

test('successful save retains saved identity and Print even when later cache or view refresh fails', async () => {
  for (const failingRefresh of ['updateCachedCaseQuotationNumbers', 'clearLeadCaches', 'renderCaseDetailView']) {
    const harness = createQuotationComposerHarness('GFS');
    harness.context[failingRefresh] = () => { throw new Error(`${failingRefresh} unavailable`); };
    const pending = harness.save();
    await flushAsyncHandlers();
    harness.requests[0].resolve(harness.savedResponse());
    await pending;
    assert.equal(harness.context.caseQuotationDraft.historyId, 'HISTORY-QUOTE-1');
    assert.ok(harness.element('printCaseQuotationButton'));
    assert.match(harness.html(), /บันทึกการแก้ไข/);
    assert.equal(harness.successToasts.length, 1);
  }
});

test('failed edits retain Print for an already saved quotation', async () => {
  const harness = createQuotationComposerHarness('MHL', { historyId: 'HISTORY-EXISTING' });
  const pending = harness.save();
  await flushAsyncHandlers();
  assert.equal(harness.requests[0].body.action, 'updateQuotationHistory');
  harness.requests[0].reject(new Error('edit unavailable'));
  await pending;
  assert.equal(harness.context.caseQuotationDraft.historyId, 'HISTORY-EXISTING');
  assert.ok(harness.element('printCaseQuotationButton'));
});

test('saved legacy quotations without a snapshot remain printable', async () => {
  const harness = createQuotationComposerHarness('GFS');
  const { context } = harness;
  context.openQuotationHistoryDrawer({ id: 'HISTORY-LEGACY', quotationNumbers: ['LEGACY-Q-1'] }, 'LEGACY-Q-1');
  assert.equal(context.caseQuotationDraft.historyId, 'HISTORY-LEGACY');
  assert.ok(harness.element('printCaseQuotationButton'));
  await context.openCaseQuotationPrintPreview(structuredClone(context.caseQuotationDraft));
  assert.equal(harness.previewDocuments.length, 1);
});

test('late save success cannot unlock or replace a newer or closed composer', async () => {
  for (const closeComposer of [false, true]) {
    const harness = createQuotationComposerHarness('GFS');
    const pending = harness.save();
    await flushAsyncHandlers();
    harness.context.caseQuotationComposerVersion += 1;
    const newDraft = closeComposer ? null : quotationDraft('MHL', { caseId: 'CASE-NEW', quoteNumber: 'MHL-Q-NEW' });
    harness.context.caseQuotationDraft = newDraft;
    if (!closeComposer) harness.context.renderCaseQuotationComposer();
    harness.requests[0].resolve(harness.savedResponse());
    await pending;
    assert.equal(harness.context.caseQuotationDraft, newDraft);
    if (!closeComposer) assert.equal(harness.element('printCaseQuotationButton'), null);
  }
});

test('pending saved preview cannot reopen or overwrite a newer or closed composer', async () => {
  for (const hydrationStage of ['hydrateQuotationSalespersonContact', 'hydrateQuotationImagePreviews']) {
    for (const closeComposer of [false, true]) {
      const harness = createQuotationComposerHarness('GFS', { historyId: 'HISTORY-EXISTING' });
      const hydrated = deferred();
      const savedData = structuredClone(harness.context.caseQuotationDraft);
      harness.context[hydrationStage] = () => hydrated.promise;
      const pendingPreview = harness.context.openCaseQuotationPrintPreview(savedData);
      await flushAsyncHandlers();
      harness.context.caseQuotationComposerVersion += 1;
      const newDraft = closeComposer ? null : quotationDraft('MHL', { caseId: 'CASE-NEW', quoteNumber: 'MHL-Q-NEW' });
      harness.context.caseQuotationDraft = newDraft;
      if (!closeComposer) harness.context.renderCaseQuotationComposer();
      hydrated.resolve(savedData);
      await pendingPreview;
      assert.equal(harness.context.caseQuotationDraft, newDraft);
      assert.equal(harness.context.caseQuotationPreviewData, null);
      assert.equal(harness.previewDocuments.length, 0);
      assert.equal(harness.element('caseQuotationPreviewModal').classList.contains('hidden'), true);
      if (!closeComposer) assert.equal(harness.element('printCaseQuotationButton'), null);
    }
  }
});

test('an older save hydrating contact details must not disable the newer composer Save', async () => {
  const harness = createQuotationComposerHarness('GFS');
  const hydrated = deferred();
  const oldData = structuredClone(harness.context.caseQuotationDraft);
  harness.context.hydrateQuotationSalespersonContact = () => hydrated.promise;
  const pending = harness.save();
  harness.context.caseQuotationComposerVersion += 1;
  const newDraft = quotationDraft('MHL', { caseId: 'CASE-NEW', quoteNumber: 'MHL-Q-NEW' });
  harness.context.caseQuotationDraft = newDraft;
  harness.context.renderCaseQuotationComposer();
  hydrated.resolve(oldData);
  await flushAsyncHandlers();
  const newerSaveDisabledDuringOldRequest = harness.element('saveCaseQuotationButton').disabled;
  if (harness.requests.length) harness.requests[0].resolve(harness.savedResponse());
  await pending;
  assert.equal(newerSaveDisabledDuringOldRequest, false, 'new composer must remain editable during the older save');
  assert.equal(harness.context.caseQuotationDraft, newDraft);
  assert.equal(harness.element('saveCaseQuotationButton').disabled, false);
  assert.equal(harness.element('printCaseQuotationButton'), null);
});

test('clearing CRM scope and opening or closing a composer invalidate its generation', () => {
  const clearSource = quotationFunctionBlock('function clearCrmScopedData()', 'function clearCrmAccessState()');
  const showSource = quotationFunctionBlock('function showCaseQuotationDrawer(company, caseId, titleText)', 'function closeCaseQuotationDrawer(immediate = false)');
  const closeSource = quotationFunctionBlock('function closeCaseQuotationDrawer(immediate = false)', "function quotationPrintText(value, fallback = '-')");
  assert.match(clearSource, /caseQuotationComposerVersion \+= 1;\s*caseQuotationDraft = null;/);
  assert.match(showSource, /caseQuotationComposerVersion \+= 1;/);
  assert.ok(showSource.indexOf('caseQuotationComposerVersion += 1;') < showSource.indexOf('renderCaseQuotationComposer();'));
  assert.match(closeSource, /caseQuotationComposerVersion \+= 1;/);
  assert.ok(closeSource.indexOf('caseQuotationComposerVersion += 1;') < closeSource.indexOf('caseQuotationDraft = null;'));
});

test('successful new quotation launched from lead follow-up still closes both drawers', async () => {
  for (const company of ['GFS', 'MHL']) {
    const harness = createQuotationComposerHarness(company, { launchSource: 'lead-follow-up' });
    const pending = harness.save();
    await flushAsyncHandlers();
    assert.equal(harness.requests[0].body.action, 'createLeadFollowUp');
    harness.requests[0].resolve(harness.savedResponse());
    await pending;
    assert.deepEqual(harness.closures, { quotation: 1, leadFollowUp: 1 });
    assert.equal(harness.context.caseQuotationDraft, null);
    assert.equal(harness.successToasts.length, 1);
  }
});

test('stale lead follow-up quotation success cannot close a newer composer', async () => {
  const harness = createQuotationComposerHarness('GFS', { launchSource: 'lead-follow-up' });
  const pending = harness.save();
  await flushAsyncHandlers();
  harness.context.caseQuotationComposerVersion += 1;
  const newDraft = quotationDraft('MHL', { caseId: 'CASE-NEW', quoteNumber: 'MHL-Q-NEW' });
  harness.context.caseQuotationDraft = newDraft;
  harness.context.renderCaseQuotationComposer();
  harness.requests[0].resolve(harness.savedResponse());
  await pending;
  assert.deepEqual(harness.closures, { quotation: 0, leadFollowUp: 0 });
  assert.equal(harness.context.caseQuotationDraft, newDraft);
  assert.equal(harness.element('printCaseQuotationButton'), null);
});

test('quotation report removes readiness status while keeping thirteen aligned columns and totals', () => {
  const { table, document } = createQuotationReportHarness();
  assert.ok(table);
  const head = table.children.find(child => child.tagName === 'thead');
  const body = table.children.find(child => child.tagName === 'tbody');
  const foot = table.children.find(child => child.tagName === 'tfoot');
  const headers = head.children[0].children;
  assert.equal(headers.length, 13);
  assert.equal(headers.some(header => header.textContent === 'สถานะ'), false);
  assert.equal(headers.at(-1).textContent, 'จัดการ');
  assert.equal(body.children.length, 3);
  body.children.forEach(row => { assert.equal(row.children.length, headers.length); });
  const totalRow = foot.children[0];
  assert.equal(totalRow.children.reduce((sum, cell) => sum + cell.colSpan, 0), headers.length);
  assert.equal(totalRow.children.at(-1).colSpan, 1);
  assert.equal(totalRow.children[1].textContent, '3103.00');
  const widths = headers.reduce((sum, cell) => sum + Number.parseFloat(cell.style.width), 0);
  assert.ok(Math.abs(widths - 100) < 0.001, 'remaining report column widths should fill the table');
  function allText(node) {
    return `${node.textContent} ${node.innerHTML} ${node.children.map(allText).join(' ')}`;
  }
  assert.doesNotMatch(allText(table), /พร้อมดูและแก้ไข|ข้อมูลเอกสารแบบเก่า/);
  assert.equal(document.getElementById('quotationSentCount').textContent, '2', 'document-ready statistics must remain unchanged');
});

test('quotation report preserves saved view/edit/print and legacy open-case actions without status cells', () => {
  const { table, savedGfs, savedMhl, legacy, openedQuotations, openedCases } = createQuotationReportHarness();
  const rows = table.children.find(child => child.tagName === 'tbody').children;
  for (const row of rows.slice(0, 2)) {
    const button = row.children.at(-1).children[0];
    assert.match(button.innerHTML, /fa-file-pen/);
    assert.equal(button.attributes['aria-label'], 'ดู / แก้ไข / พิมพ์');
    button.listeners.get('click')();
  }
  assert.deepEqual(openedQuotations, [savedGfs, savedMhl]);
  const legacyButton = rows[2].children.at(-1).children[0];
  assert.match(legacyButton.innerHTML, /fa-folder-open/);
  assert.equal(legacyButton.attributes['aria-label'], 'เปิดเคส');
  legacyButton.listeners.get('click')();
  assert.equal(openedCases.length, 1);
  assert.equal(openedCases[0].caseId, legacy.caseId);
  assert.equal(openedCases[0].customerId, legacy.customerId);
  assert.equal(openedCases[0].date, legacy.followedAt);
});

test('quotation report actions are icon-only native buttons with decorative icons, accessible labels, and original handlers', () => {
  const { table, savedGfs, savedMhl, legacy, openedQuotations, openedCases } = createQuotationReportHarness();
  const rows = table.children.find(child => child.tagName === 'tbody').children;
  const expected = [
    { item: savedGfs, label: 'ดู / แก้ไข / พิมพ์', icon: 'fa-file-pen', color: 'bg-blue-600' },
    { item: savedMhl, label: 'ดู / แก้ไข / พิมพ์', icon: 'fa-file-pen', color: 'bg-orange-500' },
    { item: legacy, label: 'เปิดเคส', icon: 'fa-folder-open', color: 'bg-blue-600' },
  ];
  for (const [index, row] of rows.entries()) {
    const actionCell = row.children.at(-1);
    assert.equal(actionCell.children.length, 1, 'each report row must retain one action button rather than separate view/edit/print controls');
    const button = actionCell.children[0];
    assert.equal(button.tagName, 'button', 'native button semantics preserve keyboard activation');
    assert.equal(button.type, 'button');
    assert.equal(button.title, expected[index].label, 'hover tooltip must explain the icon action');
    assert.equal(button.attributes['aria-label'], expected[index].label, 'screen readers must receive the former action text');
    assert.equal(button.textContent, '');
    assert.equal(button.innerHTML.replace(/<[^>]*>/g, '').trim(), '', 'no action label should remain visibly rendered');
    assert.equal((button.innerHTML.match(/<i\b/g) || []).length, 1);
    assert.match(button.innerHTML, /<i\b[^>]*aria-hidden="true"[^>]*><\/i>/, 'the icon is decorative because the button already has an accessible name');
    assert.ok(button.innerHTML.includes(expected[index].icon));
    assert.doesNotMatch(button.innerHTML, /<span\b/);
    assert.match(button.className, /\bh-8\b.*\bw-8\b/);
    assert.doesNotMatch(button.className, /\bw-full\b/);
    assert.ok(button.className.includes(expected[index].color), 'company-specific action colors stay unchanged');
    assert.ok(button.className.includes('focus:ring-2'), 'icon-only controls retain a visible keyboard-focus indicator');
    assert.equal(button.listeners.size, 1);
    assert.equal(typeof button.listeners.get('click'), 'function');
    button.listeners.get('click')();
  }
  assert.deepEqual(openedQuotations, [savedGfs, savedMhl], 'saved GFS/MHL actions still open the same full quotation objects');
  assert.equal(openedCases.length, 1);
  assert.equal(openedCases[0].caseId, legacy.caseId);
  assert.equal(openedCases[0].customerId, legacy.customerId);
  assert.equal(openedCases[0].date, legacy.followedAt);
  assert.equal(openedCases[0].status, 'ส่งใบเสนอราคา', 'legacy icon actions keep their original open-case payload');
});

test('removing quotation report readiness status does not remove picker current case status', () => {
  const { context, element, renderPicker } = createHarness();
  context.quotationCasePicker.rows = [{
    caseId: 'CASE-PICKER-STATUS-KEPT', customerId: 'CUST-PICKER-STATUS-KEPT',
    company: 'MHL', customerName: 'ลูกค้า', customerPhone: '0811111111', status: 'ต่อรองราคา',
  }];
  renderPicker();
  const html = element('quotationCasePickerList').innerHTML;
  assert.match(html, /data-quotation-case-field="status"/);
  assert.match(html, />ต่อรองราคา<\/span>/);
});
