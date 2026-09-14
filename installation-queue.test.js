const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  caseRecord,
  countUnreadCaseNotifications,
  getInstallationQueue,
  isInstallationQueueRecord,
  sortInstallationQueueRecords,
} = require('./server');

test('installation appointments are excluded from the measurement queue UI', () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const constantsSource = source.slice(
    source.indexOf('const CASE_APPOINTMENT_STATUSES'),
    source.indexOf('const BANGKOK_UTC_OFFSET')
  );
  const normalizeSource = source.slice(
    source.indexOf('function normalizeTimelineStatus(value)'),
    source.indexOf('function getSafeCaseLink')
  );
  const measurementFilterSource = source.slice(
    source.indexOf('function isMeasurementQueueCase(item)'),
    source.indexOf('function getMeasurementQueueCases')
  );
  const installationFilterSource = source.slice(
    source.indexOf('function isInstallationQueueCase(item)'),
    source.indexOf('function getInstallationQueueCases')
  );

  const result = vm.runInNewContext(`
    ${constantsSource}
    ${normalizeSource}
    ${measurementFilterSource}
    ${installationFilterSource}
    const appointment = '2026-08-23T02:30:00.000Z';
    ({
      installationInMeasurement: isMeasurementQueueCase({ status: INSTALLATION_QUEUE_STATUS }),
      installationInInstallation: isInstallationQueueCase({
        status: INSTALLATION_QUEUE_STATUS,
        latestFollowUpStatus: INSTALLATION_QUEUE_STATUS,
        nextFollowUpAt: appointment,
      }),
      measurementInMeasurement: isMeasurementQueueCase({ status: 'นัดวัดพื้นที่' }),
      measurementInInstallation: isInstallationQueueCase({
        status: 'นัดวัดพื้นที่',
        latestFollowUpStatus: 'นัดวัดพื้นที่',
        nextFollowUpAt: appointment,
      }),
    })
  `);

  assert.deepEqual(
    JSON.parse(JSON.stringify(result)),
    {
      installationInMeasurement: false,
      installationInInstallation: true,
      measurementInMeasurement: true,
      measurementInInstallation: false,
    }
  );
});

test('case notification counts use independent cursors and exact queue eligibility', () => {
  const readMap = new Map([
    ['cases', '2026-08-22T00:00:00.000Z'],
    ['measurement_queue', '2026-08-20T00:00:00.000Z'],
    ['installation_queue', '2026-08-22T00:00:00.000Z'],
    ['quotations', '2026-08-22T00:00:00.000Z'],
  ]);
  const result = countUnreadCaseNotifications([
    { status: 'นัดวัดพื้นที่', updated_at: '2026-08-21T00:00:00.000Z' },
    {
      status: 'นัดคิวติดตั้ง',
      updated_at: '2026-08-23T00:00:00.000Z',
      latest_follow_up: [{
        current_status: 'นัดคิวติดตั้ง',
        next_follow_up_at: '2026-08-24T02:30:00.000Z',
      }],
    },
    {
      status: 'นัดคิวติดตั้ง',
      updated_at: '2026-08-24T00:00:00.000Z',
      latest_follow_up: [{
        current_status: 'นัดวัดพื้นที่',
        next_follow_up_at: '2026-08-25T02:30:00.000Z',
      }],
    },
    {
      status: 'นัดคิวติดตั้ง',
      updated_at: '2026-08-25T00:00:00.000Z',
      latest_follow_up: [{
        current_status: 'นัดคิวติดตั้ง',
        next_follow_up_at: '',
      }],
    },
  ], readMap);

  assert.deepEqual(result, {
    casesUnreadCount: 3,
    measurementQueueUnreadCount: 1,
    installationQueueUnreadCount: 1,
    quotationsUnreadCount: 0,
  });
});

test('quotation unread count matches distinct menu documents from unread history rows', () => {
  const readMap = new Map([
    ['cases', '2026-08-30T00:00:00.000Z'],
    ['measurement_queue', '2026-08-30T00:00:00.000Z'],
    ['installation_queue', '2026-08-30T00:00:00.000Z'],
    ['quotations', '2026-08-22T00:00:00.000Z'],
  ]);
  const result = countUnreadCaseNotifications([], readMap, [
    {
      updated_at: '2026-08-23T00:00:00.000Z',
      quotation_numbers: ['Q-001', ' Q-002 ', 'Q-001', ''],
    },
    {
      created_at: '2026-08-24T00:00:00.000Z',
      quotation_numbers: ['Q-003'],
    },
    {
      updated_at: '2026-08-21T00:00:00.000Z',
      quotation_numbers: ['Q-OLD'],
    },
    { updated_at: '2026-08-25T00:00:00.000Z', quotation_numbers: [] },
    { updated_at: '2026-08-25T00:00:00.000Z', quotation_numbers: 'Q-NOT-AN-ARRAY' },
  ]);

  assert.deepEqual(result, {
    casesUnreadCount: 0,
    measurementQueueUnreadCount: 0,
    installationQueueUnreadCount: 0,
    quotationsUnreadCount: 3,
  });
});

test('measurement unread count includes only new pending general tasks', () => {
  const readMap = new Map([
    ['cases', '2026-08-30T00:00:00.000Z'],
    ['measurement_queue', '2026-08-22T00:00:00.000Z'],
    ['installation_queue', '2026-08-30T00:00:00.000Z'],
    ['quotations', '2026-08-30T00:00:00.000Z'],
  ]);
  const result = countUnreadCaseNotifications([], readMap, [], [
    { status: 'pending', updated_at: '2026-08-23T00:00:00.000Z' },
    { status: 'pending', created_at: '2026-08-24T00:00:00.000Z' },
    { status: 'pending', updated_at: '2026-08-21T00:00:00.000Z' },
    { status: 'completed', updated_at: '2026-08-25T00:00:00.000Z' },
    { status: 'cancelled', updated_at: '2026-08-25T00:00:00.000Z' },
  ]);

  assert.deepEqual(result, {
    casesUnreadCount: 0,
    measurementQueueUnreadCount: 2,
    installationQueueUnreadCount: 0,
    quotationsUnreadCount: 0,
  });
});

test('sidebar notification badges wire installation and quotation scopes independently', () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const sidebarSource = source.slice(
    source.indexOf('<nav class="sidebar-navigation'),
    source.indexOf('</nav>', source.indexOf('<nav class="sidebar-navigation'))
  );
  const updaterSource = source.slice(
    source.indexOf('function updateCaseNotificationUnreadBadges'),
    source.indexOf('async function loadCaseNotificationUnreadCounts')
  );
  const loaderSource = source.slice(
    source.indexOf('async function loadCaseNotificationUnreadCounts'),
    source.indexOf('async function markCaseNotificationsRead')
  );
  const markerSource = source.slice(
    source.indexOf('async function markCaseNotificationsRead'),
    source.indexOf('function scheduleCaseNotificationRefresh')
  );
  const switchPageSource = source.slice(
    source.indexOf('function switchPage(pageId)'),
    source.indexOf('function isEmployeeAdministrator')
  );

  assert.match(sidebarSource, /id="installationQueueUnreadBadge"/);
  assert.match(sidebarSource, /id="quotationsUnreadBadge"/);
  assert.match(updaterSource, /installationQueueUnreadCount/);
  assert.match(updaterSource, /quotationsUnreadCount/);
  assert.match(updaterSource, /updateCaseNotificationUnreadBadge\('installationQueueUnreadBadge'/);
  assert.match(updaterSource, /updateCaseNotificationUnreadBadge\('quotationsUnreadBadge'/);
  assert.match(loaderSource, /result\.installationQueueUnreadCount/);
  assert.match(loaderSource, /result\.quotationsUnreadCount/);
  assert.match(markerSource, /installation_queue/);
  assert.match(markerSource, /quotations/);
  assert.match(switchPageSource, /pageId === 'installation-tracker'[\s\S]*?installation_queue/);
  assert.match(switchPageSource, /pageId === 'quotations'[\s\S]*?quotations/);
});

test('notification menu data endpoints expose a read-through snapshot captured before querying', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const endpointRanges = [
    ['async function getCases(client)', 'function bangkokDateKey', 'await caseListQuery('],
    ['async function getInstallationQueue(client)', 'function generalTaskRecord', 'await installationQueueQuery('],
    ['async function getGeneralTasks(client)', 'function quotationListRecords', 'await client'],
    ['async function getQuotations(client)', 'function normalizeCaseNotificationScope', 'await client'],
  ];

  endpointRanges.forEach(([startMarker, endMarker, queryMarker]) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    const endpointSource = source.slice(start, end);

    assert.ok(start >= 0 && end > start, `${startMarker} should be present`);
    assert.match(endpointSource, /const readThroughAt = new Date\(\)\.toISOString\(\)/);
    assert.match(endpointSource, /\breadThroughAt,\s*\n/);
    assert.ok(
      endpointSource.indexOf('const readThroughAt') < endpointSource.indexOf(queryMarker),
      `${startMarker} should capture readThroughAt before starting its query`
    );
  });
});

test('measurement read-through cursor requires every menu source to load successfully', () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const functionSource = source.slice(
    source.indexOf('function earliestReadThroughAt(...values)'),
    source.indexOf('// Switch Page')
  );
  const result = vm.runInNewContext(`
    ${functionSource}
    ({
      bothLoaded: earliestReadThroughAt(
        '2026-08-22T05:00:00.000Z',
        '2026-08-22T06:00:00.000Z'
      ),
      casesFailed: earliestReadThroughAt(false, '2026-08-22T06:00:00.000Z'),
      tasksFailed: earliestReadThroughAt('2026-08-22T05:00:00.000Z', false),
    })
  `);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    bothLoaded: '2026-08-22T05:00:00.000Z',
    casesFailed: '',
    tasksFailed: '',
  });
});

test('notification read cursor normalization preserves past snapshots and clamps unsafe values', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const functionSource = source.slice(
    source.indexOf('function normalizeCaseNotificationReadAt(value)'),
    source.indexOf('function notificationChangedAt')
  );
  const fixedNow = '2026-08-22T12:00:00.000Z';
  const context = {
    Date: class FixedDate extends Date {
      static now() {
        return Date.parse(fixedNow);
      }
    },
  };

  assert.match(functionSource, /Math\.min\(requestedTime, now\)/);
  vm.runInNewContext(`
    ${functionSource}
    result = {
      past: normalizeCaseNotificationReadAt('2026-08-21T05:30:00+07:00'),
      future: normalizeCaseNotificationReadAt('2026-08-30T00:00:00.000Z'),
      invalid: normalizeCaseNotificationReadAt('not-a-date'),
      missing: normalizeCaseNotificationReadAt(''),
    };
  `, context);

  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), {
    past: '2026-08-20T22:30:00.000Z',
    future: fixedNow,
    invalid: fixedNow,
    missing: fixedNow,
  });
});

test('client marks only the still-visible menu through the fetched snapshot', () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const expectedCalls = {
    cases: 2,
    measurement_queue: 2,
    installation_queue: 2,
    quotations: 2,
  };
  const actualCalls = Object.fromEntries(Object.keys(expectedCalls).map(scope => [scope, 0]));
  const calls = [...source.matchAll(/void markCaseNotificationsRead\('([^']+)', readThroughAt\)/g)];

  calls.forEach((match) => {
    const scope = match[1];
    assert.ok(Object.hasOwn(actualCalls, scope), `unexpected notification scope ${scope}`);
    actualCalls[scope] += 1;
    const nearbyGuard = source.slice(Math.max(0, match.index - 180), match.index);
    assert.match(nearbyGuard, /isCrmPageVisible\('[^']+'\)/);
  });

  assert.deepEqual(actualCalls, expectedCalls);
});

test('mark-read payload carries readThroughAt and ignores stale responses', () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const markerSource = source.slice(
    source.indexOf('async function markCaseNotificationsRead'),
    source.indexOf('function scheduleCaseNotificationRefresh')
  );
  const guard = 'if (requestId !== caseNotificationUnreadRequestId) return;';

  assert.match(markerSource, /async function markCaseNotificationsRead\(scope, readThroughAt = ''\)/);
  assert.match(markerSource, /const requestId = \+\+caseNotificationUnreadRequestId/);
  assert.match(markerSource, /JSON\.stringify\(\{ action: 'markCaseNotificationsRead', scope, readThroughAt \}\)/);
  assert.ok(markerSource.indexOf(guard) >= 0);
  assert.ok(
    markerSource.indexOf(guard) < markerSource.indexOf('updateCaseNotificationUnreadBadges('),
    'a superseded mark response must not overwrite newer badge counts'
  );
});

test('caseRecord exposes the status and date from the latest follow-up appointment', () => {
  const record = caseRecord({
    legacy_case_id: 'CASE-INSTALL-001',
    status: 'นัดคิวติดตั้ง',
    customers: {
      legacy_cust_id: 'CUST-001',
      customer_name: 'ลูกค้าทดสอบ',
      phone: '0812345678',
    },
    latest_follow_up: [{
      current_status: 'นัดคิวติดตั้ง',
      next_follow_up_at: '2026-08-23T02:30:00.000Z',
      notes: 'นัดทีมช่างเข้าหน้างาน',
    }],
  });

  assert.equal(record.status, 'นัดคิวติดตั้ง');
  assert.equal(record.latestFollowUpStatus, 'นัดคิวติดตั้ง');
  assert.equal(record.nextFollowUpAt, '2026-08-23T02:30:00.000Z');
  assert.equal(record.latestContactDetails, 'นัดทีมช่างเข้าหน้างาน');
});

test('caseRecord does not invent installation appointment data without follow-up history', () => {
  const record = caseRecord({
    legacy_case_id: 'CASE-INSTALL-002',
    status: 'นัดคิวติดตั้ง',
    customers: null,
    latest_follow_up: [],
  });

  assert.equal(record.latestFollowUpStatus, '');
  assert.equal(record.nextFollowUpAt, '');
});

test('installation queue requires the current case and latest follow-up to match', () => {
  const appointment = '2026-08-23T02:30:00.000Z';
  assert.equal(isInstallationQueueRecord({
    caseId: 'CASE-VALID',
    status: 'นัดคิวติดตั้ง',
    latestFollowUpStatus: 'นัดคิวติดตั้ง',
    nextFollowUpAt: appointment,
  }), true);
  assert.equal(isInstallationQueueRecord({
    caseId: 'CASE-OLD-FOLLOW-UP',
    status: 'นัดคิวติดตั้ง',
    latestFollowUpStatus: 'นัดวัดพื้นที่',
    nextFollowUpAt: appointment,
  }), false);
  assert.equal(isInstallationQueueRecord({
    caseId: 'CASE-MISSING-DATE',
    status: 'นัดคิวติดตั้ง',
    latestFollowUpStatus: 'นัดคิวติดตั้ง',
    nextFollowUpAt: '',
  }), false);
});

test('installation queue records are sorted by the nearest appointment first', () => {
  const records = sortInstallationQueueRecords([
    { caseId: 'CASE-LATE', status: 'นัดคิวติดตั้ง', latestFollowUpStatus: 'นัดคิวติดตั้ง', nextFollowUpAt: '2026-08-24T02:30:00.000Z' },
    { caseId: 'CASE-EARLY', status: 'นัดคิวติดตั้ง', latestFollowUpStatus: 'นัดคิวติดตั้ง', nextFollowUpAt: '2026-08-22T02:30:00.000Z' },
  ]);

  assert.deepEqual(records.map(record => record.caseId), ['CASE-EARLY', 'CASE-LATE']);
});

test('installation queue endpoint uses keyset pagination past row caps and 1,000 records', async () => {
  const rawRows = Array.from({ length: 1001 }, (_, index) => ({
    id: String(index).padStart(4, '0'),
    legacy_case_id: `CASE-${String(index).padStart(4, '0')}`,
    status: 'นัดคิวติดตั้ง',
    recorded_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    customers: {
      legacy_cust_id: `CUST-${index}`,
      customer_name: `ลูกค้า ${index}`,
      phone: `08${String(index).padStart(8, '0')}`,
    },
    latest_follow_up: [{
      current_status: 'นัดคิวติดตั้ง',
      next_follow_up_at: new Date(Date.UTC(2026, 7, 21, 0, index)).toISOString(),
      followed_at: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
      notes: `งานติดตั้ง ${index}`,
      id: `follow-up-${index}`,
    }],
  }));
  const requestedRanges = [];
  const requestedCursors = [];
  const simulatedServerRowCap = 137;
  const client = {
    from(table) {
      assert.equal(table, 'cases');
      let afterId = '';
      return {
        select() { return this; },
        eq() { return this; },
        order() { return this; },
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

  const result = await getInstallationQueue(client);

  assert.equal(result.success, true);
  assert.equal(result.cases.length, 1001);
  assert.ok(Number.isFinite(Date.parse(result.readThroughAt)));
  assert.ok(requestedRanges.length > 3);
  assert.ok(requestedRanges.every(range => range[0] === 0 && range[1] === 499));
  assert.equal(requestedCursors[0], '');
  assert.equal(requestedCursors.at(-1), '1000');
  assert.equal(result.cases[0].caseId, 'CASE-0000');
  assert.equal(result.cases.at(-1).caseId, 'CASE-1000');
});

test('appointment input is interpreted explicitly in the Bangkok time zone', () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const functionSource = source.match(/function dateTimeLocalToIso\(value\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(functionSource, 'dateTimeLocalToIso should exist');

  const result = vm.runInNewContext(
    `const BANGKOK_UTC_OFFSET = '+07:00'; ${functionSource}; dateTimeLocalToIso('2026-08-23T09:30')`
  );
  assert.equal(result, '2026-08-23T02:30:00.000Z');
});

test('installation queue UI requires a matching latest follow-up and sorts appointments ascending', () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const fetchQueueSource = source.slice(
    source.indexOf('async function fetchInstallationQueue()'),
    source.indexOf('function setGeneralTasksMessage')
  );

  assert.match(source, /id="menu-installation-tracker"/);
  assert.match(source, /id="page-installation-tracker"/);
  assert.match(source, /normalizeTimelineStatus\(item\?\.latestFollowUpStatus\) === INSTALLATION_QUEUE_STATUS/);
  assert.match(source, /Number\.isFinite\(new Date\(appointment\)\.getTime\(\)\)/);
  assert.match(source, /tableBodyId: 'installationQueueTableBody'[\s\S]*?sortDirection: 'asc'/);
  assert.match(source, /searchParams\.set\('action', 'getInstallationQueue'\)/);
  assert.match(source, /if \(result\.apiVersion !== requiredCrmApiVersion\)/);
  assert.match(source, /if \(customerId\) \{[\s\S]*?viewLeadDetail\(customerId, item\.caseId\)/);
  assert.match(source, /billingName: item\?\.billingName \|\| ''/);
  assert.ok(
    fetchQueueSource.indexOf('if (!response.ok || !result.success)')
      < fetchQueueSource.indexOf('if (result.apiVersion !== requiredCrmApiVersion)')
  );
});
