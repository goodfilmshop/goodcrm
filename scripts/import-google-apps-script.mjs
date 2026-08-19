import { createClient } from '@supabase/supabase-js';

const requiredEnvironment = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GOOD_CRM_APPS_SCRIPT_URL',
  'APPS_SCRIPT_SHARED_SECRET'
];

for (const key of requiredEnvironment) {
  if (!process.env[key]) {
    throw new Error(`Missing ${key}. Keep the service-role key in the terminal environment only; never add it to public/index.html.`);
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const sourceUrl = process.env.GOOD_CRM_APPS_SCRIPT_URL;
const appsScriptSharedSecret = process.env.APPS_SCRIPT_SHARED_SECRET;
const batchSize = 250;

function nullable(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function toIsoTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function makeUrl(action, params = {}) {
  const url = new URL(sourceUrl);
  url.searchParams.set('action', action);
  url.searchParams.set('apiKey', appsScriptSharedSecret);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

async function readJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.error || `Source request failed (${response.status})`);
  return payload;
}

async function getAllCustomers() {
  const customers = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result = await readJson(makeUrl('getLeads', { page, pageSize: 100 }));
    customers.push(...(result.leads || []));
    totalPages = Number(result.pagination?.totalPages) || 1;
    page += 1;
  } while (page <= totalPages);

  return customers;
}

async function getAllCases() {
  const result = await readJson(makeUrl('getCases'));
  return Array.isArray(result.cases) ? result.cases : [];
}

function chunk(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

async function upsertInBatches(table, rows, options) {
  for (const batch of chunk(rows, batchSize)) {
    if (!batch.length) continue;
    const { error } = await supabase.from(table).upsert(batch, options);
    if (error) throw new Error(`${table} import failed: ${error.message}`);
  }
}

const [sourceCustomers, sourceCases] = await Promise.all([getAllCustomers(), getAllCases()]);

const customerRows = sourceCustomers
  .map((customer) => ({
    legacy_cust_id: nullable(customer.Cust_ID),
    recorded_at: toIsoTimestamp(customer['วันที่บันทึก']),
    customer_name: nullable(customer['ชื่อลูกค้า']) || 'ไม่ระบุชื่อลูกค้า',
    gender: nullable(customer['เพศ']) || 'ไม่ระบุ',
    phone: nullable(customer['เบอร์โทรศัพท์']),
    contact_channel: nullable(customer['ช่องทางติดต่อ']),
    contact_handle: nullable(customer['ชื่อช่องทางติดต่อ']),
    referral_source: nullable(customer['รู้จักครั้งแรก']),
    remarks: nullable(customer['หมายเหตุ'])
  }))
  .filter((customer) => customer.legacy_cust_id);

const customerIds = new Set(customerRows.map((customer) => customer.legacy_cust_id));
for (const item of sourceCases) {
  const legacyCustomerId = nullable(item.customerId);
  if (!legacyCustomerId || customerIds.has(legacyCustomerId)) continue;
  customerIds.add(legacyCustomerId);
  customerRows.push({
    legacy_cust_id: legacyCustomerId,
    recorded_at: toIsoTimestamp(item.date),
    customer_name: nullable(item.customerName) || 'ลูกค้าจากข้อมูลเคสเดิม',
    gender: 'ไม่ระบุ',
    phone: nullable(item.customerPhone),
    remarks: 'สร้างอัตโนมัติระหว่างย้ายข้อมูล เพราะไม่พบข้อมูลลูกค้าต้นทาง'
  });
}

await upsertInBatches('customers', customerRows, { onConflict: 'legacy_cust_id' });

const { data: savedCustomers, error: customerLookupError } = await supabase
  .from('customers')
  .select('id, legacy_cust_id')
  .in('legacy_cust_id', customerRows.map((customer) => customer.legacy_cust_id));
if (customerLookupError) throw new Error(`Could not read imported customers: ${customerLookupError.message}`);

const customerIdByLegacyId = new Map(savedCustomers.map((customer) => [customer.legacy_cust_id, customer.id]));
const caseRows = sourceCases
  .map((item) => {
    const legacyCustomerId = nullable(item.customerId);
    const customerId = customerIdByLegacyId.get(legacyCustomerId);
    if (!customerId) return null;
    return {
      legacy_case_id: nullable(item.caseId) || `sheet-row-${item.rowNumber || crypto.randomUUID()}`,
      customer_id: customerId,
      recorded_at: toIsoTimestamp(item.date) || new Date().toISOString(),
      admin_name: nullable(item.admin),
      customer_type: nullable(item.customerType),
      topic: nullable(item.topic),
      priority: nullable(item.priority),
      site_type: nullable(item.siteType),
      site_address: nullable(item.siteAddress),
      location_text: nullable(item.location),
      province: nullable(item.province),
      product_interest: nullable(item.interests),
      job_details: nullable(item.jobDetails),
      budget: nullable(item.budget),
      salesperson: nullable(item.salesperson),
      company: nullable(item.company),
      status: nullable(item.status) || 'ติดต่อสอบถาม',
      remarks: nullable(item.remarks),
      chat_link: nullable(item.chatLink),
      external_link: nullable(item.link)
    };
  })
  .filter(Boolean);

await upsertInBatches('cases', caseRows, { onConflict: 'legacy_case_id' });

console.log(JSON.stringify({
  importedCustomers: customerRows.length,
  importedCases: caseRows.length,
  sourceCustomers: sourceCustomers.length,
  sourceCases: sourceCases.length
}, null, 2));
