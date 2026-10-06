const test = require('node:test');
const assert = require('node:assert/strict');
const { employeeRecord, employeeWritePayload, saveEmployee } = require('./server');
const { readIntakePermissions } = require('./intake-permissions');

test('employee grants normalize, round trip and stay unchanged when omitted on update', () => {
  const payload = employeeWritePayload({ nickname: 'Synthetic', intakePermissions: {
    line: { manage: true }, facebook: { view: true },
  } }, 'synthetic-admin');
  assert.equal(payload.intake_permissions.line.manage, true);
  assert.ok(Object.values(payload.intake_permissions.line.accounts).every(grant => grant.view && grant.manage));
  assert.ok(Object.values(payload.intake_permissions.facebook.accounts).every(grant => grant.view && !grant.manage));
  assert.ok(Object.values(payload.intake_permissions.instagram.accounts).every(grant => !grant.view && !grant.manage));
  assert.deepEqual(employeeRecord(payload).intakePermissions, payload.intake_permissions);
  assert.equal(Object.hasOwn(employeeWritePayload({ nickname: 'Synthetic' }, 'synthetic-admin'), 'intake_permissions'), false);
  for (const intakePermissions of [null, [], { line: { view: 'true' } }, { facebook: { manage: 1 } }, { other: { view: true } }]) {
    assert.throws(() => employeeWritePayload({ nickname: 'Synthetic', intakePermissions }, 'synthetic-admin'), error => error.code === 'INVALID_INTAKE_PERMISSIONS');
  }
});

test('only administrators can edit employee grants and granted roles cannot self-promote', async () => {
  const client = { from() { assert.fail('unauthorized requests cannot query employee storage'); } };
  for (const role of ['manager', 'sales', 'member']) {
    await assert.rejects(saveEmployee(client, 'synthetic-user', { role, is_active: true,
      intakePermissions: { line: { manage: true } } }, { nickname: 'Synthetic', intakePermissions: { instagram: { manage: true } } }),
    error => error.status === 403);
  }
});

test('membership permissions come from the signed-in database RPC and errors fail closed', async () => {
  const calls = [];
  const permissions = await readIntakePermissions({ rpc: async (...args) => {
    calls.push(args); return { data: { facebook: { view: true, manage: false } } };
  } });
  assert.deepEqual(calls, [['get_current_crm_intake_permissions']]);
  assert.equal(permissions.facebook.view, true);
  assert.equal(permissions.line.view, false);
  for (const response of [{ error: { code: '42501' } }, { data: null }, { data: [] }]) {
    await assert.rejects(readIntakePermissions({ rpc: async () => response }), error => error.status === 503);
  }
});
