const crypto = require('node:crypto');

const ACCOUNT = 'gfs-line-249izgyn';
const BASIC_ID = '@249izgyn';
const INTAKE_ACCOUNTS = Object.freeze({
  'car-line-fkq6145q': {company:'CAR',basicId:'@fkq6145q', endpoint:'line-maholan-intake'},
  'mhl-line-320opqkc': {company:'MHL',basicId:'@320opqkc', endpoint:'line-mhl-intake'},
  'gfs-line-249izgyn': {company:'GFS',basicId:'@249izgyn', endpoint:'line-gfs-intake'},
  'gfs-line-095jvuls': {company:'GFS',basicId:'@095jvuls', endpoint:'line-goodfilm-intake'},
});
function intakeAccount(value) {
  const account = value || ACCOUNT;
  if (!Object.hasOwn(INTAKE_ACCOUNTS,account)) throw new Error('บัญชี LINE ไม่ถูกต้อง');
  return {key:account,...INTAKE_ACCOUNTS[account]};
}
function configuration(env = process.env) {
  return {
    enabled: env.LINE_GFS_INTAKE_ENABLED === 'true',
    secret: env.LINE_GFS_CHANNEL_SECRET || '',
    destination: env.LINE_GFS_BOT_USER_ID || '',
    token: env.LINE_GFS_CHANNEL_ACCESS_TOKEN || '',
  };
}
function validSignature(raw, signature, secret) {
  if (!Buffer.isBuffer(raw) || !secret || !/^[A-Za-z0-9+/]{43}=$/.test(signature || '')) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  const received = Buffer.from(signature, 'base64');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
function inboundEvents(body, destination) {
  if (!destination || body?.destination !== destination || !Array.isArray(body.events) || body.events.length > 100) {
    throw new Error('Invalid LINE destination or events');
  }
  return body.events.filter(event => event.type === 'message' && event.source?.type === 'user').map(event => {
    if (!/^U[0-9a-f]{32}$/.test(event.source.userId || '') ||
        typeof event.webhookEventId !== 'string' || !event.webhookEventId || event.webhookEventId.length > 128 ||
        !Number.isSafeInteger(event.timestamp) || event.timestamp < 0 || event.timestamp > Date.now() + 300000) {
      throw new Error('Invalid LINE event');
    }
    return { eventId: event.webhookEventId, userId: event.source.userId, at: new Date(event.timestamp).toISOString() };
  });
}
function createWebhook({ getClient, env = process.env }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const settings = configuration(env);
    if (!settings.enabled || !settings.secret || !settings.destination) return res.sendStatus(503);
    if (!validSignature(req.body, req.get('x-line-signature'), settings.secret)) return res.sendStatus(401);
    let events;
    try { events = inboundEvents(JSON.parse(req.body.toString('utf8')), settings.destination); }
    catch { return res.sendStatus(400); }
    const client = getClient();
    if (!client) return res.sendStatus(503);
    try {
      // Acknowledge only after durable storage. LINE retries cannot create duplicates.
      const { error } = await client.rpc('receive_line_intake', { p_account: ACCOUNT, p_events: events });
      if (error) throw error;
      return res.status(200).json({ received: true });
    } catch {
      console.error('LINE intake persistence failed; webhook must be retried');
      return res.sendStatus(503);
    }
  };
}
function requireIntakeAdmin(membership) {
  if (membership?.role !== 'admin' || !membership.is_active) {
    const error = new Error('เฉพาะผู้ดูแลระบบที่คัดรายชื่อ LINE ได้');
    error.status = 403;
    throw error;
  }
}
function intakeDate(value) {
  const date = value || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('วันที่ไม่ถูกต้อง');
  return date;
}
async function getIntake(client, membership, input) {
  requireIntakeAdmin(membership);
  const account = intakeAccount(input.account);
  const date = intakeDate(input.date);
  const status = ['pending', 'imported', 'dismissed'].includes(input.status) ? input.status : 'pending';
  const page = Math.max(0, Math.min(100000, Number.parseInt(input.page, 10) || 0));
  const settings = configuration();
  let connectionStatus = 'not-configured';
  let enabled = Boolean(settings.enabled && settings.secret && settings.destination && process.env.LINE_INTAKE_SUPABASE_SECRET_KEY);
  if (process.env.LINE_GFS_INTAKE_MODE === 'cloud' || account.key !== ACCOUNT) {
    try {
      const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/${account.endpoint}/health`, {signal:AbortSignal.timeout(3000)});
      if (!response.ok) throw new Error();
      const health = await response.json();
      enabled = health.account === account.basicId && health.configured === true;
      connectionStatus = enabled ? 'ready' : 'not-configured';
    } catch { enabled = false; connectionStatus = 'unreachable'; }
  } else { connectionStatus = enabled ? 'ready' : 'not-configured'; }
  const [rows, totals] = await Promise.all([
    client.from('line_intake_contacts').select('*', { count: 'exact' }).eq('account_key', account.key).eq('status', status)
      .order('last_seen_at', { ascending: false }).order('id').range(page * 30, page * 30 + 29),
    client.rpc('line_intake_daily_summary', { p_account: account.key, p_day: date }),
  ]);
  if (rows.error || totals.error) throw new Error('ยังอ่านรายการ LINE ไม่ได้ กรุณาตรวจการติดตั้งฐานข้อมูล');
  // Profile lookup is read-only on LINE and never delays the webhook receipt.
  if (account.key === ACCOUNT && settings.token) await Promise.all(rows.data.filter(row => !row.display_name).map(async row => {
    try {
      const response = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(row.line_user_id)}`, {
        headers: { Authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) return;
      const profile = await response.json();
      if (typeof profile.displayName !== 'string' || !profile.displayName.trim()) return;
      row.display_name = profile.displayName.slice(0, 200);
      await client.from('line_intake_contacts').update({ display_name: row.display_name }).eq('id', row.id);
    } catch { /* Show the stable user ID when LINE cannot return a profile. */ }
  }));
  return { success: true, account: account.basicId, accountKey: account.key, company: account.company, enabled, connectionStatus, date, page,
    contacts: rows.data, total: rows.count, summary: totals.data };
}
async function resolveIntake(client, membership, input) {
  requireIntakeAdmin(membership);
  if (!['create', 'link', 'dismiss'].includes(input.decision)) throw new Error('เลือกการดำเนินการไม่ถูกต้อง');
  if (input.decision !== 'dismiss' && input.replied !== true) throw new Error('กรุณายืนยันว่าตอบลูกค้าใน LINE OA แล้ว');
  const name = String(input.customerName || '').trim();
  const customer = String(input.customerId || '').trim();
  if (input.decision === 'create' && (!name || name.length > 200)) throw new Error('กรุณากรอกชื่อลูกค้าไม่เกิน 200 ตัวอักษร');
  if (input.decision === 'link' && !customer) throw new Error('กรุณาระบุรหัสลูกค้าเดิม');
  const { data, error } = await client.rpc('resolve_intake_with_details', {
    p_platform:'line', p_details:input.customerDetails || {},
    p_id: input.id, p_decision: input.decision, p_name: name, p_customer: customer,
  });
  if (error) throw new Error('คัดรายชื่อไม่สำเร็จ กรุณาตรวจรหัสลูกค้าหรือรีเฟรชรายการ');
  return { success: true, result: data };
}
module.exports = { intakeAccount, INTAKE_ACCOUNTS, ACCOUNT, BASIC_ID, configuration, validSignature, inboundEvents, createWebhook, requireIntakeAdmin, intakeDate, getIntake, resolveIntake };
