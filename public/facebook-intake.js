let facebookIntakePage = 0;
let facebookIntakeRows = [];
let facebookIntakeSelected = null;
let facebookIntakeRequest = 0;
let facebookIntakeSaving = false;
const facebookElement = suffix => document.getElementById(`facebook-intake-${suffix}`);
function selectFacebookAccount(tab) {
  if (tab.getAttribute('aria-selected') === 'true') return;
  for (const item of facebookElement('tabs').querySelectorAll('[role="tab"]')) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  facebookElement('account').value = tab.dataset.account;
  facebookElement('panel').setAttribute('aria-labelledby', tab.id);
  loadFacebookIntake(0);
}
function handleFacebookAccountKey(event) {
  const tabs = Array.from(facebookElement('tabs').querySelectorAll('[role="tab"]'));
  const index = tabs.indexOf(event.target);
  if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  selectFacebookAccount(tabs[next]);
}
function closeFacebookIntakeForm() {
  facebookIntakeSelected = null;
  facebookElement('form').classList.add('hidden');
  facebookElement('form').reset();
}
function resetFacebookIntake() {
  facebookIntakeRequest++;
  facebookIntakeRows = [];
  closeFacebookIntakeForm();
  for (const id of ['summary','list','status','count','selected']) facebookElement(id).textContent = '';
}
async function loadFacebookIntake(page = facebookIntakePage) {
  const request = ++facebookIntakeRequest;
  closeFacebookIntakeForm();
  facebookIntakeRows = [];
  facebookElement('list').textContent = '';
  facebookElement('summary').textContent = '';
  if (!isEmployeeAdministrator()) { facebookElement('status').textContent = 'เฉพาะผู้ดูแลระบบที่เข้าถึงรายชื่อรอคัดเข้าได้'; return; }
  if (!facebookElement('date').value) facebookElement('date').value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  facebookElement('status').textContent = 'กำลังโหลดรายชื่อ…';
  try {
    const url = new URL(config.crmApiUrl);
    url.searchParams.set('action', 'getFacebookIntake');
    url.searchParams.set('account', facebookElement('account').value);
    url.searchParams.set('date', facebookElement('date').value);
    url.searchParams.set('status', facebookElement('filter').value);
    url.searchParams.set('page', Math.max(0, page));
    const response = await crmFetch(url.toString(), { cache: 'no-store' });
    const result = await response.json();
    if (request !== facebookIntakeRequest || !isEmployeeAdministrator()) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'โหลดไม่สำเร็จ');
    facebookIntakePage = result.page;
    facebookIntakeRows = result.contacts;
    facebookElement('status').textContent = result.enabled ? 'ปลายทางพร้อมรับข้อมูล — ยังไม่นับเป็นลูกค้าจนกว่าจะกดเพิ่มหรือเชื่อม' : result.connectionStatus === 'unreachable' ? 'ตรวจสถานะปลายทางไม่ได้ในขณะนี้ · รายชื่อที่เก็บไว้ยังแสดงได้' : 'ยังไม่ได้เปิดรับข้อมูลจริง · รอตั้งค่าการเชื่อม Meta Business Suite';
    const s = result.summary;
    facebookElement('summary').innerHTML = [['คนทักใหม่',s.new],['คนเดิมทัก',s.total-s.new],['คนทักทั้งหมด',s.total],['คัดเข้า CRM',s.imported]].map(([label,count]) => `<div class="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2"><p class="text-sm text-slate-500">${label}</p><strong class="text-2xl">${Number(count).toLocaleString('th-TH')}</strong></div>`).join('');
    facebookElement('list').innerHTML = result.contacts.length ? result.contacts.map((row,index) => `<article class="overflow-x-auto rounded-xl border border-slate-200 px-4 py-2"><div class="flex items-center justify-between gap-4 whitespace-nowrap"><div class="flex shrink-0 items-center gap-4"><strong>${escapeHtml(row.display_name || 'ยังไม่มีชื่อโปรไฟล์ — ตรวจสอบก่อนคัดเข้า')}</strong><span class="text-xs text-slate-500">${escapeHtml(row.facebook_user_id)}</span><span class="text-xs">ทักครั้งแรก ${escapeHtml(new Date(row.first_seen_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}))}</span><span class="text-xs">ทักล่าสุด ${escapeHtml(new Date(row.last_seen_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}))}</span></div>${row.status==='pending' ? `<button type="button" onclick="selectFacebookIntake(${index})" class="shrink-0 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800">คัดรายชื่อ</button>` : `<span class="shrink-0 text-sm">${row.status==='imported'?(row.customer_id?'เพิ่ม / เชื่อมแล้ว':'ลูกค้าถูกลบแล้ว · เก็บประวัติการคัดเข้า'):'ไม่รับเข้า'}</span>`}</div></article>`).join('') : '<p class="py-5 text-sm text-slate-500">ไม่มีรายการในสถานะนี้</p>';
    facebookElement('count').textContent = `${result.total} รายการ · หน้า ${result.page + 1}`;
    facebookElement('prev').disabled = result.page === 0;
    facebookElement('next').disabled = (result.page + 1) * 30 >= result.total;
  } catch(error) { if (request === facebookIntakeRequest) facebookElement('status').textContent = error.message; }
}
function selectFacebookIntake(index) {
  if (facebookIntakeSaving || !isEmployeeAdministrator()) return;
  facebookIntakeSelected = facebookIntakeRows[index];
  if (!facebookIntakeSelected) return;
  facebookElement('form').reset();
  facebookElement('name').value = facebookIntakeSelected.display_name || '';
  facebookElement('handle').value = facebookIntakeSelected.display_name || '';
  const selectedContact = facebookIntakeSelected;
  loadReferralSources().then(() => { if (facebookIntakeSelected !== selectedContact) return; facebookElement('referral').innerHTML = '<option value="">ยังไม่ระบุ</option>' + getReferralSourceOptions(''); facebookElement('referral').value = ''; }).catch(() => {});
  facebookElement('selected').textContent = `คัดรายชื่อ: ${facebookIntakeSelected.display_name || facebookIntakeSelected.facebook_user_id}`;
  facebookElement('form').classList.remove('hidden');
  updateFacebookIntakeForm();
  facebookElement('form').scrollIntoView({behavior:'smooth',block:'center'});
}
function updateFacebookIntakeForm() {
  const decision = facebookElement('decision').value;
  facebookElement('details').classList.toggle('hidden',decision !== 'create');
  facebookElement('details').disabled = decision !== 'create';
  facebookElement('name-label').classList.toggle('hidden',decision !== 'create');
  facebookElement('customer-label').classList.toggle('hidden',decision !== 'link');
  facebookElement('replied-label').classList.toggle('hidden',decision === 'dismiss');
  facebookElement('name').required = decision === 'create';
  facebookElement('customer').required = decision === 'link';
  facebookElement('replied').required = decision !== 'dismiss';
}
async function saveFacebookIntake() {
  if (!facebookIntakeSelected || facebookIntakeSaving || !isEmployeeAdministrator()) return;
  facebookIntakeSaving = true;
  const request = facebookIntakeRequest;
  facebookElement('save').disabled = true;
  try {
    const response = await crmFetch(config.crmApiUrl, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      action:'resolveFacebookIntake', id:facebookIntakeSelected.id, decision:facebookElement('decision').value,
      customerDetails:{gender:facebookElement('gender').value,phone:facebookElement('phone').value,email:facebookElement('email').value,chat_link:facebookElement('chat-link').value,contact_handle:facebookElement('handle').value,referral_source:facebookElement('referral').value,remarks:facebookElement('remarks').value},
      customerName:facebookElement('name').value,customerId:facebookElement('customer').value,replied:facebookElement('replied').checked,
    })});
    const result = await response.json();
    if (request !== facebookIntakeRequest || !isEmployeeAdministrator()) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'บันทึกไม่สำเร็จ');
    await loadFacebookIntake(0);
    if (isEmployeeAdministrator()) showSuccessToast('บันทึกการคัดรายชื่อแล้ว');
  } catch(error) { if (request === facebookIntakeRequest) facebookElement('status').textContent = error.message; }
  finally { facebookIntakeSaving = false; facebookElement('save').disabled = false; }
}
