// Pending intake notifications use the signed-in user's granted channels and RLS.
// Read IDs only: no chat text or contact details are downloaded for notifications.
const intakeNotificationPlatforms = ['line', 'facebook'];
let intakeNotificationTimer = null;
let intakeNotificationSession = null;
const canReceiveIntakeNotification = platform => window.canViewIntakeChannel?.(platform) === true;
const intakeNotificationChannels = () => intakeNotificationPlatforms.filter(canReceiveIntakeNotification);
const intakeNotificationAccountKeys = platform => (window.IntakeAccounts?.accounts?.[platform] || [])
  .filter(account => window.canViewIntakeChannel?.(platform, account.key) === true).map(account => account.key);
const intakeNotificationScope = () => intakeNotificationChannels().map(platform => `${platform}:${intakeNotificationAccountKeys(platform).join(',')}`).join('|');

function intakeNotificationLabel(platform) {
  return platform === 'line' ? 'LINE' : 'Facebook';
}

function renderIntakeNotificationBadge(platform, count, unavailable = false) {
  const badge = document.getElementById(`${platform}-intake-badge`);
  if (!badge) return;
  const label = `${intakeNotificationLabel(platform)} ลีดใหม่ที่ยังไม่ได้เปิดดู ${count.toLocaleString('th-TH')} รายชื่อ`
    + (unavailable ? ' · ยังตรวจข้อมูลล่าสุดไม่ได้ จะลองใหม่อัตโนมัติ' : '');
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.title = label;
  badge.setAttribute('aria-label', label);
  badge.classList.toggle('hidden', count === 0);
}

function intakeNotificationStorageKey(session, platform) {
  return `goodcrm:intake-unread:v2:${session.userId}:${platform}:${session.accountKeys[platform].join(',')}`;
}

function restoreIntakeNotificationState(session, platform) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(intakeNotificationStorageKey(session, platform)));
    if (!saved || !Array.isArray(saved.seen) || !Array.isArray(saved.unread)
        || !saved.seen.every(id => typeof id === 'string') || !saved.unread.every(id => typeof id === 'string')) return;
    session.seen[platform] = new Set(saved.seen);
    session.unread[platform] = new Set(saved.unread.filter(id => session.seen[platform].has(id)));
  } catch { /* Storage may be unavailable; keep the current tab's state. */ }
}

function persistIntakeNotificationState(session, platform) {
  if (!session.seen[platform]) return;
  try {
    window.localStorage.setItem(intakeNotificationStorageKey(session, platform), JSON.stringify({
      seen:[...session.seen[platform]], unread:[...session.unread[platform]],
    }));
  } catch { /* Notifications still work for this session without storage. */ }
}

function markIntakeNotificationsRead(platform) {
  const session = intakeNotificationSession;
  if (!session || !intakeNotificationPlatforms.includes(platform) || !canReceiveIntakeNotification(platform)
      || currentAuthUser?.id !== session.userId) return;
  restoreIntakeNotificationState(session, platform);
  session.unread[platform] = new Set();
  delete session.alerts[platform];
  // The next successful snapshot includes arrivals not polled before opening.
  session.readRequested[platform] = true;
  persistIntakeNotificationState(session, platform);
  renderIntakeNotificationBadge(platform, 0);
  renderIntakeNotificationAlerts(session);
  scheduleIntakeNotificationRefresh();
}

function dismissIntakeNotifications() {
  if (intakeNotificationSession) intakeNotificationSession.alerts = {};
  document.getElementById('intake-notification-panel')?.classList.add('hidden');
}

function openIntakeNotification(platform) {
  if (!intakeNotificationPlatforms.includes(platform) || !canReceiveIntakeNotification(platform)) return;
  switchPage(`${platform}-intake`);
}

function renderIntakeNotificationAlerts(session) {
  const panel = document.getElementById('intake-notification-panel');
  if (!panel) return;
  for (const platform of intakeNotificationPlatforms) {
    const button = document.getElementById(`${platform}-intake-alert`);
    const count = canReceiveIntakeNotification(platform) ? session.alerts[platform]?.size || 0 : 0;
    button.textContent = `${intakeNotificationLabel(platform)} มีลีดใหม่ ${count.toLocaleString('th-TH')} รายชื่อ · ดูรายการ`;
    button.classList.toggle('hidden', count === 0);
  }
  panel.classList.toggle('hidden', !intakeNotificationChannels().some(platform => session.alerts[platform]?.size));
}

async function readPendingIntakeIds(client, platform, signal) {
  const ids = new Set();
  const accounts = intakeNotificationAccountKeys(platform);
  if (!accounts.length) return ids;
  let after = '';
  // Keyset pagination also handles queues larger than the API's row limit.
  for (;;) {
    let query = client.from(`${platform}_intake_contacts`).select('id')
      .eq('status', 'pending').in('account_key', accounts).order('id').limit(500);
    if (after) query = query.gt('id', after);
    const {data, error} = await query.abortSignal(signal);
    if (error || !Array.isArray(data)) throw error || new Error('Invalid intake response');
    if (!data.length) return ids;
    for (const row of data) ids.add(row.id);
    const next = data[data.length - 1].id;
    if (next === after) throw new Error('Intake pagination did not advance');
    after = next;
    if (data.length < 500) return ids;
  }
}

async function refreshIntakeNotifications() {
  const session = intakeNotificationSession;
  if (!session || session.busy || document.visibilityState !== 'visible') return;
  if (!intakeNotificationChannels().length || session.scope !== intakeNotificationScope() || currentAuthUser?.id !== session.userId) {
    stopIntakeNotificationUpdates();
    return;
  }
  session.busy = true;
  session.controller = new AbortController();
  const timeout = window.setTimeout(() => session.controller?.abort(), 20000);
  try {
    await Promise.all(intakeNotificationChannels().map(async platform => {
      try {
        const ids = await readPendingIntakeIds(session.client, platform, session.controller.signal);
        if (session !== intakeNotificationSession || !canReceiveIntakeNotification(platform)
            || session.scope !== intakeNotificationScope() || currentAuthUser?.id !== session.userId) return;
        // Re-read persisted state so another tab's acknowledgement is respected.
        restoreIntakeNotificationState(session, platform);
        const seen = session.seen[platform];
        const unread = session.unread[platform] ||= new Set();
        const alerts = session.alerts[platform] ||= new Set();
        if (seen) {
          for (const id of ids) if (!seen.has(id)) { seen.add(id); unread.add(id); alerts.add(id); }
        } else {
          // First use establishes a baseline; the old queue is not unread news.
          session.seen[platform] = ids;
        }
        for (const id of unread) if (!ids.has(id)) unread.delete(id);
        if (session.readRequested[platform]) {
          unread.clear();
          session.readRequested[platform] = false;
        }
        for (const id of alerts) if (!unread.has(id)) alerts.delete(id);
        persistIntakeNotificationState(session, platform);
        renderIntakeNotificationBadge(platform, unread.size);
      } catch {
        if (session === intakeNotificationSession && canReceiveIntakeNotification(platform)
            && session.scope === intakeNotificationScope() && currentAuthUser?.id === session.userId) {
          // A failed scan must not mark future arrivals as opened on recovery.
          session.readRequested[platform] = false;
          renderIntakeNotificationBadge(platform, session.unread[platform]?.size || 0, true);
        }
      }
    }));
    if (session === intakeNotificationSession) renderIntakeNotificationAlerts(session);
  } finally {
    window.clearTimeout(timeout);
    session.busy = false;
    session.controller = null;
    if (session.refreshAgain && session === intakeNotificationSession) {
      session.refreshAgain = false;
      void refreshIntakeNotifications();
    }
  }
}

function scheduleIntakeNotificationRefresh() {
  if (intakeNotificationSession?.busy) intakeNotificationSession.refreshAgain = true;
  else void refreshIntakeNotifications();
}

function stopIntakeNotificationUpdates() {
  if (intakeNotificationTimer) window.clearInterval(intakeNotificationTimer);
  intakeNotificationTimer = null;
  intakeNotificationSession?.controller?.abort();
  intakeNotificationSession = null;
  for (const platform of intakeNotificationPlatforms) renderIntakeNotificationBadge(platform, 0);
  dismissIntakeNotifications();
}

function startIntakeNotificationUpdates() {
  if (!supabaseClient || !intakeNotificationChannels().length || !currentAuthUser?.id) {
    stopIntakeNotificationUpdates();
    return;
  }
  // Session/token refresh must not erase the baseline or create extra timers.
  if (intakeNotificationSession?.userId === currentAuthUser.id
      && intakeNotificationSession.scope === intakeNotificationScope()) return;
  stopIntakeNotificationUpdates();
  intakeNotificationSession = {userId:currentAuthUser.id, scope:intakeNotificationScope(),
    accountKeys:Object.fromEntries(intakeNotificationPlatforms.map(platform => [platform, intakeNotificationAccountKeys(platform)])),
    client:supabaseClient, seen:{}, unread:{}, alerts:{}, readRequested:{}, busy:false};
  for (const platform of intakeNotificationChannels()) {
    restoreIntakeNotificationState(intakeNotificationSession, platform);
    renderIntakeNotificationBadge(platform, intakeNotificationSession.unread[platform]?.size || 0);
  }
  void refreshIntakeNotifications();
  intakeNotificationTimer = window.setInterval(() => void refreshIntakeNotifications(), 30000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleIntakeNotificationRefresh();
});
window.addEventListener('online', scheduleIntakeNotificationRefresh);
window.addEventListener('storage', event => {
  const session = intakeNotificationSession;
  if (!session || session.scope !== intakeNotificationScope() || currentAuthUser?.id !== session.userId) return;
  for (const platform of intakeNotificationChannels()) {
    if (event.key !== intakeNotificationStorageKey(session, platform)) continue;
    restoreIntakeNotificationState(session, platform);
    const unread = session.unread[platform] || new Set();
    for (const id of session.alerts[platform] || []) if (!unread.has(id)) session.alerts[platform].delete(id);
    renderIntakeNotificationBadge(platform, unread.size);
  }
  renderIntakeNotificationAlerts(session);
});
