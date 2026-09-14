let storageOverview = null;
let storagePage = 0;
let storageLoading = false;
let storageVisibleFiles = [];
let storageRequestId = 0;
let storageDeleting = false;
const storageElement = id => document.getElementById(`storage-${id}`);

function resetStorageOverview() {
  storageRequestId++;
  storageLoading = false;
  storageOverview = null;
  storagePage = 0;
  storageElement('summary').innerHTML = '';
  storageElement('status').textContent = '';
  storageElement('quota-note').textContent = '';
  storageElement('search').value = '';
  storageElement('bucket').innerHTML = '<option value="">ทุกหมวด</option>';
  storageElement('progress').classList.add('hidden');
  storageElement('refresh').disabled = false;
  renderStorageFiles();
}

function storageSize(bytes) {
  if (bytes === null || bytes === undefined) return 'ไม่ทราบขนาด';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = bytes > 0 ? Math.min(4, Math.floor(Math.log(bytes) / Math.log(1000))) : 0;
  return `${(bytes / 1000 ** index).toLocaleString('th-TH', { maximumFractionDigits: 2 })} ${units[index]}`;
}

async function loadStorageOverview() {
  if (storageLoading) return;
  const requestId = ++storageRequestId;
  storageOverview = null;
  storagePage = 0;
  storageElement('summary').innerHTML = '';
  storageElement('quota-note').textContent = '';
  storageElement('progress').classList.add('hidden');
  renderStorageFiles();
  if (!isEmployeeAdministrator()) {
    storageElement('status').textContent = 'เฉพาะผู้ดูแลระบบเท่านั้นที่ดูข้อมูล Storage ได้';
    return;
  }
  storageLoading = true;
  storageElement('refresh').disabled = true;
  storageElement('status').textContent = 'กำลังตรวจสอบพื้นที่และไฟล์ใน Storage…';
  try {
    const url = new URL(config.crmApiUrl);
    url.searchParams.set('action', 'getStorageOverview');
    const response = await crmFetch(url.toString(), { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'ไม่สามารถโหลดข้อมูล Storage ได้');
    // A completed request must not restore private data after sign-out.
    if (requestId !== storageRequestId || !isEmployeeAdministrator()) return;
    storageOverview = result;
    const cards = [
      [result.plan ? 'พื้นที่ใช้ไปทั้งโปรเจกต์' : 'พื้นที่ใช้ไป', `${result.unknownSizeCount ? 'อย่างน้อย ' : ''}${storageSize(result.usedBytes)}`],
      [result.plan ? `โควตา Supabase ${result.plan}` : 'โควตา CRM', result.quotaBytes === null ? 'ยังไม่ได้กำหนด' : storageSize(result.quotaBytes)],
      ['พื้นที่คงเหลือ', result.remainingBytes === null ? 'ยังคำนวณไม่ได้' : storageSize(result.remainingBytes)],
      ['ไฟล์ทั้งหมด', `${(result.totalFileCount ?? result.files.length).toLocaleString('th-TH')} ไฟล์`],
    ];
    storageElement('summary').innerHTML = cards.map(([label, value]) => `<div class="rounded-xl bg-slate-50 p-4"><p class="text-xs text-slate-500">${label}</p><p class="mt-2 text-xl font-bold text-slate-800">${escapeHtml(value)}</p></div>`).join('');
    storageElement('bucket').innerHTML = '<option value="">ทุกหมวด</option>' + result.buckets.map(bucket => `<option value="${escapeHtml(bucket.id)}">${escapeHtml(bucket.id)} (${bucket.fileCount})</option>`).join('');
    storageElement('quota-note').textContent = result.quotaBytes === null
      ? 'ยังไม่ได้กำหนดโควตาพื้นที่ CRM จึงไม่สามารถระบุพื้นที่คงเหลือได้'
      : 'พื้นที่คงเหลือเทียบกับโควตา CRM ที่กำหนดไว้ ไม่ใช่ยอดพื้นที่คงเหลือของแพ็กเกจ Supabase ทั้งบัญชี';
    if (result.unknownSizeCount) storageElement('quota-note').textContent += ` • มี ${result.unknownSizeCount} ไฟล์ที่ไม่ทราบขนาด`;
    if (result.plan) storageElement('quota-note').textContent = `คงเหลือเทียบโควตาแพ็กเกจ ${result.plan} ที่ตรวจสอบวันที่ ${result.planVerifiedAt} โดยหักขนาดไฟล์ปัจจุบันทั้งโปรเจกต์ • แสดงชื่อและขนาดของ ${result.files.length} ไฟล์ รวมไฟล์ที่ยังใช้พื้นที่แต่เปิดดูไม่ได้ • ยอดเรียกเก็บเงินของ Supabase คำนวณจากการใช้งานเฉลี่ยในรอบบิล`;
    if (result.overQuotaBytes > 0) storageElement('quota-note').textContent += ` • เกินโควตา ${storageSize(result.overQuotaBytes)}`;
    if (result.quotaBytes !== null && !result.unknownSizeCount) {
      storageElement('progress').value = Math.min(100, result.usedBytes / result.quotaBytes * 100);
      storageElement('progress').classList.remove('hidden');
    }
    storageElement('status').textContent = `อัปเดตล่าสุด ${new Date(result.checkedAt).toLocaleString('th-TH')} • ${result.buckets.length} หมวด`;
    renderStorageFiles(true);
  } catch (error) {
    if (requestId !== storageRequestId) return;
    storageElement('status').textContent = error.message || 'ไม่สามารถโหลดข้อมูล Storage ได้ กรุณาลองใหม่';
  } finally {
    if (requestId === storageRequestId) {
      storageLoading = false;
      storageElement('refresh').disabled = false;
    }
  }
}

function renderStorageFiles(resetPage = false) {
  if (resetPage) storagePage = 0;
  const query = storageElement('search').value.trim().toLowerCase();
  const bucket = storageElement('bucket').value;
  const filtered = (storageOverview?.files || []).filter(file => (!bucket || file.bucket === bucket) && file.path.toLowerCase().includes(query));
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  storagePage = Math.max(0, Math.min(storagePage, pages - 1));
  storageVisibleFiles = filtered.slice(storagePage * 50, (storagePage + 1) * 50);
  storageElement('files').innerHTML = storageVisibleFiles.map((file, index) => {
    const date = new Date(file.updatedAt);
    const updatedAt = file.updatedAt && !Number.isNaN(date.getTime()) ? date.toLocaleString('th-TH') : '—';
    const isImage = !file.metadataOnly && (/^image\/(png|jpeg|webp|gif|avif|bmp)$/i.test(file.mimeType) || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.path));
    const thumbnail = isImage ? `<button type="button" data-storage-preview="${index}" onclick="openStorageFile(${index}, true)" aria-label="ดูรูป ${escapeHtml(file.path)}" class="flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 text-xs text-slate-400" style="width:64px;height:64px"><span>กำลังโหลดรูป…</span></button>` : '';
    return `<tr class="border-t border-slate-100"><td class="max-w-xs p-4 font-medium text-slate-700"><div class="flex items-center gap-3">${thumbnail}<div class="min-w-0 break-all">${escapeHtml(file.path)}<div class="mt-1 text-xs text-slate-400">${escapeHtml(file.mimeType || 'ไม่ระบุชนิดไฟล์')}</div></div></div></td><td class="p-4 text-slate-500">${escapeHtml(file.bucket)}</td><td class="whitespace-nowrap p-4">${storageSize(file.size)}</td><td class="whitespace-nowrap p-4 text-slate-500">${updatedAt}</td><td class="p-4"><button type="button" class="whitespace-nowrap font-bold text-blue-600" onclick="openStorageFile(${index})">เปิดไฟล์</button></td></tr>`;
  }).join('') || `<tr><td colspan="5" class="p-8 text-center text-slate-400">${storageOverview ? 'ไม่พบไฟล์' : 'ยังไม่มีข้อมูล Storage'}</td></tr>`;
  storageElement('count').textContent = `${filtered.length.toLocaleString('th-TH')} ไฟล์ • หน้า ${storagePage + 1}/${pages}`;
  storageElement('prev').disabled = storagePage === 0;
  storageElement('next').disabled = storagePage >= pages - 1;
  storageElement('files').querySelectorAll('tr').forEach((row, index) => {
    if (!storageVisibleFiles[index]) return;
    if (storageVisibleFiles[index].metadataOnly) {
      row.lastElementChild.textContent = 'ข้อมูลไฟล์เท่านั้น';
      row.lastElementChild.className = 'p-4 text-xs text-slate-400';
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'ลบไฟล์';
    button.className = 'mt-3 block whitespace-nowrap font-bold text-rose-600 disabled:opacity-40';
    button.disabled = storageDeleting;
    button.onclick = () => requestStorageFileDeletion(index);
    row.lastElementChild.appendChild(button);
  });
  loadStorageThumbnails();
}

async function requestStorageFileDeletion(index) {
  const file = storageVisibleFiles[index];
  if (!file || file.metadataOnly || storageDeleting || !isEmployeeAdministrator()) return;
  const requestId = storageRequestId;
  storageDeleting = true;
  try {
    const confirmed = await openDocumentTemplateConfirmation({
      tone: 'rose', icon: 'fa-trash-can', eyebrow: 'ลบไฟล์จาก Storage',
      title: 'ลบไฟล์นี้ถาวรหรือไม่?',
      message: 'หากไฟล์นี้ถูกใช้ในข่าวประกาศหรือเอกสาร รูปในรายการเหล่านั้นจะไม่แสดงอีก',
      contextLabel: 'ไฟล์ที่จะลบ', contextValue: `${file.bucket} / ${file.path}`,
      warning: 'ลบแล้วไม่สามารถกู้คืนจากหน้านี้ได้ กรุณาตรวจสอบชื่อไฟล์ก่อนยืนยัน',
      cancelLabel: 'ยกเลิก', confirmLabel: 'ลบไฟล์ถาวร', confirmIcon: 'fa-trash-can',
    });
    if (!confirmed || requestId !== storageRequestId || !isEmployeeAdministrator()) return;
    const response = await crmFetch(config.crmApiUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deleteStorageFile', bucket: file.bucket, path: file.path }),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'ไม่สามารถลบไฟล์ได้');
    if (requestId !== storageRequestId || !isEmployeeAdministrator()) return;
    showToast('ลบไฟล์เรียบร้อยแล้ว');
    await loadStorageOverview();
  } catch (error) {
    showToast(error.message || 'ไม่สามารถลบไฟล์ได้');
  } finally {
    storageDeleting = false;
    storageElement('files').querySelectorAll('button').forEach(button => { button.disabled = false; });
  }
}

async function loadStorageThumbnails() {
  const previews = [...storageElement('files').querySelectorAll('[data-storage-preview]')];
  await Promise.all(previews.map(async element => {
    const file = storageVisibleFiles[Number(element.dataset.storagePreview)];
    if (!file || !isEmployeeAdministrator()) return;
    try {
      const { data, error } = await supabaseClient.storage.from(file.bucket).createSignedUrl(file.path, 300);
      if (error || !data?.signedUrl) throw new Error('preview unavailable');
      if (!element.isConnected || !isEmployeeAdministrator()) return;
      const image = document.createElement('img');
      image.alt = file.path.split('/').pop();
      image.loading = 'lazy';
      image.decoding = 'async';
      image.style.cssText = 'width:100%;height:100%;object-fit:contain';
      image.onerror = () => { element.textContent = 'โหลดรูปไม่ได้ • คลิกเพื่อเปิด'; };
      image.src = data.signedUrl;
      element.replaceChildren(image);
    } catch {
      if (element.isConnected) element.textContent = 'โหลดรูปไม่ได้ • คลิกเพื่อเปิด';
    }
  }));
}

function changeStoragePage(delta) {
  storagePage += delta;
  renderStorageFiles();
}

async function openStorageFile(index, showImage = false) {
  const file = storageVisibleFiles[index];
  if (!file || file.metadataOnly || !isEmployeeAdministrator()) return;
  const preview = window.open('about:blank', '_blank');
  if (preview) preview.opener = null;
  try {
    const { data, error } = await supabaseClient.storage.from(file.bucket).createSignedUrl(file.path, 60, showImage ? {} : { download: true });
    if (error || !data?.signedUrl) throw new Error('ไม่สามารถเปิดไฟล์ได้ กรุณารีเฟรชข้อมูลแล้วลองใหม่');
    if (preview) preview.location.replace(data.signedUrl);
    else showToast('กรุณาอนุญาตหน้าต่างป๊อปอัปเพื่อเปิดไฟล์');
  } catch (error) {
    preview?.close();
    showToast(error.message);
  }
}
