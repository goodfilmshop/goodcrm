let lineIntakePage = 0;
let lineIntakeRows = [];
let lineIntakeSelected = null;
let lineIntakeRequest = 0;
let lineIntakeSaving = false;
const intakeElement = suffix => document.getElementById(`line-intake-${suffix}`);
function lineIntakeName(row) {
  const name = escapeHtml(row.display_name || 'ยังไม่มีชื่อโปรไฟล์ — ตรวจสอบก่อนคัดเข้า');
  return `<strong class="font-bold text-blue-700">${name}</strong>`;
}
function selectLineAccount(tab) {
  if (tab.getAttribute('aria-selected') === 'true') return;
  for (const item of intakeElement('tabs').querySelectorAll('[role="tab"]')) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  intakeElement('account').value = tab.dataset.account;
  intakeElement('panel').setAttribute('aria-labelledby', tab.id);
  loadLineIntake(0);
}
function handleLineAccountKey(event) {
  const tabs = Array.from(intakeElement('tabs').querySelectorAll('[role="tab"]'));
  const index = tabs.indexOf(event.target);
  if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  selectLineAccount(tabs[next]);
}
function closeLineIntakeForm() {
  lineIntakeSelected = null;
  intakeElement('form').classList.add('hidden');
  intakeElement('form').reset();
}
function resetLineIntake() {
  lineIntakeRequest++;
  lineIntakeRows = [];
  closeLineIntakeForm();
  for (const id of ['summary','list','status','count','selected']) intakeElement(id).textContent = '';
}
async function loadLineIntake(page = lineIntakePage) {
  const request = ++lineIntakeRequest;
  closeLineIntakeForm();
  lineIntakeRows = [];
  intakeElement('list').textContent = '';
  intakeElement('summary').textContent = '';
  if (!isEmployeeAdministrator()) { intakeElement('status').textContent = 'เฉพาะผู้ดูแลระบบที่เข้าถึงรายชื่อรอคัดเข้าได้'; return; }
  if (!intakeElement('date').value) intakeElement('date').value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  intakeElement('status').textContent = 'กำลังโหลดรายชื่อ…';
  try {
    const url = new URL(config.crmApiUrl);
    url.searchParams.set('action', 'getLineIntake');
    url.searchParams.set('account', intakeElement('account').value);
    url.searchParams.set('date', intakeElement('date').value);
    url.searchParams.set('status', intakeElement('filter').value);
    url.searchParams.set('page', Math.max(0, page));
    const response = await crmFetch(url.toString(), { cache: 'no-store' });
    const result = await response.json();
    if (request !== lineIntakeRequest || !isEmployeeAdministrator()) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'โหลดไม่สำเร็จ');
    lineIntakePage = result.page;
    lineIntakeRows = result.contacts;
    intakeElement('status').textContent = result.enabled ? 'ปลายทางพร้อมรับข้อมูล — ยังไม่นับเป็นลูกค้าจนกว่าจะกดเพิ่มหรือเชื่อม' : result.connectionStatus === 'unreachable' ? 'ตรวจสถานะปลายทางไม่ได้ในขณะนี้ · รายชื่อที่เก็บไว้ยังแสดงได้' : 'ยังไม่ได้เปิดรับข้อมูลจริง · รอตั้งค่าการเชื่อม LINE OA';
    const s = result.summary;
    intakeElement('summary').innerHTML = [['คนทักใหม่',s.new],['คนเดิมทัก',s.total-s.new],['คนทักทั้งหมด',s.total],['คัดเข้า CRM',s.imported]].map(([label,count]) => `<div class="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2"><p class="text-sm text-slate-500">${label}</p><strong class="text-2xl">${Number(count).toLocaleString('th-TH')}</strong></div>`).join('');
    intakeElement('list').innerHTML = result.contacts.length ? result.contacts.map((row,index) => `<article class="overflow-x-auto rounded-xl border border-slate-200 px-4 py-2"><div class="flex items-center justify-between gap-4 whitespace-nowrap"><div class="flex shrink-0 items-center gap-4">${lineIntakeName(row)}<span class="text-xs text-slate-500">${escapeHtml(row.line_user_id)}</span><span class="text-xs">ทักครั้งแรก ${escapeHtml(new Date(row.first_seen_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}))}</span><span class="text-xs">ทักล่าสุด ${escapeHtml(new Date(row.last_seen_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}))}</span></div>${row.status==='pending' ? `<button type="button" onclick="selectLineIntake(${index})" class="shrink-0 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800">คัดรายชื่อ</button>` : `<span class="shrink-0 text-sm">${row.status==='imported'?(row.customer_id?'เพิ่ม / เชื่อมแล้ว':'ลูกค้าถูกลบแล้ว · เก็บประวัติการคัดเข้า'):'ไม่รับเข้า'}</span>`}</div></article>`).join('') : '<p class="py-5 text-sm text-slate-500">ไม่มีรายการในสถานะนี้</p>';
    intakeElement('count').textContent = `${result.total} รายการ · หน้า ${result.page + 1}`;
    intakeElement('prev').disabled = result.page === 0;
    intakeElement('next').disabled = (result.page + 1) * 30 >= result.total;
  } catch(error) { if (request === lineIntakeRequest) intakeElement('status').textContent = error.message; }
}
function selectLineIntake(index) {
  if (lineIntakeSaving || !isEmployeeAdministrator()) return;
  lineIntakeSelected = lineIntakeRows[index];
  if (!lineIntakeSelected) return;
  intakeElement('form').reset();
  intakeElement('name').value = lineIntakeSelected.display_name || '';
  intakeElement('handle').value = lineIntakeSelected.display_name || '';
  const selectedContact = lineIntakeSelected;
  loadReferralSources().then(() => { if (lineIntakeSelected !== selectedContact) return; intakeElement('referral').innerHTML = '<option value="">ยังไม่ระบุ</option>' + getReferralSourceOptions(''); intakeElement('referral').value = ''; }).catch(() => {});
  intakeElement('selected').textContent = `คัดรายชื่อ: ${lineIntakeSelected.display_name || lineIntakeSelected.line_user_id}`;
  intakeElement('form').classList.remove('hidden');
  updateLineIntakeForm();
  intakeElement('form').scrollIntoView({behavior:'smooth',block:'center'});
}
function updateLineIntakeForm() {
  const decision = intakeElement('decision').value;
  intakeElement('details').classList.toggle('hidden',decision !== 'create');
  intakeElement('details').disabled = decision !== 'create';
  intakeElement('name-label').classList.toggle('hidden',decision !== 'create');
  intakeElement('customer-label').classList.toggle('hidden',decision !== 'link');
  intakeElement('replied-label').classList.toggle('hidden',decision === 'dismiss');
  intakeElement('name').required = decision === 'create';
  intakeElement('customer').required = decision === 'link';
  intakeElement('replied').required = decision !== 'dismiss';
}
async function saveLineIntake() {
  if (!lineIntakeSelected || lineIntakeSaving || !isEmployeeAdministrator()) return;
  lineIntakeSaving = true;
  const request = lineIntakeRequest;
  intakeElement('save').disabled = true;
  try {
    const response = await crmFetch(config.crmApiUrl, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      action:'resolveLineIntake', id:lineIntakeSelected.id, decision:intakeElement('decision').value,
      customerDetails:{gender:intakeElement('gender').value,phone:intakeElement('phone').value,email:intakeElement('email').value,chat_link:intakeElement('chat-link').value,contact_handle:intakeElement('handle').value,referral_source:intakeElement('referral').value,remarks:intakeElement('remarks').value},
      customerName:intakeElement('name').value,customerId:intakeElement('customer').value,replied:intakeElement('replied').checked,
    })});
    const result = await response.json();
    if (request !== lineIntakeRequest || !isEmployeeAdministrator()) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'บันทึกไม่สำเร็จ');
    await loadLineIntake(0);
    if (isEmployeeAdministrator()) showSuccessToast('บันทึกการคัดรายชื่อแล้ว');
  } catch(error) { if (request === lineIntakeRequest) intakeElement('status').textContent = error.message; }
  finally { lineIntakeSaving = false; intakeElement('save').disabled = false; }
}
