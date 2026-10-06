const api = 'https://mbxuebqqglaeechltkyl.supabase.co/functions/v1/facebook-review';
const $ = id => document.getElementById(id);
let access = '', page = '125106670932394', data = null, busy = false, epoch = 0;
const status = message => { $('status').textContent = message; };
async function call(action, extra = {}) {
  const response = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-review-key': access }, body: JSON.stringify({ action, page, ...extra }), signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) signOut(); throw new Error(result.error || 'Request failed'); }
  return result;
}
function text(tag, value) { const el = document.createElement(tag); el.textContent = value; return el; }
function render() {
  $('editor').hidden = true;
  const row = data?.contacts.find(item => item.pageId === page);
  $('contact').replaceChildren();
  if (!row) $('contact').append(text('p', 'ยังไม่มีผู้เข้าร่วมทดสอบที่เปิดใช้งาน / No approved test participant.'));
  else {
    $('contact').append(text('h3', row.name || 'Meta ยังไม่ส่งชื่อ / Name unavailable'), text('p', `Page-scoped ID: ${row.userId}`), text('p', `ทักครั้งแรก: ${row.firstSeen || '—'} · ทักล่าสุด: ${row.lastSeen || '—'}`));
    if (row.verifiedAt) $('contact').append(text('p', `ดึงชื่อจาก Meta ล่าสุด / Last verified lookup: ${row.verifiedAt}`));
    const button = text('button', 'คัดรายชื่อ / Review contact');
    button.onclick = () => { $('customer-name').value = row.name || ''; $('editor').hidden = false; $('customer-name').focus(); };
    $('contact').append(button);
  }
  const customers = (data?.customers || []).filter(item => item.pageId === page);
  $('customers').replaceChildren(...(customers.length ? customers.map(item => text('p', `${item.name} · บันทึกในส่วนทดสอบ / Test record`)) : [text('p', 'ยังไม่มีลูกค้าทดสอบ / No test customers yet.')]));
  for (const button of $('pages').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.page === page));
}
async function run(work) {
  if (busy) return;
  const request = epoch;
  busy = true; for (const button of document.querySelectorAll('main button')) button.disabled = true;
  status('กำลังดำเนินการ / Working…');
  try { const message = await work(); if (request === epoch) status(message || 'พร้อมใช้งาน / Ready'); }
  catch (error) { status(error.message); }
  finally { busy = false; for (const button of document.querySelectorAll('main button')) button.disabled = false; }
}
async function load() { const request = epoch; const result = await call('snapshot'); if (request !== epoch) return; data = result; render(); }
function signOut() { epoch++; access = ''; data = null; $('code').value = ''; $('customer-name').value = ''; $('workspace').hidden = true; $('login').hidden = false; $('logout').hidden = true; $('contact').replaceChildren(); $('customers').replaceChildren(); status('ออกจากส่วนทดสอบแล้ว / Signed out'); }
$('login-form').onsubmit = event => { event.preventDefault(); run(async () => { access = $('code').value.trim(); await load(); if (!data) return; $('code').value = ''; $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; }); };
$('logout').onclick = signOut;
$('refresh').onclick = () => run(load);
$('profile').onclick = () => run(async () => { await call('refresh'); await load(); return 'ดึงชื่อจาก Meta และบันทึกในส่วนทดสอบแล้ว / Profile verified with Meta'; });
$('pages').onclick = event => { const selected = event.target.dataset.page; if (selected && !busy) { page = selected; render(); status('พร้อมใช้งาน / Ready'); } };
$('customer-form').onsubmit = event => { event.preventDefault(); run(async () => { await call('create', { name: $('customer-name').value.trim() }); await load(); return 'บันทึกลูกค้าทดสอบแล้ว / Test customer saved'; }); };
