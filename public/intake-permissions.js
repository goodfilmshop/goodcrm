(function (root, factory) {
  const catalog = typeof module === 'object' && module.exports ? require('./intake-accounts') : root.IntakeAccounts;
  const api = factory(catalog);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IntakePermissions = api;
})(typeof window === 'object' ? window : globalThis, function (catalog) {
  const channels = catalog.channels;
  const roles = Object.freeze(['admin', 'manager', 'sales', 'member']);
  const accountDefinitions = catalog.accounts;
  const editorStates = new WeakMap();
  const isAdmin = role => String(role || '').trim().toLowerCase() === 'admin';

  function normalize(source, role = '') {
    const permissions = {};
    for (const channel of channels) {
      const supplied = source?.[channel];
      const accountSpecific = supplied && Object.prototype.hasOwnProperty.call(supplied, 'accounts');
      const accounts = {};
      for (const { key } of accountDefinitions[channel]) {
        const grant = accountSpecific ? supplied.accounts?.[key] : supplied;
        const manage = isAdmin(role) || grant?.manage === true;
        accounts[key] = { view: manage || isAdmin(role) || grant?.view === true, manage };
      }
      permissions[channel] = {
        view: Object.values(accounts).some(grant => grant.view),
        manage: Object.values(accounts).some(grant => grant.manage),
        accounts,
      };
    }
    return permissions;
  }

  function memberPermissions(member) {
    const role = String(member?.role || '').trim().toLowerCase();
    const active = member?.is_active === true && roles.includes(role);
    return normalize(active ? member.intakePermissions : null, active ? role : '');
  }

  function canView(member, channel, account) {
    if (!channels.includes(channel)) return false;
    const permissions = memberPermissions(member)[channel];
    if (account === undefined) return permissions.view;
    return accountDefinitions[channel].some(item => item.key === account) && permissions.accounts[account].view;
  }

  function canManage(member, channel, account) {
    if (!channels.includes(channel)) return false;
    const permissions = memberPermissions(member)[channel];
    if (account === undefined) return permissions.manage;
    return accountDefinitions[channel].some(item => item.key === account) && permissions.accounts[account].manage;
  }

  function canViewReports(member) {
    return canView(member, 'line') || canView(member, 'facebook');
  }

  function canAccessPage(member, pageId) {
    if (pageId === 'reports') return canViewReports(member);
    const channel = channels.find(item => pageId === `${item}-intake`);
    return !channel || canView(member, channel);
  }

  function scopeKey(member) {
    const permissions = memberPermissions(member);
    return channels.map(channel => accountDefinitions[channel].map(({ key }) => {
      const grant = permissions[channel].accounts[key];
      return `${Number(grant.view)}${Number(grant.manage)}`;
    }).join('')).join('');
  }

  function syncNavigation(document, member) {
    let deniedVisiblePage = false;
    for (const pageId of [...channels.map(channel => `${channel}-intake`), 'reports']) {
      const allowed = canAccessPage(member, pageId);
      const menu = document.getElementById(`menu-${pageId}`);
      if (menu) {
        menu.hidden = !allowed;
        menu.classList.toggle('hidden', !allowed);
        menu.setAttribute('aria-hidden', String(!allowed));
      }
      const page = document.getElementById(`page-${pageId}`);
      if (page && !allowed) {
        deniedVisiblePage ||= !page.classList.contains('hidden');
        page.classList.add('hidden');
      }
    }
    return deniedVisiblePage;
  }

  function checkboxId(channel, account, action) {
    return `employeeIntake-${channel}-${account}-${action}`;
  }

  function checkbox(document, channel, account, action) {
    return document.getElementById(checkboxId(channel, account, action));
  }

  function readCheckboxes(document) {
    const permissions = {};
    for (const channel of channels) {
      const accounts = {};
      for (const { key } of accountDefinitions[channel]) {
        accounts[key] = {
          view: checkbox(document, channel, key, 'view')?.checked === true,
          manage: checkbox(document, channel, key, 'manage')?.checked === true,
        };
      }
      permissions[channel] = { accounts };
    }
    return normalize(permissions);
  }

  function renderEditor(document, permissions, role) {
    const normalized = normalize(permissions, role);
    for (const channel of channels) {
      for (const { key } of accountDefinitions[channel]) {
        for (const action of ['view', 'manage']) {
          const input = checkbox(document, channel, key, action);
          if (!input) continue;
          input.checked = normalized[channel].accounts[key][action];
          input.disabled = isAdmin(role);
        }
      }
    }
    const note = document.getElementById('employeeIntakePermissionsNote');
    if (note) note.textContent = isAdmin(role)
      ? 'ผู้ดูแลระบบมีสิทธิ์ดูและจัดการครบทุกบัญชีเสมอ'
      : 'เลือกสิทธิ์แยกแต่ละบัญชี · จัดการ: เพิ่มลูกค้าใหม่ เชื่อมลูกค้าเดิม และไม่รับเข้า โดยต้องมีสิทธิ์ดูบัญชีนั้นด้วย';
  }

  function populateEditor(document, permissions, role) {
    const draft = normalize(isAdmin(role) ? null : permissions);
    editorStates.set(document, { role, draft });
    renderEditor(document, draft, role);
  }

  function changeEditorRole(document, role) {
    const state = editorStates.get(document) || { role: '', draft: normalize(null) };
    if (!isAdmin(state.role)) state.draft = readCheckboxes(document);
    state.role = role;
    editorStates.set(document, state);
    renderEditor(document, state.draft, role);
  }

  function changeEditorPermission(document, channel, account, action) {
    if (!channels.includes(channel) || !accountDefinitions[channel].some(item => item.key === account) || !['view', 'manage'].includes(action)) return;
    const view = checkbox(document, channel, account, 'view');
    const manage = checkbox(document, channel, account, 'manage');
    if (!view || !manage || view.disabled || manage.disabled) return;
    if (action === 'manage' && manage.checked) view.checked = true;
    if (action === 'view' && !view.checked) manage.checked = false;
    const state = editorStates.get(document);
    if (state) state.draft = readCheckboxes(document);
  }

  function readEditor(document, role) {
    return normalize(readCheckboxes(document), role);
  }

  return { channels, accountDefinitions, checkboxId, normalize, canView, canManage, canViewReports, canAccessPage, scopeKey,
    syncNavigation, populateEditor, changeEditorRole, changeEditorPermission, readEditor };
});
