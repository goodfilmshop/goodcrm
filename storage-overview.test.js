const test = require('node:test');
const assert = require('node:assert/strict');
const { getStorageOverview, deleteStorageFile } = require('./storage-overview');
const admin = { role: 'admin' };
test('storage deletion validates admin, bucket and exact path before issuing remove', async () => {
  const calls = [];
  const api = { storage: { from: bucket => ({ remove: async paths => {
    calls.push({ bucket, paths }); return { data: paths.map(name => ({ name })) };
  } }) } };
  const input = { bucket: 'announcement-images', path: 'announcements/test.png' };
  await assert.rejects(deleteStorageFile(api, { role: 'manager' }, input, {}), error => error.status === 403);
  for (const invalid of [{ ...input, bucket: 'other' }, { ...input, path: '../file' }, { ...input, path: '' }]) {
    await assert.rejects(deleteStorageFile(api, admin, invalid, {}), error => error.status === 400);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await deleteStorageFile(api, admin, input, {}), { success: true });
  assert.deepEqual(calls, [{ bucket: input.bucket, paths: [input.path] }]);
  api.storage.from = () => ({ remove: async () => ({ data: [] }) });
  await assert.rejects(deleteStorageFile(api, admin, input, {}), error => error.status === 404);
  api.storage.from = () => ({ remove: async () => ({ error: { message: 'denied' } }) });
  await assert.rejects(deleteStorageFile(api, admin, input, {}), error => error.status === 403);
});
const file = (name, size) => ({ id: name, name, metadata: { size, mimetype: 'image/webp' } });
const client = list => ({ storage: { from: bucket => ({ list: (path, options) => list(bucket, path, options) }) } });

test('verified project quota uses whole-project totals, not only visible files', async () => {
  const api = client(async () => ({ data: [] }));
  api.rpc = async name => {
    assert.equal(name, 'crm_storage_usage_summary');
    return { data: { usedBytes: 3370956, fileCount: 10, unknownSizeCount: 0 } };
  };
  const env = { SUPABASE_URL: 'https://mbxuebqqglaeechltkyl.supabase.co' };
  const result = await getStorageOverview(api, admin, env);
  assert.equal(result.files.length, 0);
  assert.equal(result.totalFileCount, 10);
  assert.equal(result.quotaBytes, 1000000000);
  assert.equal(result.remainingBytes, 996629044);
  api.rpc = async () => ({ error: { message: 'unavailable' } });
  await assert.rejects(getStorageOverview(api, admin, env), /ทั้งโปรเจกต์/);
});

test('storage rejects non-admins before reading any files', async () => {
  for (const membership of [null, { role: 'sales' }, { role: 'manager' }]) {
    await assert.rejects(getStorageOverview(null, membership), error => error.status === 403);
  }
});

test('inventory includes inaccessible files as metadata only and counts their buckets', async () => {
  const api = client(async () => ({ data: [] }));
  api.rpc = async () => ({ data: { usedBytes: 123, fileCount: 1, unknownSizeCount: 0,
    files: [{ bucket: 'quotation-images', path: 'cases/deleted/image.webp', size: 123 }] } });
  const result = await getStorageOverview(api, admin, { SUPABASE_URL: 'https://mbxuebqqglaeechltkyl.supabase.co' });
  assert.equal(result.files[0].metadataOnly, true);
  assert.equal(result.files[0].path, 'cases/deleted/image.webp');
  assert.deepEqual(result.buckets, [{ id: 'quotation-images', usedBytes: 123, fileCount: 1 }]);
});

test('storage totals include nested folders and pages without treating a per-file limit as quota', async () => {
  const calls = [];
  const result = await getStorageOverview(client(async (bucket, path, options) => {
    calls.push([bucket, path, options.offset]);
    if (bucket === 'announcement-images') return { data: [file('announcement.webp', 50)] };
    if (!path) return { data: [{ id: null, name: 'cases', metadata: null }] };
    if (path === 'cases') return { data: [{ id: null, name: 'C001', metadata: null }] };
    return { data: options.offset === 0 ? Array.from({ length: 100 }, (_, i) => file(`${i}.webp`, 10)) : [file('last.webp', 20)] };
  }), admin, { CRM_STORAGE_QUOTA_BYTES: '2000' });
  assert.equal(result.files.length, 102);
  assert.equal(result.usedBytes, 1070);
  assert.equal(result.remainingBytes, 930);
  assert.equal(result.files.at(-1).path, 'cases/C001/last.webp');
  assert.ok(calls.some(([, path, offset]) => path === 'cases/C001' && offset === 100));
});

test('storage leaves remaining space unknown without a valid quota or with missing file sizes', async () => {
  for (const quota of ['', '-1', 'invalid', '1.5']) {
    const result = await getStorageOverview(client(async () => ({ data: [] })), admin, { CRM_STORAGE_QUOTA_BYTES: quota });
    assert.equal(result.quotaBytes, null);
    assert.equal(result.remainingBytes, null);
  }
  const result = await getStorageOverview(client(async () => ({ data: [file('unknown', undefined)] })), admin, { CRM_STORAGE_QUOTA_BYTES: '100' });
  assert.equal(result.unknownSizeCount, 2);
  assert.equal(result.remainingBytes, null);
});

test('storage handles empty buckets, custom buckets, and quota overage', async () => {
  const result = await getStorageOverview(client(async bucket => ({ data: bucket === 'empty' ? [] : [file('big', 150)] })), admin, {
    CRM_STORAGE_BUCKETS: 'empty,custom,custom', CRM_STORAGE_QUOTA_BYTES: '100',
  });
  assert.equal(result.buckets.length, 2);
  assert.equal(result.buckets[0].fileCount, 0);
  assert.equal(result.remainingBytes, 0);
  assert.equal(result.overQuotaBytes, 50);
});

test('storage fails the overview if any bucket cannot be read instead of showing a partial total', async () => {
  await assert.rejects(getStorageOverview(client(async bucket => bucket === 'quotation-images'
    ? { error: { message: 'permission denied' } } : { data: [file('ok', 10)] }), admin, {}), /ไม่สามารถอ่าน Storage/);
});
