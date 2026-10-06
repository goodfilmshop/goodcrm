const { INTAKE_ACCOUNTS, intakeDate } = require('./line-intake');
const { ACCOUNTS } = require('./facebook-intake');
const { canAccessIntake } = require('./intake-permissions');

// Historical account keys/company metadata predate the current FB tab labels.
// Keep intake/customer routing intact; report each page under its current company.
const FACEBOOK_REPORT_COMPANIES = {
  '125106670932394': 'GFS',
  '101634951180913': 'MHL',
  '109607531869658': 'CAR',
};

async function getIntakeReport(client, membership, input = {}) {
  const channels = ['facebook', 'line'].filter(channel => canAccessIntake(membership, channel));
  if (!channels.length) {
    throw Object.assign(new Error('บัญชีนี้ไม่มีสิทธิ์ดูสรุปการติดต่อ FB และ LINE'), { status: 403 });
  }
  if (input.month !== undefined) return getMonthlyIntakeReport(client, input.month, membership);
  const date = intakeDate(input.date);
  // Reuse the daily intake definitions and the caller's RLS-protected client.
  // Count each contact once per account; identities across accounts are distinct.
  const accounts = [
    ...Object.entries(ACCOUNTS).map(([key, value]) => ({ key, company: FACEBOOK_REPORT_COMPANIES[value.pageId] || value.company, channel: 'FB', rpc: 'facebook_intake_daily_summary' })),
    ...Object.entries(INTAKE_ACCOUNTS).map(([key, value]) => ({ key, company: value.company, channel: 'LINE', rpc: 'line_intake_daily_summary' })),
  ].filter(account => canAccessIntake(membership, account.channel === 'LINE' ? 'line' : 'facebook', 'view', account.key));
  const summaries = await Promise.all(accounts.map(async account => {
    const { data, error } = await client.rpc(account.rpc, { p_account: account.key, p_day: date });
    if (error || !data || !['new', 'total', 'imported'].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0) || data.new > data.total) {
      throw Object.assign(new Error('โหลดสรุปการติดต่อไม่ครบ กรุณาลองใหม่'), { status: 503 });
    }
    return { ...account, ...data };
  }));
  const grouped = new Map();
  for (const item of summaries) {
    const key = `${item.company}:${item.channel}`;
    if (!grouped.has(key)) grouped.set(key, { company: item.company, channel: item.channel, accounts: 0, new: 0, returning: 0, total: 0, imported: 0 });
    const row = grouped.get(key);
    row.accounts++;
    row.new += item.new;
    row.returning += item.total - item.new;
    row.total += item.total;
    row.imported += item.imported;
  }
  const rows = [...grouped.values()].sort((a, b) => ['GFS', 'MHL', 'CAR'].indexOf(a.company) - ['GFS', 'MHL', 'CAR'].indexOf(b.company) || a.channel.localeCompare(b.channel));
  return { success: true, date, rows };
}

function reportMonth(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || Number(value.slice(0, 4)) < 1000 || Number(value.slice(0, 4)) > 9998) {
    throw new Error('เดือนของรายงานไม่ถูกต้อง');
  }
  const start = new Date(`${value}-01T00:00:00Z`);
  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const length = Math.round((next - start) / 86400000);
  return { month: value, next: next.toISOString().slice(0, 10), dates: Array.from({ length }, (_, i) => `${value}-${String(i + 1).padStart(2, '0')}`) };
}

function reportUnavailable() {
  return Object.assign(new Error('โหลดสรุปการติดต่อไม่ครบ กรุณาลองใหม่'), { status: 503 });
}

async function readReportPages(query) {
  const rows = [];
  while (true) {
    const { data, error, count } = await query().range(rows.length, rows.length + 499);
    if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || (data.length === 0 && rows.length < count)) throw reportUnavailable();
    rows.push(...data);
    if (rows.length >= count) return rows;
  }
}

function bangkokDay(timestamp) {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw reportUnavailable();
  return new Date(value + 7 * 3600000).toISOString().slice(0, 10);
}

async function getMonthlyIntakeReport(client, month, membership) {
  const period = reportMonth(month);
  const accounts = [
    ...Object.entries(ACCOUNTS).map(([key, value]) => ({ key, company: FACEBOOK_REPORT_COMPANIES[value.pageId] || value.company, channel: 'FB', label: `FB-${FACEBOOK_REPORT_COMPANIES[value.pageId] || value.company}` })),
    ...Object.entries(INTAKE_ACCOUNTS).map(([key, value]) => ({ key, company: value.company, channel: 'LINE', label: value.basicId })),
  ].filter(account => canAccessIntake(membership, account.channel === 'LINE' ? 'line' : 'facebook', 'view', account.key));
  const channels = ['facebook', 'line'].filter(platform => accounts.some(account => account.channel === (platform === 'line' ? 'LINE' : 'FB')));
  const days = period.dates.map(date => ({ date, accounts: accounts.map(account => ({ ...account, new: 0, returning: 0, total: 0, imported: 0 })) }));
  const lookup = new Map(days.flatMap(day => day.accounts.map(account => [`${day.date}:${account.key}`, account])));
  const increment = (date, key, metric) => {
    const target = lookup.get(`${date}:${key}`);
    if (!target) throw reportUnavailable();
    target[metric]++;
  };
  // Read the month in paginated batches, not 7 RPC calls for each calendar day.
  // Query only granted channels with the caller's RLS-protected client.
  await Promise.all(channels.map(async platform => {
    const table = `${platform}_intake_contacts`;
    const keys = accounts.filter(account => account.channel === (platform === 'line' ? 'LINE' : 'FB')).map(account => account.key);
    const [activity, imports] = await Promise.all([
      readReportPages(() => client.from(`${platform}_intake_days`)
        .select(`day,contact_id,contact:${table}!inner(account_key,first_seen_at)`, { count: 'exact' })
        .gte('day', period.dates[0]).lt('day', period.next).in('contact.account_key', keys)
        .order('day').order('contact_id')),
      readReportPages(() => client.from(table).select('id,account_key,resolved_at', { count: 'exact' })
        .eq('status', 'imported').in('account_key', keys)
        .gte('resolved_at', `${period.dates[0]}T00:00:00+07:00`).lt('resolved_at', `${period.next}T00:00:00+07:00`).order('id')),
    ]);
    for (const row of activity) {
      if (!row.contact?.account_key) throw reportUnavailable();
      const firstDay = bangkokDay(row.contact.first_seen_at);
      if (firstDay > row.day) throw reportUnavailable();
      increment(row.day, row.contact.account_key, 'total');
      increment(row.day, row.contact.account_key, firstDay === row.day ? 'new' : 'returning');
    }
    for (const row of imports) increment(bangkokDay(row.resolved_at), row.account_key, 'imported');
  }));
  return { success: true, month, dates: period.dates, days };
}

module.exports = { getIntakeReport, reportMonth };
