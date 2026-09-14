const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { announcementRecord, announcementWritePayload, getAnnouncements, setAnnouncementPinned } = require('./server');
const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');

function pinClient(result = { data: { id: 'post-1', is_pinned: true }, error: null }) {
  const calls = [];
  const query = {
    update(payload) { calls.push(['update', payload]); return this; },
    eq(column, value) { calls.push(['eq', column, value]); return this; },
    select(columns) { calls.push(['select', columns]); return this; },
    async maybeSingle() { return result; },
  };
  return { calls, from(table) { calls.push(['from', table]); return query; } };
}

test('announcement pin state is explicit and omitted legacy edits preserve the existing pin', () => {
  assert.equal(announcementRecord({}).isPinned, false);
  assert.equal(announcementRecord({ is_pinned: true }).isPinned, true);
  assert.equal(announcementWritePayload({ title: 'Post', isPinned: true }, 'manager').is_pinned, true);
  assert.equal(announcementWritePayload({ title: 'Post', isPinned: false }, 'manager').is_pinned, false);
  assert.equal(Object.hasOwn(announcementWritePayload({ title: 'Post' }, 'manager'), 'is_pinned'), false);
  assert.throws(() => announcementWritePayload({ title: 'Post', isPinned: 'yes' }, 'manager'),
    error => error.code === 'INVALID_ANNOUNCEMENT_PINNED');
});

test('only admin/manager may change pins; no database call is made for other roles', async () => {
  for (const role of ['sales', 'member', '', undefined]) {
    const client = pinClient();
    await assert.rejects(setAnnouncementPinned(client, 'user', { role }, { announcementId: 'post-1', isPinned: true }),
      error => error.status === 403 || error.code === 'ANNOUNCEMENT_MANAGER_REQUIRED');
    assert.equal(client.calls.length, 0);
  }
});

test('pin/unpin updates only the selected post and never republishes it or changes its image', async () => {
  for (const [role, isPinned] of [['admin', true], ['manager', false]]) {
    const client = pinClient({ data: { id: 'post-1', is_pinned: isPinned, published_at: '2026-08-01T00:00:00Z' }, error: null });
    const result = await setAnnouncementPinned(client, 'manager-id', { role }, { announcementId: 'post-1', isPinned });
    assert.deepEqual(client.calls.find(call => call[0] === 'update')[1], { is_pinned: isPinned, updated_by: 'manager-id' });
    assert.deepEqual(client.calls.find(call => call[0] === 'eq'), ['eq', 'id', 'post-1']);
    assert.equal(result.announcement.isPinned, isPinned);
    assert.equal(result.announcement.publishedAt, '2026-08-01T00:00:00Z');
  }
});

test('pin action validates target/value and reports missing posts or unavailable schema', async () => {
  await assert.rejects(setAnnouncementPinned(pinClient(), 'manager', { role: 'manager' }, { isPinned: true }),
    error => error.code === 'MISSING_ANNOUNCEMENT_ID');
  for (const isPinned of [undefined, null, 1, 'yes']) {
    const client = pinClient();
    await assert.rejects(setAnnouncementPinned(client, 'manager', { role: 'manager' }, { announcementId: 'post-1', isPinned }),
      error => error.code === 'INVALID_ANNOUNCEMENT_PINNED');
    assert.equal(client.calls.length, 0);
  }
  await assert.rejects(setAnnouncementPinned(pinClient({ data: null, error: null }), 'manager', { role: 'manager' },
    { announcementId: 'missing', isPinned: true }), error => error.code === 'ANNOUNCEMENT_NOT_FOUND');
  await assert.rejects(setAnnouncementPinned(pinClient({ data: null, error: { code: '42703', message: 'is_pinned missing' } }),
    'manager', { role: 'manager' }, { announcementId: 'post-1', isPinned: true }), error => error.code === 'ANNOUNCEMENT_PINNING_NOT_READY');
});

test('database listing orders pinned first, then newest, and keeps publication filtering/read counts', async () => {
  const calls = [];
  const client = { from(table) {
    return {
      select(columns) { calls.push(['select', table, columns]); return this; },
      eq(column, value) { calls.push(['eq', table, column, value]); return this; },
      order(column, options) { calls.push(['order', column, options.ascending]); return this; },
      then(resolve, reject) { return Promise.resolve({ data: table === 'announcements'
        ? [{ id: 'pinned', is_pinned: true, is_published: true }, { id: 'new', is_published: true }]
        : [{ announcement_id: 'pinned', read_at: '2026-09-01' }], error: null }).then(resolve, reject); },
    };
  } };
  const result = await getAnnouncements(client, 'member-id', { role: 'sales' });
  assert.deepEqual(calls.filter(call => call[0] === 'order'),
    [['order', 'is_pinned', false], ['order', 'published_at', false], ['order', 'created_at', false]]);
  assert.ok(calls.some(call => call[0] === 'eq' && call[1] === 'announcements' && call[2] === 'is_published' && call[3] === true));
  assert.equal(result.announcements[0].isPinned, true);
  assert.equal(result.unreadCount, 1);
  assert.equal(result.canManage, false);
});

function element(tag = 'div') {
  const classes = new Set();
  return { tag, children: [], style: {}, attrs: {}, listeners: {}, scrollLeft: 0, scrollTop: 0,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; }, setAttribute(key, value) { this.attrs[key] = value; },
    removeAttribute(key) { delete this.attrs[key]; if (key === 'src') delete this.src; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    focus() { this.focusCount = (this.focusCount || 0) + 1; },
    setPointerCapture() {}, hasPointerCapture() { return false; }, releasePointerCapture() {},
  };
}

test('announcement cards sort pins first, expose keyboard-friendly image buttons, and hide manager actions from members', async () => {
  for (const canManage of [false, true]) {
    const list = element();
    const opened = [];
    const pins = [];
    const context = vm.createContext({
      announcementsRequestId: 1, announcements: [
        { id: 'new', title: '<New>', imagePath: 'new.png', isPublished: true, publishedAt: '2026-09-13' },
        { id: 'old', title: 'Pinned', imagePath: 'old.png', isPublished: true, isPinned: true, publishedAt: '2026-08-01' },
      ], document: { getElementById: () => list, createElement: element },
      getAnnouncementImageUrl: async value => value, formatSheetDate: value => value,
      canManageAnnouncements: () => canManage, openAnnouncementImageViewer: (...args) => opened.push(args),
      toggleAnnouncementPinned: (...args) => pins.push(args),
    });
    const start = html.indexOf('async function renderAnnouncements(');
    const end = html.indexOf('function initializeAnnouncementImageViewer(', start);
    vm.runInContext(html.slice(start, end), context);
    await context.renderAnnouncements();
    const [pinned, newest] = list.children;
    assert.match(pinned.className, /border-amber-300/);
    assert.equal(pinned.children[0].tag, 'button');
    assert.equal(pinned.children[0].children[0].src, 'old.png');
    assert.match(pinned.children[0].children[0].className, /object-top/);
    pinned.children[0].listeners.click();
    assert.deepEqual(opened[0], ['old.png', 'Pinned']);
    assert.equal(newest.children[1].children[1].textContent, '<New>');
    assert.equal(pinned.children[1].children.length, canManage ? 3 : 2);
    if (canManage) {
      const button = pinned.children[1].children[2].children[0];
      assert.equal(button.attrs['aria-pressed'], 'true');
      button.listeners.click();
      assert.equal(pins[0][0], 'old');
    }
  }
});

function viewerContext() {
  const ids = ['announcementImageViewer', 'announcementImageViewerStage', 'announcementImageViewerCanvas',
    'announcementImageViewerFull', 'announcementImageViewerTitle', 'announcementImageViewerClose',
    'announcementImageZoomLabel', 'announcementImageZoomOut', 'announcementImageZoomIn'];
  const nodes = Object.fromEntries(ids.map(id => [id, Object.assign(element(), { id })]));
  const stage = nodes.announcementImageViewerStage;
  Object.assign(stage, { clientWidth: 1000, clientHeight: 700, scrollWidth: 1000, scrollHeight: 700 });
  Object.assign(nodes.announcementImageViewerFull, { complete: true, naturalWidth: 800, naturalHeight: 1600, offsetLeft: 0, offsetTop: 0 });
  Object.assign(nodes.announcementImageViewer, { open: false, showModal() { this.open = true; }, close() { this.open = false; } });
  const previous = Object.assign(element('button'), { isConnected: true });
  const body = element('body');
  const state = { scale: 1, fitWidth: 0, fitHeight: 0, previousFocus: null, initialized: false, drag: null };
  const context = vm.createContext({ announcementImageView: state,
    document: { getElementById: id => nodes[id], body, activeElement: previous },
    window: { addEventListener() {} }, showToast() {},
  });
  const start = html.indexOf('function initializeAnnouncementImageViewer(');
  const end = html.indexOf('async function toggleAnnouncementPinned(', start);
  vm.runInContext(html.slice(start, end), context);
  return { context, nodes, state, body, previous };
}

test('frontend pin action posts only its target/state, ignores stale scope, and recovers after failure', async () => {
  for (const scenario of ['success', 'stale', 'failure', 'unauthorized']) {
    const calls = [], button = { disabled: false };
    const context = vm.createContext({ announcements: [{ id: 'old', isPinned: true }], announcementsRequestId: 1,
      config: { crmApiUrl: '/api/crm' }, canManageAnnouncements: () => scenario !== 'unauthorized',
      crmFetch: async (url, options) => {
        calls.push(['post', url, JSON.parse(options.body)]);
        if (scenario === 'stale') context.announcementsRequestId++;
        return { ok: scenario !== 'failure', json: async () => ({ success: scenario !== 'failure', error: 'Pin failed' }) };
      }, loadAnnouncements: async () => calls.push(['load']),
      showSuccessToast: value => calls.push(['success', value]), showToast: value => calls.push(['error', value]),
    });
    const start = html.indexOf('async function toggleAnnouncementPinned(');
    const end = html.indexOf('function setAnnouncementImagePreview(', start);
    vm.runInContext(html.slice(start, end), context);
    await context.toggleAnnouncementPinned('old', button);
    assert.equal(button.disabled, false);
    if (scenario === 'unauthorized') { assert.equal(calls.length, 0); continue; }
    assert.equal(calls[0][1], '/api/crm');
    assert.equal(JSON.stringify(calls[0][2]), JSON.stringify({ action: 'setAnnouncementPinned', announcementId: 'old', isPinned: false }));
    if (scenario === 'success') assert.ok(calls.some(call => call[0] === 'load'));
    if (scenario === 'stale') assert.equal(calls.length, 1);
    if (scenario === 'failure') assert.deepEqual(calls[1], ['error', 'Pin failed']);
  }
});

test('full-image popup preserves aspect ratio, fits the entire image, supports bounded zoom and restores focus', () => {
  const { context, nodes, state, body, previous } = viewerContext();
  context.openAnnouncementImageViewer('test.png', '<Full image>');
  assert.equal(nodes.announcementImageViewer.open, true);
  assert.equal(nodes.announcementImageViewerTitle.textContent, '<Full image>');
  assert.equal(body.classList.contains('announcement-image-viewer-open'), true);
  assert.equal(state.fitHeight, 668);
  assert.equal(state.fitWidth, 334);
  assert.equal(nodes.announcementImageViewerFull.style.height, '668px');
  context.zoomAnnouncementImage(1);
  assert.equal(nodes.announcementImageViewerFull.style.height, '1336px');
  assert.equal(nodes.announcementImageViewerCanvas.style.height, '1368px');
  context.zoomAnnouncementImage(100);
  assert.equal(state.scale, 5);
  assert.equal(nodes.announcementImageZoomIn.disabled, true);
  context.zoomAnnouncementImage(-100);
  assert.equal(state.scale, 0.5);
  assert.equal(nodes.announcementImageZoomOut.disabled, true);
  context.resetAnnouncementImageZoom();
  assert.equal(state.scale, 1);
  context.closeAnnouncementImageViewer();
  assert.equal(nodes.announcementImageViewer.open, false);
  assert.equal(nodes.announcementImageViewerFull.src, undefined);
  assert.equal(body.classList.contains('announcement-image-viewer-open'), false);
  assert.equal(previous.focusCount, 1);
  assert.match(html, /\.announcement-image-viewer-canvas img[^}]+object-fit: contain/);
});

test('wheel/keyboard zoom, mouse panning and Escape work within the popup without reaching underlying dialogs', () => {
  const { context, nodes, state } = viewerContext();
  context.openAnnouncementImageViewer('test.png');
  let prevented = 0, stopped = 0;
  context.handleAnnouncementImageWheel({ deltaY: -1, preventDefault() { prevented++; } });
  assert.equal(state.scale, 1.1);
  const keyboard = key => nodes.announcementImageViewer.listeners.keydown({ key,
    preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  keyboard('+');
  assert.equal(state.scale, 1.35);
  const stage = nodes.announcementImageViewerStage;
  stage.listeners.pointerdown({ pointerType: 'mouse', button: 0, pointerId: 1, clientX: 100, clientY: 100,
    target: nodes.announcementImageViewerFull, preventDefault() {} });
  stage.listeners.pointermove({ pointerId: 1, clientX: 80, clientY: 75 });
  assert.ok(stage.scrollLeft >= 20);
  assert.ok(stage.scrollTop >= 25);
  stage.listeners.pointerup({ pointerId: 1 });
  assert.equal(state.drag, null);
  keyboard('0');
  assert.equal(state.scale, 1);
  keyboard('Escape');
  assert.equal(nodes.announcementImageViewer.open, false);
  assert.equal(stopped, 3);
  assert.equal(prevented, 4);
});
