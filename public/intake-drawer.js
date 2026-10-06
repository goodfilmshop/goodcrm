// Keep the existing intake form and submission flow inside a native modal drawer.
const IntakeDrawer = (() => {
  let active = null;
  function close(form) {
    if (!active || active.form !== form) return;
    const state = active;
    active = null;
    state.dialog.close();
    state.placeholder.replaceWith(form);
    state.dialog.remove();
    document.body.style.overflow = state.overflow;
    if (state.trigger?.isConnected) state.trigger.focus({ preventScroll: true });
  }
  function open(form, onClose, isSaving) {
    if (active) active.onClose();
    const trigger = document.activeElement;
    const placeholder = document.createComment('intake form position');
    form.before(placeholder);
    const dialog = document.createElement('dialog');
    dialog.className = 'intake-drawer';
    dialog.setAttribute('aria-labelledby', form.querySelector('h3').id);
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'intake-drawer-close';
    closeButton.setAttribute('aria-label', 'ปิดหน้าคัดรายชื่อ');
    closeButton.textContent = '×';
    const requestClose = () => { if (!isSaving()) onClose(); };
    closeButton.addEventListener('click', requestClose);
    dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) requestClose();
    });
    const error = document.createElement('p');
    error.className = 'intake-drawer-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    form.querySelector('button[type="submit"]').before(error);
    dialog.append(closeButton, form);
    document.body.append(dialog);
    active = { form, dialog, placeholder, trigger, onClose, error, overflow: document.body.style.overflow };
    // Remove only the drawer's transient error when restoring the form.
    dialog.addEventListener('close', () => error.remove(), { once: true });
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    closeButton.focus({ preventScroll: true });
  }
  function showError(form, message) {
    if (active?.form !== form) return;
    active.error.textContent = message;
    active.error.hidden = false;
    active.error.scrollIntoView({ block: 'nearest' });
  }
  return { open, close, showError };
})();
