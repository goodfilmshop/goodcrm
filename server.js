const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { getStorageOverview, deleteStorageFile } = require('./storage-overview');
const { createWebhook, getIntake, resolveIntake } = require('./line-intake');
const facebookIntake = require('./facebook-intake');

loadLocalEnvironment();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PROJECT_URL = process.env.SUPABASE_URL;
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const geoAccess = createGeoAccessConfig(process.env);
const CRM_API_VERSION = '2026-09-14-server-three-day-follow-up-v43';
const INSTALLATION_QUEUE_STATUS = 'นัดคิวติดตั้ง';
const INSTALLATION_QUEUE_PAGE_SIZE = 500;
const FOLLOW_UP_TASK_PAGE_SIZE = 500;
const MEASUREMENT_QUEUE_CASE_LIMIT = 1000;
const FOLLOW_UP_FINAL_STATUSES = new Set(['ยกเลิก', 'ปิดงาน']);
const BANGKOK_TIME_ZONE = 'Asia/Bangkok';
const BANGKOK_DATE_FORMATTER = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
  timeZone: BANGKOK_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const CASE_STATUSES = new Set([
  'รอดำเนินการ',
  'ติดต่อสอบถาม',
  'ประเมินราคา',
  'เลื่อนคิว',
  'นัดวัดพื้นที่',
  'ส่งใบเสนอราคา',
  'ติดตามครั้งที่ 1',
  'ติดตามครั้งที่ 2',
  'ติดตามครั้งที่ 3',
  'ติดตามครั้งที่ 4',
  'ติดตามครั้งที่ 5',
  'ต่อรองราคา',
  'ออกใบแจ้งหนี้',
  'เซ็นต์สัญญา',
  'มัดจำก่อนติด',
  'เลื่อนนัด',
  'นัดคิวติดตั้ง',
  'ติดตั้งสิ้นเสร็จ',
  'ประเมินหลังการขาย',
  'แก้ไขงาน',
  'ออกใบเสร็จรับเงิน',
  'ชำระเงินครบ',
  'เก็บซิลิโคลน',
  'ยกเลิก',
  'ปิดงาน',
]);
const CASE_APPOINTMENT_STATUSES = new Set([
  'เลื่อนคิว',
  'นัดวัดพื้นที่',
  'เซ็นต์สัญญา',
  'เลื่อนนัด',
  'นัดคิวติดตั้ง',
  'แก้ไขงาน',
  'เก็บซิลิโคลน',
]);
const MEASUREMENT_QUEUE_STATUSES = new Set(
  [...CASE_APPOINTMENT_STATUSES].filter(status => status !== INSTALLATION_QUEUE_STATUS)
);
const CASE_NOTIFICATION_SCOPES = new Set([
  'cases',
  'measurement_queue',
  'installation_queue',
  'quotations',
]);
const EMPLOYEE_ACCESS_ROLES = new Set(['admin', 'manager', 'sales', 'member']);
const EMPLOYEE_STATUSES = new Set(['active', 'inactive']);
const GENERAL_TASK_STATUSES = new Set(['pending', 'completed', 'cancelled']);
const DOCUMENT_TEMPLATE_COMPANIES = new Set(['GFS', 'MHL']);
const DOCUMENT_TEMPLATE_TYPES = new Set([
  'quotation',
  'invoice',
  'receipt',
  'tax_invoice',
  'work_delivery',
  'credit_note',
]);
const DOCUMENT_TEMPLATE_STATUSES = new Set(['draft', 'published', 'archived']);
const DOCUMENT_TEMPLATE_SCHEMA_VERSION = 2;
const DOCUMENT_TEMPLATE_MAX_JSON_BYTES = 64 * 1024;
const DOCUMENT_TEMPLATE_MAX_DEPTH = 8;
const DOCUMENT_TEMPLATE_MAX_NODES = 1000;
const DOCUMENT_TEMPLATE_MAX_OBJECT_KEYS = 64;
const DOCUMENT_TEMPLATE_MAX_ARRAY_ITEMS = 100;
const DOCUMENT_TEMPLATE_MAX_STRING_LENGTH = 48 * 1024;
const QUOTATION_IMAGE_MIN_DISPLAY_WIDTH = 60;
const QUOTATION_IMAGE_MAX_DISPLAY_WIDTH = 720;
const DOCUMENT_TEMPLATE_CANVAS_PRESETS = new Set(['', 'gfs-quotation-2026']);
const DOCUMENT_TEMPLATE_CANVAS_FIELD_KEYS = new Set([
  'documentNumber',
  'issueDate',
  'validUntil',
  'customerName',
  'branch',
  'taxId',
  'address',
  'contactName',
  'telephone',
  'creditTerm',
  'paymentTerms',
  'projectName',
  'salesperson',
  'itemsTable',
  'subtotal',
  'vat',
  'grandTotal',
  'totalInWords',
  'notes',
  'pageNumber',
]);
const DOCUMENT_TEMPLATE_CANVAS_FONT_WEIGHTS = new Set([400, 500, 600, 700]);
const DOCUMENT_TEMPLATE_CANVAS_TEXT_ALIGNMENTS = new Set(['left', 'center', 'right']);
const DOCUMENT_TEMPLATE_STORAGE_ERROR_CODES = new Set(['42P01', '42703', '42501', 'PGRST204', 'PGRST205']);

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

function isInvalidSessionError(error) {
  const message = String(error?.message || '');
  return /jwt\s+issued\s+at\s+future|jwt\s+expired|jwt\s+not\s+active|invalid\s+jwt|token\s+is\s+expired/i.test(message);
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

  const [
    { data: membership, error: membershipError },
    { data: assignmentData, error: assignmentError },
  ] = await Promise.all([
    userClient
      .from('crm_members')
      .select('user_id, display_name, role, is_active')
      .eq('user_id', userId)
      .maybeSingle(),
    userClient
      .rpc('get_current_crm_assignment_identity')
      .maybeSingle(),
  ]);

  if (membershipError) {
    console.error('Unable to check CRM membership:', membershipError.message);
    if (isInvalidSessionError(membershipError)) {
      return res.status(401).json({
        error: 'Your session is invalid or has expired.',
        code: 'SESSION_TOKEN_INVALID',
      });
    }
    return res.status(503).json({ error: 'CRM access control is not ready yet.' });
  }
  if (!membership || !membership.is_active) {
    return res.status(403).json({ error: 'This account does not have active CRM access.' });
  }

  if (assignmentError) {
    console.error('Unable to resolve CRM assignment identity:', assignmentError.message);
    return res.status(503).json({ error: 'CRM assignment access control is not ready yet.' });
  }

  const assignment = crmAssignmentRecord(assignmentData);
  if (!assignment) {
    return res.status(403).json({ error: 'This account does not have active CRM access.' });
  }
  if (assignment.restricted && (!assignment.employeeId || !assignment.salespersonName)) {
    return res.status(403).json({
      error: 'บัญชีฝ่ายขายนี้ยังไม่ได้ผูกกับข้อมูลพนักงาน กรุณาติดต่อผู้ดูแลระบบ',
      code: 'SALES_EMPLOYEE_NOT_LINKED',
    });
  }

  req.crmUser = { id: userId, membership, assignment, client: userClient };
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

function crmAssignmentRecord(assignment) {
  if (!assignment || typeof assignment !== 'object') return null;
  return {
    employeeId: text(assignment.employee_id),
    salespersonName: text(assignment.salesperson_name),
    restricted: assignment.restricted === true,
  };
}

function isRestrictedCrmSales(assignment) {
  return assignment?.restricted === true;
}

function scopeCaseAssignment(body, assignment) {
  if (!isRestrictedCrmSales(assignment)) return body;
  const salespersonName = text(assignment?.salespersonName);
  if (!salespersonName) {
    throw new CrmRequestError(
      403,
      'บัญชีฝ่ายขายนี้ยังไม่ได้ผูกกับข้อมูลพนักงาน กรุณาติดต่อผู้ดูแลระบบ',
      'SALES_EMPLOYEE_NOT_LINKED'
    );
  }
  return { ...body, salesperson: salespersonName };
}

function requireCaseAssignmentManager(assignment) {
  if (isRestrictedCrmSales(assignment)) {
    throw new CrmRequestError(
      403,
      'บัญชีฝ่ายขายไม่สามารถเปลี่ยนผู้รับผิดชอบเคสได้',
      'CASE_REASSIGNMENT_FORBIDDEN'
    );
  }
}

function requireCaseDeletionManager(membership) {
  const role = text(membership?.role).toLowerCase();
  if (!['admin', 'manager'].includes(role)) {
    throw new CrmRequestError(
      403,
      'เฉพาะผู้จัดการและผู้ดูแลระบบเท่านั้นที่ลบเคสได้',
      'CASE_DELETE_FORBIDDEN'
    );
  }
}

function requireGeneralTaskManager(membership) {
  const role = text(membership?.role).toLowerCase();
  if (!['admin', 'manager'].includes(role)) {
    throw new CrmRequestError(
      403,
      'เฉพาะผู้จัดการและผู้ดูแลระบบเท่านั้นที่จัดการงานทั่วไปได้',
      'GENERAL_TASK_MANAGER_REQUIRED'
    );
  }
}

function requireGeneralTaskCreator(membership) {
  const role = text(membership?.role).toLowerCase();
  if (membership?.is_active !== true || !EMPLOYEE_ACCESS_ROLES.has(role)) {
    throw new CrmRequestError(
      403,
      'บัญชีนี้ไม่มีสิทธิ์เพิ่มงานทั่วไป',
      'GENERAL_TASK_CREATE_FORBIDDEN'
    );
  }
}

function requireQuotationHistoryDeletionManager(membership) {
  const role = text(membership?.role).toLowerCase();
  if (!['admin', 'manager'].includes(role)) {
    throw new CrmRequestError(
      403,
      'เฉพาะผู้จัดการและผู้ดูแลระบบเท่านั้นที่ลบใบเสนอราคาได้',
      'QUOTATION_DELETE_FORBIDDEN'
    );
  }
}

function canManageDocumentTemplates(membership) {
  return ['admin', 'manager'].includes(text(membership?.role).toLowerCase());
}

function requireDocumentTemplateManager(membership) {
  if (!canManageDocumentTemplates(membership)) {
    throw new CrmRequestError(
      403,
      'เฉพาะผู้จัดการและผู้ดูแลระบบเท่านั้นที่จัดการแม่แบบเอกสารได้',
      'DOCUMENT_TEMPLATE_MANAGER_REQUIRED'
    );
  }
}

function validateDocumentTemplateCompany(value) {
  if (typeof value !== 'string' || !DOCUMENT_TEMPLATE_COMPANIES.has(value)) {
    throw new CrmRequestError(400, 'บริษัทของแม่แบบเอกสารไม่ถูกต้อง', 'INVALID_DOCUMENT_TEMPLATE_COMPANY');
  }
  return value;
}

function validateDocumentTemplateType(value) {
  if (typeof value !== 'string' || !DOCUMENT_TEMPLATE_TYPES.has(value)) {
    throw new CrmRequestError(400, 'ประเภทแม่แบบเอกสารไม่ถูกต้อง', 'INVALID_DOCUMENT_TEMPLATE_TYPE');
  }
  return value;
}

function validateDocumentTemplateSchemaVersion(value) {
  const schemaVersion = value === undefined ? DOCUMENT_TEMPLATE_SCHEMA_VERSION : value;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion !== DOCUMENT_TEMPLATE_SCHEMA_VERSION) {
    throw new CrmRequestError(
      400,
      `ระบบรองรับโครงสร้างแม่แบบเวอร์ชัน ${DOCUMENT_TEMPLATE_SCHEMA_VERSION} เท่านั้น`,
      'UNSUPPORTED_DOCUMENT_TEMPLATE_SCHEMA_VERSION'
    );
  }
  return schemaVersion;
}

function isPlainJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDocumentTemplateObject(value, pathName, allowedKeys, requiredKeys = allowedKeys) {
  if (!isPlainJsonObject(value)) {
    throw new CrmRequestError(400, `${pathName} ต้องเป็นออบเจ็กต์`, 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
  }
  const keys = Object.keys(value);
  if (keys.length > DOCUMENT_TEMPLATE_MAX_OBJECT_KEYS) {
    throw new CrmRequestError(400, `${pathName} มีค่ามากเกินไป`, 'DOCUMENT_TEMPLATE_DESIGN_TOO_COMPLEX');
  }
  const allowed = new Set(allowedKeys);
  for (const key of keys) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || !allowed.has(key)) {
      throw new CrmRequestError(400, `${pathName}.${key} ไม่ได้รับอนุญาต`, 'DOCUMENT_TEMPLATE_DESIGN_FIELD_NOT_ALLOWED');
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new CrmRequestError(400, `${pathName}.${key} จำเป็นต้องระบุ`, 'MISSING_DOCUMENT_TEMPLATE_DESIGN_FIELD');
    }
  }
}

function documentTemplateString(value, pathName, maximumLength, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > maximumLength || (!allowEmpty && !value.trim())) {
    throw new CrmRequestError(400, `${pathName} ไม่ถูกต้อง`, 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) || /<\/?(?:script|style|iframe|object|embed|svg)\b|javascript\s*:|data\s*:\s*text\/html/i.test(value)) {
    throw new CrmRequestError(400, `${pathName} มีเนื้อหาที่ไม่ได้รับอนุญาต`, 'DOCUMENT_TEMPLATE_DESIGN_CONTENT_NOT_ALLOWED');
  }
  return value;
}

function documentTemplateBoolean(value, pathName) {
  if (typeof value !== 'boolean') {
    throw new CrmRequestError(400, `${pathName} ต้องเป็น boolean`, 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
  }
  return value;
}

function documentTemplateOrder(value, pathName) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new CrmRequestError(400, `${pathName} ต้องเป็นจำนวนเต็มระหว่าง 1-20`, 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
  }
  return value;
}

function isSafeDocumentTemplateCanvasBackgroundUrl(value) {
  if (value === '') return true;
  if (value === '/assets/gfs-quotation-2026.png') return true;
  if (value.length > 2048) return false;

  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === 'https:'
      && !parsedUrl.username
      && !parsedUrl.password
      && /\.(?:png|jpe?g|webp)$/i.test(parsedUrl.pathname);
  } catch {
    return false;
  }
}

function validateDocumentTemplateCanvas(canvas, documentType, company) {
  assertDocumentTemplateObject(
    canvas,
    'design.canvas',
    ['enabled', 'preset', 'backgroundImageUrl', 'width', 'height', 'fields']
  );
  documentTemplateBoolean(canvas.enabled, 'design.canvas.enabled');
  documentTemplateString(canvas.preset, 'design.canvas.preset', 64);
  if (!DOCUMENT_TEMPLATE_CANVAS_PRESETS.has(canvas.preset)) {
    throw new CrmRequestError(400, 'design.canvas.preset ไม่ได้รับอนุญาต', 'INVALID_DOCUMENT_TEMPLATE_CANVAS_PRESET');
  }
  if (
    canvas.preset === 'gfs-quotation-2026'
    && (
      (documentType !== undefined && documentType !== 'quotation')
      || (company !== undefined && company !== 'GFS')
    )
  ) {
    throw new CrmRequestError(
      400,
      'preset gfs-quotation-2026 ใช้ได้กับบริษัท GFS และแม่แบบใบเสนอราคาเท่านั้น',
      'DOCUMENT_TEMPLATE_CANVAS_PRESET_NOT_ALLOWED'
    );
  }

  documentTemplateString(canvas.backgroundImageUrl, 'design.canvas.backgroundImageUrl', 2048);
  if ((canvas.enabled && !canvas.backgroundImageUrl) || !isSafeDocumentTemplateCanvasBackgroundUrl(canvas.backgroundImageUrl)) {
    throw new CrmRequestError(
      400,
      'design.canvas.backgroundImageUrl ต้องเป็นไฟล์ภาพ HTTPS ชนิด PNG/JPEG/WebP หรือ asset ที่ระบบอนุญาต',
      'INVALID_DOCUMENT_TEMPLATE_CANVAS_BACKGROUND_URL'
    );
  }

  if (!Number.isSafeInteger(canvas.width) || canvas.width < 320 || canvas.width > 4000) {
    throw new CrmRequestError(400, 'design.canvas.width ต้องเป็นจำนวนเต็มระหว่าง 320-4000', 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
  }
  if (!Number.isSafeInteger(canvas.height) || canvas.height < 320 || canvas.height > 4000) {
    throw new CrmRequestError(400, 'design.canvas.height ต้องเป็นจำนวนเต็มระหว่าง 320-4000', 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
  }
  if (!Array.isArray(canvas.fields) || canvas.fields.length < 1 || canvas.fields.length > 40) {
    throw new CrmRequestError(400, 'design.canvas.fields ต้องมี 1-40 ฟิลด์', 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
  }

  const seenFieldKeys = new Set();
  canvas.fields.forEach((field, index) => {
    const pathName = `design.canvas.fields[${index}]`;
    assertDocumentTemplateObject(
      field,
      pathName,
      ['key', 'visible', 'x', 'y', 'width', 'height', 'fontSize', 'fontWeight', 'color', 'textAlign', 'lineHeight']
    );
    if (typeof field.key !== 'string' || !DOCUMENT_TEMPLATE_CANVAS_FIELD_KEYS.has(field.key)) {
      throw new CrmRequestError(400, `${pathName}.key ไม่ได้รับอนุญาต`, 'INVALID_DOCUMENT_TEMPLATE_CANVAS_FIELD');
    }
    if (seenFieldKeys.has(field.key)) {
      throw new CrmRequestError(400, `${pathName}.key ซ้ำกัน`, 'DUPLICATE_DOCUMENT_TEMPLATE_CANVAS_FIELD');
    }
    seenFieldKeys.add(field.key);
    documentTemplateBoolean(field.visible, `${pathName}.visible`);

    if (
      !Number.isSafeInteger(field.x)
      || !Number.isSafeInteger(field.y)
      || !Number.isSafeInteger(field.width)
      || !Number.isSafeInteger(field.height)
      || field.x < 0
      || field.y < 0
      || field.width < 24
      || field.height < 16
      || field.x + field.width > canvas.width
      || field.y + field.height > canvas.height
    ) {
      throw new CrmRequestError(
        400,
        `${pathName} ต้องใช้พิกัดและขนาดจำนวนเต็มที่อยู่ภายใน canvas`,
        'INVALID_DOCUMENT_TEMPLATE_CANVAS_FIELD_BOUNDS'
      );
    }
    if (!Number.isSafeInteger(field.fontSize) || field.fontSize < 8 || field.fontSize > 96) {
      throw new CrmRequestError(400, `${pathName}.fontSize ต้องเป็นจำนวนเต็มระหว่าง 8-96`, 'INVALID_DOCUMENT_TEMPLATE_CANVAS_FIELD');
    }
    if (!DOCUMENT_TEMPLATE_CANVAS_FONT_WEIGHTS.has(field.fontWeight)) {
      throw new CrmRequestError(400, `${pathName}.fontWeight ไม่ได้รับอนุญาต`, 'INVALID_DOCUMENT_TEMPLATE_CANVAS_FIELD');
    }
    if (typeof field.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(field.color)) {
      throw new CrmRequestError(400, `${pathName}.color ต้องเป็นสีรูปแบบ #RRGGBB`, 'INVALID_DOCUMENT_TEMPLATE_CANVAS_FIELD');
    }
    if (typeof field.textAlign !== 'string' || !DOCUMENT_TEMPLATE_CANVAS_TEXT_ALIGNMENTS.has(field.textAlign)) {
      throw new CrmRequestError(400, `${pathName}.textAlign ไม่ได้รับอนุญาต`, 'INVALID_DOCUMENT_TEMPLATE_CANVAS_FIELD');
    }
    if (typeof field.lineHeight !== 'number' || !Number.isFinite(field.lineHeight) || field.lineHeight < 1 || field.lineHeight > 2.5) {
      throw new CrmRequestError(400, `${pathName}.lineHeight ต้องอยู่ระหว่าง 1-2.5`, 'INVALID_DOCUMENT_TEMPLATE_CANVAS_FIELD');
    }
  });
}

function assertDocumentTemplateDesignComplexity(value) {
  let nodeCount = 0;
  const visit = (node, depth) => {
    nodeCount += 1;
    if (nodeCount > DOCUMENT_TEMPLATE_MAX_NODES || depth > DOCUMENT_TEMPLATE_MAX_DEPTH) {
      throw new CrmRequestError(400, 'โครงสร้างแม่แบบเอกสารซับซ้อนเกินไป', 'DOCUMENT_TEMPLATE_DESIGN_TOO_COMPLEX');
    }
    if (typeof node === 'string' && node.length > DOCUMENT_TEMPLATE_MAX_STRING_LENGTH) {
      throw new CrmRequestError(400, 'ข้อความในแม่แบบเอกสารยาวเกินไป', 'DOCUMENT_TEMPLATE_DESIGN_TOO_LARGE');
    }
    if (Array.isArray(node)) {
      if (node.length > DOCUMENT_TEMPLATE_MAX_ARRAY_ITEMS) {
        throw new CrmRequestError(400, 'รายการในแม่แบบเอกสารมากเกินไป', 'DOCUMENT_TEMPLATE_DESIGN_TOO_COMPLEX');
      }
      node.forEach(child => visit(child, depth + 1));
    } else if (isPlainJsonObject(node)) {
      const keys = Object.keys(node);
      if (keys.length > DOCUMENT_TEMPLATE_MAX_OBJECT_KEYS) {
        throw new CrmRequestError(400, 'แม่แบบเอกสารมีค่ามากเกินไป', 'DOCUMENT_TEMPLATE_DESIGN_TOO_COMPLEX');
      }
      for (const key of keys) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) {
          throw new CrmRequestError(400, 'แม่แบบเอกสารมีชื่อฟิลด์ที่ไม่ได้รับอนุญาต', 'DOCUMENT_TEMPLATE_DESIGN_FIELD_NOT_ALLOWED');
        }
        visit(node[key], depth + 1);
      }
    }
  };
  visit(value, 1);
}

function validateDocumentTemplateDesign(design, documentType, company) {
  if (documentType !== undefined) validateDocumentTemplateType(documentType);
  if (company !== undefined) validateDocumentTemplateCompany(company);
  assertDocumentTemplateDesignComplexity(design);
  let serialized;
  try {
    serialized = JSON.stringify(design);
  } catch {
    throw new CrmRequestError(400, 'แม่แบบเอกสารต้องเป็น JSON ที่ถูกต้อง', 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > DOCUMENT_TEMPLATE_MAX_JSON_BYTES) {
    throw new CrmRequestError(400, 'แม่แบบเอกสารมีขนาดเกิน 64 KB', 'DOCUMENT_TEMPLATE_DESIGN_TOO_LARGE');
  }

  const rootKeys = ['theme', 'company', 'header', 'customerSection', 'itemsTable', 'totals', 'notes', 'signatures', 'footer', 'print', 'canvas'];
  assertDocumentTemplateObject(design, 'design', rootKeys);

  assertDocumentTemplateObject(design.theme, 'design.theme', ['accentColor', 'fontFamily']);
  if (!/^#[0-9A-Fa-f]{6}$/.test(design.theme.accentColor)) {
    throw new CrmRequestError(400, 'design.theme.accentColor ต้องเป็นสีรูปแบบ #RRGGBB', 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
  }
  if (!['Sarabun', 'Noto Sans Thai', 'system-ui', 'sans-serif'].includes(design.theme.fontFamily)) {
    throw new CrmRequestError(400, 'design.theme.fontFamily ไม่ได้รับอนุญาต', 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
  }

  validateDocumentTemplateCanvas(design.canvas, documentType, company);

  assertDocumentTemplateObject(design.company, 'design.company', ['name', 'nameEnglish', 'contact', 'logoText', 'logoImageUrl']);
  documentTemplateString(design.company.name, 'design.company.name', 200, false);
  documentTemplateString(design.company.nameEnglish, 'design.company.nameEnglish', 200);
  documentTemplateString(design.company.contact, 'design.company.contact', 1000);
  documentTemplateString(design.company.logoText, 'design.company.logoText', 20);
  documentTemplateString(design.company.logoImageUrl, 'design.company.logoImageUrl', 48 * 1024);
  if (design.company.logoImageUrl) {
    const logoImageUrl = design.company.logoImageUrl;
    const isSafeDataImage = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(logoImageUrl);
    let isSafeHttpsUrl = false;
    if (!isSafeDataImage && logoImageUrl.length <= 2048) {
      try {
        const parsedUrl = new URL(logoImageUrl);
        isSafeHttpsUrl = parsedUrl.protocol === 'https:' && !parsedUrl.username && !parsedUrl.password;
      } catch {
        isSafeHttpsUrl = false;
      }
    }
    if (!isSafeDataImage && !isSafeHttpsUrl) {
      throw new CrmRequestError(400, 'design.company.logoImageUrl ต้องเป็น HTTPS หรือ data:image ชนิด PNG/JPEG/WebP', 'INVALID_DOCUMENT_TEMPLATE_LOGO_URL');
    }
  }

  assertDocumentTemplateObject(design.header, 'design.header', ['title', 'documentNumberLabel', 'dateLabel']);
  documentTemplateString(design.header.title, 'design.header.title', 200, false);
  documentTemplateString(design.header.documentNumberLabel, 'design.header.documentNumberLabel', 120, false);
  documentTemplateString(design.header.dateLabel, 'design.header.dateLabel', 120, false);

  assertDocumentTemplateObject(design.customerSection, 'design.customerSection', ['visible', 'order', 'labels']);
  documentTemplateBoolean(design.customerSection.visible, 'design.customerSection.visible');
  documentTemplateOrder(design.customerSection.order, 'design.customerSection.order');
  assertDocumentTemplateObject(design.customerSection.labels, 'design.customerSection.labels', ['customer', 'contact', 'telephone', 'address']);
  for (const key of ['customer', 'contact', 'telephone', 'address']) {
    documentTemplateString(design.customerSection.labels[key], `design.customerSection.labels.${key}`, 120, false);
  }

  assertDocumentTemplateObject(design.itemsTable, 'design.itemsTable', ['visible', 'order', 'columns']);
  documentTemplateBoolean(design.itemsTable.visible, 'design.itemsTable.visible');
  documentTemplateOrder(design.itemsTable.order, 'design.itemsTable.order');
  if (!Array.isArray(design.itemsTable.columns) || design.itemsTable.columns.length < 1 || design.itemsTable.columns.length > 6) {
    throw new CrmRequestError(400, 'design.itemsTable.columns ต้องมี 1-6 คอลัมน์', 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
  }
  const allowedColumnKeys = new Set(['sequence', 'description', 'quantity', 'unit', 'unitPrice', 'amount']);
  const seenColumnKeys = new Set();
  design.itemsTable.columns.forEach((column, index) => {
    const pathName = `design.itemsTable.columns[${index}]`;
    assertDocumentTemplateObject(column, pathName, ['key', 'label', 'visible']);
    if (!allowedColumnKeys.has(column.key) || seenColumnKeys.has(column.key)) {
      throw new CrmRequestError(400, `${pathName}.key ไม่ถูกต้องหรือซ้ำกัน`, 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
    }
    seenColumnKeys.add(column.key);
    documentTemplateString(column.label, `${pathName}.label`, 120, false);
    documentTemplateBoolean(column.visible, `${pathName}.visible`);
  });
  if (!design.itemsTable.columns.some(column => column.visible) || !design.itemsTable.columns.some(column => column.key === 'description' && column.visible)) {
    throw new CrmRequestError(400, 'ตารางรายการต้องมีคอลัมน์รายการที่แสดงอย่างน้อย 1 คอลัมน์', 'DOCUMENT_TEMPLATE_DESCRIPTION_COLUMN_REQUIRED');
  }

  assertDocumentTemplateObject(design.totals, 'design.totals', ['visible', 'order', 'labels']);
  documentTemplateBoolean(design.totals.visible, 'design.totals.visible');
  documentTemplateOrder(design.totals.order, 'design.totals.order');
  assertDocumentTemplateObject(design.totals.labels, 'design.totals.labels', ['subtotal', 'discount', 'afterDiscount', 'tax', 'grandTotal']);
  for (const key of ['subtotal', 'discount', 'afterDiscount', 'tax', 'grandTotal']) {
    documentTemplateString(design.totals.labels[key], `design.totals.labels.${key}`, 120, false);
  }

  assertDocumentTemplateObject(design.notes, 'design.notes', ['visible', 'order', 'heading', 'text']);
  documentTemplateBoolean(design.notes.visible, 'design.notes.visible');
  documentTemplateOrder(design.notes.order, 'design.notes.order');
  documentTemplateString(design.notes.heading, 'design.notes.heading', 200);
  documentTemplateString(design.notes.text, 'design.notes.text', DOCUMENT_TEMPLATE_MAX_STRING_LENGTH);

  assertDocumentTemplateObject(design.signatures, 'design.signatures', ['visible', 'order', 'labels']);
  documentTemplateBoolean(design.signatures.visible, 'design.signatures.visible');
  documentTemplateOrder(design.signatures.order, 'design.signatures.order');
  assertDocumentTemplateObject(design.signatures.labels, 'design.signatures.labels', ['preparedBy', 'approvedBy', 'customer']);
  for (const key of ['preparedBy', 'approvedBy', 'customer']) {
    documentTemplateString(design.signatures.labels[key], `design.signatures.labels.${key}`, 120, false);
  }

  assertDocumentTemplateObject(design.footer, 'design.footer', ['visible', 'order', 'text']);
  documentTemplateBoolean(design.footer.visible, 'design.footer.visible');
  documentTemplateOrder(design.footer.order, 'design.footer.order');
  documentTemplateString(design.footer.text, 'design.footer.text', 2000);

  assertDocumentTemplateObject(design.print, 'design.print', ['paperSize', 'orientation', 'marginMm']);
  if (design.print.paperSize !== 'A4' || !['portrait', 'landscape'].includes(design.print.orientation)) {
    throw new CrmRequestError(400, 'design.print รองรับกระดาษ A4 แนวตั้งหรือแนวนอน', 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
  }
  if (typeof design.print.marginMm !== 'number' || !Number.isFinite(design.print.marginMm) || design.print.marginMm < 5 || design.print.marginMm > 30) {
    throw new CrmRequestError(400, 'design.print.marginMm ต้องอยู่ระหว่าง 5-30 มม.', 'INVALID_DOCUMENT_TEMPLATE_DESIGN');
  }

  const orders = [
    design.customerSection.order,
    design.itemsTable.order,
    design.totals.order,
    design.notes.order,
    design.signatures.order,
    design.footer.order,
  ];
  if (new Set(orders).size !== orders.length) {
    throw new CrmRequestError(400, 'ลำดับส่วนของแม่แบบเอกสารต้องไม่ซ้ำกัน', 'DUPLICATE_DOCUMENT_TEMPLATE_SECTION_ORDER');
  }

  if (documentType && !design.itemsTable.visible) {
    throw new CrmRequestError(400, 'เอกสารทุกประเภทต้องแสดงตารางรายการ', 'DOCUMENT_TEMPLATE_ITEMS_TABLE_REQUIRED');
  }
  if (documentType && documentType !== 'work_delivery' && !design.totals.visible) {
    throw new CrmRequestError(400, 'เอกสารประเภทนี้ต้องแสดงส่วนสรุปยอด', 'DOCUMENT_TEMPLATE_TOTALS_REQUIRED');
  }

  return JSON.parse(serialized);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function documentTemplateChecksum(design) {
  return crypto.createHash('sha256').update(canonicalJson(design), 'utf8').digest('hex');
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

function customerLeadMetrics(caseRows) {
  const companies = new Set();
  const quotationNumbers = new Set();

  for (const caseRow of Array.isArray(caseRows) ? caseRows : []) {
    const company = text(caseRow?.company).toUpperCase();
    if (company) companies.add(company);
    for (const quotationNumber of quotationNumbersForHistory(caseRow?.quotation_history)) {
      quotationNumbers.add(quotationNumber);
    }
  }

  const companyOrder = new Map([['GFS', 0], ['MHL', 1]]);
  return {
    companies: [...companies].sort((first, second) => {
      const firstOrder = companyOrder.has(first) ? companyOrder.get(first) : 99;
      const secondOrder = companyOrder.has(second) ? companyOrder.get(second) : 99;
      return firstOrder - secondOrder || first.localeCompare(second);
    }),
    quotationCount: quotationNumbers.size,
  };
}

function customerSummary(customer, caseCount = 0, caseRows = []) {
  const leadMetrics = customerLeadMetrics(caseRows);
  return {
    Cust_ID: customer.legacy_cust_id || '',
    วันที่บันทึก: customer.recorded_at || '',
    ชื่อลูกค้า: customer.customer_name || '',
    เพศ: customer.gender || 'ไม่ระบุ',
    เบอร์โทรศัพท์: customer.phone || '',
    อีเมล: customer.email || '',
    ช่องทางติดต่อ: customer.contact_channel || '',
    ชื่อช่องทางติดต่อ: customer.contact_handle || '',
    'Link Chat': customer.chat_link || '',
    รู้จักครั้งแรก: customer.referral_source || '',
    หมายเหตุ: customer.remarks || '',
    จำนวนเคส: Number(caseCount) || 0,
    จำนวนใบเสนอราคา: leadMetrics.quotationCount,
    บริษัท: leadMetrics.companies,
  };
}

function customerRecord(customer) {
  return {
    custId: customer.legacy_cust_id || '',
    customerName: customer.customer_name || '',
    phone: customer.phone || '',
    email: customer.email || '',
    gender: customer.gender || 'ไม่ระบุ',
    contactChannel: customer.contact_channel || '',
    contactHandle: customer.contact_handle || '',
    customerChatLink: customer.chat_link || '',
    referralDate: customer.referral_source || '',
    customerRemarks: customer.remarks || '',
  };
}

function quotationNumbersForHistory(history) {
  const quotationNumbers = new Set();
  for (const entry of Array.isArray(history) ? history : []) {
    for (const quotationNumber of Array.isArray(entry?.quotation_numbers) ? entry.quotation_numbers : []) {
      const normalizedNumber = text(quotationNumber);
      if (normalizedNumber) quotationNumbers.add(normalizedNumber);
    }
  }
  return [...quotationNumbers];
}

function quotationCountForHistory(history) {
  return quotationNumbersForHistory(history).length;
}

function statusesForHistory(history) {
  const statuses = new Set();
  for (const entry of Array.isArray(history) ? history : []) {
    const status = text(entry?.current_status);
    if (status) statuses.add(status);
  }
  return [...statuses];
}

function caseRecord(caseRow) {
  const customer = unwrapCustomer(caseRow.customers);
  const followUpCount = 1 + (Number(caseRow.lead_follow_up_history?.[0]?.count) || 0);
  const quotationNumbers = quotationNumbersForHistory(caseRow.quotation_history);
  const quotationCount = quotationNumbers.length;
  const latestFollowUp = Array.isArray(caseRow.latest_follow_up)
    ? caseRow.latest_follow_up[0] || {}
    : caseRow.latest_follow_up || {};
  const latestContactDetails = latestFollowUp.notes || '';
  return {
    caseId: caseRow.legacy_case_id || '',
    customerId: customer.legacy_cust_id || '',
    customerName: customer.customer_name || '',
    customerPhone: customer.phone || '',
    company: caseRow.company || '',
    topic: caseRow.topic || '',
    status: caseRow.status || '',
    date: caseRow.recorded_at || '',
    nextFollowUpAt: effectiveCaseFollowUpAt(caseRow),
    latestFollowUpStatus: latestFollowUp.current_status || '',
    admin: caseRow.admin_name || '',
    customerType: caseRow.customer_type || '',
    priority: caseRow.priority || '',
    siteType: caseRow.site_type || '',
    siteAddress: caseRow.site_address || '',
    location: caseRow.location_url || caseRow.location_text || '',
    province: caseRow.province || '',
    interests: caseRow.product_interest || '',
    jobDetails: caseRow.job_details || '',
    latestContactDetails,
    latestContactAt: latestFollowUp.followed_at || '',
    budget: caseRow.budget || '',
    salesperson: caseRow.salesperson || '',
    salespersonEmployeeId: caseRow.salesperson_employee_id || '',
    remarks: caseRow.remarks || '',
    chatLink: caseRow.chat_link || '',
    link: caseRow.external_link || '',
    billingName: caseRow.billing_name || '',
    billingAddress: caseRow.billing_address || '',
    billingBranch: caseRow.billing_branch || '',
    taxId: caseRow.tax_id || '',
    followUpCount,
    quotationCount,
    quotationNumbers,
    statusHistory: statusesForHistory(caseRow.status_history),
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
    latestContactDetails: result.latestContactDetails,
    latestContactAt: result.latestContactAt,
    budget: result.budget,
    salesperson: result.salesperson,
    salespersonEmployeeId: result.salespersonEmployeeId,
    company: result.company,
    remarks: result.remarks,
    chatLink: result.chatLink,
    link: result.link,
    billingName: result.billingName,
    billingAddress: result.billingAddress,
    billingBranch: result.billingBranch,
    taxId: result.taxId,
    nextFollowUpAt: result.nextFollowUpAt,
    followUpCount: result.followUpCount,
    quotationCount: result.quotationCount,
    quotationNumbers: result.quotationNumbers,
    statusHistory: result.statusHistory,
  };
}

function throwDatabaseError(error, fallback = 'Supabase database is temporarily unavailable.') {
  if (!error) return;
  if (error.code === '23503' && /unknown crm salesperson nickname/i.test(error.message || '')) {
    throw new CrmRequestError(400, 'ไม่พบชื่อฝ่ายขายที่เลือก กรุณาเลือกจากรายชื่อพนักงาน', 'INVALID_SALESPERSON');
  }
  if (error.code === '42501') {
    throw new CrmRequestError(403, 'ไม่มีสิทธิ์เข้าถึงหรือแก้ไขรายการนี้', 'CRM_ROW_ACCESS_FORBIDDEN');
  }
  if (error.code === '42703' && /billing_branch/i.test(error.message || '')) {
    throw new CrmRequestError(
      503,
      'ยังไม่พบช่อง “สาขา” สำหรับออกบิล กรุณา apply migration 20260826140000_add_case_billing_branch.sql ก่อนใช้งาน',
      'BILLING_BRANCH_MIGRATION_REQUIRED'
    );
  }
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
    .select('id, legacy_cust_id, recorded_at, customer_name, gender, phone, email, contact_channel, contact_handle, chat_link, referral_source, remarks, created_by')
    .eq('legacy_cust_id', legacyCustomerId)
    .maybeSingle();
  throwDatabaseError(error);
  return data;
}

async function getLeads(client, query) {
  const requestedPage = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.max(10, Math.min(Number.parseInt(query.pageSize, 10) || 15, 100));
  const search = sanitizedSearch(query.search);
  const gender = text(query.gender);
  const channel = normalizeChannel(query.channel);
  const selectColumns = 'id, legacy_cust_id, recorded_at, customer_name, gender, phone, email, contact_channel, contact_handle, chat_link, referral_source, remarks, cases(count), lead_case_metrics:cases(company, quotation_history:lead_follow_up_history(quotation_numbers))';

  function buildQuery(page) {
    let request = client.from('customers').select(selectColumns, { count: 'exact' });
    if (search) {
      const term = `%${search}%`;
      request = request.or(`legacy_cust_id.ilike.${term},customer_name.ilike.${term},phone.ilike.${term},email.ilike.${term},contact_handle.ilike.${term}`);
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
    leads: (data || []).map((customer) => customerSummary(customer, customer.cases?.[0]?.count, customer.lead_case_metrics)),
    pagination: { page, pageSize, total, totalPages },
    apiVersion: CRM_API_VERSION,
  };
}

function nextBangkokDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return '';
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateKey) return '';
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function caseSearchCustomerIds(client, search) {
  if (!search) return [];
  const term = `%${search}%`;
  const { data, error } = await client
    .from('customers')
    .select('id')
    .or(`legacy_cust_id.ilike.${term},customer_name.ilike.${term},phone.ilike.${term},email.ilike.${term},contact_handle.ilike.${term}`)
    .limit(500);
  throwDatabaseError(error);
  return (data || []).map((customer) => text(customer?.id)).filter(Boolean);
}

function caseListQuery(client, filters = {}) {
  let request = client
    .from('cases')
    .select('legacy_case_id, recorded_at, created_at, admin_name, customer_type, topic, priority, site_type, site_address, location_text, location_url, province, product_interest, job_details, budget, salesperson, salesperson_employee_id, company, status, remarks, chat_link, external_link, billing_name, billing_address, billing_branch, tax_id, customers!inner(legacy_cust_id, customer_name, phone), lead_follow_up_history(count), quotation_history:lead_follow_up_history(quotation_numbers), latest_follow_up:lead_follow_up_history(next_follow_up_at, current_status, followed_at, created_at, notes, id)', { count: filters.withCount ? 'exact' : undefined })
    .order('recorded_at', { ascending: false })
    .order('followed_at', { referencedTable: 'latest_follow_up', ascending: false })
    .order('created_at', { referencedTable: 'latest_follow_up', ascending: false })
    .order('id', { referencedTable: 'latest_follow_up', ascending: false })
    .limit(1, { referencedTable: 'latest_follow_up' });

  if (filters.status) request = request.eq('status', filters.status);
  if (filters.admin) request = request.eq('admin_name', filters.admin);
  if (filters.salesperson) request = request.eq('salesperson', filters.salesperson);
  if (filters.date) {
    const nextDate = nextBangkokDateKey(filters.date);
    if (nextDate) {
      request = request
        .gte('recorded_at', `${filters.date}T00:00:00+07:00`)
        .lt('recorded_at', `${nextDate}T00:00:00+07:00`);
    }
  }
  if (filters.statuses?.length) request = request.in('status', filters.statuses);
  if (filters.search) {
    const term = `%${filters.search}%`;
    const fields = [
      'legacy_case_id', 'admin_name', 'customer_type', 'topic', 'priority', 'site_type',
      'site_address', 'location_text', 'location_url', 'province', 'product_interest',
      'job_details', 'budget', 'salesperson', 'company', 'status', 'remarks', 'chat_link',
      'external_link', 'billing_name', 'billing_address', 'billing_branch', 'tax_id',
    ].map((field) => `${field}.ilike.${term}`);
    if (filters.customerIds?.length) fields.push(`customer_id.in.(${filters.customerIds.join(',')})`);
    request = request.or(fields.join(','));
  }

  return request;
}

async function getCases(client) {
  const query = arguments[1] || {};
  const readThroughAt = new Date().toISOString();
  const scope = text(query.scope);

  if (scope === 'measurementQueue') {
    const { data, error } = await caseListQuery(client, {
      statuses: [...MEASUREMENT_QUEUE_STATUSES],
    }).limit(MEASUREMENT_QUEUE_CASE_LIMIT);
    throwDatabaseError(error);
    return {
      success: true,
      cases: (data || []).map(caseRecord),
      pagination: { page: 1, pageSize: MEASUREMENT_QUEUE_CASE_LIMIT, total: (data || []).length, totalPages: 1 },
      readThroughAt,
      apiVersion: CRM_API_VERSION,
    };
  }

  const requestedPage = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.max(10, Math.min(Number.parseInt(query.pageSize, 10) || 20, 100));
  const filters = {
    search: sanitizedSearch(query.search),
    status: text(query.status),
    admin: text(query.admin),
    salesperson: text(query.salesperson),
    date: text(query.date),
    withCount: true,
  };
  filters.customerIds = await caseSearchCustomerIds(client, filters.search);

  function buildQuery(page) {
    const from = (page - 1) * pageSize;
    return caseListQuery(client, filters).range(from, from + pageSize - 1);
  }

  let { data, error, count } = await buildQuery(requestedPage);
  throwDatabaseError(error);
  const total = Number(count) || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  if (page !== requestedPage && total > 0) {
    ({ data, error } = await buildQuery(page));
    throwDatabaseError(error);
  }

  return {
    success: true,
    cases: (data || []).map(caseRecord),
    pagination: { page, pageSize, total, totalPages },
    readThroughAt,
    apiVersion: CRM_API_VERSION,
  };
}

function bangkokDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(
    BANGKOK_DATE_FORMATTER
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
  return parts.year && parts.month && parts.day
    ? `${parts.year}-${parts.month}-${parts.day}`
    : '';
}

function addCalendarDays(dateKey, days) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const shifted = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + Number(days || 0)
  ));
  const pad = value => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function ordinaryFollowUpAt(activityAt, requestedAt = '') {
  const activityTimestamp = activityAt instanceof Date ? activityAt.getTime() : Date.parse(text(activityAt));
  if (!Number.isFinite(activityTimestamp)) return '';
  const activityDateKey = bangkokDateKey(new Date(activityTimestamp));
  if (!activityDateKey) return '';
  let time = '00:00:00';
  if (text(requestedAt)) {
    const requestedIso = requiredIsoDate(requestedAt, 'เวลานัดติดตามครั้งถัดไป');
    // Bangkok is UTC+7 without daylight-saving transitions. Keep an optional
    // selected time, but always replace the date with the activity day + 3.
    time = new Date(Date.parse(requestedIso) + 7 * 60 * 60 * 1000).toISOString().slice(11, 19);
  }
  return new Date(`${addCalendarDays(activityDateKey, 3)}T${time}+07:00`).toISOString();
}

function effectiveCaseFollowUpAt(caseRow) {
  const latestFollowUp = Array.isArray(caseRow?.latest_follow_up)
    ? caseRow.latest_follow_up[0] || {}
    : caseRow?.latest_follow_up || {};
  const status = text(caseRow?.status) || text(latestFollowUp.current_status);
  if (FOLLOW_UP_FINAL_STATUSES.has(status)) return '';
  const storedAt = text(latestFollowUp.next_follow_up_at);
  const validStoredAt = Number.isFinite(Date.parse(storedAt)) ? storedAt : '';
  if (CASE_APPOINTMENT_STATUSES.has(status)) {
    const scheduledStatus = text(latestFollowUp.current_status);
    return scheduledStatus && scheduledStatus !== status ? '' : validStoredAt;
  }

  const firstValidTimestamp = (...values) => values
    .map(value => Date.parse(text(value)))
    .find(Number.isFinite);
  const historyActivityAt = firstValidTimestamp(latestFollowUp.followed_at, latestFollowUp.created_at);
  const caseActivityAt = firstValidTimestamp(caseRow?.recorded_at, caseRow?.created_at);
  const anchors = [historyActivityAt, caseActivityAt].filter(Number.isFinite);
  if (!anchors.length) return validStoredAt;
  // Read-derived legacy schedules are anchored to saved activity/state dates,
  // never to request time: an overdue case stays overdue until it is followed up.
  return ordinaryFollowUpAt(new Date(Math.max(...anchors)), validStoredAt);
}

function isFollowUpTaskRecord(record) {
  const dueTimestamp = new Date(text(record?.nextFollowUpAt)).getTime();
  const status = text(record?.status) || text(record?.latestFollowUpStatus);
  return Number.isFinite(dueTimestamp)
    && !FOLLOW_UP_FINAL_STATUSES.has(status);
}

function sortFollowUpTaskRecords(records) {
  return (Array.isArray(records) ? records : [])
    .filter(isFollowUpTaskRecord)
    .sort((left, right) => {
      const dueDifference = new Date(left.nextFollowUpAt).getTime() - new Date(right.nextFollowUpAt).getTime();
      return dueDifference || text(left.caseId).localeCompare(text(right.caseId), 'th');
    });
}

function followUpTaskRecord(caseRow) {
  const customer = unwrapCustomer(caseRow?.customers);
  const latestFollowUp = Array.isArray(caseRow?.latest_follow_up)
    ? caseRow.latest_follow_up[0] || {}
    : caseRow?.latest_follow_up || {};
  return {
    caseId: caseRow?.legacy_case_id || '',
    customerId: customer.legacy_cust_id || '',
    customerName: customer.customer_name || '',
    customerPhone: customer.phone || '',
    company: caseRow?.company || '',
    topic: caseRow?.topic || '',
    siteType: caseRow?.site_type || '',
    siteAddress: caseRow?.site_address || '',
    province: caseRow?.province || '',
    status: caseRow?.status || '',
    priority: caseRow?.priority || '',
    admin: caseRow?.admin_name || '',
    salesperson: caseRow?.salesperson || '',
    salespersonEmployeeId: caseRow?.salesperson_employee_id || '',
    nextFollowUpAt: effectiveCaseFollowUpAt(caseRow),
    latestFollowUpStatus: latestFollowUp.current_status || '',
    latestContactDetails: latestFollowUp.notes || '',
    latestContactAt: latestFollowUp.followed_at || '',
  };
}

function followUpTaskBucket(record, generatedAt = new Date()) {
  const dueDateKey = bangkokDateKey(record?.nextFollowUpAt);
  const todayDateKey = bangkokDateKey(generatedAt);
  if (!dueDateKey || !todayDateKey) return '';
  if (dueDateKey < todayDateKey) return 'overdue';
  if (dueDateKey === todayDateKey) return 'today';
  if (dueDateKey <= addCalendarDays(todayDateKey, 7)) return 'upcoming';
  return 'later';
}

function summarizeFollowUpTasks(records, generatedAt = new Date()) {
  const summary = { total: 0, overdue: 0, today: 0, upcoming: 0, later: 0 };
  for (const record of Array.isArray(records) ? records : []) {
    const bucket = followUpTaskBucket(record, generatedAt);
    if (!bucket) continue;
    summary.total += 1;
    summary[bucket] += 1;
  }
  return summary;
}

function followUpTaskQuery(client, afterId = '') {
  let query = client
    .from('cases')
    .select('id, legacy_case_id, recorded_at, created_at, admin_name, topic, priority, site_type, site_address, province, salesperson, salesperson_employee_id, company, status, customers!inner(legacy_cust_id, customer_name, phone), latest_follow_up:lead_follow_up_history(next_follow_up_at, current_status, followed_at, created_at, notes, id)')
    .not('status', 'in', '("ยกเลิก","ปิดงาน")')
    .order('id', { ascending: true })
    .order('followed_at', { referencedTable: 'latest_follow_up', ascending: false })
    .order('created_at', { referencedTable: 'latest_follow_up', ascending: false })
    .order('id', { referencedTable: 'latest_follow_up', ascending: false })
    .limit(1, { referencedTable: 'latest_follow_up' });
  if (afterId) query = query.gt('id', afterId);
  return query;
}

function throwFollowUpTaskDatabaseError(error) {
  if (['42P01', '42703', 'PGRST200', 'PGRST204'].includes(error?.code)) {
    throw new CrmRequestError(503, 'ยังไม่พบตารางประวัติติดตามลีด กรุณา apply database migration ก่อนใช้งาน', 'FOLLOW_UP_TABLE_NOT_READY');
  }
  throwDatabaseError(error, 'ไม่สามารถโหลดกิจกรรมติดตามได้');
}

async function getFollowUpTasks(client, generatedAtValue = new Date()) {
  const generatedAt = generatedAtValue instanceof Date
    ? new Date(generatedAtValue.getTime())
    : new Date(generatedAtValue);
  if (!Number.isFinite(generatedAt.getTime())) {
    throw new CrmRequestError(500, 'ไม่สามารถกำหนดเวลาสร้างรายการติดตามได้', 'INVALID_FOLLOW_UP_GENERATED_AT');
  }

  const caseRows = [];
  let afterId = '';

  while (true) {
    const { data, error } = await followUpTaskQuery(client, afterId)
      .range(0, FOLLOW_UP_TASK_PAGE_SIZE - 1);
    throwFollowUpTaskDatabaseError(error);

    const pageRows = Array.isArray(data) ? data : [];
    if (!pageRows.length) break;
    caseRows.push(...pageRows);

    const nextAfterId = text(pageRows.at(-1)?.id);
    if (!nextAfterId || nextAfterId === afterId) {
      throw new CrmRequestError(503, 'ไม่สามารถแบ่งหน้ากิจกรรมติดตามได้ กรุณาลองใหม่อีกครั้ง', 'FOLLOW_UP_TASK_PAGINATION_FAILED');
    }
    afterId = nextAfterId;
  }

  const tasks = sortFollowUpTaskRecords(caseRows.map(followUpTaskRecord));
  return {
    success: true,
    tasks,
    summary: summarizeFollowUpTasks(tasks, generatedAt),
    generatedAt: generatedAt.toISOString(),
    apiVersion: CRM_API_VERSION,
  };
}

function isInstallationQueueRecord(record) {
  const appointmentTimestamp = new Date(text(record?.nextFollowUpAt)).getTime();
  return text(record?.status) === INSTALLATION_QUEUE_STATUS
    && text(record?.latestFollowUpStatus) === INSTALLATION_QUEUE_STATUS
    && Number.isFinite(appointmentTimestamp);
}

function sortInstallationQueueRecords(records) {
  return (Array.isArray(records) ? records : [])
    .filter(isInstallationQueueRecord)
    .sort((left, right) => {
      const appointmentDifference = new Date(left.nextFollowUpAt).getTime() - new Date(right.nextFollowUpAt).getTime();
      return appointmentDifference || text(left.caseId).localeCompare(text(right.caseId), 'th');
    });
}

function installationQueueQuery(client, afterId = '') {
  let query = client
    .from('cases')
    .select('id, legacy_case_id, recorded_at, admin_name, customer_type, topic, priority, site_type, site_address, location_text, location_url, province, product_interest, job_details, budget, salesperson, salesperson_employee_id, company, status, remarks, chat_link, external_link, billing_name, billing_address, billing_branch, tax_id, customers!inner(legacy_cust_id, customer_name, phone), lead_follow_up_history(count), quotation_history:lead_follow_up_history(quotation_numbers), latest_follow_up:lead_follow_up_history(next_follow_up_at, current_status, followed_at, created_at, notes, id)')
    .eq('status', INSTALLATION_QUEUE_STATUS)
    .order('id', { ascending: true })
    .order('followed_at', { referencedTable: 'latest_follow_up', ascending: false })
    .order('created_at', { referencedTable: 'latest_follow_up', ascending: false })
    .order('id', { referencedTable: 'latest_follow_up', ascending: false })
    .limit(1, { referencedTable: 'latest_follow_up' });
  if (afterId) query = query.gt('id', afterId);
  return query;
}

async function getInstallationQueue(client) {
  const readThroughAt = new Date().toISOString();
  const caseRows = [];
  let afterId = '';

  while (true) {
    const { data, error } = await installationQueueQuery(client, afterId)
      .range(0, INSTALLATION_QUEUE_PAGE_SIZE - 1);
    throwDatabaseError(error);

    const pageRows = Array.isArray(data) ? data : [];
    if (!pageRows.length) break;
    caseRows.push(...pageRows);

    const nextAfterId = text(pageRows.at(-1)?.id);
    if (!nextAfterId || nextAfterId === afterId) {
      throw new CrmRequestError(503, 'ไม่สามารถแบ่งหน้าคิวติดตั้งได้ กรุณาลองใหม่อีกครั้ง', 'INSTALLATION_QUEUE_PAGINATION_FAILED');
    }
    afterId = nextAfterId;
  }

  return {
    success: true,
    cases: sortInstallationQueueRecords(caseRows.map(caseRecord)),
    readThroughAt,
    apiVersion: CRM_API_VERSION,
  };
}

function generalTaskRecord(task) {
  return {
    id: task.id || '',
    title: task.title || '',
    description: task.description || '',
    customerName: task.contact_name || '',
    customerPhone: task.contact_phone || '',
    siteAddress: task.site_address || '',
    location: task.location_url || '',
    province: task.province || '',
    taskOwner: task.task_owner || '',
    dueAt: task.due_at || '',
    assignedTo: task.assigned_to || '',
    status: task.status || 'pending',
    completionNote: task.completion_note || '',
    completedAt: task.completed_at || '',
    createdAt: task.created_at || '',
    updatedAt: task.updated_at || '',
  };
}

function throwGeneralTaskDatabaseError(error, fallback = 'ไม่สามารถจัดการงานทั่วไปได้') {
  if (error?.code === '42P01') {
    throw new CrmRequestError(503, 'ระบบงานทั่วไปยังไม่พร้อม กรุณา apply database migration ก่อนใช้งาน', 'GENERAL_TASKS_TABLE_NOT_READY');
  }
  if (error?.code === '23503' && /unknown active crm salesperson nickname/i.test(error.message || '')) {
    throw new CrmRequestError(400, 'ไม่พบฝ่ายขายที่เลือก กรุณาเลือกจากข้อมูลพนักงาน', 'INVALID_GENERAL_TASK_ASSIGNEE');
  }
  throwDatabaseError(error, fallback);
}

async function getGeneralTasks(client) {
  const readThroughAt = new Date().toISOString();
  const { data, error } = await client
    .from('general_tasks')
    .select('id, title, description, contact_name, contact_phone, site_address, location_url, province, task_owner, due_at, assigned_to, status, completion_note, completed_at, created_at, updated_at')
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(1000);
  throwGeneralTaskDatabaseError(error, 'ไม่สามารถอ่านงานทั่วไปได้');
  return {
    success: true,
    tasks: (data || []).map(generalTaskRecord),
    readThroughAt,
    apiVersion: CRM_API_VERSION,
  };
}

function quotationListRecords(row) {
  const caseRow = Array.isArray(row?.cases) ? row.cases[0] || {} : row?.cases || {};
  const customer = unwrapCustomer(caseRow.customers);
  const snapshot = row?.quotation_snapshot && typeof row.quotation_snapshot === 'object' && !Array.isArray(row.quotation_snapshot)
    ? row.quotation_snapshot
    : null;
  const snapshotNumber = text(snapshot?.quoteNumber);
  const quotationNumbers = new Set(
    (Array.isArray(row?.quotation_numbers) ? row.quotation_numbers : [])
      .map(quotationNumber => text(quotationNumber))
      .filter(Boolean)
  );
  if (snapshotNumber) quotationNumbers.add(snapshotNumber);

  return [...quotationNumbers].map(quoteNumber => ({
    quoteNumber,
    caseId: caseRow.legacy_case_id || '',
    customerId: customer.legacy_cust_id || '',
    customerName: text(snapshot?.customerName) || customer.customer_name || '',
    // The report list is operational data, so retain the case's canonical
    // salesperson nickname. The quotation snapshot keeps the full name used
    // when rendering the quotation document itself.
    salesperson: text(caseRow.salesperson) || text(snapshot?.salesperson) || '',
    admin: caseRow.admin_name || '',
    company: text(snapshot?.company || caseRow.company).toUpperCase(),
    topic: caseRow.topic || '',
    siteAddress: caseRow.site_address || '',
    followedAt: row.followed_at || '',
    quotationSnapshot: snapshot && snapshotNumber === quoteNumber ? snapshot : null,
  }));
}

async function getQuotations(client) {
  const readThroughAt = new Date().toISOString();
  const { data, error } = await client
    .from('lead_follow_up_history')
    .select('id, followed_at, quotation_numbers, quotation_snapshot, cases!inner(legacy_case_id, company, admin_name, salesperson, topic, site_address, customers(legacy_cust_id, customer_name))')
    .not('quotation_numbers', 'eq', '{}')
    .order('followed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1000);

  if (['42P01', '42703'].includes(error?.code)) {
    throw new CrmRequestError(503, 'ยังไม่พบข้อมูลประวัติใบเสนอราคา กรุณา apply database migration ก่อนใช้งาน', 'QUOTATION_HISTORY_NOT_READY');
  }
  throwDatabaseError(error, 'ไม่สามารถอ่านรายการใบเสนอราคาได้');

  return {
    success: true,
    quotations: (data || []).flatMap(quotationListRecords),
    readThroughAt,
    apiVersion: CRM_API_VERSION,
  };
}

function normalizeCaseNotificationScope(value) {
  const scope = text(value);
  if (!CASE_NOTIFICATION_SCOPES.has(scope)) {
    throw new CrmRequestError(400, 'ประเภทการแจ้งเตือนเคสไม่ถูกต้อง', 'INVALID_CASE_NOTIFICATION_SCOPE');
  }
  return scope;
}

function normalizeCaseNotificationReadAt(value) {
  const now = Date.now();
  const requestedTime = Date.parse(value || '');
  return new Date(Number.isFinite(requestedTime) ? Math.min(requestedTime, now) : now).toISOString();
}

function notificationChangedAt(record) {
  const latestFollowUp = Array.isArray(record?.latest_follow_up)
    ? record.latest_follow_up[0] || {}
    : record?.latest_follow_up || {};
  const timestamps = [
    record?.updated_at,
    record?.created_at,
    latestFollowUp.updated_at,
    latestFollowUp.created_at,
    latestFollowUp.followed_at,
  ]
    .map(value => Date.parse(value || ''))
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : Number.NaN;
}

function isUnreadCaseNotification(caseRow, readAt) {
  const changedAt = notificationChangedAt(caseRow);
  const readTime = Date.parse(readAt || '');
  return Number.isFinite(changedAt) && (!Number.isFinite(readTime) || changedAt > readTime);
}

function quotationNotificationCount(quotationRows, readAt) {
  return (Array.isArray(quotationRows) ? quotationRows : []).reduce((count, row) => {
    if (!isUnreadCaseNotification(row, readAt)) return count;
    const quotationNumbers = new Set(
      (Array.isArray(row?.quotation_numbers) ? row.quotation_numbers : [])
        .map(quotationNumber => text(quotationNumber))
        .filter(Boolean)
    );
    const snapshotNumber = text(row?.quotation_snapshot?.quoteNumber);
    if (snapshotNumber) quotationNumbers.add(snapshotNumber);
    return count + quotationNumbers.size;
  }, 0);
}

function countUnreadCaseNotifications(
  caseRows,
  readMap,
  quotationRows = [],
  generalTaskRows = [],
  installationRows = caseRows
) {
  const rows = Array.isArray(caseRows) ? caseRows : [];
  const installationQueueRows = Array.isArray(installationRows) ? installationRows : [];
  const casesUnreadCount = rows.filter(row => isUnreadCaseNotification(row, readMap.get('cases'))).length;
  const measurementCaseUnreadCount = rows.filter(row => (
    MEASUREMENT_QUEUE_STATUSES.has(text(row?.status))
    && isUnreadCaseNotification(row, readMap.get('measurement_queue'))
  )).length;
  const generalTaskUnreadCount = (Array.isArray(generalTaskRows) ? generalTaskRows : []).filter(row => (
    text(row?.status) === 'pending'
    && isUnreadCaseNotification(row, readMap.get('measurement_queue'))
  )).length;
  const installationQueueUnreadCount = installationQueueRows.filter(row => (
    isInstallationQueueRecord(caseRecord(row))
    && isUnreadCaseNotification(row, readMap.get('installation_queue'))
  )).length;
  const quotationsUnreadCount = quotationNotificationCount(
    quotationRows,
    readMap.get('quotations')
  );
  return {
    casesUnreadCount,
    measurementQueueUnreadCount: measurementCaseUnreadCount + generalTaskUnreadCount,
    installationQueueUnreadCount,
    quotationsUnreadCount,
  };
}

function throwCaseNotificationReadDatabaseError(error, fallback) {
  if (error?.code === '42P01') {
    throw new CrmRequestError(503, 'ระบบแจ้งเตือนรายการเคสยังไม่พร้อม กรุณา apply database migration ก่อนใช้งาน', 'CASE_NOTIFICATION_READS_TABLE_NOT_READY');
  }
  throwDatabaseError(error, fallback);
}

async function getCaseNotificationReadMap(client, userId) {
  const { data, error } = await client
    .from('case_notification_reads')
    .select('notification_scope, read_at')
    .eq('user_id', userId);
  throwCaseNotificationReadDatabaseError(error, 'ไม่สามารถอ่านสถานะการแจ้งเตือนรายการเคสได้');
  return new Map((data || []).map(row => [row.notification_scope, row.read_at || '']));
}

function installationNotificationQuery(client, afterId = '') {
  let query = client
    .from('cases')
    .select('id, status, created_at, updated_at, latest_follow_up:lead_follow_up_history(next_follow_up_at, current_status, followed_at, created_at, updated_at, id)')
    .eq('status', INSTALLATION_QUEUE_STATUS)
    .order('id', { ascending: true })
    .order('followed_at', { referencedTable: 'latest_follow_up', ascending: false })
    .order('created_at', { referencedTable: 'latest_follow_up', ascending: false })
    .order('id', { referencedTable: 'latest_follow_up', ascending: false })
    .limit(1, { referencedTable: 'latest_follow_up' });
  if (afterId) query = query.gt('id', afterId);
  return query;
}

async function getInstallationNotificationRows(client) {
  const rows = [];
  let afterId = '';
  while (true) {
    const { data, error } = await installationNotificationQuery(client, afterId)
      .range(0, INSTALLATION_QUEUE_PAGE_SIZE - 1);
    throwDatabaseError(error, 'ไม่สามารถตรวจสอบคิวติดตั้งใหม่ได้');
    const pageRows = Array.isArray(data) ? data : [];
    if (!pageRows.length) break;
    rows.push(...pageRows);
    const nextAfterId = text(pageRows.at(-1)?.id);
    if (!nextAfterId || nextAfterId === afterId) {
      throw new CrmRequestError(503, 'ไม่สามารถแบ่งหน้าการแจ้งเตือนคิวติดตั้งได้ กรุณาลองใหม่อีกครั้ง', 'INSTALLATION_NOTIFICATION_PAGINATION_FAILED');
    }
    afterId = nextAfterId;
  }
  return rows;
}

async function getCaseNotificationUnreadCounts(client, userId) {
  const [
    { data: caseRows, error: casesError },
    installationRows,
    { data: quotationRows, error: quotationsError },
    { data: generalTaskRows, error: generalTasksError },
    readMap,
  ] = await Promise.all([
    client
      .from('cases')
      .select('id, status, recorded_at, created_at, updated_at, latest_follow_up:lead_follow_up_history(next_follow_up_at, current_status, followed_at, created_at, updated_at, id)')
      .order('recorded_at', { ascending: false })
      .order('followed_at', { referencedTable: 'latest_follow_up', ascending: false })
      .order('created_at', { referencedTable: 'latest_follow_up', ascending: false })
      .order('id', { referencedTable: 'latest_follow_up', ascending: false })
      .limit(1, { referencedTable: 'latest_follow_up' })
      .limit(1000),
    getInstallationNotificationRows(client),
    client
      .from('lead_follow_up_history')
      .select('id, followed_at, quotation_numbers, quotation_snapshot, created_at, updated_at, cases!inner(id)')
      .not('quotation_numbers', 'eq', '{}')
      .order('followed_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1000),
    client
      .from('general_tasks')
      .select('id, status, due_at, created_at, updated_at')
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1000),
    getCaseNotificationReadMap(client, userId),
  ]);
  throwDatabaseError(casesError, 'ไม่สามารถตรวจสอบรายการเคสใหม่ได้');
  throwDatabaseError(quotationsError, 'ไม่สามารถตรวจสอบใบเสนอราคาใหม่ได้');
  throwDatabaseError(generalTasksError, 'ไม่สามารถตรวจสอบงานทั่วไปใหม่ได้');
  return {
    success: true,
    ...countUnreadCaseNotifications(
      caseRows,
      readMap,
      quotationRows,
      generalTaskRows,
      installationRows
    ),
    apiVersion: CRM_API_VERSION,
  };
}

async function markCaseNotificationsRead(client, userId, scopeValue, readThroughAtValue) {
  const notificationScope = normalizeCaseNotificationScope(scopeValue);
  const readAt = normalizeCaseNotificationReadAt(readThroughAtValue);
  const { error } = await client
    .from('case_notification_reads')
    .upsert({
      user_id: userId,
      notification_scope: notificationScope,
      read_at: readAt,
    }, { onConflict: 'user_id,notification_scope' });
  throwCaseNotificationReadDatabaseError(error, 'ไม่สามารถบันทึกสถานะอ่านรายการเคสได้');
  return getCaseNotificationUnreadCounts(client, userId);
}

async function getLeadDetail(client, legacyCustomerId) {
  if (!legacyCustomerId) throw new CrmRequestError(400, 'กรุณาระบุรหัสลูกค้า', 'MISSING_CUSTOMER_ID');
  const customer = await readCustomerByLegacyId(client, legacyCustomerId);
  if (!customer) throw new CrmRequestError(404, `ไม่พบข้อมูลลูกค้า: ${legacyCustomerId}`, 'CUSTOMER_NOT_FOUND');

  const { data: cases, error } = await client
    .from('cases')
    .select('legacy_case_id, recorded_at, created_at, admin_name, customer_type, topic, priority, site_type, site_address, location_text, location_url, province, product_interest, job_details, budget, salesperson, salesperson_employee_id, company, status, remarks, chat_link, external_link, billing_name, billing_address, billing_branch, tax_id, lead_follow_up_history(count), quotation_history:lead_follow_up_history(quotation_numbers), status_history:lead_follow_up_history(current_status), latest_follow_up:lead_follow_up_history(next_follow_up_at, current_status, followed_at, created_at, notes, id)')
    .eq('customer_id', customer.id)
    .order('recorded_at', { ascending: false })
    .order('followed_at', { referencedTable: 'latest_follow_up', ascending: false })
    .order('created_at', { referencedTable: 'latest_follow_up', ascending: false })
    .order('id', { referencedTable: 'latest_follow_up', ascending: false })
    .limit(1, { referencedTable: 'latest_follow_up' });
  throwDatabaseError(error);
  const timeline = (cases || []).map(caseTimelineRecord);
  const lead = customerSummary(customer, timeline.length);
  let creatorName = '';
  if (customer.created_by) {
    // Resolve only the creator of this accessible customer, never the account directory.
    const { data: creator, error: creatorError } = await client
      .rpc('get_customer_creator', { p_customer_id: customer.id })
      .maybeSingle();
    throwDatabaseError(creatorError, 'ไม่สามารถอ่านชื่อผู้บันทึกลูกค้าได้');
    creatorName = text(creator?.display_name);
  }
  lead['บันทึกโดย'] = creatorName;
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
  const columns = 'legacy_cust_id, customer_name, gender, phone, email, contact_channel, contact_handle, chat_link, referral_source, remarks';
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

async function getEmployees(client, position, assignment) {
  const normalizedPosition = text(position).slice(0, 120) || 'Admin Sale';
  if (isRestrictedCrmSales(assignment) && normalizedPosition.toLowerCase() === 'sales representative') {
    return {
      success: true,
      employees: [{ name: assignment.salespersonName, position: normalizedPosition }],
      apiVersion: CRM_API_VERSION,
    };
  }
  const { data, error } = await client
    .rpc('list_crm_employees_by_position', { p_position: normalizedPosition });
  throwDatabaseError(error, 'ไม่สามารถโหลดรายชื่อพนักงานตามตำแหน่งได้');
  return {
    success: true,
    employees: (data || []).map((employee) => ({
      name: employee.name,
      position: employee.position,
    })),
    apiVersion: CRM_API_VERSION,
  };
}

async function getCaseSalespersonContact(client, caseIdValue) {
  const caseId = text(caseIdValue);
  if (!caseId) throw new CrmRequestError(400, 'ไม่พบ Case_ID ของใบเสนอราคา', 'MISSING_CASE_ID');

  const { data: caseRow, error: caseError } = await client
    .from('cases')
    .select('id, legacy_case_id, salesperson')
    .eq('legacy_case_id', caseId)
    .maybeSingle();
  throwDatabaseError(caseError, 'ไม่สามารถตรวจสอบฝ่ายขายของใบเสนอราคาได้');
  if (!caseRow) throw new CrmRequestError(404, `ไม่พบเคส ${caseId}`, 'CASE_NOT_FOUND');

  const { data, error } = await client.rpc('get_case_salesperson_contact', { p_case_id: caseRow.id });
  if (error?.code === 'PGRST202' || error?.code === '42883') {
    throw new CrmRequestError(503, 'ยังไม่ได้ติดตั้งข้อมูลติดต่อพนักงานขายสำหรับใบเสนอราคา', 'SALESPERSON_CONTACT_LOOKUP_NOT_READY');
  }
  throwDatabaseError(error, 'ไม่สามารถอ่านข้อมูลติดต่อพนักงานขายได้');
  const contact = Array.isArray(data) ? data[0] || {} : data || {};
  const fullName = text(contact.full_name).slice(0, 500);
  const phone = text(contact.phone).slice(0, 100);
  const name = fullName || text(caseRow.salesperson).slice(0, 500);
  return {
    success: true,
    caseId: caseRow.legacy_case_id,
    fullName,
    phone,
    display: name && phone ? `${name} (${phone})` : name,
    apiVersion: CRM_API_VERSION,
  };
}

async function getCaseAdminContact(client, caseIdValue) {
  const caseId = text(caseIdValue);
  if (!caseId) throw new CrmRequestError(400, 'ไม่พบ Case_ID ของใบเสนอราคา', 'MISSING_CASE_ID');

  const { data: caseRow, error: caseError } = await client
    .from('cases')
    .select('id, legacy_case_id, admin_name')
    .eq('legacy_case_id', caseId)
    .maybeSingle();
  throwDatabaseError(caseError, 'ไม่สามารถตรวจสอบแอดมินของใบเสนอราคาได้');
  if (!caseRow) throw new CrmRequestError(404, `ไม่พบเคส ${caseId}`, 'CASE_NOT_FOUND');

  const { data, error } = await client.rpc('get_case_admin_contact', { p_case_id: caseRow.id });
  if (error?.code === 'PGRST202' || error?.code === '42883') {
    throw new CrmRequestError(503, 'ยังไม่ได้ติดตั้งข้อมูลติดต่อแอดมินสำหรับใบเสนอราคา', 'ADMIN_CONTACT_LOOKUP_NOT_READY');
  }
  throwDatabaseError(error, 'ไม่สามารถอ่านข้อมูลติดต่อแอดมินได้');
  const contact = Array.isArray(data) ? data[0] || {} : data || {};
  const fullName = text(contact.full_name).slice(0, 500);
  const phone = text(contact.phone).slice(0, 100);
  const name = fullName || text(caseRow.admin_name).slice(0, 500);
  return {
    success: true,
    caseId: caseRow.legacy_case_id,
    fullName,
    phone,
    display: name && phone ? `${name} (${phone})` : name,
    apiVersion: CRM_API_VERSION,
  };
}

function requireEmployeeAdministrator(membership) {
  if (membership?.role !== 'admin') {
    throw new CrmRequestError(403, 'เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการข้อมูลพนักงานได้', 'EMPLOYEE_ADMIN_REQUIRED');
  }
}

function requireContactTopicAdministrator(membership) {
  if (membership?.role !== 'admin') {
    throw new CrmRequestError(403, 'เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการหัวข้อที่ติดต่อได้', 'CONTACT_TOPIC_ADMIN_REQUIRED');
  }
}

function requireSiteTypeAdministrator(membership) {
  if (membership?.role !== 'admin') {
    throw new CrmRequestError(403, 'เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการประเภทหน้างานได้', 'SITE_TYPE_ADMIN_REQUIRED');
  }
}

function requireReferralSourceAdministrator(membership) {
  if (membership?.role !== 'admin') {
    throw new CrmRequestError(403, 'เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการแหล่งที่รู้จักครั้งแรกได้', 'REFERRAL_SOURCE_ADMIN_REQUIRED');
  }
}

function requireProductAdministrator(membership) {
  if (membership?.role !== 'admin') {
    throw new CrmRequestError(403, 'เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการข้อมูลสินค้าได้', 'PRODUCT_ADMIN_REQUIRED');
  }
}

function canManageAnnouncements(membership) {
  return ['admin', 'manager'].includes(text(membership?.role).toLowerCase());
}

function requireAnnouncementManager(membership) {
  if (!canManageAnnouncements(membership)) {
    throw new CrmRequestError(
      403,
      'เฉพาะผู้จัดการและผู้ดูแลระบบเท่านั้นที่จัดการข่าวประกาศได้',
      'ANNOUNCEMENT_MANAGER_REQUIRED'
    );
  }
}

function announcementRecord(announcement, readAt = '') {
  return {
    id: announcement.id || '',
    title: announcement.title || '',
    content: announcement.content || '',
    imagePath: announcement.image_path || '',
    isPublished: announcement.is_published !== false,
    isPinned: announcement.is_pinned === true,
    publishedAt: announcement.published_at || '',
    createdAt: announcement.created_at || '',
    updatedAt: announcement.updated_at || '',
    readAt: readAt || '',
    isRead: Boolean(readAt),
  };
}

function throwAnnouncementDatabaseError(error, fallback) {
  if (error?.code === '42703' && /is_pinned/.test(error.message || '')) {
    throw new CrmRequestError(503, 'ระบบปักหมุดยังไม่พร้อม กรุณา apply database migration ก่อนใช้งาน', 'ANNOUNCEMENT_PINNING_NOT_READY');
  }
  if (error?.code === '42P01') {
    throw new CrmRequestError(503, 'ยังไม่พบตารางข่าวประกาศ กรุณา apply database migration ก่อนใช้งาน', 'ANNOUNCEMENT_TABLE_NOT_READY');
  }
  throwDatabaseError(error, fallback);
}

function throwAnnouncementReadDatabaseError(error, fallback) {
  if (error?.code === '42P01') {
    throw new CrmRequestError(503, 'ระบบแจ้งเตือนข่าวประกาศยังไม่พร้อม กรุณา apply database migration ก่อนใช้งาน', 'ANNOUNCEMENT_READS_TABLE_NOT_READY');
  }
  throwDatabaseError(error, fallback);
}

function announcementPinnedValue(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new CrmRequestError(400, 'สถานะปักหมุดไม่ถูกต้อง', 'INVALID_ANNOUNCEMENT_PINNED');
}

function announcementWritePayload(body, userId) {
  const title = text(body.title).replace(/\s+/g, ' ').slice(0, 180);
  const content = text(body.content).slice(0, 5000);
  const imagePath = text(body.imagePath).slice(0, 500);
  const isPublished = body.isPublished === undefined
    ? true
    : !['false', '0', 'off', 'no'].includes(String(body.isPublished).trim().toLowerCase());

  if (!title) throw new CrmRequestError(400, 'กรุณาระบุหัวข้อข่าวประกาศ', 'MISSING_ANNOUNCEMENT_TITLE');
  if (imagePath && !/^announcements\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(imagePath)) {
    throw new CrmRequestError(400, 'พาธรูปข่าวประกาศไม่ถูกต้อง', 'INVALID_ANNOUNCEMENT_IMAGE_PATH');
  }

  return {
    title,
    content: nullableText(content),
    image_path: nullableText(imagePath),
    is_published: isPublished,
    ...(body.isPinned === undefined ? {} : { is_pinned: announcementPinnedValue(body.isPinned) }),
    published_at: new Date().toISOString(),
    updated_by: userId,
  };
}

async function getAnnouncementReadMap(client, userId) {
  const { data, error } = await client
    .from('announcement_reads')
    .select('announcement_id, read_at')
    .eq('user_id', userId);
  throwAnnouncementReadDatabaseError(error, 'ไม่สามารถอ่านสถานะข่าวประกาศได้');
  return new Map((data || []).map(row => [row.announcement_id, row.read_at || '']));
}

function countUnreadAnnouncements(rows, readMap) {
  return rows.filter(announcement => announcement.is_published !== false && !readMap.has(announcement.id)).length;
}

async function getAnnouncements(client, userId, membership, includeUnpublished = false) {
  const shouldIncludeUnpublished = includeUnpublished === true;
  if (shouldIncludeUnpublished) requireAnnouncementManager(membership);

  let request = client
    .from('announcements')
    .select('id, title, content, image_path, is_published, is_pinned, published_at, created_at, updated_at')
    .order('is_pinned', { ascending: false })
    .order('published_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (!shouldIncludeUnpublished) request = request.eq('is_published', true);

  const { data, error } = await request;
  throwAnnouncementDatabaseError(error, 'ไม่สามารถโหลดข่าวประกาศได้');
  const announcementRows = data || [];
  const readMap = await getAnnouncementReadMap(client, userId);
  return {
    success: true,
    announcements: announcementRows.map(announcement => announcementRecord(announcement, readMap.get(announcement.id))),
    unreadCount: countUnreadAnnouncements(announcementRows, readMap),
    canManage: canManageAnnouncements(membership),
    apiVersion: CRM_API_VERSION,
  };
}

async function getAnnouncementUnreadCount(client, userId) {
  const { data, error } = await client
    .from('announcements')
    .select('id, is_published')
    .eq('is_published', true);
  throwAnnouncementDatabaseError(error, 'ไม่สามารถตรวจสอบข่าวประกาศใหม่ได้');
  const announcementRows = data || [];
  const readMap = await getAnnouncementReadMap(client, userId);
  return {
    success: true,
    unreadCount: countUnreadAnnouncements(announcementRows, readMap),
    apiVersion: CRM_API_VERSION,
  };
}

async function markAnnouncementsRead(client, userId) {
  const { data, error } = await client
    .from('announcements')
    .select('id')
    .eq('is_published', true);
  throwAnnouncementDatabaseError(error, 'ไม่สามารถเปิดอ่านข่าวประกาศได้');

  const rows = (data || []).map(announcement => ({
    announcement_id: announcement.id,
    user_id: userId,
    read_at: new Date().toISOString(),
  }));
  if (rows.length) {
    const { error: upsertError } = await client
      .from('announcement_reads')
      .upsert(rows, { onConflict: 'announcement_id,user_id' });
    throwAnnouncementReadDatabaseError(upsertError, 'ไม่สามารถบันทึกสถานะอ่านข่าวประกาศได้');
  }

  return { success: true, unreadCount: 0, apiVersion: CRM_API_VERSION };
}

async function saveAnnouncement(client, userId, membership, body) {
  requireAnnouncementManager(membership);
  const announcementId = text(body.announcementId);
  const payload = announcementWritePayload(body, userId);
  const columns = 'id, title, content, image_path, is_published, is_pinned, published_at, created_at, updated_at';
  let previousImagePath = '';

  if (announcementId) {
    const { data: existing, error: existingError } = await client
      .from('announcements')
      .select('image_path')
      .eq('id', announcementId)
      .maybeSingle();
    throwAnnouncementDatabaseError(existingError, 'ไม่สามารถอ่านข้อมูลข่าวประกาศเดิมได้');
    if (!existing) throw new CrmRequestError(404, 'ไม่พบข่าวประกาศที่ต้องการแก้ไข', 'ANNOUNCEMENT_NOT_FOUND');
    previousImagePath = text(existing.image_path);
  }

  const result = announcementId
    ? await client.from('announcements').update(payload).eq('id', announcementId).select(columns).maybeSingle()
    : await client.from('announcements').insert({ ...payload, created_by: userId }).select(columns).single();
  throwAnnouncementDatabaseError(result.error, announcementId ? 'ไม่สามารถแก้ไขข่าวประกาศได้' : 'ไม่สามารถเพิ่มข่าวประกาศได้');
  if (!result.data) throw new CrmRequestError(404, 'ไม่พบข่าวประกาศที่ต้องการแก้ไข', 'ANNOUNCEMENT_NOT_FOUND');

  if (previousImagePath && previousImagePath !== payload.image_path) {
    const { error: removeError } = await client.storage.from('announcement-images').remove([previousImagePath]);
    if (removeError) console.warn('Unable to remove replaced announcement image:', removeError.message);
  }
  return { success: true, announcement: announcementRecord(result.data), apiVersion: CRM_API_VERSION };
}

async function setAnnouncementPinned(client, userId, membership, body) {
  requireAnnouncementManager(membership);
  const announcementId = text(body.announcementId);
  if (!announcementId) throw new CrmRequestError(400, 'ไม่พบข่าวประกาศที่ต้องการปักหมุด', 'MISSING_ANNOUNCEMENT_ID');
  const isPinned = announcementPinnedValue(body.isPinned);
  const { data, error } = await client.from('announcements')
    .update({ is_pinned: isPinned, updated_by: userId })
    .eq('id', announcementId)
    .select('id, title, content, image_path, is_published, is_pinned, published_at, created_at, updated_at')
    .maybeSingle();
  throwAnnouncementDatabaseError(error, 'ไม่สามารถเปลี่ยนสถานะปักหมุดได้');
  if (!data) throw new CrmRequestError(404, 'ไม่พบข่าวประกาศที่ต้องการปักหมุด', 'ANNOUNCEMENT_NOT_FOUND');
  return { success: true, announcement: announcementRecord(data), apiVersion: CRM_API_VERSION };
}

async function deleteAnnouncement(client, membership, body) {
  requireAnnouncementManager(membership);
  const announcementId = text(body.announcementId);
  if (!announcementId) throw new CrmRequestError(400, 'ไม่พบข่าวประกาศที่ต้องการลบ', 'MISSING_ANNOUNCEMENT_ID');

  const { data, error } = await client
    .from('announcements')
    .delete()
    .eq('id', announcementId)
    .select('id, image_path')
    .maybeSingle();
  throwAnnouncementDatabaseError(error, 'ไม่สามารถลบข่าวประกาศได้');
  if (!data) throw new CrmRequestError(404, 'ไม่พบข่าวประกาศที่ต้องการลบ', 'ANNOUNCEMENT_NOT_FOUND');

  const imagePath = text(data.image_path);
  if (imagePath) {
    const { error: removeError } = await client.storage.from('announcement-images').remove([imagePath]);
    if (removeError) console.warn('Unable to remove deleted announcement image:', removeError.message);
  }
  return { success: true, announcementId, apiVersion: CRM_API_VERSION };
}

function employeeRecord(employee) {
  return {
    id: employee.id || '',
    employeeCode: employee.employee_code || '',
    recordedAt: employee.created_at || '',
    nickname: employee.nickname || '',
    fullName: employee.full_name || '',
    position: employee.position || '',
    phone: employee.phone || '',
    email: employee.email || '',
    company: employee.company || '',
    status: employee.status || 'active',
    notes: employee.notes || '',
    loginName: employee.login_name || '',
    accessRole: employee.access_role || 'sales',
  };
}

function employeeWritePayload(body, userId) {
  const nickname = text(body.nickname).slice(0, 100);
  const fullName = text(body.fullName).slice(0, 200);
  const position = text(body.position).slice(0, 120);
  const phone = text(body.phone).slice(0, 30);
  const email = text(body.email).toLowerCase().slice(0, 254);
  const company = text(body.company).slice(0, 120);
  const notes = text(body.notes).slice(0, 2000);
  const loginName = text(body.loginName).slice(0, 120);
  const status = text(body.status) || 'active';
  const accessRole = text(body.accessRole) || 'sales';

  if (!nickname) throw new CrmRequestError(400, 'กรุณาระบุชื่อเล่นพนักงาน', 'MISSING_EMPLOYEE_NICKNAME');
  if (!EMPLOYEE_STATUSES.has(status)) throw new CrmRequestError(400, 'สถานะพนักงานไม่ถูกต้อง', 'INVALID_EMPLOYEE_STATUS');
  if (!EMPLOYEE_ACCESS_ROLES.has(accessRole)) throw new CrmRequestError(400, 'สิทธิ์การเข้าถึงไม่ถูกต้อง', 'INVALID_EMPLOYEE_ACCESS_ROLE');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CrmRequestError(400, 'รูปแบบอีเมลไม่ถูกต้อง', 'INVALID_EMPLOYEE_EMAIL');
  }

  return {
    nickname,
    full_name: nullableText(fullName),
    position: nullableText(position),
    phone: nullableText(phone),
    email: nullableText(email),
    company: nullableText(company),
    status,
    notes: nullableText(notes),
    login_name: nullableText(loginName),
    access_role: accessRole,
    updated_by: userId,
  };
}

async function getEmployeeDirectory(client, membership) {
  requireEmployeeAdministrator(membership);
  const { data, error } = await client
    .from('crm_employees')
    .select('id, employee_code, created_at, nickname, full_name, position, phone, email, company, status, notes, login_name, access_role')
    .order('created_at', { ascending: false });
  throwDatabaseError(error);
  return { success: true, employees: (data || []).map(employeeRecord), apiVersion: CRM_API_VERSION };
}

function throwEmployeeSaveError(error, fallback) {
  if (error?.code === '23505' && /crm_employees_nickname_normalized_unique/i.test(error.message || '')) {
    throw new CrmRequestError(409, 'ชื่อเล่นพนักงานนี้มีอยู่แล้ว กรุณาใช้ชื่อที่ไม่ซ้ำกัน', 'DUPLICATE_EMPLOYEE_NICKNAME');
  }
  throwDatabaseError(error, fallback);
}

async function saveEmployee(client, userId, membership, body) {
  requireEmployeeAdministrator(membership);
  const employeeId = text(body.employeeId);
  const payload = employeeWritePayload(body, userId);
  if (!employeeId) {
    const { data, error } = await client
      .from('crm_employees')
      .insert({ ...payload, created_by: userId })
      .select('id, employee_code, created_at, nickname, full_name, position, phone, email, company, status, notes, login_name, access_role')
      .single();
    throwEmployeeSaveError(error, 'ไม่สามารถเพิ่มข้อมูลพนักงานได้');
    return { success: true, employee: employeeRecord(data), apiVersion: CRM_API_VERSION };
  }

  const { data, error } = await client
    .from('crm_employees')
    .update(payload)
    .eq('id', employeeId)
    .select('id, employee_code, created_at, nickname, full_name, position, phone, email, company, status, notes, login_name, access_role')
    .maybeSingle();
  throwEmployeeSaveError(error, 'ไม่สามารถแก้ไขข้อมูลพนักงานได้');
  if (!data) throw new CrmRequestError(404, 'ไม่พบข้อมูลพนักงานที่ต้องการแก้ไข', 'EMPLOYEE_NOT_FOUND');
  return { success: true, employee: employeeRecord(data), apiVersion: CRM_API_VERSION };
}

async function deleteEmployee(client, membership, body) {
  requireEmployeeAdministrator(membership);
  const employeeId = text(body.employeeId);
  if (!employeeId) throw new CrmRequestError(400, 'ไม่พบข้อมูลพนักงานที่ต้องการลบ', 'MISSING_EMPLOYEE_ID');
  const { data, error } = await client
    .from('crm_employees')
    .delete()
    .eq('id', employeeId)
    .select('id')
    .maybeSingle();
  if (
    error?.code === '23503'
    && /(cases_salesperson_employee_id_fkey|general_tasks_assigned_employee_id_fkey)/i.test(`${error.message || ''} ${error.details || ''}`)
  ) {
    throw new CrmRequestError(
      409,
      'พนักงานยังมีเคสหรืองานทั่วไปที่รับผิดชอบ กรุณาโอนงานให้พนักงานคนอื่นหรือเปลี่ยนสถานะเป็นไม่ใช้งาน',
      'EMPLOYEE_HAS_ASSIGNMENTS'
    );
  }
  throwDatabaseError(error, 'ไม่สามารถลบข้อมูลพนักงานได้');
  if (!data) throw new CrmRequestError(404, 'ไม่พบข้อมูลพนักงานที่ต้องการลบ', 'EMPLOYEE_NOT_FOUND');
  return { success: true, employeeId, apiVersion: CRM_API_VERSION };
}

function contactTopicRecord(topic) {
  return {
    id: topic.id || '',
    name: topic.name || '',
    description: topic.description || '',
    isActive: topic.is_active !== false,
    sortOrder: Number(topic.sort_order) || 0,
    usageCount: Math.max(0, Number(topic.usage_count) || 0),
    createdAt: topic.created_at || '',
    updatedAt: topic.updated_at || '',
  };
}

function throwContactTopicDatabaseError(error, fallback) {
  if (error?.code === '42P01') {
    throw new CrmRequestError(503, 'ยังไม่พบตารางหัวข้อที่ติดต่อ กรุณา apply database migration ก่อนใช้งาน', 'CONTACT_TOPIC_TABLE_NOT_READY');
  }
  throwDatabaseError(error, fallback);
}

async function getContactTopics(client, membership, includeInactive = false) {
  if (includeInactive) requireContactTopicAdministrator(membership);
  let request = client
    .from('contact_topics')
    .select('id, name, description, is_active, sort_order, created_at, updated_at')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (!includeInactive) request = request.eq('is_active', true);
  const { data, error } = await request;
  throwContactTopicDatabaseError(error, 'ไม่สามารถโหลดหัวข้อที่ติดต่อได้');

  let usageCountByTopicId = new Map();
  if (includeInactive && data?.length) {
    const { data: usageRows, error: usageError } = await client
      .from('contact_topic_usage_counts')
      .select('contact_topic_id, usage_count');
    if (usageError?.code === '42P01') {
      throw new CrmRequestError(503, 'ยังไม่พบข้อมูลสรุปการใช้งานหัวข้อ กรุณา apply database migration ก่อนใช้งาน', 'CONTACT_TOPIC_USAGE_VIEW_NOT_READY');
    }
    throwContactTopicDatabaseError(usageError, 'ไม่สามารถนับการใช้งานหัวข้อที่ติดต่อได้');
    usageCountByTopicId = new Map((usageRows || []).map((row) => [row.contact_topic_id, Number(row.usage_count) || 0]));
  }

  return {
    success: true,
    contactTopics: (data || []).map((topic) => contactTopicRecord({
      ...topic,
      usage_count: usageCountByTopicId.get(topic.id) || 0,
    })),
    apiVersion: CRM_API_VERSION,
  };
}

function contactTopicWritePayload(body, userId) {
  const name = text(body.name).replace(/\s+/g, ' ').slice(0, 120);
  const description = text(body.description).slice(0, 1000);
  const sortOrderSource = text(body.sortOrder);
  const sortOrder = sortOrderSource === '' ? 0 : Number(sortOrderSource);
  const isActive = body.isActive === undefined
    ? true
    : !['false', '0', 'off', 'no'].includes(String(body.isActive).trim().toLowerCase());

  if (!name) throw new CrmRequestError(400, 'กรุณาระบุชื่อหัวข้อที่ติดต่อ', 'MISSING_CONTACT_TOPIC_NAME');
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 999999) {
    throw new CrmRequestError(400, 'ลำดับหัวข้อที่ติดต่อไม่ถูกต้อง', 'INVALID_CONTACT_TOPIC_SORT_ORDER');
  }

  return {
    name,
    description: nullableText(description),
    is_active: isActive,
    sort_order: sortOrder,
    updated_by: userId,
  };
}

async function saveContactTopic(client, userId, membership, body) {
  requireContactTopicAdministrator(membership);
  const contactTopicId = text(body.contactTopicId);
  const payload = contactTopicWritePayload(body, userId);
  const columns = 'id, name, description, is_active, sort_order, created_at, updated_at';
  const result = contactTopicId
    ? await client.from('contact_topics').update(payload).eq('id', contactTopicId).select(columns).maybeSingle()
    : await client.from('contact_topics').insert({ ...payload, created_by: userId }).select(columns).single();

  if (result.error?.code === '23505') {
    throw new CrmRequestError(409, 'มีหัวข้อที่ติดต่อชื่อนี้อยู่แล้ว', 'DUPLICATE_CONTACT_TOPIC');
  }
  throwContactTopicDatabaseError(
    result.error,
    contactTopicId ? 'ไม่สามารถแก้ไขหัวข้อที่ติดต่อได้' : 'ไม่สามารถเพิ่มหัวข้อที่ติดต่อได้'
  );
  if (!result.data) throw new CrmRequestError(404, 'ไม่พบหัวข้อที่ติดต่อที่ต้องการแก้ไข', 'CONTACT_TOPIC_NOT_FOUND');
  return { success: true, contactTopic: contactTopicRecord(result.data), apiVersion: CRM_API_VERSION };
}

async function deleteContactTopic(client, membership, body) {
  requireContactTopicAdministrator(membership);
  const contactTopicId = text(body.contactTopicId);
  if (!contactTopicId) throw new CrmRequestError(400, 'ไม่พบหัวข้อที่ติดต่อที่ต้องการลบ', 'MISSING_CONTACT_TOPIC_ID');
  const { data, error } = await client
    .from('contact_topics')
    .delete()
    .eq('id', contactTopicId)
    .select('id')
    .maybeSingle();
  throwContactTopicDatabaseError(error, 'ไม่สามารถลบหัวข้อที่ติดต่อได้');
  if (!data) throw new CrmRequestError(404, 'ไม่พบหัวข้อที่ติดต่อที่ต้องการลบ', 'CONTACT_TOPIC_NOT_FOUND');
  return { success: true, contactTopicId, apiVersion: CRM_API_VERSION };
}

function siteTypeRecord(siteType) {
  return {
    id: siteType.id || '',
    name: siteType.name || '',
    isActive: siteType.is_active !== false,
    sortOrder: Number(siteType.sort_order) || 0,
    usageCount: Math.max(0, Number(siteType.usage_count) || 0),
    createdAt: siteType.created_at || '',
    updatedAt: siteType.updated_at || '',
  };
}

function throwSiteTypeDatabaseError(error, fallback) {
  // Postgres returns 42P01 for a missing relation over a direct connection;
  // the Supabase Data API returns PGRST205 when the new table is absent from
  // its schema cache. Treat both as the same actionable migration problem.
  if (['42P01', 'PGRST205'].includes(error?.code)) {
    throw new CrmRequestError(503, 'ยังไม่พบตารางประเภทหน้างาน กรุณา apply database migration ก่อนใช้งาน', 'SITE_TYPE_TABLE_NOT_READY');
  }
  throwDatabaseError(error, fallback);
}

async function getSiteTypes(client, membership, includeInactive = false) {
  if (includeInactive) requireSiteTypeAdministrator(membership);
  let request = client
    .from('site_types')
    .select('id, name, is_active, sort_order, created_at, updated_at')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (!includeInactive) request = request.eq('is_active', true);
  const { data, error } = await request;
  throwSiteTypeDatabaseError(error, 'ไม่สามารถโหลดประเภทหน้างานได้');

  let usageCountBySiteTypeId = new Map();
  if (includeInactive && data?.length) {
    const { data: usageRows, error: usageError } = await client
      .from('site_type_usage_counts')
      .select('site_type_id, usage_count');
    if (['42P01', 'PGRST205'].includes(usageError?.code)) {
      throw new CrmRequestError(503, 'ยังไม่พบข้อมูลสรุปการใช้งานประเภทหน้างาน กรุณา apply database migration ก่อนใช้งาน', 'SITE_TYPE_USAGE_VIEW_NOT_READY');
    }
    throwSiteTypeDatabaseError(usageError, 'ไม่สามารถนับการใช้งานประเภทหน้างานได้');
    usageCountBySiteTypeId = new Map((usageRows || []).map((row) => [row.site_type_id, Number(row.usage_count) || 0]));
  }

  return {
    success: true,
    siteTypes: (data || []).map((siteType) => siteTypeRecord({
      ...siteType,
      usage_count: usageCountBySiteTypeId.get(siteType.id) || 0,
    })),
    apiVersion: CRM_API_VERSION,
  };
}

function siteTypeWritePayload(body, userId) {
  const name = text(body.name).replace(/\s+/g, ' ').slice(0, 120);
  const sortOrderSource = text(body.sortOrder);
  const sortOrder = sortOrderSource === '' ? 0 : Number(sortOrderSource);
  const isActive = body.isActive === undefined
    ? true
    : !['false', '0', 'off', 'no'].includes(String(body.isActive).trim().toLowerCase());

  if (!name) throw new CrmRequestError(400, 'กรุณาระบุชื่อประเภทหน้างาน', 'MISSING_SITE_TYPE_NAME');
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 999999) {
    throw new CrmRequestError(400, 'ลำดับประเภทหน้างานไม่ถูกต้อง', 'INVALID_SITE_TYPE_SORT_ORDER');
  }

  return {
    name,
    is_active: isActive,
    sort_order: sortOrder,
    updated_by: userId,
  };
}

async function saveSiteType(client, userId, membership, body) {
  requireSiteTypeAdministrator(membership);
  const siteTypeId = text(body.siteTypeId);
  const payload = siteTypeWritePayload(body, userId);
  const columns = 'id, name, is_active, sort_order, created_at, updated_at';
  const result = siteTypeId
    ? await client.from('site_types').update(payload).eq('id', siteTypeId).select(columns).maybeSingle()
    : await client.from('site_types').insert({ ...payload, created_by: userId }).select(columns).single();

  if (result.error?.code === '23505') {
    throw new CrmRequestError(409, 'มีประเภทหน้างานชื่อนี้อยู่แล้ว', 'DUPLICATE_SITE_TYPE');
  }
  throwSiteTypeDatabaseError(
    result.error,
    siteTypeId ? 'ไม่สามารถแก้ไขประเภทหน้างานได้' : 'ไม่สามารถเพิ่มประเภทหน้างานได้'
  );
  if (!result.data) throw new CrmRequestError(404, 'ไม่พบประเภทหน้างานที่ต้องการแก้ไข', 'SITE_TYPE_NOT_FOUND');
  return { success: true, siteType: siteTypeRecord(result.data), apiVersion: CRM_API_VERSION };
}

async function deleteSiteType(client, membership, body) {
  requireSiteTypeAdministrator(membership);
  const siteTypeId = text(body.siteTypeId);
  if (!siteTypeId) throw new CrmRequestError(400, 'ไม่พบประเภทหน้างานที่ต้องการลบ', 'MISSING_SITE_TYPE_ID');
  const { data, error } = await client
    .from('site_types')
    .delete()
    .eq('id', siteTypeId)
    .select('id')
    .maybeSingle();
  throwSiteTypeDatabaseError(error, 'ไม่สามารถลบประเภทหน้างานได้');
  if (!data) throw new CrmRequestError(404, 'ไม่พบประเภทหน้างานที่ต้องการลบ', 'SITE_TYPE_NOT_FOUND');
  return { success: true, siteTypeId, apiVersion: CRM_API_VERSION };
}

function referralSourceRecord(referralSource) {
  return {
    id: referralSource.id || '',
    name: referralSource.name || '',
    isActive: referralSource.is_active !== false,
    sortOrder: Number(referralSource.sort_order) || 0,
    usageCount: Math.max(0, Number(referralSource.usage_count) || 0),
    createdAt: referralSource.created_at || '',
    updatedAt: referralSource.updated_at || '',
  };
}

function throwReferralSourceDatabaseError(error, fallback) {
  // Postgres returns 42P01 for a missing relation over a direct connection;
  // the Supabase Data API returns PGRST205 when the new table is absent from
  // its schema cache. Treat both as the same actionable migration problem.
  if (['42P01', 'PGRST205'].includes(error?.code)) {
    throw new CrmRequestError(503, 'ยังไม่พบตารางแหล่งที่รู้จักครั้งแรก กรุณา apply database migration ก่อนใช้งาน', 'REFERRAL_SOURCE_TABLE_NOT_READY');
  }
  throwDatabaseError(error, fallback);
}

async function getReferralSources(client, membership, includeInactive = false) {
  if (includeInactive) requireReferralSourceAdministrator(membership);
  let request = client
    .from('referral_sources')
    .select('id, name, is_active, sort_order, created_at, updated_at')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (!includeInactive) request = request.eq('is_active', true);
  const { data, error } = await request;
  throwReferralSourceDatabaseError(error, 'ไม่สามารถโหลดแหล่งที่รู้จักครั้งแรกได้');

  let usageCountByReferralSourceId = new Map();
  if (includeInactive && data?.length) {
    const { data: usageRows, error: usageError } = await client
      .from('referral_source_usage_counts')
      .select('referral_source_id, usage_count');
    if (['42P01', 'PGRST205'].includes(usageError?.code)) {
      throw new CrmRequestError(503, 'ยังไม่พบข้อมูลสรุปการใช้งานแหล่งที่รู้จักครั้งแรก กรุณา apply database migration ก่อนใช้งาน', 'REFERRAL_SOURCE_USAGE_VIEW_NOT_READY');
    }
    throwReferralSourceDatabaseError(usageError, 'ไม่สามารถนับการใช้งานแหล่งที่รู้จักครั้งแรกได้');
    usageCountByReferralSourceId = new Map((usageRows || []).map((row) => [row.referral_source_id, Number(row.usage_count) || 0]));
  }

  return {
    success: true,
    referralSources: (data || []).map((referralSource) => referralSourceRecord({
      ...referralSource,
      usage_count: usageCountByReferralSourceId.get(referralSource.id) || 0,
    })),
    apiVersion: CRM_API_VERSION,
  };
}

function referralSourceWritePayload(body, userId) {
  const name = text(body.name).replace(/\s+/g, ' ').slice(0, 120);
  const sortOrderSource = text(body.sortOrder);
  const sortOrder = sortOrderSource === '' ? 0 : Number(sortOrderSource);
  const isActive = body.isActive === undefined
    ? true
    : !['false', '0', 'off', 'no'].includes(String(body.isActive).trim().toLowerCase());

  if (!name) throw new CrmRequestError(400, 'กรุณาระบุชื่อแหล่งที่รู้จักครั้งแรก', 'MISSING_REFERRAL_SOURCE_NAME');
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 999999) {
    throw new CrmRequestError(400, 'ลำดับแหล่งที่รู้จักครั้งแรกไม่ถูกต้อง', 'INVALID_REFERRAL_SOURCE_SORT_ORDER');
  }

  return {
    name,
    is_active: isActive,
    sort_order: sortOrder,
    updated_by: userId,
  };
}

async function saveReferralSource(client, userId, membership, body) {
  requireReferralSourceAdministrator(membership);
  const referralSourceId = text(body.referralSourceId);
  const payload = referralSourceWritePayload(body, userId);
  const columns = 'id, name, is_active, sort_order, created_at, updated_at';
  const result = referralSourceId
    ? await client.from('referral_sources').update(payload).eq('id', referralSourceId).select(columns).maybeSingle()
    : await client.from('referral_sources').insert({ ...payload, created_by: userId }).select(columns).single();

  if (result.error?.code === '23505') {
    throw new CrmRequestError(409, 'มีแหล่งที่รู้จักครั้งแรกชื่อนี้อยู่แล้ว', 'DUPLICATE_REFERRAL_SOURCE');
  }
  throwReferralSourceDatabaseError(
    result.error,
    referralSourceId ? 'ไม่สามารถแก้ไขแหล่งที่รู้จักครั้งแรกได้' : 'ไม่สามารถเพิ่มแหล่งที่รู้จักครั้งแรกได้'
  );
  if (!result.data) throw new CrmRequestError(404, 'ไม่พบแหล่งที่รู้จักครั้งแรกที่ต้องการแก้ไข', 'REFERRAL_SOURCE_NOT_FOUND');
  return { success: true, referralSource: referralSourceRecord(result.data), apiVersion: CRM_API_VERSION };
}

function productRecord(product) {
  return {
    id: product.id || '',
    sku: product.sku || '',
    brand: product.brand || '',
    productType: product.product_type || '',
    series: product.series || '',
    model: product.model || '',
    size: product.size || '',
    stock: Math.max(0, Number(product.stock) || 0),
    unit: product.unit || 'ม้วน',
    createdAt: product.created_at || '',
    updatedAt: product.updated_at || '',
  };
}

function throwProductDatabaseError(error, fallback) {
  if (error?.code === '42P01') {
    throw new CrmRequestError(503, 'ยังไม่พบตารางสินค้า กรุณา apply database migration ก่อนใช้งาน', 'PRODUCT_TABLE_NOT_READY');
  }
  throwDatabaseError(error, fallback);
}

function productWritePayload(body, userId) {
  const sku = text(body.sku).slice(0, 120);
  const brand = text(body.brand).slice(0, 120);
  const productType = text(body.productType).slice(0, 120);
  const series = text(body.series).slice(0, 120);
  const model = text(body.model).slice(0, 120);
  const size = text(body.size).slice(0, 120);
  const stockText = text(body.stock);
  const stock = stockText ? Number(stockText) : 0;
  const unit = text(body.unit).slice(0, 30) || 'ม้วน';

  if (!sku) throw new CrmRequestError(400, 'กรุณาระบุ SKU', 'MISSING_PRODUCT_SKU');
  if (!brand) throw new CrmRequestError(400, 'กรุณาระบุ Brand', 'MISSING_PRODUCT_BRAND');
  if (!productType) throw new CrmRequestError(400, 'กรุณาระบุ Type', 'MISSING_PRODUCT_TYPE');
  if (!series) throw new CrmRequestError(400, 'กรุณาระบุ Series', 'MISSING_PRODUCT_SERIES');
  if (!model) throw new CrmRequestError(400, 'กรุณาระบุ Model', 'MISSING_PRODUCT_MODEL');
  if (!size) throw new CrmRequestError(400, 'กรุณาระบุ Size', 'MISSING_PRODUCT_SIZE');
  if (!Number.isFinite(stock) || stock < 0) throw new CrmRequestError(400, 'จำนวนสต๊อกต้องเป็นเลขศูนย์หรือมากกว่า', 'INVALID_PRODUCT_STOCK');

  return {
    sku,
    brand,
    product_type: productType,
    series,
    model,
    size,
    stock,
    unit,
    updated_by: userId,
  };
}

async function getProductDirectory(client, membership) {
  requireProductAdministrator(membership);
  const { data, error } = await client
    .from('crm_products')
    .select('id, sku, brand, product_type, series, model, size, stock, unit, created_at, updated_at')
    .order('brand', { ascending: true })
    .order('product_type', { ascending: true })
    .order('series', { ascending: true })
    .order('model', { ascending: true })
    .order('size', { ascending: true })
    .order('sku', { ascending: true });
  throwProductDatabaseError(error, 'ไม่สามารถโหลดข้อมูลสินค้าได้');
  return { success: true, products: (data || []).map(productRecord), apiVersion: CRM_API_VERSION };
}

async function saveProduct(client, userId, membership, body) {
  requireProductAdministrator(membership);
  const productId = text(body.productId);
  const payload = productWritePayload(body, userId);
  const columns = 'id, sku, brand, product_type, series, model, size, stock, unit, created_at, updated_at';
  const result = productId
    ? await client.from('crm_products').update(payload).eq('id', productId).select(columns).maybeSingle()
    : await client.from('crm_products').insert({ ...payload, created_by: userId }).select(columns).single();

  if (result.error?.code === '23505') {
    throw new CrmRequestError(409, 'มีรายการสินค้านี้อยู่แล้ว', 'DUPLICATE_PRODUCT');
  }
  throwProductDatabaseError(result.error, productId ? 'ไม่สามารถแก้ไขข้อมูลสินค้าได้' : 'ไม่สามารถเพิ่มสินค้าได้');
  if (!result.data) throw new CrmRequestError(404, 'ไม่พบสินค้าที่ต้องการแก้ไข', 'PRODUCT_NOT_FOUND');
  return { success: true, product: productRecord(result.data), apiVersion: CRM_API_VERSION };
}

async function deleteProduct(client, membership, body) {
  requireProductAdministrator(membership);
  const productId = text(body.productId);
  if (!productId) throw new CrmRequestError(400, 'ไม่พบสินค้าที่ต้องการลบ', 'MISSING_PRODUCT_ID');
  const { data, error } = await client
    .from('crm_products')
    .delete()
    .eq('id', productId)
    .select('id')
    .maybeSingle();
  throwProductDatabaseError(error, 'ไม่สามารถลบสินค้าได้');
  if (!data) throw new CrmRequestError(404, 'ไม่พบสินค้าที่ต้องการลบ', 'PRODUCT_NOT_FOUND');
  return { success: true, productId, apiVersion: CRM_API_VERSION };
}

function customerChatLinkValue(value) {
  const link = text(value);
  if (!link) return null;
  try {
    const url = new URL(link);
    if (link.length <= 2048 && /^https?:\/\//i.test(link) && !/\s/.test(link)
      && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      return link;
    }
  } catch (_) { /* Report malformed and unsafe URLs with the same validation message. */ }
  throw new CrmRequestError(400, 'Link Chat ต้องเป็นลิงก์ http:// หรือ https:// ที่ถูกต้อง (ไม่เกิน 2,048 ตัวอักษร)', 'INVALID_CUSTOMER_CHAT_LINK');
}

function customerWritePayload(body, userId) {
  const customerName = text(body.customerName);
  const email = text(body.email).toLowerCase();
  if (!customerName) throw new CrmRequestError(400, 'กรุณาระบุชื่อลูกค้า', 'MISSING_CUSTOMER_NAME');
  if (!isValidThaiPhone(body.phone)) {
    throw new CrmRequestError(400, 'กรุณากรอกเบอร์มือถือ 10 หลัก หรือโทรศัพท์บ้าน 02 จำนวน 9 หลัก', 'INVALID_PHONE');
  }
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new CrmRequestError(400, 'รูปแบบอีเมลไม่ถูกต้อง', 'INVALID_CUSTOMER_EMAIL');
  }
  return {
    customer_name: customerName,
    gender: text(body.gender) || 'ไม่ระบุ',
    phone: formatThaiPhone(body.phone),
    email: nullableText(email),
    contact_channel: nullableText(body.contactChannel),
    contact_handle: nullableText(body.contactHandle),
    // Legacy clients may omit this field; do not erase an existing customer link.
    ...(Object.prototype.hasOwnProperty.call(body, 'customerChatLink')
      ? { chat_link: customerChatLinkValue(body.customerChatLink) } : {}),
    referral_source: nullableText(body.referralDate),
    remarks: nullableText(body.customerRemarks ?? body.customerNote),
    updated_by: userId,
  };
}

async function findPhoneDuplicate(client, phone, excludedCustomerId = '') {
  const { data, error } = await client
    .from('customers')
    .select('legacy_cust_id, customer_name, gender, phone, email, contact_channel, contact_handle, chat_link, referral_source, remarks')
    .eq('phone_normalized', normalizePhone(phone))
    .maybeSingle();
  throwDatabaseError(error);
  if (!data || data.legacy_cust_id === excludedCustomerId) return null;
  return customerRecord(data);
}

function isPhoneUniqueViolation(error) {
  if (error?.code !== '23505') return false;
  const description = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
  return /phone_normalized|customers_phone_normalized_unique/i.test(description);
}

function hiddenPhoneDuplicateResult() {
  return {
    success: false,
    code: 'DUPLICATE_PHONE',
    error: 'เบอร์โทรนี้มีอยู่ในระบบแล้ว กรุณาติดต่อผู้ดูแลระบบหากต้องการใช้ข้อมูลลูกค้าเดิม',
  };
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
      .select('legacy_cust_id, remarks, chat_link')
      .single();
    if (error?.code === '23505') {
      const racedDuplicate = await findPhoneDuplicate(client, payload.phone, legacyCustomerId);
      if (racedDuplicate) {
        return { success: false, code: 'DUPLICATE_PHONE', error: 'เบอร์โทรนี้มีอยู่ในระบบแล้ว', existingCustomer: racedDuplicate };
      }
      if (isPhoneUniqueViolation(error)) return hiddenPhoneDuplicateResult();
    }
    throwDatabaseError(error);
    return { success: true, custId: data.legacy_cust_id, updated: true, customerRemarks: data.remarks || '', customerChatLink: data.chat_link || '', apiVersion: CRM_API_VERSION };
  }

  const recordedAt = new Date().toISOString();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await client
      .from('customers')
      .insert({ ...payload, legacy_cust_id: newLegacyId('CUST'), recorded_at: recordedAt, created_by: userId })
      .select('legacy_cust_id, recorded_at, remarks, chat_link')
      .single();
    if (!error) {
      return { success: true, custId: data.legacy_cust_id, recordedAt: data.recorded_at, updated: false, customerRemarks: data.remarks || '', customerChatLink: data.chat_link || '', apiVersion: CRM_API_VERSION };
    }
    if (error.code !== '23505') throwDatabaseError(error);
    const racedDuplicate = await findPhoneDuplicate(client, payload.phone);
    if (racedDuplicate) {
      return { success: false, code: 'DUPLICATE_PHONE', error: 'เบอร์โทรนี้มีอยู่ในระบบแล้ว', existingCustomer: racedDuplicate };
    }
    if (isPhoneUniqueViolation(error)) return hiddenPhoneDuplicateResult();
  }
  throw new CrmRequestError(503, 'ไม่สามารถสร้างรหัสลูกค้าใหม่ได้ กรุณาลองอีกครั้ง', 'CUSTOMER_ID_RETRY_EXHAUSTED');
}

function caseWritePayload(body, customerId, userId, activityAt = new Date()) {
  const remarks = [text(body.remarks), text(body.billingRemarks) ? `หมายเหตุบิล: ${text(body.billingRemarks)}` : ''].filter(Boolean).join('\n');
  const status = text(body.jobStatus) || 'รอดำเนินการ';
  const nextFollowUpAt = CASE_APPOINTMENT_STATUSES.has(status)
    ? requiredIsoDate(body.nextFollowUpAt, 'วันและเวลานัดติดตามครั้งถัดไป')
    : FOLLOW_UP_FINAL_STATUSES.has(status)
      ? null
      : ordinaryFollowUpAt(activityAt, body.nextFollowUpAt);
  return {
    casePayload: {
      customer_id: customerId,
      recorded_at: requiredIsoDate(activityAt instanceof Date ? activityAt.toISOString() : activityAt, 'วันบันทึกเคส'),
      admin_name: nullableText(body.adminName),
      customer_type: nullableText(body.customerType),
      topic: nullableText(body.topic),
      priority: nullableText(body.priority),
      site_type: nullableText(body.siteType),
      site_address: nullableText(body.siteAddress),
      location_url: nullableText(body.location),
      province: nullableText(body.province),
      product_interest: nullableText(body.interests),
      job_details: nullableText(body.jobDetails),
      budget: nullableText(body.budget),
      salesperson: nullableText(body.salesperson),
      company: nullableText(body.company ?? body.billingName),
      status,
      remarks: nullableText(remarks),
      chat_link: nullableText(body.chatLink),
      external_link: nullableText(body.link),
      billing_name: nullableText(body.billingName),
      billing_address: nullableText(body.billingAddress),
      billing_branch: nullableText(body.billingBranch),
      tax_id: nullableText(body.taxId),
      client_request_id: nullableText(body.caseRequestId),
      created_by: userId,
      updated_by: userId,
    },
    nextFollowUpAt,
  };
}

async function createCaseAppointment(client, userId, caseRow, nextFollowUpAt, activityAt = new Date()) {
  if (!nextFollowUpAt) return;
  const isAppointment = CASE_APPOINTMENT_STATUSES.has(text(caseRow.status));

  const { error } = await client
    .from('lead_follow_up_history')
    .insert({
      case_id: caseRow.id,
      followed_at: requiredIsoDate(activityAt instanceof Date ? activityAt.toISOString() : activityAt, 'วันบันทึกเคส'),
      activity_type: isAppointment ? 'appointment' : 'follow_up',
      notes: isAppointment
        ? `กำหนดนัดหมายจากการสร้างเคส: ${caseRow.status}`
        : 'กำหนดติดตามอัตโนมัติทุก 3 วันจากการสร้างเคส',
      next_follow_up_at: nextFollowUpAt,
      current_status: caseRow.status,
      created_by: userId,
      updated_by: userId,
    });
  if (!error) return;

  const { data: rolledBack, error: rollbackError } = await client
    .rpc('rollback_new_crm_case', { p_case_id: caseRow.id });
  if (rollbackError || !rolledBack) {
    console.error(
      'Unable to roll back a case after appointment creation failed:',
      rollbackError?.message || 'rollback conditions were not met'
    );
  }

  if (error.code === '42P01') {
    throw new CrmRequestError(503, 'ยังไม่พบตารางนัดติดตาม กรุณา apply migration ของระบบติดตามก่อนใช้งาน', 'FOLLOW_UP_TABLE_NOT_READY');
  }
  console.error('Unable to save the follow-up schedule for a new case:', error.message);
  throw new CrmRequestError(503,
    isAppointment ? 'ไม่สามารถบันทึกวันและเวลานัด กรุณาลองอีกครั้ง' : 'ไม่สามารถกำหนดวันติดตามเคส กรุณาลองอีกครั้ง',
    isAppointment ? 'CASE_APPOINTMENT_SAVE_FAILED' : 'CASE_FOLLOW_UP_SAVE_FAILED');
}

async function createCase(client, userId, assignment, body) {
  const scopedBody = scopeCaseAssignment(body, assignment);
  const legacyCustomerId = text(scopedBody.customerId);
  if (!legacyCustomerId) throw new CrmRequestError(400, 'กรุณาบันทึกข้อมูลลูกค้าก่อน', 'MISSING_CUSTOMER_ID');
  const customer = await readCustomerByLegacyId(client, legacyCustomerId);
  if (!customer) throw new CrmRequestError(404, `ไม่พบข้อมูลลูกค้า: ${legacyCustomerId}`, 'CUSTOMER_NOT_FOUND');
  const { casePayload: payload, nextFollowUpAt } = caseWritePayload(scopedBody, customer.id, userId);
  if (!payload.topic || !payload.company) {
    throw new CrmRequestError(400, 'กรุณาระบุหัวข้อที่ติดต่อและบริษัท', 'MISSING_CASE_DETAILS');
  }
  validateCaseStatus(payload.status);

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
      .select('id, legacy_case_id, status')
      .single();
    if (!error) {
      await createCaseAppointment(client, userId, data, nextFollowUpAt, payload.recorded_at);
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

async function updateCaseDetails(client, userId, assignment, body) {
  const scopedBody = scopeCaseAssignment(body, assignment);
  const caseId = text(scopedBody.caseId);
  if (!caseId) throw new CrmRequestError(400, 'ไม่พบ Case_ID ที่ต้องการแก้ไข', 'MISSING_CASE_ID');
  if (!text(scopedBody.topic) || !text(scopedBody.company)) {
    throw new CrmRequestError(400, 'กรุณาระบุหัวข้อที่ติดต่อและบริษัท', 'MISSING_CASE_DETAILS');
  }
  const updatePayload = {
    topic: text(scopedBody.topic),
    company: text(scopedBody.company),
    customer_type: nullableText(scopedBody.customerType),
    priority: nullableText(scopedBody.priority),
    budget: nullableText(scopedBody.budget),
    site_type: nullableText(scopedBody.siteType),
    product_interest: nullableText(scopedBody.interests),
    province: nullableText(scopedBody.province),
    admin_name: nullableText(scopedBody.admin),
    site_address: nullableText(scopedBody.siteAddress),
    location_url: nullableText(scopedBody.location),
    job_details: nullableText(scopedBody.jobDetails),
    chat_link: nullableText(scopedBody.chatLink),
    external_link: nullableText(scopedBody.link),
    billing_name: nullableText(scopedBody.billingName),
    billing_address: nullableText(scopedBody.billingAddress),
    billing_branch: nullableText(scopedBody.billingBranch),
    tax_id: nullableText(scopedBody.taxId),
    remarks: nullableText(scopedBody.remarks),
    updated_by: userId,
  };
  if (!isRestrictedCrmSales(assignment)) {
    updatePayload.salesperson = nullableText(scopedBody.salesperson);
  }

  const { data, error } = await client
    .from('cases')
    .update(updatePayload)
    .eq('legacy_case_id', caseId)
    .select('legacy_case_id')
    .maybeSingle();
  throwDatabaseError(error);
  if (!data) throw new CrmRequestError(404, `ไม่พบเคส ${caseId}`, 'CASE_NOT_FOUND');
  return { success: true, caseId, apiVersion: CRM_API_VERSION };
}

async function deleteCase(client, membership, body) {
  requireCaseDeletionManager(membership);
  const caseId = text(body.caseId);
  if (!caseId) throw new CrmRequestError(400, 'ไม่พบ Case_ID ที่ต้องการลบ', 'MISSING_CASE_ID');

  const { data, error } = await client
    .from('cases')
    .delete()
    .eq('legacy_case_id', caseId)
    .select('legacy_case_id')
    .maybeSingle();
  if (
    error?.code === '23503'
    && /\bcrm_invoices_(?:case_id|source_history_id)_fkey\b/.test(`${error.message || ''} ${error.details || ''}`)
  ) {
    throw new CrmRequestError(
      409,
      'ไม่สามารถลบเคสนี้ได้ เนื่องจากมีใบแจ้งหนี้อยู่ ใบแจ้งหนี้และข้อมูลเดิมยังคงอยู่',
      'CASE_HAS_INVOICES'
    );
  }
  throwDatabaseError(error, 'ไม่สามารถลบเคสได้');
  if (!data) throw new CrmRequestError(404, `ไม่พบเคส ${caseId}`, 'CASE_NOT_FOUND');

  return { success: true, caseId: data.legacy_case_id, apiVersion: CRM_API_VERSION };
}

async function updateCaseSalesperson(client, userId, assignment, body) {
  requireCaseAssignmentManager(assignment);
  const caseId = text(body.caseId);
  if (!caseId) throw new CrmRequestError(400, 'ไม่พบ Case_ID ที่ต้องการแก้ไข', 'MISSING_CASE_ID');

  const { data, error } = await client
    .from('cases')
    .update({
      salesperson: nullableText(body.salesperson),
      updated_by: userId,
    })
    .eq('legacy_case_id', caseId)
    .select('legacy_case_id, salesperson')
    .maybeSingle();
  throwDatabaseError(error);
  if (!data) throw new CrmRequestError(404, `ไม่พบเคส ${caseId}`, 'CASE_NOT_FOUND');
  return {
    success: true,
    caseId: data.legacy_case_id,
    salesperson: data.salesperson || '',
    apiVersion: CRM_API_VERSION,
  };
}

function optionalIsoDate(value, fieldName) {
  const source = text(value);
  if (!source) return null;
  const timestamp = new Date(source);
  if (Number.isNaN(timestamp.getTime())) {
    throw new CrmRequestError(400, `${fieldName}ไม่ถูกต้อง`, 'INVALID_GENERAL_TASK_DATE');
  }
  return timestamp.toISOString();
}

function generalTaskWritePayload(body, userId) {
  const title = text(body.title).slice(0, 200);
  const assignedTo = text(body.assignedTo).slice(0, 100);
  const status = text(body.status) || 'pending';
  if (!title) throw new CrmRequestError(400, 'กรุณาระบุชื่องาน', 'MISSING_GENERAL_TASK_TITLE');
  if (!GENERAL_TASK_STATUSES.has(status)) {
    throw new CrmRequestError(400, 'สถานะงานทั่วไปไม่ถูกต้อง', 'INVALID_GENERAL_TASK_STATUS');
  }
  const payload = {
    title,
    description: nullableText(text(body.description).slice(0, 3000)),
    contact_name: nullableText(text(body.customerName).slice(0, 200)),
    contact_phone: nullableText(text(body.customerPhone).slice(0, 100)),
    site_address: nullableText(text(body.siteAddress).slice(0, 3000)),
    location_url: nullableText(text(body.location).slice(0, 2000)),
    province: nullableText(text(body.province).slice(0, 100)),
    task_owner: nullableText(text(body.taskOwner).slice(0, 200)),
    due_at: optionalIsoDate(body.dueAt, 'วันครบกำหนด'),
    assigned_to: nullableText(assignedTo),
    status,
    updated_by: userId,
  };
  // Keep existing completion notes intact after the manager form stopped exposing that field.
  if (Object.prototype.hasOwnProperty.call(body || {}, 'completionNote')) {
    payload.completion_note = nullableText(text(body.completionNote).slice(0, 3000));
  }
  return payload;
}

async function saveGeneralTask(client, userId, membership, body) {
  const taskId = text(body.taskId);
  if (taskId) requireGeneralTaskManager(membership);
  else requireGeneralTaskCreator(membership);
  const payload = generalTaskWritePayload(body, userId);
  const query = taskId
    ? client
      .from('general_tasks')
      .update(payload)
      .eq('id', taskId)
      .select('id, title, description, contact_name, contact_phone, site_address, location_url, province, task_owner, due_at, assigned_to, status, completion_note, completed_at, created_at, updated_at')
      .maybeSingle()
    : client
      .from('general_tasks')
      .insert({ ...payload, created_by: userId })
      .select('id, title, description, contact_name, contact_phone, site_address, location_url, province, task_owner, due_at, assigned_to, status, completion_note, completed_at, created_at, updated_at')
      .single();
  const { data, error } = await query;
  throwGeneralTaskDatabaseError(error, taskId ? 'ไม่สามารถแก้ไขงานทั่วไปได้' : 'ไม่สามารถเพิ่มงานทั่วไปได้');
  if (!data) throw new CrmRequestError(404, 'ไม่พบงานทั่วไปที่ต้องการแก้ไข', 'GENERAL_TASK_NOT_FOUND');
  return { success: true, task: generalTaskRecord(data), apiVersion: CRM_API_VERSION };
}

async function completeGeneralTask(client, userId, assignment, body) {
  const taskId = text(body.taskId);
  if (!taskId) throw new CrmRequestError(400, 'ไม่พบงานทั่วไปที่ต้องการอัปเดต', 'MISSING_GENERAL_TASK_ID');
  if (text(body.status) !== 'completed') {
    throw new CrmRequestError(400, 'ฝ่ายขายสามารถบันทึกได้เฉพาะสถานะเสร็จสิ้น', 'INVALID_GENERAL_TASK_COMPLETION');
  }
  const { data, error } = await client
    .from('general_tasks')
    .update({
      status: 'completed',
      completion_note: nullableText(text(body.completionNote).slice(0, 3000)),
      updated_by: userId,
    })
    .eq('id', taskId)
    .select('id, title, description, contact_name, contact_phone, site_address, location_url, province, task_owner, due_at, assigned_to, status, completion_note, completed_at, created_at, updated_at')
    .maybeSingle();
  throwGeneralTaskDatabaseError(error, 'ไม่สามารถบันทึกงานว่าเสร็จสิ้นได้');
  if (!data) throw new CrmRequestError(404, 'ไม่พบงานทั่วไปที่ต้องการอัปเดต', 'GENERAL_TASK_NOT_FOUND');
  return { success: true, task: generalTaskRecord(data), apiVersion: CRM_API_VERSION };
}

async function deleteGeneralTask(client, membership, body) {
  requireGeneralTaskManager(membership);
  const taskId = text(body.taskId);
  if (!taskId) throw new CrmRequestError(400, 'ไม่พบงานทั่วไปที่ต้องการลบ', 'MISSING_GENERAL_TASK_ID');
  const { data, error } = await client
    .from('general_tasks')
    .delete()
    .eq('id', taskId)
    .select('id')
    .maybeSingle();
  throwGeneralTaskDatabaseError(error, 'ไม่สามารถลบงานทั่วไปได้');
  if (!data) throw new CrmRequestError(404, 'ไม่พบงานทั่วไปที่ต้องการลบ', 'GENERAL_TASK_NOT_FOUND');
  return { success: true, taskId: data.id, apiVersion: CRM_API_VERSION };
}

function requiredIsoDate(value, fieldName) {
  const source = text(value);
  if (!source) {
    throw new CrmRequestError(400, `กรุณาระบุ${fieldName}`, 'MISSING_NEXT_FOLLOW_UP_DATE');
  }
  const timestamp = new Date(source);
  if (Number.isNaN(timestamp.getTime())) {
    throw new CrmRequestError(400, `${fieldName}ไม่ถูกต้อง`, 'INVALID_FOLLOW_UP_DATE');
  }
  return timestamp.toISOString();
}

function normalizeQuotationNumbers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((quotationNumber) => text(quotationNumber).replace(/\s+/g, ' ').slice(0, 200))
    .filter(Boolean);
}

function optionalNonNegativeInteger(value, fieldName) {
  const source = text(value);
  if (!source) return null;
  if (!/^\d+$/.test(source)) {
    throw new CrmRequestError(400, `${fieldName}ต้องเป็นจำนวนเต็มศูนย์หรือมากกว่า`, 'INVALID_EVALUATION_PANEL_COUNT');
  }
  const amount = Number(source);
  if (!Number.isSafeInteger(amount) || amount > 100000000) {
    throw new CrmRequestError(400, `${fieldName}ไม่ถูกต้อง`, 'INVALID_EVALUATION_PANEL_COUNT');
  }
  return amount;
}

function optionalNonNegativeDecimal(value, fieldName) {
  const source = text(value);
  if (!source) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(source)) {
    throw new CrmRequestError(400, `${fieldName}ต้องเป็นตัวเลขศูนย์หรือมากกว่า (ทศนิยมไม่เกิน 2 ตำแหน่ง)`, 'INVALID_EVALUATION_AREA');
  }
  const amount = Number(source);
  if (!Number.isFinite(amount) || amount > 9999999999.99) {
    throw new CrmRequestError(400, `${fieldName}ไม่ถูกต้อง`, 'INVALID_EVALUATION_AREA');
  }
  return amount;
}

function evaluationMeasurementPayload(status, body) {
  if (status !== 'ประเมินราคา') {
    return { evaluationPanelCount: null, evaluationAreaSqM: null };
  }
  return {
    evaluationPanelCount: optionalNonNegativeInteger(body.evaluationPanelCount, 'จำนวน (บาน) '),
    evaluationAreaSqM: optionalNonNegativeDecimal(body.evaluationAreaSqM, 'พื้นที่ (ตร.ฟ.) '),
  };
}

function normalizeQuotationPrintOptions(value) {
  const defaults = {
    showBranch: false,
    showCreditTerm: false,
    showPaymentTerms: true,
    showTotals: true,
    showTotalInWords: true,
    showNotes: true,
    showSalesperson: true,
  };
  if (value === undefined || value === null) return defaults;
  if (Array.isArray(value) || typeof value !== 'object') {
    throw new CrmRequestError(400, 'ตัวเลือกการแสดงผลใบเสนอราคาไม่ถูกต้อง', 'INVALID_QUOTATION_SNAPSHOT');
  }
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [
    key,
    typeof value[key] === 'boolean' ? value[key] : fallback,
  ]));
}

function normalizeQuotationSnapshot(value, quotationNumbers = []) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) || typeof value !== 'object') {
    throw new CrmRequestError(400, 'รายละเอียดใบเสนอราคาไม่ถูกต้อง', 'INVALID_QUOTATION_SNAPSHOT');
  }

  const quoteNumber = text(value.quoteNumber).replace(/\s+/g, ' ').slice(0, 200);
  const issuedQuotationNumbers = normalizeQuotationNumbers(quotationNumbers);
  const companyInput = text(value.company).toUpperCase();
  const company = companyInput === 'MHL' ? 'MHL' : companyInput === 'GFS' ? 'GFS' : '';
  const issueDate = text(value.issueDate).slice(0, 10);
  const validDays = Number(value.validDays);
  const customerName = text(value.customerName).slice(0, 500);
  const printOptions = normalizeQuotationPrintOptions(value.printOptions);
  const itemsInput = Array.isArray(value.items) ? value.items : [];

  if (!quoteNumber || !company || !customerName || !itemsInput.length || itemsInput.length > 100) {
    throw new CrmRequestError(400, 'กรุณากรอกรายละเอียดใบเสนอราคาให้ครบถ้วน', 'INVALID_QUOTATION_SNAPSHOT');
  }
  if (issuedQuotationNumbers.length && !issuedQuotationNumbers.includes(quoteNumber)) {
    throw new CrmRequestError(400, 'เลขที่ใบเสนอราคาไม่ตรงกับประวัติเคส', 'QUOTATION_NUMBER_MISMATCH');
  }
  if (issueDate && !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    throw new CrmRequestError(400, 'วันที่เสนอราคาไม่ถูกต้อง', 'INVALID_QUOTATION_SNAPSHOT');
  }
  if (!Number.isFinite(validDays) || validDays < 1 || validDays > 3650) {
    throw new CrmRequestError(400, 'ระยะเวลายืนราคาไม่ถูกต้อง', 'INVALID_QUOTATION_SNAPSHOT');
  }

  const items = itemsInput.map((item) => {
    if (!item || Array.isArray(item) || typeof item !== 'object') {
      throw new CrmRequestError(400, 'รายการเสนอราคาไม่ถูกต้อง', 'INVALID_QUOTATION_SNAPSHOT');
    }
    const description = text(item.description).slice(0, 1000);
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    const unit = text(item.unit).slice(0, 100) || 'ตรฟ.';
    const isDiscount = item.isDiscount === true || unit === 'ส่วนลด';
    const imagePath = text(item.imagePath).slice(0, 500);
    const imageDisplayWidth = Number(item.imageDisplayWidth || 120);
    if (!description || !Number.isFinite(quantity) || quantity <= 0 || quantity > 10000000
      || !Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1000000000
      || (isDiscount && imagePath)
      || (imagePath && !/^cases\/[A-Za-z0-9_-]{1,200}\/[A-Za-z0-9_-]+\.webp$/.test(imagePath))
      || !Number.isInteger(imageDisplayWidth)
      || imageDisplayWidth < QUOTATION_IMAGE_MIN_DISPLAY_WIDTH
      || imageDisplayWidth > QUOTATION_IMAGE_MAX_DISPLAY_WIDTH) {
      throw new CrmRequestError(400, 'รายการเสนอราคาไม่ถูกต้อง', 'INVALID_QUOTATION_SNAPSHOT');
    }
    return {
      description,
      details: text(item.details).slice(0, 5000),
      quantity,
      unit,
      unitPrice,
      isDiscount,
      imagePath: imagePath || '',
      imageDisplayWidth,
    };
  });

  return {
    company,
    quoteNumber,
    issueDate,
    validDays: String(Math.round(validDays)),
    customerName,
    contactName: text(value.contactName).slice(0, 500),
    contactPhone: text(value.contactPhone).slice(0, 100),
    taxId: text(value.taxId).slice(0, 100),
    address: text(value.address).slice(0, 5000),
    branch: text(value.branch).slice(0, 500),
    creditTerm: text(value.creditTerm).slice(0, 500),
    salesperson: text(value.salesperson).slice(0, 500),
    salespersonSource: text(value.salespersonSource) === 'admin' ? 'admin' : 'salesperson',
    signatureSalesperson: text(value.signatureSalesperson).slice(0, 500),
    signatureSalespersonSource: text(value.signatureSalespersonSource) === 'salesperson' ? 'salesperson' : 'admin',
    paymentTerms: text(value.paymentTerms).slice(0, 1000),
    notes: text(value.notes).slice(0, 2400),
    printOptions,
    items,
  };
}

function leadFollowUpRecord(row, caseId) {
  return {
    id: row.id,
    caseId,
    followedAt: row.followed_at,
    contactChannel: row.contact_channel || '',
    outcome: row.outcome || '',
    notes: row.notes || '',
    nextFollowUpAt: row.next_follow_up_at || '',
    previousStatus: row.previous_status || '',
    status: row.current_status || '',
    evaluationPanelCount: row.evaluation_panel_count ?? null,
    evaluationAreaSqM: row.evaluation_area_sq_m ?? null,
    quotationNumbers: Array.isArray(row.quotation_numbers) ? row.quotation_numbers : [],
    quotationSnapshot: row.quotation_snapshot && typeof row.quotation_snapshot === 'object' && !Array.isArray(row.quotation_snapshot)
      ? row.quotation_snapshot
      : null,
    createdAt: row.created_at || '',
  };
}

function initialCaseHistoryRecord(caseRow) {
  const recordedAt = caseRow.created_at || caseRow.recorded_at || '';
  const topic = text(caseRow.topic);
  return {
    id: `case-created:${caseRow.legacy_case_id}`,
    caseId: caseRow.legacy_case_id,
    followedAt: recordedAt,
    contactChannel: '',
    outcome: 'เพิ่มเคสใหม่',
    notes: topic ? `เพิ่มเคสใหม่: ${topic}` : 'เพิ่มเคสใหม่',
    nextFollowUpAt: '',
    previousStatus: '',
    status: caseRow.status || '',
    quotationNumbers: [],
    quotationSnapshot: null,
    createdAt: recordedAt,
    isInitial: true,
  };
}

async function getLeadFollowUps(client, caseIdValue) {
  const caseId = text(caseIdValue);
  if (!caseId) throw new CrmRequestError(400, 'ไม่พบ Case_ID ที่ต้องการอ่านข้อมูลการติดต่อ', 'MISSING_CASE_ID');

  const { data: caseRow, error: caseError } = await client
    .from('cases')
    .select('id, legacy_case_id, created_at, recorded_at, topic, status')
    .eq('legacy_case_id', caseId)
    .maybeSingle();
  throwDatabaseError(caseError);
  if (!caseRow) throw new CrmRequestError(404, `ไม่พบเคส ${caseId}`, 'CASE_NOT_FOUND');

  const { data, error } = await client
    .from('lead_follow_up_history')
    .select('id, followed_at, contact_channel, outcome, notes, next_follow_up_at, previous_status, current_status, evaluation_panel_count, evaluation_area_sq_m, quotation_numbers, quotation_snapshot, created_at')
    .eq('case_id', caseRow.id)
    .order('followed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(200);

  if (['42P01', '42703'].includes(error?.code)) {
    throw new CrmRequestError(503, 'ยังไม่พบตารางประวัติติดตามลีด กรุณา apply database migration ก่อนใช้งาน', 'FOLLOW_UP_TABLE_NOT_READY');
  }
  throwDatabaseError(error, 'ไม่สามารถอ่านข้อมูลการติดต่อได้');
  const { data: invoices, error: invoiceError } = await client.from('crm_invoices')
    .select('id,invoice_number,source_history_id,created_at').eq('case_id',caseRow.id).order('created_at',{ascending:false});
  throwDatabaseError(invoiceError, 'ไม่สามารถอ่านประวัติใบแจ้งหนี้ได้');
  const invoiceHistory = (invoices || []).map(invoice => ({
    id:'invoice-' + invoice.id, caseId:caseRow.legacy_case_id, followedAt:invoice.created_at,
    contactChannel:'ออกใบแจ้งหนี้', status:'ออกใบแจ้งหนี้',
    notes:'ออกใบแจ้งหนี้เลขที่ ' + invoice.invoice_number,
    invoiceId:invoice.id, invoiceNumber:invoice.invoice_number, sourceHistoryId:invoice.source_history_id,
    quotationNumbers:[], nextFollowUpAt:'',
  }));
  return {
    success: true,
    caseId: caseRow.legacy_case_id,
    // The list badge counts the case creation as its first history item. Include
    // the same item here so the badge and visible case history always agree.
    followUps: [
      ...(data || []).map((row) => leadFollowUpRecord(row, caseRow.legacy_case_id)),
      ...invoiceHistory,
      initialCaseHistoryRecord(caseRow),
    ].sort((a,b) => new Date(b.followedAt) - new Date(a.followedAt)),
    apiVersion: CRM_API_VERSION,
  };
}

async function syncQuotationCustomerToCase(client, userId, caseRow, quotationSnapshot) {
  if (!quotationSnapshot) return null;

  const { data, error } = await client
    .from('cases')
    .update({
      billing_name: nullableText(quotationSnapshot.customerName),
      tax_id: nullableText(quotationSnapshot.taxId),
      billing_address: nullableText(quotationSnapshot.address),
      billing_branch: nullableText(quotationSnapshot.branch),
      updated_by: userId,
    })
    .eq('id', caseRow.id)
    .select('legacy_case_id, billing_name, tax_id, billing_address, billing_branch')
    .maybeSingle();
  throwDatabaseError(error, 'ไม่สามารถซิงก์ข้อมูลลูกค้าไปยังเคสได้');
  if (!data) throw new CrmRequestError(404, `ไม่พบเคส ${caseRow.legacy_case_id}`, 'CASE_NOT_FOUND');

  return {
    billingName: data.billing_name || '',
    taxId: data.tax_id || '',
    billingAddress: data.billing_address || '',
    billingBranch: data.billing_branch || '',
  };
}

async function createLeadFollowUp(client, userId, body) {
  const caseId = text(body.caseId);
  const contactChannel = nullableText(body.contactChannel)?.slice(0, 100) || null;
  const notes = text(body.notes).slice(0, 5000);
  const requestedStatus = text(body.status);

  if (!caseId) throw new CrmRequestError(400, 'ไม่พบ Case_ID ที่ต้องการบันทึกการติดต่อ', 'MISSING_CASE_ID');
  if (!notes) throw new CrmRequestError(400, 'กรุณาระบุรายละเอียดการติดต่อ', 'MISSING_CONTACT_NOTES');

  const { data: caseRow, error: caseError } = await client
    .from('cases')
    .select('id, legacy_case_id, status, recorded_at, updated_by')
    .eq('legacy_case_id', caseId)
    .maybeSingle();
  throwDatabaseError(caseError);
  if (!caseRow) throw new CrmRequestError(404, `ไม่พบเคส ${caseId}`, 'CASE_NOT_FOUND');

  const previousStatus = text(caseRow.status);
  const currentStatus = requestedStatus || previousStatus;
  validateCaseStatus(currentStatus);
  const quotationNumbers = currentStatus === 'ส่งใบเสนอราคา'
    ? normalizeQuotationNumbers(body.quotationNumbers)
    : [];
  if (currentStatus === 'ส่งใบเสนอราคา' && quotationNumbers.length === 0) {
    throw new CrmRequestError(400, 'กรุณาระบุเลขที่ใบเสนอราคาอย่างน้อย 1 รายการ', 'MISSING_QUOTATION_NUMBER');
  }
  if (body.quotationSnapshot !== undefined && currentStatus !== 'ส่งใบเสนอราคา') {
    throw new CrmRequestError(400, 'รายละเอียดใบเสนอราคาใช้ได้เฉพาะสถานะส่งใบเสนอราคา', 'INVALID_QUOTATION_SNAPSHOT');
  }
  const quotationSnapshot = normalizeQuotationSnapshot(body.quotationSnapshot, quotationNumbers);
  const evaluationMeasurements = evaluationMeasurementPayload(currentStatus, body);
  const followedAt = new Date().toISOString();
  const nextFollowUpAt = FOLLOW_UP_FINAL_STATUSES.has(currentStatus)
    ? followedAt
    : CASE_APPOINTMENT_STATUSES.has(currentStatus)
      ? requiredIsoDate(body.nextFollowUpAt, 'วันนัดติดตามครั้งถัดไป')
      : ordinaryFollowUpAt(followedAt, body.nextFollowUpAt);
  const statusChanged = currentStatus !== previousStatus;

  if (statusChanged) {
    const { data: updatedCase, error: updateError } = await client
      .from('cases')
      .update({ status: currentStatus, recorded_at: followedAt, updated_by: userId })
      .eq('id', caseRow.id)
      .select('legacy_case_id')
      .maybeSingle();
    throwDatabaseError(updateError, 'ไม่สามารถอัปเดตสถานะงานได้');
    if (!updatedCase) throw new CrmRequestError(404, `ไม่พบเคส ${caseId}`, 'CASE_NOT_FOUND');
  }

  const { data, error } = await client
    .from('lead_follow_up_history')
    .insert({
      case_id: caseRow.id,
      followed_at: followedAt,
      activity_type: 'contact',
      contact_channel: contactChannel,
      notes,
      next_follow_up_at: nextFollowUpAt,
      previous_status: nullableText(previousStatus),
      current_status: nullableText(currentStatus),
      evaluation_panel_count: evaluationMeasurements.evaluationPanelCount,
      evaluation_area_sq_m: evaluationMeasurements.evaluationAreaSqM,
      quotation_numbers: quotationNumbers,
      quotation_snapshot: quotationSnapshot,
      created_by: userId,
      updated_by: userId,
    })
    .select('id, followed_at, contact_channel, outcome, notes, next_follow_up_at, previous_status, current_status, evaluation_panel_count, evaluation_area_sq_m, quotation_numbers, quotation_snapshot, created_at')
    .single();

  if (error && statusChanged) {
    const { error: rollbackError } = await client
      .from('cases')
      .update({
        status: previousStatus,
        recorded_at: caseRow.recorded_at,
        updated_by: caseRow.updated_by,
      })
      .eq('id', caseRow.id);
    if (rollbackError) console.error('Unable to roll back case status after follow-up failure:', rollbackError.message);
  }

  if (['42P01', '42703'].includes(error?.code)) {
    throw new CrmRequestError(503, 'ยังไม่พบตารางประวัติติดตามลีด กรุณา apply database migration ก่อนใช้งาน', 'FOLLOW_UP_TABLE_NOT_READY');
  }
  throwDatabaseError(error, 'ไม่สามารถบันทึกประวัติการติดต่อได้');
  const caseSync = await syncQuotationCustomerToCase(client, userId, caseRow, quotationSnapshot);
  return {
    success: true,
    followUp: leadFollowUpRecord(data, caseRow.legacy_case_id),
    status: currentStatus,
    statusChanged,
    updatedAt: followedAt,
    caseSync,
    apiVersion: CRM_API_VERSION,
  };
}

async function getQuotationHistoryForCase(client, caseId, historyId) {
  if (!caseId) throw new CrmRequestError(400, 'ไม่พบ Case_ID ของใบเสนอราคา', 'MISSING_CASE_ID');
  if (!historyId) throw new CrmRequestError(400, 'ไม่พบประวัติใบเสนอราคา', 'MISSING_QUOTATION_HISTORY_ID');

  const { data: caseRow, error: caseError } = await client
    .from('cases')
    .select('id, legacy_case_id')
    .eq('legacy_case_id', caseId)
    .maybeSingle();
  throwDatabaseError(caseError);
  if (!caseRow) throw new CrmRequestError(404, `ไม่พบเคส ${caseId}`, 'CASE_NOT_FOUND');

  const { data: historyRow, error: historyError } = await client
    .from('lead_follow_up_history')
    .select('id, case_id, quotation_numbers, quotation_snapshot')
    .eq('id', historyId)
    .eq('case_id', caseRow.id)
    .maybeSingle();
  if (['42P01', '42703'].includes(historyError?.code)) {
    throw new CrmRequestError(503, 'ยังไม่ได้ติดตั้งโครงสร้างข้อมูลใบเสนอราคา กรุณา apply database migration ก่อนใช้งาน', 'QUOTATION_HISTORY_NOT_READY');
  }
  throwDatabaseError(historyError, 'ไม่สามารถอ่านประวัติใบเสนอราคาได้');
  if (!historyRow) {
    throw new CrmRequestError(404, 'ไม่พบเอกสารใบเสนอราคาที่แก้ไขได้ในประวัตินี้', 'QUOTATION_HISTORY_NOT_FOUND');
  }
  return { caseRow, historyRow };
}

function normalizeInvoiceSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CrmRequestError(400, 'ข้อมูลใบแจ้งหนี้ไม่ถูกต้อง', 'INVALID_INVOICE');
  const dueDate = text(value.dueDate);
  const issueDate = text(value.issueDate);
  const isDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10) === date;
  if (!isDate(issueDate) || (dueDate && (!isDate(dueDate) || dueDate < issueDate))) throw new CrmRequestError(400, 'กรุณาตรวจสอบวันที่ใบแจ้งหนี้และวันครบกำหนดชำระ', 'INVALID_INVOICE_DATE');
  const normalized = normalizeQuotationSnapshot({ ...value, quoteNumber: text(value.sourceQuoteNumber) || 'INVOICE', validDays: 30 });
  const subtotal = normalized.items.filter(x => !x.isDiscount).reduce((n,x) => n+x.quantity*x.unitPrice,0);
  const discount = normalized.items.filter(x => x.isDiscount).reduce((n,x) => n+x.unitPrice,0);
  if (discount > subtotal) throw new CrmRequestError(400, 'ส่วนลดมากกว่ายอดสินค้า', 'INVALID_INVOICE_TOTAL');
  return { ...normalized, dueDate };
}

function invoiceRecord(row) {
  return row ? { ...row.snapshot, invoiceId:row.id, invoiceNumber:row.invoice_number, invoiceUpdatedAt:row.updated_at } : null;
}

async function getInvoiceForQuotation(client, body) {
  const { historyRow } = await getQuotationHistoryForCase(client, text(body.caseId), text(body.historyId));
  const { data, error } = await client.from('crm_invoices').select('*').eq('source_history_id',historyRow.id).eq('id',text(body.invoiceId)).maybeSingle();
  throwDatabaseError(error, 'ไม่สามารถโหลดใบแจ้งหนี้ได้');
  return { success:true, invoice:invoiceRecord(data), apiVersion:CRM_API_VERSION };
}

async function getInvoicesForCase(client, body) {
  const { data: caseRow, error: caseError } = await client.from('cases').select('id').eq('legacy_case_id',text(body.caseId)).maybeSingle();
  throwDatabaseError(caseError);
  if (!caseRow) throw new CrmRequestError(404, 'ไม่พบเคส', 'CASE_NOT_FOUND');
  const { data, error } = await client.from('crm_invoices').select('id,invoice_number,source_history_id').eq('case_id',caseRow.id).order('created_at',{ascending:false});
  throwDatabaseError(error);
  return {success:true,invoices:data || [],apiVersion:CRM_API_VERSION};
}

async function saveInvoice(client, body) {
  const { historyRow } = await getQuotationHistoryForCase(client, text(body.caseId), text(body.historyId));
  const snapshot = normalizeInvoiceSnapshot(body.invoice);
  const expected = text(body.expectedUpdatedAt) || null;
  if (expected && !Number.isFinite(Date.parse(expected))) throw new CrmRequestError(400, 'รุ่นข้อมูลใบแจ้งหนี้ไม่ถูกต้อง', 'INVALID_INVOICE_VERSION');
  const { data, error } = await client.rpc('save_crm_invoice', { p_history_id:historyRow.id, p_snapshot:snapshot, p_expected_updated_at:expected, p_invoice_id:text(body.invoiceId) || crypto.randomUUID() });
  if (error?.code === '40001') throw new CrmRequestError(409, 'ใบแจ้งหนี้มีการแก้ไขจากผู้ใช้อื่น กรุณาเปิดใหม่ก่อนบันทึก', 'INVOICE_CONFLICT');
  throwDatabaseError(error, 'ไม่สามารถบันทึกใบแจ้งหนี้ได้');
  return { success:true, invoice:invoiceRecord(data), apiVersion:CRM_API_VERSION };
}

async function deleteInvoice(client, body) {
  const { historyRow } = await getQuotationHistoryForCase(client, text(body.caseId), text(body.historyId));
  const invoiceId = text(body.invoiceId);
  const expected = text(body.expectedUpdatedAt);
  if (!invoiceId || !expected || !Number.isFinite(Date.parse(expected))) throw new CrmRequestError(400, 'ข้อมูลใบแจ้งหนี้ที่ต้องการลบไม่ครบถ้วน', 'INVALID_INVOICE_VERSION');
  const { data, error } = await client.from('crm_invoices').delete().eq('id',invoiceId).eq('source_history_id',historyRow.id).eq('updated_at',expected).select('id').maybeSingle();
  throwDatabaseError(error, 'ไม่สามารถลบใบแจ้งหนี้ได้');
  if (!data) throw new CrmRequestError(409, 'ใบแจ้งหนี้ถูกแก้ไขหรือลบแล้ว กรุณาเปิดใหม่', 'INVOICE_CONFLICT');
  return { success:true, apiVersion:CRM_API_VERSION };
}

async function updateQuotationHistory(client, userId, body) {
  const caseId = text(body.caseId);
  const historyId = text(body.historyId).slice(0, 100);
  const { caseRow, historyRow } = await getQuotationHistoryForCase(client, caseId, historyId);
  const quotationSnapshot = normalizeQuotationSnapshot(body.quotationSnapshot);

  const { data, error } = await client
    .from('lead_follow_up_history')
    .update({
      contact_channel: 'ออกใบเสนอราคา',
      notes: `ออกใบเสนอราคาเลขที่ ${quotationSnapshot.quoteNumber}`,
      quotation_numbers: [quotationSnapshot.quoteNumber],
      quotation_snapshot: quotationSnapshot,
      updated_by: userId,
    })
    .eq('id', historyRow.id)
    .eq('case_id', caseRow.id)
    .select('id, followed_at, contact_channel, outcome, notes, next_follow_up_at, previous_status, current_status, quotation_numbers, quotation_snapshot, created_at')
    .maybeSingle();
  if (['42P01', '42703'].includes(error?.code)) {
    throw new CrmRequestError(503, 'ยังไม่ได้ติดตั้งโครงสร้างข้อมูลใบเสนอราคา กรุณา apply database migration ก่อนใช้งาน', 'QUOTATION_HISTORY_NOT_READY');
  }
  throwDatabaseError(error, 'ไม่สามารถแก้ไขใบเสนอราคาได้');
  if (!data) throw new CrmRequestError(404, 'ไม่พบประวัติใบเสนอราคาที่แก้ไขได้ในประวัตินี้', 'QUOTATION_HISTORY_NOT_FOUND');
  const caseSync = await syncQuotationCustomerToCase(client, userId, caseRow, quotationSnapshot);
  return {
    success: true,
    followUp: leadFollowUpRecord(data, caseRow.legacy_case_id),
    caseSync,
    apiVersion: CRM_API_VERSION,
  };
}

async function deleteQuotationHistory(client, membership, body) {
  requireQuotationHistoryDeletionManager(membership);
  const caseId = text(body.caseId);
  const historyId = text(body.historyId).slice(0, 100);
  const { caseRow, historyRow } = await getQuotationHistoryForCase(client, caseId, historyId);

  const { data, error } = await client
    .from('lead_follow_up_history')
    .delete()
    .eq('id', historyRow.id)
    .eq('case_id', caseRow.id)
    .select('id')
    .maybeSingle();
  throwDatabaseError(error, 'ไม่สามารถลบใบเสนอราคาได้');
  if (!data) throw new CrmRequestError(404, 'ไม่พบประวัติใบเสนอราคาที่ลบได้ในประวัตินี้', 'QUOTATION_HISTORY_NOT_FOUND');
  return {
    success: true,
    caseId: caseRow.legacy_case_id,
    historyId: historyRow.id,
    apiVersion: CRM_API_VERSION,
  };
}

class DocumentTemplateCapabilityError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.code = code;
    this.available = options.available === true;
    this.readOnly = options.readOnly !== false;
  }
}

function isDocumentTemplateStorageError(error) {
  if (!error || !DOCUMENT_TEMPLATE_STORAGE_ERROR_CODES.has(String(error.code || ''))) return false;
  if (!['42501', '42703'].includes(String(error.code || ''))) return true;
  return /document_template/i.test(
    `${error.message || ''} ${error.details || ''} ${error.hint || ''}`
  );
}

function throwDocumentTemplateDatabaseError(error, fallback, options = {}) {
  if (!error) return;
  if (isDocumentTemplateStorageError(error)) {
    throw new DocumentTemplateCapabilityError(
      options.write ? 'DOCUMENT_TEMPLATE_WRITE_NOT_AVAILABLE' : 'DOCUMENT_TEMPLATE_STORAGE_NOT_READY',
      options.write
        ? 'ระบบเก็บแม่แบบเอกสารยังไม่พร้อมให้แก้ไข กรุณา apply database migration และตรวจสอบ Data API grants'
        : 'ยังไม่ได้ติดตั้งโครงสร้างแม่แบบเอกสาร ระบบเดิมยังใช้งานได้ตามปกติ',
      { available: options.write, readOnly: true }
    );
  }
  throwDatabaseError(error, fallback);
}

function documentTemplatePermissions(membership, available = true) {
  const canManage = canManageDocumentTemplates(membership);
  return {
    canView: true,
    canEdit: available && canManage,
    canSaveDraft: available && canManage,
    canPublish: available && canManage,
    canRestore: available && canManage,
  };
}

function documentTemplateCapability(membership, available = true, readOnly = false, reason = '') {
  const permissions = documentTemplatePermissions(membership, available && !readOnly);
  return {
    available,
    writable: permissions.canSaveDraft,
    readOnly: readOnly || !permissions.canSaveDraft,
    schemaVersion: DOCUMENT_TEMPLATE_SCHEMA_VERSION,
    companies: [...DOCUMENT_TEMPLATE_COMPANIES],
    documentTypes: [...DOCUMENT_TEMPLATE_TYPES],
    reason: reason || null,
  };
}

function documentTemplateUnavailableResponse(membership, error, operation = 'read') {
  const capability = documentTemplateCapability(membership, error.available, error.readOnly, error.code);
  return {
    success: true,
    operationCompleted: false,
    saved: false,
    published: false,
    restored: false,
    available: capability.available,
    readOnly: capability.readOnly,
    code: error.code,
    message: error.message,
    capability,
    permissions: documentTemplatePermissions(membership, capability.available && !capability.readOnly),
    templates: [],
    template: null,
    currentVersion: null,
    publishedVersion: null,
    versions: [],
    design: null,
    operation,
    apiVersion: CRM_API_VERSION,
  };
}

function documentTemplateVersionRecord(version, currentVersionId = '', expectedDocumentType, expectedCompany) {
  if (!version || typeof version !== 'object') return null;
  const versionNumber = Number(version.version_number);
  const status = text(version.status);
  const schemaVersion = Number(version.schema_version);
  if (
    !Number.isSafeInteger(versionNumber)
    || versionNumber < 1
    || !DOCUMENT_TEMPLATE_STATUSES.has(status)
    || !Number.isSafeInteger(schemaVersion)
    || schemaVersion !== DOCUMENT_TEMPLATE_SCHEMA_VERSION
    || !isPlainJsonObject(version.design_json)
    || !/^[0-9a-f]{64}$/.test(String(version.checksum || ''))
  ) {
    throw new CrmRequestError(503, 'ข้อมูลเวอร์ชันแม่แบบเอกสารไม่ถูกต้อง', 'INVALID_DOCUMENT_TEMPLATE_VERSION_RECORD');
  }
  let validatedDesign;
  try {
    validatedDesign = validateDocumentTemplateDesign(version.design_json, expectedDocumentType, expectedCompany);
  } catch {
    throw new CrmRequestError(503, 'ข้อมูลเวอร์ชันแม่แบบเอกสารไม่ถูกต้อง', 'INVALID_DOCUMENT_TEMPLATE_VERSION_RECORD');
  }
  if (documentTemplateChecksum(validatedDesign) !== String(version.checksum || '')) {
    throw new CrmRequestError(503, 'checksum ของแม่แบบเอกสารไม่ถูกต้อง', 'INVALID_DOCUMENT_TEMPLATE_VERSION_CHECKSUM');
  }
  return {
    id: version.id || '',
    templateId: version.template_id || '',
    versionNumber,
    status,
    schemaVersion,
    design: validatedDesign,
    checksum: version.checksum || '',
    changeSummary: version.change_summary || '',
    createdAt: version.created_at || '',
    createdBy: version.created_by || '',
    publishedAt: version.published_at || '',
    publishedBy: version.published_by || '',
    isCurrent: Boolean(currentVersionId && version.id === currentVersionId),
  };
}

function documentTemplateRecord(template, currentVersion = null, publishedVersion = null) {
  if (!template || typeof template !== 'object') return null;
  return {
    id: template.id || '',
    company: template.company_code || '',
    documentType: template.document_type || '',
    displayName: template.display_name || '',
    isActive: template.is_active !== false,
    currentVersionId: currentVersion?.id || '',
    publishedVersionId: publishedVersion?.id || '',
    status: currentVersion?.status || 'not_configured',
    design: currentVersion?.design || null,
    createdAt: template.created_at || '',
    updatedAt: template.updated_at || '',
  };
}

function requestedDocumentTemplateIdentity(input, options = {}) {
  const hasCompany = Object.prototype.hasOwnProperty.call(input || {}, 'company');
  const hasDocumentType = Object.prototype.hasOwnProperty.call(input || {}, 'documentType');
  if (hasCompany !== hasDocumentType || (options.required && (!hasCompany || !hasDocumentType))) {
    throw new CrmRequestError(400, 'กรุณาระบุ company และ documentType ให้ครบ', 'MISSING_DOCUMENT_TEMPLATE_IDENTITY');
  }
  if (!hasCompany) return null;
  return {
    company: validateDocumentTemplateCompany(input.company),
    documentType: validateDocumentTemplateType(input.documentType),
  };
}

async function readDocumentTemplateDesigner(client, membership, input = {}) {
  const identity = requestedDocumentTemplateIdentity(input);
  try {
    let templatesRequest = client
      .from('document_templates')
      .select('id, company_code, document_type, display_name, is_active, created_at, updated_at, created_by, updated_by')
      .order('company_code', { ascending: true })
      .order('document_type', { ascending: true });
    if (identity) {
      templatesRequest = templatesRequest
        .eq('company_code', identity.company)
        .eq('document_type', identity.documentType);
    }
    const { data: templateRows, error: templateError } = await templatesRequest;
    throwDocumentTemplateDatabaseError(templateError, 'ไม่สามารถอ่านรายการแม่แบบเอกสารได้');

    const rows = Array.isArray(templateRows) ? templateRows : [];
    if (identity && canManageDocumentTemplates(membership) && rows.length === 0) {
      throw new DocumentTemplateCapabilityError(
        'DOCUMENT_TEMPLATE_SEED_NOT_READY',
        'ยังไม่พบแม่แบบเริ่มต้นสำหรับบริษัทและประเภทเอกสารนี้ กรุณา apply database migration ให้ครบ',
        { available: false, readOnly: true }
      );
    }
    const templateIds = rows.map(row => row.id).filter(Boolean);
    let publicationRows = [];
    let versionRows = [];
    if (templateIds.length) {
      const [{ data: publications, error: publicationError }, { data: versions, error: versionError }] = await Promise.all([
        client
          .from('document_template_publications')
          .select('template_id, current_version_id, published_at, published_by, updated_at, updated_by')
          .in('template_id', templateIds),
        client
          .from('document_template_versions')
          .select('id, template_id, version_number, status, schema_version, design_json, checksum, change_summary, created_at, created_by, published_at, published_by')
          .in('template_id', templateIds)
          .order('version_number', { ascending: false }),
      ]);
      throwDocumentTemplateDatabaseError(publicationError, 'ไม่สามารถอ่านแม่แบบที่เผยแพร่ได้');
      throwDocumentTemplateDatabaseError(versionError, 'ไม่สามารถอ่านเวอร์ชันแม่แบบเอกสารได้');
      publicationRows = publications || [];
      versionRows = versions || [];
    }

    const publicationsByTemplate = new Map(publicationRows.map(row => [row.template_id, row]));
    const rawVersionsByTemplate = new Map();
    for (const row of versionRows) {
      if (!rawVersionsByTemplate.has(row.template_id)) rawVersionsByTemplate.set(row.template_id, []);
      rawVersionsByTemplate.get(row.template_id).push(row);
    }

    const detailByTemplate = new Map();
    const templateRecords = rows.map(row => {
      const publication = publicationsByTemplate.get(row.id) || null;
      const currentPublicationId = publication?.current_version_id || '';
      const versions = (rawVersionsByTemplate.get(row.id) || [])
        .map(version => documentTemplateVersionRecord(version, currentPublicationId, row.document_type, row.company_code))
        .sort((first, second) => second.versionNumber - first.versionNumber);
      const publishedVersion = versions.find(version => version.id === currentPublicationId) || null;
      const latestDraft = canManageDocumentTemplates(membership)
        ? versions.find(version => version.status === 'draft') || null
        : null;
      const currentVersion = latestDraft && (!publishedVersion || latestDraft.versionNumber > publishedVersion.versionNumber)
        ? latestDraft
        : publishedVersion || latestDraft || versions[0] || null;
      const template = documentTemplateRecord(row, currentVersion, publishedVersion);
      detailByTemplate.set(row.id, { template, currentVersion, publishedVersion, versions });
      return template;
    });

    const selectedRow = identity ? rows[0] || null : null;
    const selected = selectedRow ? detailByTemplate.get(selectedRow.id) : null;
    const capability = documentTemplateCapability(membership, true, false);
    return {
      success: true,
      operationCompleted: true,
      available: true,
      readOnly: capability.readOnly,
      capability,
      permissions: documentTemplatePermissions(membership, true),
      templates: templateRecords,
      template: selected?.template || null,
      currentVersion: selected?.currentVersion || null,
      publishedVersion: selected?.publishedVersion || null,
      versions: selected?.versions || [],
      design: selected?.currentVersion?.design || null,
      apiVersion: CRM_API_VERSION,
    };
  } catch (error) {
    if (error instanceof DocumentTemplateCapabilityError) {
      return documentTemplateUnavailableResponse(membership, error, 'read');
    }
    throw error;
  }
}

function documentTemplateChangeSummary(value) {
  if (value === undefined || value === null || value === '') return null;
  return documentTemplateString(value, 'changeSummary', 500, false).trim();
}

function documentTemplateVersionLocator(input, required = false) {
  const versionId = input?.versionId;
  const versionNumber = input?.versionNumber;
  const hasVersionId = versionId !== undefined && versionId !== null && versionId !== '';
  const hasVersionNumber = versionNumber !== undefined && versionNumber !== null && versionNumber !== '';
  if (hasVersionId && hasVersionNumber) {
    throw new CrmRequestError(400, 'กรุณาระบุ versionId หรือ versionNumber เพียงอย่างเดียว', 'AMBIGUOUS_DOCUMENT_TEMPLATE_VERSION');
  }
  if (!hasVersionId && !hasVersionNumber) {
    if (required) throw new CrmRequestError(400, 'กรุณาระบุเวอร์ชันแม่แบบเอกสาร', 'MISSING_DOCUMENT_TEMPLATE_VERSION');
    return null;
  }
  if (hasVersionId) {
    if (typeof versionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(versionId)) {
      throw new CrmRequestError(400, 'versionId ไม่ถูกต้อง', 'INVALID_DOCUMENT_TEMPLATE_VERSION_ID');
    }
    return { versionId };
  }
  const parsedVersionNumber = typeof versionNumber === 'number' ? versionNumber : Number(versionNumber);
  if (!Number.isSafeInteger(parsedVersionNumber) || parsedVersionNumber < 1) {
    throw new CrmRequestError(400, 'versionNumber ไม่ถูกต้อง', 'INVALID_DOCUMENT_TEMPLATE_VERSION_NUMBER');
  }
  return { versionNumber: parsedVersionNumber };
}

async function ensureDocumentTemplate(client, identity) {
  const selectColumns = 'id, company_code, document_type, display_name, is_active, created_at, updated_at, created_by, updated_by';
  const { data, error } = await client
    .from('document_templates')
    .select(selectColumns)
    .eq('company_code', identity.company)
    .eq('document_type', identity.documentType)
    .maybeSingle();
  throwDocumentTemplateDatabaseError(error, 'ไม่สามารถอ่านแม่แบบเอกสารได้');
  if (data) return data;
  throw new DocumentTemplateCapabilityError(
    'DOCUMENT_TEMPLATE_SEED_NOT_READY',
    'ยังไม่พบแม่แบบเริ่มต้นสำหรับบริษัทและประเภทเอกสารนี้ กรุณา apply database migration ให้ครบ',
    { available: false, readOnly: true }
  );
}

async function insertDocumentTemplateDraft(client, userId, identity, input) {
  if (input.status !== undefined && input.status !== 'draft') {
    throw new CrmRequestError(400, 'การบันทึกแม่แบบใหม่รองรับสถานะ draft เท่านั้น', 'INVALID_DOCUMENT_TEMPLATE_STATUS');
  }
  const schemaVersion = validateDocumentTemplateSchemaVersion(input.schemaVersion);
  const design = validateDocumentTemplateDesign(input.design, identity.documentType, identity.company);
  const template = await ensureDocumentTemplate(client, identity);
  if (template.is_active === false) {
    throw new CrmRequestError(409, 'แม่แบบเอกสารนี้ถูกปิดใช้งาน', 'DOCUMENT_TEMPLATE_INACTIVE');
  }
  const { data, error } = await client
    .from('document_template_versions')
    .insert({
      template_id: template.id,
      status: 'draft',
      schema_version: schemaVersion,
      design_json: design,
      checksum: documentTemplateChecksum(design),
      change_summary: documentTemplateChangeSummary(input.changeSummary),
      created_by: userId,
    })
    .select('id, template_id, version_number, status, schema_version, design_json, checksum, change_summary, created_at, created_by, published_at, published_by')
    .single();
  throwDocumentTemplateDatabaseError(error, 'ไม่สามารถบันทึกฉบับร่างแม่แบบเอกสารได้', { write: true });
  return { template, version: documentTemplateVersionRecord(data, '', identity.documentType, identity.company) };
}

async function saveDocumentTemplateDraft(client, userId, membership, input) {
  requireDocumentTemplateManager(membership);
  const identity = requestedDocumentTemplateIdentity(input, { required: true });
  try {
    const saved = await insertDocumentTemplateDraft(client, userId, identity, input);
    const result = await readDocumentTemplateDesigner(client, membership, identity);
    return {
      ...result,
      operationCompleted: true,
      saved: true,
      savedVersion: saved.version,
    };
  } catch (error) {
    if (error instanceof DocumentTemplateCapabilityError) return documentTemplateUnavailableResponse(membership, error, 'saveDraft');
    throw error;
  }
}

async function readDocumentTemplateForWrite(client, identity) {
  const data = await ensureDocumentTemplate(client, identity);
  if (data.is_active === false) throw new CrmRequestError(409, 'แม่แบบเอกสารนี้ถูกปิดใช้งาน', 'DOCUMENT_TEMPLATE_INACTIVE');
  return data;
}

async function findDocumentTemplateVersion(client, templateId, input, defaultStatus, documentType, company) {
  const locator = documentTemplateVersionLocator(input);
  let request = client
    .from('document_template_versions')
    .select('id, template_id, version_number, status, schema_version, design_json, checksum, change_summary, created_at, created_by, published_at, published_by')
    .eq('template_id', templateId);
  if (locator?.versionId) request = request.eq('id', locator.versionId);
  else if (locator?.versionNumber) request = request.eq('version_number', locator.versionNumber);
  else if (defaultStatus) request = request.eq('status', defaultStatus).order('version_number', { ascending: false }).limit(1);
  const { data, error } = await request.maybeSingle();
  throwDocumentTemplateDatabaseError(error, 'ไม่สามารถอ่านเวอร์ชันแม่แบบเอกสารได้');
  if (!data) throw new CrmRequestError(404, 'ไม่พบเวอร์ชันแม่แบบเอกสาร', 'DOCUMENT_TEMPLATE_VERSION_NOT_FOUND');
  return documentTemplateVersionRecord(data, '', documentType, company);
}

async function activateDocumentTemplateVersion(client, templateId, targetVersion, userId) {
  const activatedAt = new Date().toISOString();
  const publication = {
    current_version_id: targetVersion.id,
    updated_at: activatedAt,
    updated_by: userId,
  };
  const { data: existingPublication, error: lookupError } = await client
    .from('document_template_publications')
    .select('template_id')
    .eq('template_id', templateId)
    .maybeSingle();
  throwDocumentTemplateDatabaseError(lookupError, 'ไม่สามารถตรวจสอบแม่แบบเอกสารที่เปิดใช้งานอยู่ได้');

  if (existingPublication) {
    const { error } = await client
      .from('document_template_publications')
      .update(publication)
      .eq('template_id', templateId);
    throwDocumentTemplateDatabaseError(error, 'ไม่สามารถเปิดใช้งานแม่แบบเอกสารได้', { write: true });
    return activatedAt;
  }

  const { error: insertError } = await client
    .from('document_template_publications')
    .insert({
      template_id: templateId,
      ...publication,
      published_at: targetVersion.publishedAt || activatedAt,
      published_by: targetVersion.publishedBy || userId,
    });

  if (String(insertError?.code || '') === '23505') {
    // Another manager may have created the publication after our lookup.
    // Retrying as UPDATE lets the database lifecycle trigger archive that
    // just-published version before activating this target atomically.
    const { error: retryError } = await client
      .from('document_template_publications')
      .update(publication)
      .eq('template_id', templateId);
    throwDocumentTemplateDatabaseError(retryError, 'ไม่สามารถเปิดใช้งานแม่แบบเอกสารได้', { write: true });
    return activatedAt;
  }

  throwDocumentTemplateDatabaseError(insertError, 'ไม่สามารถเปิดใช้งานแม่แบบเอกสารได้', { write: true });
  return activatedAt;
}

async function publishDocumentTemplateVersion(client, userId, membership, input) {
  requireDocumentTemplateManager(membership);
  const identity = requestedDocumentTemplateIdentity(input, { required: true });
  try {
    let template;
    let targetVersion;
    if (input.design !== undefined) {
      if (input.versionId !== undefined || input.versionNumber !== undefined) {
        throw new CrmRequestError(400, 'ไม่สามารถส่ง design พร้อมตัวระบุเวอร์ชันได้', 'AMBIGUOUS_DOCUMENT_TEMPLATE_PUBLISH_INPUT');
      }
      const saved = await insertDocumentTemplateDraft(client, userId, identity, input);
      template = saved.template;
      targetVersion = saved.version;
    } else {
      template = await readDocumentTemplateForWrite(client, identity);
      documentTemplateVersionLocator(input, true);
      targetVersion = await findDocumentTemplateVersion(client, template.id, input, undefined, identity.documentType, identity.company);
    }
    if (!['draft', 'published'].includes(targetVersion.status)) {
      throw new CrmRequestError(409, 'เผยแพร่ได้เฉพาะฉบับร่างหรือเวอร์ชันที่เผยแพร่แล้ว', 'INVALID_DOCUMENT_TEMPLATE_PUBLISH_STATUS');
    }
    await activateDocumentTemplateVersion(client, template.id, targetVersion, userId);
    const result = await readDocumentTemplateDesigner(client, membership, identity);
    return {
      ...result,
      operationCompleted: true,
      published: true,
      publishedVersion: result.publishedVersion || targetVersion,
    };
  } catch (error) {
    if (error instanceof DocumentTemplateCapabilityError) return documentTemplateUnavailableResponse(membership, error, 'publish');
    throw error;
  }
}

async function restoreDocumentTemplateVersion(client, userId, membership, input) {
  requireDocumentTemplateManager(membership);
  const identity = requestedDocumentTemplateIdentity(input, { required: true });
  documentTemplateVersionLocator(input, true);
  try {
    const template = await readDocumentTemplateForWrite(client, identity);
    const targetVersion = await findDocumentTemplateVersion(client, template.id, input, undefined, identity.documentType, identity.company);
    if (!['published', 'archived'].includes(targetVersion.status)) {
      throw new CrmRequestError(409, 'กู้คืนได้เฉพาะเวอร์ชันที่เคยเผยแพร่แล้ว', 'DOCUMENT_TEMPLATE_VERSION_NOT_PUBLISHED');
    }
    await activateDocumentTemplateVersion(client, template.id, targetVersion, userId);
    const result = await readDocumentTemplateDesigner(client, membership, identity);
    return { ...result, operationCompleted: true, restored: true, restoredVersion: targetVersion };
  } catch (error) {
    if (error instanceof DocumentTemplateCapabilityError) return documentTemplateUnavailableResponse(membership, error, 'restore');
    throw error;
  }
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
    if ((isGet && action === 'getLineIntake') || (!isGet && action === 'resolveLineIntake')) {
      try {
        payload = isGet
          ? await getIntake(req.crmUser.client, req.crmUser.membership, input)
          : await resolveIntake(req.crmUser.client, req.crmUser.membership, input);
        return res.set('Cache-Control', 'no-store, private').json(payload);
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    }
    if ((isGet && action === 'getFacebookIntake') || (!isGet && action === 'resolveFacebookIntake')) {
      try {
        payload = isGet
          ? await facebookIntake.getIntake(req.crmUser.client, req.crmUser.membership, input)
          : await facebookIntake.resolveIntake(req.crmUser.client, req.crmUser.membership, input);
        return res.set('Cache-Control', 'no-store, private').json(payload);
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    }
    if (isGet) {
      switch (action) {
        case 'getStorageOverview':
          try {
            payload = await getStorageOverview(req.crmUser.client, req.crmUser.membership);
          } catch (error) {
            throw new CrmRequestError(error.status || 503, error.message, error.code || 'STORAGE_UNAVAILABLE');
          }
          break;
        case 'getVersion':
          payload = { success: true, apiVersion: CRM_API_VERSION };
          break;
        case 'getLeads':
          payload = await getLeads(req.crmUser.client, input);
          break;
        case 'getCases':
          payload = await getCases(req.crmUser.client, input);
          break;
        case 'getFollowUpTasks':
          payload = await getFollowUpTasks(req.crmUser.client);
          break;
        case 'getInstallationQueue':
          payload = await getInstallationQueue(req.crmUser.client);
          break;
        case 'getGeneralTasks':
          payload = await getGeneralTasks(req.crmUser.client);
          break;
        case 'getInvoiceForQuotation':
          payload = await getInvoiceForQuotation(req.crmUser.client, input);
          break;
        case 'getInvoicesForCase':
          payload = await getInvoicesForCase(req.crmUser.client, input);
          break;
        case 'getQuotations':
          payload = await getQuotations(req.crmUser.client);
          break;
        case 'getCaseNotificationUnreadCounts':
          payload = await getCaseNotificationUnreadCounts(req.crmUser.client, req.crmUser.id);
          break;
        case 'getLeadDetail':
          payload = await getLeadDetail(req.crmUser.client, text(input.customerId));
          break;
        case 'getLeadFollowUps':
          payload = await getLeadFollowUps(req.crmUser.client, input.caseId);
          break;
        case 'getCustomer':
          payload = await getCustomer(req.crmUser.client, text(input.customerId));
          break;
        case 'lookupCustomer':
          payload = await lookupCustomer(req.crmUser.client, input);
          break;
        case 'getEmployees':
          payload = await getEmployees(req.crmUser.client, input.position, req.crmUser.assignment);
          break;
        case 'getCaseSalespersonContact':
          payload = await getCaseSalespersonContact(req.crmUser.client, input.caseId);
          break;
        case 'getCaseAdminContact':
          payload = await getCaseAdminContact(req.crmUser.client, input.caseId);
          break;
        case 'getEmployeeDirectory':
          payload = await getEmployeeDirectory(req.crmUser.client, req.crmUser.membership);
          break;
        case 'getContactTopics':
          payload = await getContactTopics(req.crmUser.client, req.crmUser.membership, parseBoolean(input.includeInactive, false));
          break;
        case 'getReferralSources':
          payload = await getReferralSources(req.crmUser.client, req.crmUser.membership, parseBoolean(input.includeInactive, false));
          break;
        case 'getSiteTypes':
          payload = await getSiteTypes(req.crmUser.client, req.crmUser.membership, parseBoolean(input.includeInactive, false));
          break;
        case 'getProductDirectory':
          payload = await getProductDirectory(req.crmUser.client, req.crmUser.membership);
          break;
        case 'getAnnouncements':
          payload = await getAnnouncements(
            req.crmUser.client,
            req.crmUser.id,
            req.crmUser.membership,
            parseBoolean(input.includeUnpublished, false)
          );
          break;
        case 'getAnnouncementUnreadCount':
          payload = await getAnnouncementUnreadCount(req.crmUser.client, req.crmUser.id);
          break;
        case 'getDocumentTemplateDesigner':
          payload = await readDocumentTemplateDesigner(req.crmUser.client, req.crmUser.membership, input);
          break;
        default:
          throw new CrmRequestError(400, 'Unknown CRM action.', 'UNKNOWN_ACTION');
      }
    } else {
      switch (action) {
        case 'deleteStorageFile':
          try {
            payload = await deleteStorageFile(req.crmUser.client, req.crmUser.membership, input);
          } catch (error) {
            throw new CrmRequestError(error.status || 503, error.message, error.code || 'STORAGE_DELETE_FAILED');
          }
          break;
        case 'saveCustomer':
          payload = await saveCustomer(req.crmUser.client, req.crmUser.id, input);
          break;
        case 'updateCaseStatus':
          payload = await updateCaseStatus(req.crmUser.client, req.crmUser.id, input);
          break;
        case 'updateCaseDetails':
          payload = await updateCaseDetails(req.crmUser.client, req.crmUser.id, req.crmUser.assignment, input);
          break;
        case 'deleteCase':
          payload = await deleteCase(req.crmUser.client, req.crmUser.membership, input);
          break;
        case 'updateCaseSalesperson':
          payload = await updateCaseSalesperson(req.crmUser.client, req.crmUser.id, req.crmUser.assignment, input);
          break;
        case 'saveGeneralTask':
          payload = await saveGeneralTask(req.crmUser.client, req.crmUser.id, req.crmUser.membership, input);
          break;
        case 'completeGeneralTask':
          payload = await completeGeneralTask(req.crmUser.client, req.crmUser.id, req.crmUser.assignment, input);
          break;
        case 'deleteGeneralTask':
          payload = await deleteGeneralTask(req.crmUser.client, req.crmUser.membership, input);
          break;
        case 'createLeadFollowUp':
          payload = await createLeadFollowUp(req.crmUser.client, req.crmUser.id, input);
          break;
        case 'saveInvoice':
          payload = await saveInvoice(req.crmUser.client, input);
          break;
        case 'deleteInvoice':
          payload = await deleteInvoice(req.crmUser.client, input);
          break;
        case 'updateQuotationHistory':
          payload = await updateQuotationHistory(req.crmUser.client, req.crmUser.id, input);
          break;
        case 'deleteQuotationHistory':
          payload = await deleteQuotationHistory(req.crmUser.client, req.crmUser.membership, input);
          break;
        case 'saveEmployee':
          payload = await saveEmployee(req.crmUser.client, req.crmUser.id, req.crmUser.membership, input);
          break;
        case 'deleteEmployee':
          payload = await deleteEmployee(req.crmUser.client, req.crmUser.membership, input);
          break;
        case 'saveContactTopic':
          payload = await saveContactTopic(req.crmUser.client, req.crmUser.id, req.crmUser.membership, input);
          break;
        case 'deleteContactTopic':
          payload = await deleteContactTopic(req.crmUser.client, req.crmUser.membership, input);
          break;
        case 'saveReferralSource':
          payload = await saveReferralSource(req.crmUser.client, req.crmUser.id, req.crmUser.membership, input);
          break;
        case 'saveSiteType':
          payload = await saveSiteType(req.crmUser.client, req.crmUser.id, req.crmUser.membership, input);
          break;
        case 'deleteSiteType':
          payload = await deleteSiteType(req.crmUser.client, req.crmUser.membership, input);
          break;
        case 'saveProduct':
          payload = await saveProduct(req.crmUser.client, req.crmUser.id, req.crmUser.membership, input);
          break;
        case 'deleteProduct':
          payload = await deleteProduct(req.crmUser.client, req.crmUser.membership, input);
          break;
        case 'saveAnnouncement':
          payload = await saveAnnouncement(req.crmUser.client, req.crmUser.id, req.crmUser.membership, input);
          break;
        case 'deleteAnnouncement':
          payload = await deleteAnnouncement(req.crmUser.client, req.crmUser.membership, input);
          break;
        case 'setAnnouncementPinned':
          payload = await setAnnouncementPinned(req.crmUser.client, req.crmUser.id, req.crmUser.membership, input);
          break;
        case 'markAnnouncementsRead':
          payload = await markAnnouncementsRead(req.crmUser.client, req.crmUser.id);
          break;
        case 'markCaseNotificationsRead':
          payload = await markCaseNotificationsRead(
            req.crmUser.client,
            req.crmUser.id,
            input.scope,
            input.readThroughAt
          );
          break;
        case 'saveDocumentTemplateDraft':
          payload = await saveDocumentTemplateDraft(
            req.crmUser.client,
            req.crmUser.id,
            req.crmUser.membership,
            input
          );
          break;
        case 'publishDocumentTemplateVersion':
          payload = await publishDocumentTemplateVersion(
            req.crmUser.client,
            req.crmUser.id,
            req.crmUser.membership,
            input
          );
          break;
        case 'restoreDocumentTemplateVersion':
          payload = await restoreDocumentTemplateVersion(
            req.crmUser.client,
            req.crmUser.id,
            req.crmUser.membership,
            input
          );
          break;
        case 'createCase':
          payload = await createCase(req.crmUser.client, req.crmUser.id, req.crmUser.assignment, input);
          break;
        default:
          if (!action) {
            // Backward compatibility for an older cached form that submitted
            // case data without an explicit action.
            payload = await createCase(req.crmUser.client, req.crmUser.id, req.crmUser.assignment, input);
            break;
          }
          throw new CrmRequestError(400, 'Unknown CRM action.', 'UNKNOWN_ACTION');
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
// LINE servers are outside Thailand. This exact, signed route is independent
// of browser login and country restrictions; every other route stays protected.
app.post('/webhooks/line/gfs-249izgyn', express.raw({ type: 'application/json', limit: '256kb' }), createWebhook({
  getClient() {
    const key = process.env.LINE_INTAKE_SUPABASE_SECRET_KEY;
    if (!PROJECT_URL || !key) return null;
    return createClient(PROJECT_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
  },
}));
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
    assignment: req.crmUser.assignment,
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

module.exports = {
  announcementRecord, announcementWritePayload, getAnnouncements, setAnnouncementPinned,
  referralSourceRecord, referralSourceWritePayload, getReferralSources, saveReferralSource,
  normalizeInvoiceSnapshot, invoiceRecord, getInvoiceForQuotation, saveInvoice, deleteInvoice,
  app,
  createGeoAccessConfig,
  isLoopbackAddress,
  crmAssignmentRecord,
  isRestrictedCrmSales,
  scopeCaseAssignment,
  requireCaseAssignmentManager,
  requireGeneralTaskCreator,
  generalTaskRecord,
  generalTaskWritePayload,
  normalizeQuotationSnapshot,
  normalizeQuotationPrintOptions,
  isPhoneUniqueViolation,
  customerLeadMetrics,
  getCaseSalespersonContact,
  getCaseAdminContact,
  siteTypeRecord,
  siteTypeWritePayload,
  getSiteTypes,
  quotationCountForHistory,
  quotationListRecords,
  caseRecord,
  ordinaryFollowUpAt,
  effectiveCaseFollowUpAt,
  caseWritePayload,
  createCaseAppointment,
  createLeadFollowUp,
  getCases,
  deleteCase,
  evaluationMeasurementPayload,
  getLeadFollowUps,
  getLeadDetail,
  customerWritePayload,
  customerRecord,
  getCustomer,
  lookupCustomer,
  getLeads,
  saveCustomer,
  bangkokDateKey,
  isFollowUpTaskRecord,
  sortFollowUpTaskRecords,
  followUpTaskBucket,
  summarizeFollowUpTasks,
  getFollowUpTasks,
  isInstallationQueueRecord,
  sortInstallationQueueRecords,
  getInstallationQueue,
  countUnreadCaseNotifications,
  validateCaseStatus,
  canManageDocumentTemplates,
  requireDocumentTemplateManager,
  validateDocumentTemplateCompany,
  validateDocumentTemplateType,
  validateDocumentTemplateSchemaVersion,
  validateDocumentTemplateDesign,
  documentTemplateChecksum,
  documentTemplateVersionRecord,
  documentTemplateVersionLocator,
  isDocumentTemplateStorageError,
  activateDocumentTemplateVersion,
};
