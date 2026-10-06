const { channels: INTAKE_CHANNELS, accounts: INTAKE_PERMISSION_ACCOUNTS } = require('./public/intake-accounts');

function normalizeIntakePermissions(value) {
  return Object.fromEntries(INTAKE_CHANNELS.map(channel => {
    const source = value?.[channel];
    const specific = source && typeof source === 'object' && Object.hasOwn(source, 'accounts');
    const accounts = Object.fromEntries(INTAKE_PERMISSION_ACCOUNTS[channel].map(({ key }) => {
      const grant = specific ? source.accounts?.[key] : source;
      const manage = grant?.manage === true;
      return [key, { view: manage || grant?.view === true, manage }];
    }));
    return [channel, { view: Object.values(accounts).some(grant => grant.view),
      manage: Object.values(accounts).some(grant => grant.manage), accounts }];
  }));
}

function canAccessIntake(membership, channel, operation = 'view', account = null) {
  if (membership?.is_active !== true || !INTAKE_CHANNELS.includes(channel)
      || !['view', 'manage'].includes(operation)) return false;
  if (account !== null && !INTAKE_PERMISSION_ACCOUNTS[channel].some(item => item.key === account)) return false;
  if (membership.role === 'admin') return true;
  if (!['manager', 'sales', 'member'].includes(membership.role)) return false;
  const permissions = normalizeIntakePermissions(membership.intakePermissions)[channel];
  return account === null ? permissions[operation] : permissions.accounts[account][operation];
}

function requireIntakeAccess(membership, channel, operation = 'view', account = null) {
  if (canAccessIntake(membership, channel, operation, account)) return;
  const label = { line: 'LINE', facebook: 'Facebook', instagram: 'Instagram' }[channel] || 'ช่องนี้';
  throw Object.assign(new Error(`บัญชีนี้ไม่มีสิทธิ์${operation === 'manage' ? 'คัดรายชื่อ' : 'ดูข้อมูล'} ${label}`), {
    status: 403, code: 'INTAKE_ACCESS_FORBIDDEN',
  });
}

function validateIntakePermissions(value) {
  const invalid = () => {
    throw Object.assign(new Error('สิทธิ์ช่องทางรับลีดไม่ถูกต้อง'), { status: 400, code: 'INVALID_INTAKE_PERMISSIONS' });
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const [channel, permissions] of Object.entries(value)) {
    if (!INTAKE_CHANNELS.includes(channel) || !permissions || typeof permissions !== 'object'
        || Array.isArray(permissions)) invalid();
    for (const [operation, enabled] of Object.entries(permissions)) {
      if (operation === 'accounts') {
        if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) invalid();
        for (const [account, grant] of Object.entries(enabled)) {
          if (!INTAKE_PERMISSION_ACCOUNTS[channel].some(item => item.key === account)
              || !grant || typeof grant !== 'object' || Array.isArray(grant)) invalid();
          for (const [action, allowed] of Object.entries(grant)) {
            if (!['view', 'manage'].includes(action) || typeof allowed !== 'boolean') invalid();
          }
        }
      } else if (!['view', 'manage'].includes(operation) || typeof enabled !== 'boolean') invalid();
    }
  }
  return normalizeIntakePermissions(value);
}

async function readIntakePermissions(client) {
  const { data, error } = await client.rpc('get_current_crm_intake_permissions');
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw Object.assign(new Error('ยังตรวจสิทธิ์ช่องทางรับลีดไม่ได้ กรุณาลองใหม่'), {
      status: 503, code: 'INTAKE_ACCESS_UNAVAILABLE',
    });
  }
  return normalizeIntakePermissions(data);
}

module.exports = { INTAKE_CHANNELS, INTAKE_PERMISSION_ACCOUNTS, normalizeIntakePermissions, validateIntakePermissions,
  canAccessIntake, requireIntakeAccess, readIntakePermissions };
