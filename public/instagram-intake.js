let instagramIntakePage = 0;
let instagramIntakeRows = [];
let instagramIntakeSelected = null;
let instagramIntakeRequest = 0;
let instagramIntakeSaving = false;
const instagramElement = suffix => document.getElementById(`instagram-intake-${suffix}`);
function instagramIntakeContext() {
  return { version: crmScopeVersion, key: getCrmScopeKey(), account: instagramElement('account').value };
}
function instagramIntakeContextCurrent(request, scope, operation = 'view') {
  return request === instagramIntakeRequest && scope.version === crmScopeVersion && scope.key === getCrmScopeKey()
    && scope.account === instagramElement('account').value
    && (operation === 'manage' ? canManageIntakeChannel('instagram', scope.account) : canViewIntakeChannel('instagram', scope.account));
}
function syncInstagramIntakeAccounts() {
  const tabs = Array.from(instagramElement('tabs').querySelectorAll('[role="tab"]'));
  const allowed = tabs.filter(tab => canViewIntakeChannel('instagram', tab.dataset.account));
  const accountInput = instagramElement('account');
  if (!allowed.some(tab => tab.dataset.account === accountInput.value)) accountInput.value = allowed[0]?.dataset.account || '';
  for (const tab of tabs) {
    const permitted = allowed.includes(tab);
    const selected = permitted && tab.dataset.account === accountInput.value;
    tab.hidden = !permitted; tab.disabled = !permitted;
    tab.classList.toggle('hidden', !permitted);
    tab.setAttribute('aria-hidden', String(!permitted));
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) instagramElement('panel').setAttribute('aria-labelledby', tab.id);
  }
  return accountInput.value;
}
function selectInstagramAccount(tab) {
  if (!tab || !canViewIntakeChannel('instagram', tab.dataset.account)) return;
  if (tab.getAttribute('aria-selected') === 'true') return;
  for (const item of instagramElement('tabs').querySelectorAll('[role="tab"]')) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  instagramElement('account').value = tab.dataset.account;
  instagramElement('panel').setAttribute('aria-labelledby', tab.id);
  return loadInstagramIntake(0);
}
function handleInstagramAccountKey(event) {
  const tabs = Array.from(instagramElement('tabs').querySelectorAll('[role="tab"]')).filter(tab => canViewIntakeChannel('instagram', tab.dataset.account));
  const index = tabs.indexOf(event.target);
  if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  selectInstagramAccount(tabs[next]);
}
function closeInstagramIntakeForm() {
  instagramIntakeSelected = null;
  instagramElement('form').classList.add('hidden');
  instagramElement('form').reset();
}
function resetInstagramIntake() {
  instagramIntakeRequest++;
  instagramIntakeRows = [];
  closeInstagramIntakeForm();
  for (const id of ['summary','list','status','count','selected']) instagramElement(id).textContent = '';
}
async function loadInstagramIntake(page = instagramIntakePage) {
  const request = ++instagramIntakeRequest;
  syncInstagramIntakeAccounts();
  const scope = instagramIntakeContext();
  closeInstagramIntakeForm();
  instagramIntakeRows = [];
  instagramElement('list').textContent = '';
  instagramElement('summary').textContent = '';
  if (!scope.account || !canViewIntakeChannel('instagram', scope.account)) { instagramElement('status').textContent = 'ไม่มีสิทธิ์ดูรายชื่อช่องนี้'; return; }
  const canManage = canManageIntakeChannel('instagram', instagramElement('account').value);
  instagramElement('save').disabled = !canManage || instagramIntakeSaving;
  if (!instagramElement('date').value) instagramElement('date').value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  instagramElement('status').textContent = 'กำลังโหลดรายชื่อ…';
  try {
    const url = new URL(config.crmApiUrl);
    url.searchParams.set('action', 'getInstagramIntake');
    url.searchParams.set('account', scope.account);
    url.searchParams.set('date', instagramElement('date').value);
    url.searchParams.set('status', instagramElement('filter').value);
    url.searchParams.set('page', Math.max(0, page));
    const response = await crmFetch(url.toString(), { cache: 'no-store' });
    const result = await response.json();
    if (!instagramIntakeContextCurrent(request, scope)) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'โหลดไม่สำเร็จ');
    if (result.accountKey !== scope.account || !Array.isArray(result.contacts) || result.contacts.some(row => row.account_key !== scope.account)) throw new Error('บัญชีรายชื่อไม่ตรงกับบัญชีที่เลือก กรุณาโหลดใหม่');
    instagramIntakePage = result.page;
    instagramIntakeRows = result.contacts;
    instagramElement('status').textContent = '';
    const s = result.summary;
    instagramElement('summary').innerHTML = [['คนทักใหม่',s.new],['คนเดิมทัก',s.total-s.new],['คนทักทั้งหมด',s.total],['คัดเข้า CRM',s.imported]].map(([label,count]) => `<div class="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2"><p class="text-sm text-slate-500">${label}</p><strong class="text-2xl">${Number(count).toLocaleString('th-TH')}</strong></div>`).join('');
    instagramElement('list').innerHTML = renderIntakeDailyGroups(result.contacts, (row,index) => `<article class="overflow-x-auto rounded-xl border border-slate-200 px-4 py-2"><div class="flex items-center justify-between gap-4"><div class="intake-timeline-info flex flex-wrap items-center gap-x-4 gap-y-1"><strong>${escapeHtml(row.display_name || row.username || 'ยังไม่มีชื่อโปรไฟล์ — ตรวจสอบก่อนคัดเข้า')}</strong>${renderIntakeCustomerTag(row)}<span class="text-xs text-slate-500">${escapeHtml(row.username ? '@'+row.username : row.instagram_user_id)}</span><span class="text-xs">ทักครั้งแรก ${escapeHtml(new Date(row.first_seen_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}))}</span></div>${row.status==='pending' ? `<button type="button" ${canManage ? `onclick="selectInstagramIntake(${index})"` : 'disabled aria-disabled="true" title="มีสิทธิ์ดูข้อมูลอย่างเดียว"'} class="shrink-0 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800">คัดรายชื่อ</button>` : `<span class="shrink-0 text-sm">${row.status==='imported'?(row.customer_id?'เพิ่ม / เชื่อมแล้ว':'ลูกค้าถูกลบแล้ว · เก็บประวัติการคัดเข้า'):'ไม่รับเข้า'}</span>`}</div></article>`);
    instagramElement('count').textContent = `${result.total} รายการ · หน้า ${result.page + 1}`;
    instagramElement('prev').disabled = result.page === 0;
    instagramElement('next').disabled = (result.page + 1) * 30 >= result.total;
  } catch(error) { if (instagramIntakeContextCurrent(request, scope)) instagramElement('status').textContent = error.message; }
}
function selectInstagramIntake(index) {
  if (instagramIntakeSaving || !canManageIntakeChannel('instagram', instagramElement('account').value)) return;
  const selected = instagramIntakeRows[index];
  if (!selected || selected.account_key !== instagramElement('account').value || !canManageIntakeChannel('instagram', selected.account_key) || selected.status !== 'pending') return;
  instagramIntakeSelected = selected;
  instagramElement('form').reset();
  instagramElement('name').value = instagramIntakeSelected.display_name || instagramIntakeSelected.username || '';
  instagramElement('handle').value = instagramIntakeSelected.username ? '@' + instagramIntakeSelected.username : instagramIntakeSelected.display_name || '';
  const selectedContact = instagramIntakeSelected;
  const request = instagramIntakeRequest;
  const scope = instagramIntakeContext();
  loadReferralSources().then(() => { if (instagramIntakeSelected !== selectedContact || !instagramIntakeContextCurrent(request, scope, 'manage')) return; instagramElement('referral').innerHTML = '<option value="">ยังไม่ระบุ</option>' + getReferralSourceOptions(''); instagramElement('referral').value = ''; }).catch(() => {});
  instagramElement('selected').textContent = `คัดรายชื่อ: ${instagramIntakeSelected.display_name || instagramIntakeSelected.instagram_user_id}`;
  instagramElement('form').classList.remove('hidden');
  updateInstagramIntakeForm();
  instagramElement('form').scrollIntoView({behavior:'smooth',block:'center'});
}
function updateInstagramIntakeForm() {
  if (!canManageIntakeChannel('instagram', instagramElement('account').value)) { closeInstagramIntakeForm(); return; }
  const decision = instagramElement('decision').value;
  instagramElement('details').classList.toggle('hidden',decision !== 'create');
  instagramElement('details').disabled = decision !== 'create';
  instagramElement('name-label').classList.toggle('hidden',decision !== 'create');
  instagramElement('customer-label').classList.toggle('hidden',decision !== 'link');
  instagramElement('replied-label').classList.toggle('hidden',decision === 'dismiss');
  instagramElement('name').required = decision === 'create';
  instagramElement('customer').required = decision === 'link';
  instagramElement('replied').required = decision !== 'dismiss';
}
async function saveInstagramIntake() {
  if (!instagramIntakeSelected || instagramIntakeSaving || instagramIntakeSelected.account_key !== instagramElement('account').value || !canManageIntakeChannel('instagram', instagramIntakeSelected.account_key)) return;
  instagramIntakeSaving = true;
  const request = instagramIntakeRequest;
  const scope = instagramIntakeContext();
  instagramElement('save').disabled = true;
  try {
    const response = await crmFetch(config.crmApiUrl, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      action:'resolveInstagramIntake', account:scope.account, id:instagramIntakeSelected.id, decision:instagramElement('decision').value,
      customerDetails:{gender:instagramElement('gender').value,phone:instagramElement('phone').value,email:instagramElement('email').value,chat_link:instagramElement('chat-link').value,contact_handle:instagramElement('handle').value,referral_source:instagramElement('referral').value,remarks:instagramElement('remarks').value},
      customerName:instagramElement('name').value,customerId:instagramElement('customer').value,replied:instagramElement('replied').checked,
    })});
    const result = await response.json();
    if (!instagramIntakeContextCurrent(request, scope, 'manage')) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'บันทึกไม่สำเร็จ');
    await loadInstagramIntake(0);

    if (instagramIntakeContextCurrent(request + 1, scope, 'manage')) showSuccessToast('บันทึกการคัดรายชื่อแล้ว');
  } catch(error) { if (instagramIntakeContextCurrent(request, scope)) instagramElement('status').textContent = error.message; }
  finally { instagramIntakeSaving = false; instagramElement('save').disabled = !canManageIntakeChannel('instagram', instagramElement('account').value); }
}
