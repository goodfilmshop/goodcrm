const intakeDayFormat = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit'});
const intakeTimeFormat = new Intl.DateTimeFormat('th-TH', {timeZone:'Asia/Bangkok', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'});

function intakeDayKey(value) {
  const date = new Date(value || NaN);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(intakeDayFormat.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function renderIntakeCustomerTag(row) {
  const firstDay = intakeDayKey(row.first_seen_at);
  const latestDay = intakeDayKey(row.last_seen_at);
  if (!firstDay || !latestDay || firstDay > latestDay) return '';
  const isNew = firstDay === latestDay;
  const label = isNew ? 'ลูกค้าใหม่' : 'ลูกค้าเก่า';
  const description = isNew ? 'ทักครั้งแรกในวันของกลุ่มนี้ ตามประวัติที่ระบบเก็บได้' : 'เคยทักในวันก่อนหน้า ตามประวัติที่ระบบเก็บได้';
  const colors = isNew ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-800 border-amber-200';
  return `<span class="shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${colors}" title="${description}" aria-label="${label}: ${description}">${label}</span>`;
}

// Keep each row's original index so admission buttons still select the right contact.
function renderIntakeDailyGroups(rows, renderRow) {
  if (!rows.length) return '<p class="py-5 text-sm text-slate-500">ไม่มีรายการในสถานะนี้</p>';
  const labelFormat = new Intl.DateTimeFormat('th-TH', {timeZone:'Asia/Bangkok', day:'numeric', month:'long', year:'numeric'});
  const groups = new Map();
  rows.forEach((row, index) => {
    const date = new Date(row.last_seen_at || NaN);
    const valid = Number.isFinite(date.getTime());
    const key = intakeDayKey(row.last_seen_at);
    if (!groups.has(key)) groups.set(key, {label:valid ? labelFormat.format(date) : 'ไม่ระบุวันที่', rows:[]});
    groups.get(key).rows.push({row, index});
  });
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([, group]) => `
    <section class="space-y-2 pt-2">
      <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-blue-50 px-3 py-2">
        <h3 class="text-sm font-bold text-blue-800"><i class="fa-regular fa-calendar mr-2" aria-hidden="true"></i>ทักล่าสุด · ${escapeHtml(group.label)}</h3>
        <span class="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-blue-700">${group.rows.length} รายชื่อในหน้านี้</span>
      </div>
      <ol class="intake-timeline" aria-label="เวลาทักล่าสุด ${escapeHtml(group.label)}">${group.rows
        .sort((a, b) => (Date.parse(b.row.last_seen_at) - Date.parse(a.row.last_seen_at)) || a.index - b.index)
        .map(({row, index}) => {
          const date = new Date(row.last_seen_at || NaN);
          const valid = Number.isFinite(date.getTime());
          const time = valid ? `<time datetime="${date.toISOString()}" aria-label="ทักล่าสุด ${intakeTimeFormat.format(date)} นาฬิกา">${intakeTimeFormat.format(date)}</time>` : '<span>—</span>';
          return `<li class="intake-timeline-item"><div class="intake-timeline-time">${time}</div><span class="intake-timeline-track" aria-hidden="true"></span><div class="intake-timeline-content">${renderRow(row, index)}</div></li>`;
        }).join('')}</ol>
    </section>`).join('');
}
