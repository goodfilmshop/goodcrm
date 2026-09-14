const DEFAULT_BUCKETS = ['announcement-images', 'quotation-images'];
const verifiedPlan = require('./storage-plan.json');

// This is a CRM allocation, not the provider's billing quota or per-file limit.
async function getStorageOverview(client, membership, environment = process.env) {
  if (membership?.role !== 'admin') {
    const error = new Error('เฉพาะผู้ดูแลระบบเท่านั้นที่ดูข้อมูล Storage ได้');
    error.status = 403;
    error.code = 'STORAGE_ADMIN_REQUIRED';
    throw error;
  }
  const bucketIds = [...new Set(String(environment.CRM_STORAGE_BUCKETS || DEFAULT_BUCKETS.join(','))
    .split(',').map(value => value.trim()).filter(Boolean))];
  const configuredQuota = Number(environment.CRM_STORAGE_QUOTA_BYTES);
  const projectPlan = environment.SUPABASE_URL === `https://${verifiedPlan.projectRef}.supabase.co` ? verifiedPlan : null;
  const quotaBytes = projectPlan ? projectPlan.quotaBytes : Number.isSafeInteger(configuredQuota) && configuredQuota > 0 ? configuredQuota : null;
  const files = [];
  const buckets = [];
  let requests = 0;
  let unknownSizeCount = 0;
  for (const bucket of bucketIds) {
    const folders = [''];
    const visited = new Set();
    let usedBytes = 0;
    let fileCount = 0;
    while (folders.length) {
      const folder = folders.pop();
      if (visited.has(folder)) continue;
      visited.add(folder);
      for (let offset = 0; ; offset += 100) {
        if (++requests > 2000) throw new Error('รายการ Storage มีขนาดใหญ่เกินกว่าจะสรุปได้ในครั้งเดียว');
        const { data, error } = await client.storage.from(bucket).list(folder, {
          limit: 100, offset, sortBy: { column: 'name', order: 'asc' },
        });
        if (error || !Array.isArray(data)) throw new Error(`ไม่สามารถอ่าน Storage หมวด ${bucket} ได้ กรุณาลองใหม่`);
        for (const item of data) {
          const path = folder ? `${folder}/${item.name}` : item.name;
          if (item.id === null && item.metadata === null) {
            folders.push(path);
            continue;
          }
          const rawSize = item.metadata?.size;
          const size = rawSize !== null && rawSize !== undefined && Number.isSafeInteger(Number(rawSize)) && Number(rawSize) >= 0
            ? Number(rawSize) : null;
          if (size === null) unknownSizeCount++;
          usedBytes += size || 0;
          fileCount++;
          files.push({ bucket, path, size, mimeType: item.metadata?.mimetype || '', updatedAt: item.updated_at || item.created_at || null });
        }
        if (data.length < 100) break;
      }
    }
    buckets.push({ id: bucket, usedBytes, fileCount });
  }
  let usedBytes = buckets.reduce((total, bucket) => total + bucket.usedBytes, 0);
  let totalFileCount = files.length;
  if (projectPlan) {
    const { data, error } = await client.rpc('crm_storage_usage_summary');
    if (error || !data || !['usedBytes', 'fileCount', 'unknownSizeCount'].every(key => Number.isSafeInteger(Number(data[key])) && Number(data[key]) >= 0)) {
      throw new Error('ไม่สามารถอ่านยอดพื้นที่ Storage ทั้งโปรเจกต์ได้ กรุณาลองใหม่');
    }
    usedBytes = Number(data.usedBytes);
    totalFileCount = Number(data.fileCount);
    unknownSizeCount = Number(data.unknownSizeCount);
    if (Array.isArray(data.files)) {
      const readable = new Set(files.map(file => JSON.stringify([file.bucket, file.path])));
      files.splice(0, files.length, ...data.files.map(file => ({
        ...file, metadataOnly: !readable.has(JSON.stringify([file.bucket, file.path])),
      })));
      buckets.splice(0, buckets.length);
      for (const file of files) {
        let bucket = buckets.find(item => item.id === file.bucket);
        if (!bucket) { bucket = { id: file.bucket, usedBytes: 0, fileCount: 0 }; buckets.push(bucket); }
        bucket.usedBytes += Number(file.size) || 0;
        bucket.fileCount++;
      }
    }
  }
  return {
    success: true, buckets, files, usedBytes, quotaBytes, unknownSizeCount,
    totalFileCount,
    plan: projectPlan?.plan || null,
    planVerifiedAt: projectPlan?.verifiedAt || null,
    remainingBytes: quotaBytes !== null && !unknownSizeCount ? Math.max(0, quotaBytes - usedBytes) : null,
    overQuotaBytes: quotaBytes !== null && !unknownSizeCount ? Math.max(0, usedBytes - quotaBytes) : null,
    checkedAt: new Date().toISOString(),
  };
}

async function deleteStorageFile(client, membership, input, environment = process.env) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status, code: 'STORAGE_DELETE_FAILED' }); };
  if (membership?.role !== 'admin') fail(403, 'เฉพาะผู้ดูแลระบบเท่านั้นที่ลบไฟล์ได้');
  const buckets = String(environment.CRM_STORAGE_BUCKETS || DEFAULT_BUCKETS.join(',')).split(',').map(value => value.trim());
  const bucket = input?.bucket;
  const path = input?.path;
  if (!buckets.includes(bucket) || typeof path !== 'string' || !path || path.length > 1024 || path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/.test(path)) {
    fail(400, 'หมวดหรือชื่อไฟล์ไม่ถูกต้อง');
  }
  // User-scoped Storage API keeps the existing object delete policies in force.
  const { data, error } = await client.storage.from(bucket).remove([path]);
  if (error) fail(403, 'ไม่สามารถลบไฟล์ได้ กรุณาตรวจสอบสิทธิ์และลองใหม่');
  if (!Array.isArray(data) || !data.some(item => item.name === path)) fail(404, 'ไม่พบไฟล์หรือไม่มีสิทธิ์ลบไฟล์นี้ กรุณารีเฟรชข้อมูล');
  return { success: true };
}

module.exports = { getStorageOverview, deleteStorageFile };
