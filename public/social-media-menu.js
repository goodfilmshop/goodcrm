window.SocialMediaMenu = (() => {
  const group = document.getElementById('social-media-group');
  const toggle = document.getElementById('menu-social-media');
  const submenu = document.getElementById('social-media-submenu');
  const channels = ['line', 'facebook', 'instagram'];
  function setOpen(open) {
    toggle.setAttribute('aria-expanded', String(open));
    submenu.hidden = !open;
  }
  function sync(pageId) {
    group.hidden = !channels.some(channel => !document.getElementById(`menu-${channel}-intake`).hidden);
    const selected = channels.some(channel => {
      const page = document.getElementById(`page-${channel}-intake`);
      return page && !page.classList.contains('hidden');
    });
    toggle.dataset.active = String(selected);
    if (channels.some(channel => pageId === `${channel}-intake`)) setOpen(true);
  }
  function toggleOpen() {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  }
  function syncBadge() {
    document.getElementById('social-media-unread').hidden = !['line', 'facebook'].some(channel => {
      const badge = document.getElementById(`${channel}-intake-badge`);
      return !document.getElementById(`menu-${channel}-intake`).hidden && !badge.classList.contains('hidden');
    });
  }
  const observer = new MutationObserver(syncBadge);
  for (const channel of ['line', 'facebook']) {
    observer.observe(document.getElementById(`${channel}-intake-badge`), { attributes: true, attributeFilter: ['class'] });
    observer.observe(document.getElementById(`menu-${channel}-intake`), { attributes: true, attributeFilter: ['hidden'] });
  }
  syncBadge();
  return { sync, toggle: toggleOpen };
})();
