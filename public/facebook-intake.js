let facebookIntakePage = 0;
let facebookIntakeRows = [];
let facebookIntakeSelected = null;
let facebookIntakeRequest = 0;
let facebookIntakeSaving = false;
const facebookElement = suffix => document.getElementById(`facebook-intake-${suffix}`);
function facebookIntakeContext() {
  return { version: crmScopeVersion, key: getCrmScopeKey(), account: facebookElement('account').value };
}
function facebookIntakeContextCurrent(request, scope, operation = 'view') {
  return request === facebookIntakeRequest && scope.version === crmScopeVersion && scope.key === getCrmScopeKey()
    && scope.account === facebookElement('account').value
    && (operation === 'manage' ? canManageIntakeChannel('facebook', scope.account) : canViewIntakeChannel('facebook', scope.account));
}
function syncFacebookIntakeAccounts() {
  const tabs = Array.from(facebookElement('tabs').querySelectorAll('[role="tab"]'));
  const allowed = tabs.filter(tab => canViewIntakeChannel('facebook', tab.dataset.account));
  const accountInput = facebookElement('account');
  if (!allowed.some(tab => tab.dataset.account === accountInput.value)) accountInput.value = allowed[0]?.dataset.account || '';
  for (const tab of tabs) {
    const permitted = allowed.includes(tab);
    const selected = permitted && tab.dataset.account === accountInput.value;
    tab.hidden = !permitted; tab.disabled = !permitted;
    tab.classList.toggle('hidden', !permitted);
    tab.setAttribute('aria-hidden', String(!permitted));
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) facebookElement('panel').setAttribute('aria-labelledby', tab.id);
  }
  return accountInput.value;
}
function selectFacebookAccount(tab) {
  if (!tab || !canViewIntakeChannel('facebook', tab.dataset.account)) return;
  if (tab.getAttribute('aria-selected') === 'true') return;
  for (const item of facebookElement('tabs').querySelectorAll('[role="tab"]')) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  facebookElement('account').value = tab.dataset.account;
  facebookElement('panel').setAttribute('aria-labelledby', tab.id);
  return loadFacebookIntake(0);
}
function handleFacebookAccountKey(event) {
  const tabs = Array.from(facebookElement('tabs').querySelectorAll('[role="tab"]')).filter(tab => canViewIntakeChannel('facebook', tab.dataset.account));
  const index = tabs.indexOf(event.target);
  if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  selectFacebookAccount(tabs[next]);
}
function closeFacebookIntakeForm() {
  IntakeDrawer.close(facebookElement('form'));
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
  syncFacebookIntakeAccounts();
  const scope = facebookIntakeContext();
  closeFacebookIntakeForm();
  facebookIntakeRows = [];
  facebookElement('list').textContent = '';
  facebookElement('summary').textContent = '';
  if (!scope.account || !canViewIntakeChannel('facebook', scope.account)) { facebookElement('status').textContent = 'ไม่มีสิทธิ์ดูรายชื่อช่องนี้'; return; }
  const canManage = canManageIntakeChannel('facebook', facebookElement('account').value);
  facebookElement('save').disabled = !canManage || facebookIntakeSaving;
  if (!facebookElement('date').value) facebookElement('date').value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  facebookElement('status').textContent = 'กำลังโหลดรายชื่อ…';
  try {
    const url = new URL(config.crmApiUrl);
    url.searchParams.set('action', 'getFacebookIntake');
    url.searchParams.set('account', scope.account);
    url.searchParams.set('date', facebookElement('date').value);
    url.searchParams.set('status', facebookElement('filter').value);
    url.searchParams.set('page', Math.max(0, page));
    const response = await crmFetch(url.toString(), { cache: 'no-store' });
    const result = await response.json();
    if (!facebookIntakeContextCurrent(request, scope)) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'โหลดไม่สำเร็จ');
    if (result.accountKey !== scope.account || !Array.isArray(result.contacts) || result.contacts.some(row => row.account_key !== scope.account)) throw new Error('บัญชีรายชื่อไม่ตรงกับบัญชีที่เลือก กรุณาโหลดใหม่');
    facebookIntakePage = result.page;
    facebookIntakeRows = result.contacts;
    facebookElement('status').textContent = '';
    const s = result.summary;
    facebookElement('summary').innerHTML = [['คนทักใหม่',s.new],['คนเดิมทัก',s.total-s.new],['คนทักทั้งหมด',s.total],['คัดเข้า CRM',s.imported]].map(([label,count]) => `<div class="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2"><p class="text-sm text-slate-500">${label}</p><strong class="text-2xl">${Number(count).toLocaleString('th-TH')}</strong></div>`).join('');
    facebookElement('list').innerHTML = renderIntakeDailyGroups(result.contacts, (row,index) => `<article class="overflow-x-auto rounded-xl border border-slate-200 px-4 py-2"><div class="flex items-center justify-between gap-4"><div class="intake-timeline-info flex flex-wrap items-center gap-x-4 gap-y-1"><strong>${escapeHtml(row.display_name || 'ยังไม่มีชื่อโปรไฟล์ — ตรวจสอบก่อนคัดเข้า')}</strong>${renderIntakeCustomerTag(row)}<span class="text-xs text-slate-500">${escapeHtml(row.facebook_user_id)}</span><span class="text-xs">ทักครั้งแรก ${escapeHtml(new Date(row.first_seen_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}))}</span></div>${['pending','dismissed'].includes(row.status) ? `<button type="button" ${canManage ? `onclick="selectFacebookIntake(${index})"` : 'disabled aria-disabled="true" title="มีสิทธิ์ดูข้อมูลอย่างเดียว"'} class="shrink-0 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800">${row.status === 'dismissed' ? 'รับเข้าอีกครั้ง' : 'คัดรายชื่อ'}</button>` : `<span class="shrink-0 text-sm">${row.status==='imported'?(row.customer_id?'เพิ่ม / เชื่อมแล้ว':'ลูกค้าถูกลบแล้ว · เก็บประวัติการคัดเข้า'):'ไม่รับเข้า'}</span>`}</div></article>`);
    facebookElement('count').textContent = `${result.total} รายการ · หน้า ${result.page + 1}`;
    facebookElement('prev').disabled = result.page === 0;
    facebookElement('next').disabled = (result.page + 1) * 30 >= result.total;
  } catch(error) { if (facebookIntakeContextCurrent(request, scope)) facebookElement('status').textContent = error.message; }
}
function selectFacebookIntake(index) {
  if (facebookIntakeSaving || !canManageIntakeChannel('facebook', facebookElement('account').value)) return;
  const selected = facebookIntakeRows[index];
  if (!selected || selected.account_key !== facebookElement('account').value || !canManageIntakeChannel('facebook', selected.account_key) || !['pending','dismissed'].includes(selected.status)) return;
  facebookIntakeSelected = selected;
  facebookElement('form').reset();
  facebookElement('name').value = facebookIntakeSelected.display_name || '';
  facebookElement('handle').value = facebookIntakeSelected.display_name || '';
  const selectedContact = facebookIntakeSelected;
  const request = facebookIntakeRequest;
  const scope = facebookIntakeContext();
  loadReferralSources().then(() => { if (facebookIntakeSelected !== selectedContact || !facebookIntakeContextCurrent(request, scope, 'manage')) return; facebookElement('referral').innerHTML = '<option value="">ยังไม่ระบุ</option>' + getReferralSourceOptions(''); facebookElement('referral').value = ''; }).catch(() => {});
  facebookElement('selected').textContent = `${facebookIntakeSelected.status === 'dismissed' ? 'รับเข้าอีกครั้ง' : 'คัดรายชื่อ'}: ${facebookIntakeSelected.display_name || facebookIntakeSelected.facebook_user_id}`;
  facebookElement('form').classList.remove('hidden');
  updateFacebookIntakeForm();
  IntakeDrawer.open(facebookElement('form'), closeFacebookIntakeForm, () => facebookIntakeSaving);
}
function updateFacebookIntakeForm() {
  if (!canManageIntakeChannel('facebook', facebookElement('account').value)) { closeFacebookIntakeForm(); return; }
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
  if (!facebookIntakeSelected || facebookIntakeSaving || facebookIntakeSelected.account_key !== facebookElement('account').value || !canManageIntakeChannel('facebook', facebookIntakeSelected.account_key)) return;
  facebookIntakeSaving = true;
  const request = facebookIntakeRequest;
  const scope = facebookIntakeContext();
  facebookElement('save').disabled = true;
  try {
    const response = await crmFetch(config.crmApiUrl, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      action:'resolveFacebookIntake', account:scope.account, id:facebookIntakeSelected.id, decision:facebookElement('decision').value,
      customerDetails:{gender:facebookElement('gender').value,phone:facebookElement('phone').value,email:facebookElement('email').value,chat_link:facebookElement('chat-link').value,contact_handle:facebookElement('handle').value,referral_source:facebookElement('referral').value,remarks:facebookElement('remarks').value},
      customerName:facebookElement('name').value,customerId:facebookElement('customer').value,replied:facebookElement('replied').checked,
    })});
    const result = await response.json();
    if (!facebookIntakeContextCurrent(request, scope, 'manage')) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'บันทึกไม่สำเร็จ');
    await loadFacebookIntake(0);
    if (typeof scheduleIntakeNotificationRefresh === 'function') scheduleIntakeNotificationRefresh();
    if (facebookIntakeContextCurrent(request + 1, scope, 'manage')) showSuccessToast('บันทึกการคัดรายชื่อแล้ว');
  } catch(error) { if (facebookIntakeContextCurrent(request, scope)) { facebookElement('status').textContent = error.message; IntakeDrawer.showError(facebookElement('form'), error.message); } }
  finally { facebookIntakeSaving = false; facebookElement('save').disabled = !canManageIntakeChannel('facebook', facebookElement('account').value); }
}
