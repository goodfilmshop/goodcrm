const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

loadLocalEnvironment();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PROJECT_URL = process.env.SUPABASE_URL;
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const geoAccess = createGeoAccessConfig(process.env);
const CRM_API_VERSION = '2026-08-19-supabase-v1';
const CASE_STATUSES = new Set([
  'รอดำเนินการ',
  'ติดต่อสอบถาม',
  'ประเมินราคา',
  'นัดวัดพื้นที่',
  'เสนอราคา',
  'ติดตามครั้งที่ 1',
  'ติดตามครั้งที่ 2',
  'ติดตามครั้งที่ 3',
  'ติดตามครั้งที่ 4',
  'ติดตามครั้งที่ 5',
  'ต่อรองราคา',
  'เซ็นต์สัญญา',
  'มัดจำก่อนติด',
  'นัดคิวติดตั้ง',
  'ติดตั้งสิ้นเสร็จ',
  'ชำระเงินครบ',
  'เก็บซิลิโคลน',
  'ยกเลิก',
]);

app.disable('x-powered-by');

function loadLocalEnvironment() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;

    const [, name, rawValue] = match;
    process.env[name] = rawValue.replace(/^(['"])(.*)\1$/, '$2');
  }
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function createGeoAccessConfig(environment) {
  // Fail closed by default. Local loopback remains available for development
  // unless GEO_ALLOW_LOCAL_DEVELOPMENT is explicitly disabled.
  const enabledByDefault = true;
  const allowedCountries = new Set(
    String(environment.GEO_ALLOWED_COUNTRIES || 'TH')
      .split(',')
      .map((country) => country.trim().toUpperCase())
      .filter((country) => /^[A-Z]{2}$/.test(country))
  );

  return {
    enabled: parseBoolean(environment.GEO_RESTRICTION_ENABLED, enabledByDefault),
    allowedCountries: allowedCountries.size ? allowedCountries : new Set(['TH']),
    countryHeader: String(environment.GEO_COUNTRY_HEADER || 'cf-ipcountry').trim().toLowerCase(),
    allowLocalDevelopment: parseBoolean(environment.GEO_ALLOW_LOCAL_DEVELOPMENT, environment.NODE_ENV !== 'production'),
  };
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').replace(/^::ffff:/i, '').toLowerCase();
  return normalized === '::1' || normalized === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function countryFromRequest(req) {
  const country = String(req.get(geoAccess.countryHeader) || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : '';
}

function sendGeoDenied(req, res, status, message) {
  res.set('Cache-Control', 'no-store, private');
  res.set('Vary', geoAccess.countryHeader);

  if (req.accepts('html')) {
    return res.status(status).type('html').send(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ไม่อนุญาตให้ใช้งาน</title></head><body><main style="font-family:system-ui,sans-serif;max-width:42rem;margin:10vh auto;padding:1.5rem;line-height:1.6"><h1>ไม่อนุญาตให้ใช้งาน</h1><p>${message}</p><p>หากคิดว่าเป็นข้อผิดพลาด โปรดติดต่อผู้ดูแลระบบ GOOD CRM</p></main></body></html>`);
  }
  return res.status(status).json({ error: message, code: status === 403 ? 'COUNTRY_NOT_ALLOWED' : 'GEOLOCATION_UNAVAILABLE' });
}

function requireAllowedCountry(req, res, next) {
  if (!geoAccess.enabled) return next();

  // Never use X-Forwarded-For here. The selected country header must be
  // added by the trusted edge and the origin must reject direct traffic;
  // otherwise a caller could forge it.
  if (geoAccess.allowLocalDevelopment && isLoopbackAddress(req.socket.remoteAddress)) {
    return next();
  }

  const country = countryFromRequest(req);
  if (!country) {
    return sendGeoDenied(req, res, 503, 'ไม่สามารถยืนยันประเทศของการเชื่อมต่อได้ ระบบจึงไม่อนุญาตให้เข้าใช้งาน');
  }
  if (!geoAccess.allowedCountries.has(country)) {
    return sendGeoDenied(req, res, 403, 'GOOD CRM อนุญาตให้ใช้งานจากประเทศไทยเท่านั้น');
  }
  return next();
}

function setSecurityHeaders(req, res, next) {
  res.set({
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  });
  next();
}

function configuredSupabaseClient(accessToken) {
  if (!PROJECT_URL || !PUBLISHABLE_KEY) return null;

  return createClient(PROJECT_URL, PUBLISHABLE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    },
  });
}

function runtimeConfig(req, res) {
  if (!PROJECT_URL || !PUBLISHABLE_KEY) {
    return res.status(503).json({
      error: 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.',
    });
  }

  res.set('Cache-Control', 'no-store, private');
  return res.json({ url: PROJECT_URL, publishableKey: PUBLISHABLE_KEY });
}

async function requireCrmMember(req, res, next) {
  const authorization = req.get('authorization') || '';
  const accessToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const userClient = configuredSupabaseClient(accessToken);

  if (!accessToken) {
    return res.status(401).json({ error: 'Authentication is required.' });
  }
  if (!userClient) {
    return res.status(503).json({ error: 'CRM access control is not configured.' });
  }

  let authUser;
  try {
    const authResponse = await fetch(`${PROJECT_URL}/auth/v1/user`, {
      headers: {
        apikey: PUBLISHABLE_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!authResponse.ok) {
      return res.status(401).json({ error: 'Your session is invalid or has expired.' });
    }
    authUser = await authResponse.json();
  } catch (error) {
    console.error('Unable to verify Supabase session:', error.message);
    return res.status(503).json({ error: 'CRM access control is temporarily unavailable.' });
  }

  const userId = authUser?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Your session is invalid or has expired.' });
  }

  const { data: membership, error: membershipError } = await userClient
    .from('crm_members')
    .select('user_id, display_name, role, is_active')
    .eq('user_id', userId)
    .maybeSingle();

  if (membershipError) {
    console.error('Unable to check CRM membership:', membershipError.message);
    return res.status(503).json({ error: 'CRM access control is not ready yet.' });
  }
  if (!membership || !membership.is_active) {
    return res.status(403).json({ error: 'This account does not have active CRM access.' });
  }

  req.crmUser = { id: userId, membership, client: userClient };
  return next();
}

class CrmRequestError extends Error {
  constructor(status, message, code = 'CRM_REQUEST_FAILED', details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function text(value) {
  return String(value ?? '').trim();
}

function nullableText(value) {
  const result = text(value);
  return result || null;
}

function normalizePhone(value) {
  return text(value).replace(/\D/g, '');
}

function isValidThaiPhone(value) {
  const digits = normalizePhone(value);
  return /^02\d{7}$/.test(digits) || /^0\d{9}$/.test(digits);
}

function formatThaiPhone(value) {
  const digits = normalizePhone(value).slice(0, 10);
  if (/^02\d{7}$/.test(digits)) return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function normalizeChannel(value) {
  const channel = text(value).toLowerCase();
  const aliases = {
    'walk in': 'walkin',
    'walk-in': 'walkin',
    'facebook ads': 'facebook',
    'line official': 'line',
    'อื่นๆ (other)': 'อื่นๆ',
  };
  return aliases[channel] || channel;
}

function sanitizedSearch(value) {
  return text(value).slice(0, 100).replace(/[(),.%_]/g, ' ').trim();
}

function newLegacyId(prefix) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const date = ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value || '').join('');
  const suffix = crypto.randomBytes(2).toString('hex').slice(0, 3).toUpperCase();
  return `${prefix}-${date}-${suffix}`;
}

function unwrapCustomer(value) {
  return Array.isArray(value) ? value[0] || {} : value || {};
}

function customerSummary(customer, caseCount = 0) {
  return {
    Cust_ID: customer.legacy_cust_id || '',
    วันที่บันทึก: customer.recorded_at || '',
    ชื่อลูกค้า: customer.customer_name || '',
    เพศ: customer.gender || 'ไม่ระบุ',
    เบอร์โทรศัพท์: customer.phone || '',
    ช่องทางติดต่อ: customer.contact_channel || '',
    ชื่อช่องทางติดต่อ: customer.contact_handle || '',
    รู้จักครั้งแรก: customer.referral_source || '',
    หมายเหตุ: customer.remarks || '',
    จำนวนเคส: Number(caseCount) || 0,
  };
}

function customerRecord(customer) {
  return {
    custId: customer.legacy_cust_id || '',
    customerName: customer.customer_name || '',
    phone: customer.phone || '',
    gender: customer.gender || 'ไม่ระบุ',
    contactChannel: customer.contact_channel || '',
    contactHandle: customer.contact_handle || '',
    referralDate: customer.referral_source || '',
    customerRemarks: customer.remarks || '',
  };
}

function caseRecord(caseRow) {
  const customer = unwrapCustomer(caseRow.customers);
  return {
    caseId: caseRow.legacy_case_id || '',
    customerId: customer.legacy_cust_id || '',
    customerName: customer.customer_name || '',
    customerPhone: customer.phone || '',
    company: caseRow.company || '',
    topic: caseRow.topic || '',
    status: caseRow.status || '',
    date: caseRow.recorded_at || '',
    admin: caseRow.admin_name || '',
    customerType: caseRow.customer_type || '',
    priority: caseRow.priority || '',
    siteType: caseRow.site_type || '',
    siteAddress: caseRow.site_address || '',
    location: caseRow.location_url || caseRow.location_text || '',
    province: caseRow.province || '',
    interests: caseRow.product_interest || '',
    jobDetails: caseRow.job_details || '',
    budget: caseRow.budget || '',
    salesperson: caseRow.salesperson || '',
    remarks: caseRow.remarks || '',
    chatLink: caseRow.chat_link || '',
    link: caseRow.external_link || '',
  };
}

function caseTimelineRecord(caseRow) {
  const result = caseRecord(caseRow);
  return {
    status: result.status,
    date: result.date,
    admin: result.admin,
    logId: result.caseId,
    customerType: result.customerType,
    topic: result.topic,
    priority: result.priority,
    siteType: result.siteType,
    siteAddress: result.siteAddress,
    location: result.location,
    province: result.province,
    interests: result.interests,
    jobDetails: result.jobDetails,
    budget: result.budget,
    salesperson: result.salesperson,
    company: result.company,
    remarks: result.remarks,
    chatLink: result.chatLink,
    link: result.link,
  };
}

function throwDatabaseError(error, fallback = 'Supabase database is temporarily unavailable.') {
  if (!error) return;
  console.error('Supabase CRM request failed:', error.message);
  throw new CrmRequestError(503, fallback, 'DATABASE_UNAVAILABLE');
}

function validateCaseStatus(status) {
  if (!CASE_STATUSES.has(status)) {
    throw new CrmRequestError(400, 'สถานะงานไม่ถูกต้อง', 'INVALID_CASE_STATUS');
  }
}

async function readCustomerByLegacyId(client, legacyCustomerId) {
  const { data, error } = await client
    .from('customers')
    .select('id, legacy_cust_id, recorded_at, customer_name, gender, phone, contact_channel, contact_handle, referral_source, remarks')
    .eq('legacy_cust_id', legacyCustomerId)
    .maybeSingle();
  throwDatabaseError(error);
  return data;
}

async function getLeads(client, query) {
  const requestedPage = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.max(10, Math.min(Number.parseInt(query.pageSize, 10) || 50, 100));
  const search = sanitizedSearch(query.search);
  const gender = text(query.gender);
  const channel = normalizeChannel(query.channel);
  const selectColumns = 'id, legacy_cust_id, recorded_at, customer_name, gender, phone, contact_channel, contact_handle, referral_source, remarks, cases(count)';

  function buildQuery(page) {
    let request = client.from('customers').select(selectColumns, { count: 'exact' });
    if (search) {
      const term = `%${search}%`;
      request = request.or(`legacy_cust_id.ilike.${term},customer_name.ilike.${term},phone.ilike.${term},contact_handle.ilike.${term}`);
    }
    if (gender) request = request.eq('gender', gender);
    if (channel) request = request.ilike('contact_channel', channel);
    const from = (page - 1) * pageSize;
    return request.order('recorded_at', { ascending: false, nullsFirst: false }).range(from, from + pageSize - 1);
  }

  let { data, error, count } = await buildQuery(requestedPage);
  throwDatabaseError(error);
  const total = Number(count) || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  if (page !== requestedPage) {
    ({ data, error } = await buildQuery(page));
    throwDatabaseError(error);
  }

  return {
    success: true,
    leads: (data || []).map((customer) => customerSummary(customer, customer.cases?.[0]?.count)),
    pagination: { page, pageSize, total, totalPages },
    apiVersion: CRM_API_VERSION,
  };
}

async function getCases(client) {
  const { data, error } = await client
    .from('cases')
    .select('legacy_case_id, recorded_at, admin_name, customer_type, topic, priority, site_type, site_address, location_text, location_url, province, product_interest, job_details, budget, salesperson, company, status, remarks, chat_link, external_link, customers!inner(legacy_cust_id, customer_name, phone)')
    .order('recorded_at', { ascending: false })
    .limit(1000);
  throwDatabaseError(error);
  return { success: true, cases: (data || []).map(caseRecord), apiVersion: CRM_API_VERSION };
}

async function getLeadDetail(client, legacyCustomerId) {
  if (!legacyCustomerId) throw new CrmRequestError(400, 'กรุณาระบุรหัสลูกค้า', 'MISSING_CUSTOMER_ID');
  const customer = await readCustomerByLegacyId(client, legacyCustomerId);
  if (!customer) throw new CrmRequestError(404, `ไม่พบข้อมูลลูกค้า: ${legacyCustomerId}`, 'CUSTOMER_NOT_FOUND');

  const { data: cases, error } = await client
    .from('cases')
    .select('legacy_case_id, recorded_at, admin_name, customer_type, topic, priority, site_type, site_address, location_text, location_url, province, product_interest, job_details, budget, salesperson, company, status, remarks, chat_link, external_link')
    .eq('customer_id', customer.id)
    .order('recorded_at', { ascending: false });
  throwDatabaseError(error);
  const timeline = (cases || []).map(caseTimelineRecord);
  const lead = customerSummary(customer, timeline.length);
  lead['ไทม์ไลน์สถานะ'] = timeline;
  return { success: true, lead, apiVersion: CRM_API_VERSION };
}

async function getCustomer(client, legacyCustomerId) {
  if (!legacyCustomerId) throw new CrmRequestError(400, 'กรุณาระบุรหัสลูกค้า', 'MISSING_CUSTOMER_ID');
  const customer = await readCustomerByLegacyId(client, legacyCustomerId);
  if (!customer) throw new CrmRequestError(404, `ไม่พบข้อมูลลูกค้า: ${legacyCustomerId}`, 'CUSTOMER_NOT_FOUND');
  return { success: true, customer: customerRecord(customer), apiVersion: CRM_API_VERSION };
}

async function lookupCustomer(client, query) {
  const customerName = sanitizedSearch(query.customerName);
  const normalizedPhone = normalizePhone(query.phone);
  const columns = 'legacy_cust_id, customer_name, gender, phone, contact_channel, contact_handle, referral_source, remarks';
  const nameRequest = customerName
    ? client.from('customers').select(columns).ilike('customer_name', `%${customerName}%`).order('recorded_at', { ascending: false }).limit(5)
    : Promise.resolve({ data: [], error: null });
  const phoneRequest = normalizedPhone
    ? client.from('customers').select(columns).eq('phone_normalized', normalizedPhone).limit(1)
    : Promise.resolve({ data: [], error: null });
  const [nameResult, phoneResult] = await Promise.all([nameRequest, phoneRequest]);
  throwDatabaseError(nameResult.error);
  throwDatabaseError(phoneResult.error);
  return {
    success: true,
    nameMatches: (nameResult.data || []).map(customerRecord),
    phoneMatches: (phoneResult.data || []).map(customerRecord),
    apiVersion: CRM_API_VERSION,
  };
}

async function getEmployees(client, position) {
  const { data, error } = await client
    .from('crm_members')
    .select('display_name, role')
    .eq('is_active', true)
    .order('display_name');
  throwDatabaseError(error);
  const normalizedPosition = text(position) || 'Admin Sale';
  return {
    success: true,
    employees: (data || []).map((member) => ({ name: member.display_name, position: normalizedPosition, role: member.role })),
    apiVersion: CRM_API_VERSION,
  };
}

function customerWritePayload(body, userId) {
  const customerName = text(body.customerName);
  if (!customerName) throw new CrmRequestError(400, 'กรุณาระบุชื่อลูกค้า', 'MISSING_CUSTOMER_NAME');
  if (!isValidThaiPhone(body.phone)) {
    throw new CrmRequestError(400, 'กรุณากรอกเบอร์มือถือ 10 หลัก หรือโทรศัพท์บ้าน 02 จำนวน 9 หลัก', 'INVALID_PHONE');
  }
  return {
    customer_name: customerName,
    gender: text(body.gender) || 'ไม่ระบุ',
    phone: formatThaiPhone(body.phone),
    contact_channel: nullableText(body.contactChannel),
    contact_handle: nullableText(body.contactHandle),
    referral_source: nullableText(body.referralDate),
    remarks: nullableText(body.customerRemarks ?? body.customerNote),
    updated_by: userId,
  };
}

async function findPhoneDuplicate(client, phone, excludedCustomerId = '') {
  const { data, error } = await client
    .from('customers')
    .select('legacy_cust_id, customer_name, gender, phone, contact_channel, contact_handle, referral_source, remarks')
    .eq('phone_normalized', normalizePhone(phone))
    .maybeSingle();
  throwDatabaseError(error);
  if (!data || data.legacy_cust_id === excludedCustomerId) return null;
  return customerRecord(data);
}

async function saveCustomer(client, userId, body) {
  const legacyCustomerId = text(body.customerId);
  const payload = customerWritePayload(body, userId);
  const duplicate = await findPhoneDuplicate(client, payload.phone, legacyCustomerId);
  if (duplicate) {
    return {
      success: false,
      code: 'DUPLICATE_PHONE',
      error: 'เบอร์โทรนี้มีอยู่ในระบบแล้ว',
      existingCustomer: duplicate,
    };
  }

  if (legacyCustomerId) {
    const existing = await readCustomerByLegacyId(client, legacyCustomerId);
    if (!existing) throw new CrmRequestError(404, `ไม่พบรหัสลูกค้าที่ต้องการแก้ไข: ${legacyCustomerId}`, 'CUSTOMER_NOT_FOUND');
    const { data, error } = await client
      .from('customers')
      .update(payload)
      .eq('legacy_cust_id', legacyCustomerId)
      .select('legacy_cust_id, remarks')
      .single();
    if (error?.code === '23505') {
      const racedDuplicate = await findPhoneDuplicate(client, payload.phone, legacyCustomerId);
      if (racedDuplicate) {
        return { success: false, code: 'DUPLICATE_PHONE', error: 'เบอร์โทรนี้มีอยู่ในระบบแล้ว', existingCustomer: racedDuplicate };
      }
    }
    throwDatabaseError(error);
    return { success: true, custId: data.legacy_cust_id, updated: true, customerRemarks: data.remarks || '', apiVersion: CRM_API_VERSION };
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await client
      .from('customers')
      .insert({ ...payload, legacy_cust_id: newLegacyId('CUST'), created_by: userId })
      .select('legacy_cust_id, remarks')
      .single();
    if (!error) {
      return { success: true, custId: data.legacy_cust_id, updated: false, customerRemarks: data.remarks || '', apiVersion: CRM_API_VERSION };
    }
    if (error.code !== '23505') throwDatabaseError(error);
    const racedDuplicate = await findPhoneDuplicate(client, payload.phone);
    if (racedDuplicate) {
      return { success: false, code: 'DUPLICATE_PHONE', error: 'เบอร์โทรนี้มีอยู่ในระบบแล้ว', existingCustomer: racedDuplicate };
    }
  }
  throw new CrmRequestError(503, 'ไม่สามารถสร้างรหัสลูกค้าใหม่ได้ กรุณาลองอีกครั้ง', 'CUSTOMER_ID_RETRY_EXHAUSTED');
}

function caseWritePayload(body, customerId, userId) {
  const remarks = [text(body.remarks), text(body.billingRemarks) ? `หมายเหตุบิล: ${text(body.billingRemarks)}` : ''].filter(Boolean).join('\n');
  return {
    customer_id: customerId,
    admin_name: nullableText(body.adminName),
    customer_type: nullableText(body.customerType),
    topic: nullableText(body.topic),
    priority: nullableText(body.priority),
    site_type: nullableText(body.siteType),
    site_address: nullableText(body.siteAddress),
    province: nullableText(body.province),
    product_interest: nullableText(body.interests),
    job_details: nullableText(body.jobDetails),
    budget: nullableText(body.budget),
    salesperson: nullableText(body.salesperson),
    company: nullableText(body.company ?? body.billingName),
    status: text(body.jobStatus) || 'รอดำเนินการ',
    remarks: nullableText(remarks),
    external_link: nullableText(body.link),
    billing_name: nullableText(body.billingName),
    billing_address: nullableText(body.billingAddress),
    tax_id: nullableText(body.taxId),
    client_request_id: nullableText(body.caseRequestId),
    created_by: userId,
    updated_by: userId,
  };
}

async function createCase(client, userId, body) {
  const legacyCustomerId = text(body.customerId);
  if (!legacyCustomerId) throw new CrmRequestError(400, 'กรุณาบันทึกข้อมูลลูกค้าก่อน', 'MISSING_CUSTOMER_ID');
  const customer = await readCustomerByLegacyId(client, legacyCustomerId);
  if (!customer) throw new CrmRequestError(404, `ไม่พบข้อมูลลูกค้า: ${legacyCustomerId}`, 'CUSTOMER_NOT_FOUND');
  const payload = caseWritePayload(body, customer.id, userId);
  if (!payload.topic || !payload.company) {
    throw new CrmRequestError(400, 'กรุณาระบุหัวข้อที่ติดต่อและบริษัท', 'MISSING_CASE_DETAILS');
  }

  if (payload.client_request_id) {
    const { data: existing, error } = await client
      .from('cases')
      .select('legacy_case_id')
      .eq('client_request_id', payload.client_request_id)
      .maybeSingle();
    throwDatabaseError(error);
    if (existing) {
      return { success: true, duplicatePrevented: true, custId: legacyCustomerId, caseId: existing.legacy_case_id, logId: existing.legacy_case_id, apiVersion: CRM_API_VERSION };
    }
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await client
      .from('cases')
      .insert({ ...payload, legacy_case_id: newLegacyId('CASE') })
      .select('legacy_case_id')
      .single();
    if (!error) {
      return { success: true, custId: legacyCustomerId, caseId: data.legacy_case_id, logId: data.legacy_case_id, apiVersion: CRM_API_VERSION };
    }
    if (error.code !== '23505') throwDatabaseError(error);
    if (payload.client_request_id) {
      const { data: existing, error: duplicateError } = await client
        .from('cases')
        .select('legacy_case_id')
        .eq('client_request_id', payload.client_request_id)
        .maybeSingle();
      throwDatabaseError(duplicateError);
      if (existing) {
        return { success: true, duplicatePrevented: true, custId: legacyCustomerId, caseId: existing.legacy_case_id, logId: existing.legacy_case_id, apiVersion: CRM_API_VERSION };
      }
    }
  }
  throw new CrmRequestError(503, 'ไม่สามารถสร้างรหัสเคสใหม่ได้ กรุณาลองอีกครั้ง', 'CASE_ID_RETRY_EXHAUSTED');
}

async function updateCaseStatus(client, userId, body) {
  const caseId = text(body.caseId);
  const status = text(body.status);
  if (!caseId) throw new CrmRequestError(400, 'ไม่พบ Case_ID ที่ต้องการอัปเดต', 'MISSING_CASE_ID');
  validateCaseStatus(status);
  const updatedAt = new Date().toISOString();
  const { data, error } = await client
    .from('cases')
    .update({ status, recorded_at: updatedAt, updated_by: userId })
    .eq('legacy_case_id', caseId)
    .select('legacy_case_id')
    .maybeSingle();
  throwDatabaseError(error);
  if (!data) throw new CrmRequestError(404, `ไม่พบเคส ${caseId}`, 'CASE_NOT_FOUND');
  return { success: true, caseId, status, updatedAt, apiVersion: CRM_API_VERSION };
}

async function updateCaseDetails(client, userId, body) {
  const caseId = text(body.caseId);
  const status = text(body.status);
  if (!caseId) throw new CrmRequestError(400, 'ไม่พบ Case_ID ที่ต้องการแก้ไข', 'MISSING_CASE_ID');
  if (!text(body.topic) || !text(body.company)) {
    throw new CrmRequestError(400, 'กรุณาระบุหัวข้อที่ติดต่อและบริษัท', 'MISSING_CASE_DETAILS');
  }
  validateCaseStatus(status);
  const { data, error } = await client
    .from('cases')
    .update({
      topic: text(body.topic),
      company: text(body.company),
      status,
      priority: nullableText(body.priority),
      budget: nullableText(body.budget),
      site_type: nullableText(body.siteType),
      product_interest: nullableText(body.interests),
      province: nullableText(body.province),
      admin_name: nullableText(body.admin),
      salesperson: nullableText(body.salesperson),
      site_address: nullableText(body.siteAddress),
      job_details: nullableText(body.jobDetails),
      external_link: nullableText(body.link),
      remarks: nullableText(body.remarks),
      updated_by: userId,
    })
    .eq('legacy_case_id', caseId)
    .select('legacy_case_id')
    .maybeSingle();
  throwDatabaseError(error);
  if (!data) throw new CrmRequestError(404, `ไม่พบเคส ${caseId}`, 'CASE_NOT_FOUND');
  return { success: true, caseId, apiVersion: CRM_API_VERSION };
}

async function handleCrmRequest(req, res) {
  const isGet = req.method === 'GET';
  const input = isGet ? req.query : req.body;
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    return res.status(400).json({ success: false, error: 'A JSON object is required.' });
  }
  const action = text(input.action);

  try {
    let payload;
    if (isGet) {
      switch (action) {
        case 'getVersion':
          payload = { success: true, apiVersion: CRM_API_VERSION };
          break;
        case 'getLeads':
          payload = await getLeads(req.crmUser.client, input);
          break;
        case 'getCases':
          payload = await getCases(req.crmUser.client);
          break;
        case 'getLeadDetail':
          payload = await getLeadDetail(req.crmUser.client, text(input.customerId));
          break;
        case 'getCustomer':
          payload = await getCustomer(req.crmUser.client, text(input.customerId));
          break;
        case 'lookupCustomer':
          payload = await lookupCustomer(req.crmUser.client, input);
          break;
        case 'getEmployees':
          payload = await getEmployees(req.crmUser.client, input.position);
          break;
        default:
          throw new CrmRequestError(400, 'Unknown CRM action.', 'UNKNOWN_ACTION');
      }
    } else {
      switch (action) {
        case 'saveCustomer':
          payload = await saveCustomer(req.crmUser.client, req.crmUser.id, input);
          break;
        case 'updateCaseStatus':
          payload = await updateCaseStatus(req.crmUser.client, req.crmUser.id, input);
          break;
        case 'updateCaseDetails':
          payload = await updateCaseDetails(req.crmUser.client, req.crmUser.id, input);
          break;
        default:
          payload = await createCase(req.crmUser.client, req.crmUser.id, input);
      }
    }
    res.set('Cache-Control', 'no-store, private');
    return res.json(payload);
  } catch (error) {
    const status = error instanceof CrmRequestError ? error.status : 500;
    const code = error instanceof CrmRequestError ? error.code : 'CRM_REQUEST_FAILED';
    const message = error instanceof CrmRequestError ? error.message : 'ไม่สามารถดำเนินการกับข้อมูล CRM ได้';
    if (!(error instanceof CrmRequestError)) console.error('Unhandled CRM request failure:', error);
    res.set('Cache-Control', 'no-store, private');
    return res.status(status).json({ success: false, code, error: message, ...(error.details || {}) });
  }
}

app.use(setSecurityHeaders);
app.use(requireAllowedCountry);

app.get('/api/runtime-config', runtimeConfig);
app.use('/api/crm', express.json({ type: ['application/json', 'text/plain'], limit: '100kb' }));
app.all('/api/crm', requireCrmMember, handleCrmRequest);

app.get('/api/protected/health', requireCrmMember, (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  res.json({
    authenticated: true,
    userId: req.crmUser.id,
    membership: req.crmUser.membership,
  });
});

app.use(
  '/vendor/supabase',
  express.static(path.join(__dirname, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd'), {
    immutable: true,
    maxAge: '1d',
  })
);

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  maxAge: 0,
  setHeaders(res, filePath) {
    if (path.basename(filePath) === 'index.html') {
      res.set('Cache-Control', 'no-store, must-revalidate');
    }
  },
}));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Good CRM Lead Entry App running at http://localhost:${PORT}`);
  });
}

module.exports = { app, createGeoAccessConfig, isLoopbackAddress };
