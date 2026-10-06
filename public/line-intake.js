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
function lineIntakeContext() {
  return { version: crmScopeVersion, key: getCrmScopeKey(), account: intakeElement('account').value };
}
function lineIntakeContextCurrent(request, scope, operation = 'view') {
  return request === lineIntakeRequest && scope.version === crmScopeVersion && scope.key === getCrmScopeKey()
    && scope.account === intakeElement('account').value
    && (operation === 'manage' ? canManageIntakeChannel('line', scope.account) : canViewIntakeChannel('line', scope.account));
}
function syncLineIntakeAccounts() {
  const tabs = Array.from(intakeElement('tabs').querySelectorAll('[role="tab"]'));
  const allowed = tabs.filter(tab => canViewIntakeChannel('line', tab.dataset.account));
  const accountInput = intakeElement('account');
  if (!allowed.some(tab => tab.dataset.account === accountInput.value)) accountInput.value = allowed[0]?.dataset.account || '';
  for (const tab of tabs) {
    const permitted = allowed.includes(tab);
    const selected = permitted && tab.dataset.account === accountInput.value;
    tab.hidden = !permitted; tab.disabled = !permitted;
    tab.classList.toggle('hidden', !permitted);
    tab.setAttribute('aria-hidden', String(!permitted));
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) intakeElement('panel').setAttribute('aria-labelledby', tab.id);
  }
  return accountInput.value;
}
function selectLineAccount(tab) {
  if (!tab || !canViewIntakeChannel('line', tab.dataset.account)) return;
  if (tab.getAttribute('aria-selected') === 'true') return;
  for (const item of intakeElement('tabs').querySelectorAll('[role="tab"]')) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  intakeElement('account').value = tab.dataset.account;
  intakeElement('panel').setAttribute('aria-labelledby', tab.id);
  return loadLineIntake(0);
}
function handleLineAccountKey(event) {
  const tabs = Array.from(intakeElement('tabs').querySelectorAll('[role="tab"]')).filter(tab => canViewIntakeChannel('line', tab.dataset.account));
  const index = tabs.indexOf(event.target);
  if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  selectLineAccount(tabs[next]);
}
function closeLineIntakeForm() {
  IntakeDrawer.close(intakeElement('form'));
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
  syncLineIntakeAccounts();
  const scope = lineIntakeContext();
  closeLineIntakeForm();
  lineIntakeRows = [];
  intakeElement('list').textContent = '';
  intakeElement('summary').textContent = '';
  if (!scope.account || !canViewIntakeChannel('line', scope.account)) { intakeElement('status').textContent = 'ไม่มีสิทธิ์ดูรายชื่อช่องนี้'; return; }
  const canManage = canManageIntakeChannel('line', intakeElement('account').value);
  intakeElement('save').disabled = !canManage || lineIntakeSaving;
  if (!intakeElement('date').value) intakeElement('date').value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  intakeElement('status').textContent = 'กำลังโหลดรายชื่อ…';
  try {
    const url = new URL(config.crmApiUrl);
    url.searchParams.set('action', 'getLineIntake');
    url.searchParams.set('account', scope.account);
    url.searchParams.set('date', intakeElement('date').value);
    url.searchParams.set('status', intakeElement('filter').value);
    url.searchParams.set('page', Math.max(0, page));
    const response = await crmFetch(url.toString(), { cache: 'no-store' });
    const result = await response.json();
    if (!lineIntakeContextCurrent(request, scope)) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'โหลดไม่สำเร็จ');
    if (result.accountKey !== scope.account || !Array.isArray(result.contacts) || result.contacts.some(row => row.account_key !== scope.account)) throw new Error('บัญชีรายชื่อไม่ตรงกับบัญชีที่เลือก กรุณาโหลดใหม่');
    lineIntakePage = result.page;
    lineIntakeRows = result.contacts;
    intakeElement('status').textContent = '';
    const s = result.summary;
    intakeElement('summary').innerHTML = [['คนทักใหม่',s.new],['คนเดิมทัก',s.total-s.new],['คนทักทั้งหมด',s.total],['คัดเข้า CRM',s.imported]].map(([label,count]) => `<div class="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2"><p class="text-sm text-slate-500">${label}</p><strong class="text-2xl">${Number(count).toLocaleString('th-TH')}</strong></div>`).join('');
    intakeElement('list').innerHTML = renderIntakeDailyGroups(result.contacts, (row,index) => `<article class="overflow-x-auto rounded-xl border border-slate-200 px-4 py-2"><div class="flex items-center justify-between gap-4"><div class="intake-timeline-info flex flex-wrap items-center gap-x-4 gap-y-1">${lineIntakeName(row)}${renderIntakeCustomerTag(row)}<span class="text-xs text-slate-500">${escapeHtml(row.line_user_id)}</span><span class="text-xs">ทักครั้งแรก ${escapeHtml(new Date(row.first_seen_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}))}</span></div>${['pending','dismissed'].includes(row.status) ? `<button type="button" ${canManage ? `onclick="selectLineIntake(${index})"` : 'disabled aria-disabled="true" title="มีสิทธิ์ดูข้อมูลอย่างเดียว"'} class="shrink-0 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800">${row.status === 'dismissed' ? 'รับเข้าอีกครั้ง' : 'คัดรายชื่อ'}</button>` : `<span class="shrink-0 text-sm">${row.status==='imported'?(row.customer_id?'เพิ่ม / เชื่อมแล้ว':'ลูกค้าถูกลบแล้ว · เก็บประวัติการคัดเข้า'):'ไม่รับเข้า'}</span>`}</div></article>`);
    intakeElement('count').textContent = `${result.total} รายการ · หน้า ${result.page + 1}`;
    intakeElement('prev').disabled = result.page === 0;
    intakeElement('next').disabled = (result.page + 1) * 30 >= result.total;
  } catch(error) { if (lineIntakeContextCurrent(request, scope)) intakeElement('status').textContent = error.message; }
}
function selectLineIntake(index) {
  if (lineIntakeSaving || !canManageIntakeChannel('line', intakeElement('account').value)) return;
  const selected = lineIntakeRows[index];
  if (!selected || selected.account_key !== intakeElement('account').value || !canManageIntakeChannel('line', selected.account_key) || !['pending','dismissed'].includes(selected.status)) return;
  lineIntakeSelected = selected;
  intakeElement('form').reset();
  intakeElement('name').value = lineIntakeSelected.display_name || '';
  intakeElement('handle').value = lineIntakeSelected.display_name || '';
  const suggestions = lineIntakeSelected.contact_suggestions || {};
  for (const key of ['name', 'phone', 'email', 'gender']) {
    const values = Array.isArray(suggestions[key]) ? suggestions[key].filter(v => typeof v === 'string') : [];
    if (values.length === 1) {
      intakeElement(key).value = values[0];
    }
  }
  const selectedContact = lineIntakeSelected;
  const request = lineIntakeRequest;
  const scope = lineIntakeContext();
  loadReferralSources().then(() => { if (lineIntakeSelected !== selectedContact || !lineIntakeContextCurrent(request, scope, 'manage')) return; intakeElement('referral').innerHTML = '<option value="">ยังไม่ระบุ</option>' + getReferralSourceOptions(''); intakeElement('referral').value = ''; }).catch(() => {});
  intakeElement('selected').textContent = `${lineIntakeSelected.status === 'dismissed' ? 'รับเข้าอีกครั้ง' : 'คัดรายชื่อ'}: ${lineIntakeSelected.display_name || lineIntakeSelected.line_user_id}`;
  intakeElement('form').classList.remove('hidden');
  updateLineIntakeForm();
  IntakeDrawer.open(intakeElement('form'), closeLineIntakeForm, () => lineIntakeSaving);
}
function updateLineIntakeForm() {
  if (!canManageIntakeChannel('line', intakeElement('account').value)) { closeLineIntakeForm(); return; }
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
  if (!lineIntakeSelected || lineIntakeSaving || lineIntakeSelected.account_key !== intakeElement('account').value || !canManageIntakeChannel('line', lineIntakeSelected.account_key)) return;
  lineIntakeSaving = true;
  const request = lineIntakeRequest;
  const scope = lineIntakeContext();
  intakeElement('save').disabled = true;
  try {
    const response = await crmFetch(config.crmApiUrl, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      action:'resolveLineIntake', account:scope.account, id:lineIntakeSelected.id, decision:intakeElement('decision').value,
      customerDetails:{gender:intakeElement('gender').value,phone:intakeElement('phone').value,email:intakeElement('email').value,chat_link:intakeElement('chat-link').value,contact_handle:intakeElement('handle').value,referral_source:intakeElement('referral').value,remarks:intakeElement('remarks').value},
      customerName:intakeElement('name').value,customerId:intakeElement('customer').value,replied:intakeElement('replied').checked,
    })});
    const result = await response.json();
    if (!lineIntakeContextCurrent(request, scope, 'manage')) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'บันทึกไม่สำเร็จ');
    await loadLineIntake(0);
    if (typeof scheduleIntakeNotificationRefresh === 'function') scheduleIntakeNotificationRefresh();
    if (lineIntakeContextCurrent(request + 1, scope, 'manage')) showSuccessToast('บันทึกการคัดรายชื่อแล้ว');
  } catch(error) { if (lineIntakeContextCurrent(request, scope)) { intakeElement('status').textContent = error.message; IntakeDrawer.showError(intakeElement('form'), error.message); } }
  finally { lineIntakeSaving = false; intakeElement('save').disabled = !canManageIntakeChannel('line', intakeElement('account').value); }
}
