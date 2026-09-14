const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(`${__dirname}/public/index.html`, 'utf8');
const tooltipFunctions = html.slice(
  html.indexOf('function hideSidebarMenuTooltip()'),
  html.indexOf('// Toggle Sidebar collapsed state (Desktop)')
);

test('sidebar omits the sales pipeline menu and places reports after quotations', () => {
  const sidebar = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
  const menuIds = [...sidebar.matchAll(/id="(menu-[^"]+)"/g)].map(match => match[1]);
  assert.ok(!menuIds.includes('menu-pipeline'));
  assert.ok(!sidebar.includes("switchPage('pipeline')"));
  assert.ok(!sidebar.includes('Pipeline การขาย'));
  const quotationsIndex = menuIds.indexOf('menu-quotations');
  assert.ok(quotationsIndex >= 0);
  assert.equal(menuIds[quotationsIndex + 1], 'menu-reports');
});

function createFixture() {
  const buttonEvents = {};
  const navigationEvents = {};
  const windowEvents = {};
  const documentEvents = {};
  const attributes = new Map([['aria-describedby', 'existing-help']]);
  const button = {
    querySelector: () => ({ textContent: 'คิวติดตั้ง' }),
    getAttribute: name => attributes.get(name) || null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
    addEventListener: (name, handler) => { buttonEvents[name] = handler; },
    getBoundingClientRect: () => ({ top: 580, height: 40 }),
  };
  const tooltip = { hidden: true, style: {}, offsetWidth: 150, offsetHeight: 32 };
  const sidebar = {
    dataset: {},
    querySelectorAll: () => [button],
    querySelector: () => ({ addEventListener: (name, handler) => { navigationEvents[name] = handler; } }),
    getBoundingClientRect: () => ({ left: 0, right: 80 }),
  };
  const context = vm.createContext({
    document: {
      getElementById: id => ({ sidebar, sidebarMenuTooltip: tooltip })[id],
      addEventListener: (name, handler) => { documentEvents[name] = handler; },
    },
    window: {
      innerWidth: 800,
      innerHeight: 600,
      addEventListener: (name, handler) => { windowEvents[name] = handler; },
    },
  });
  vm.runInContext(`let isSidebarCollapsed = true; let sidebarTooltipButton = null; ${tooltipFunctions}`, context);
  context.initializeSidebarMenuTooltips();
  return { context, button, tooltip, attributes, buttonEvents, navigationEvents, windowEvents, documentEvents };
}

test('collapsed menu tooltip uses the menu name and stays outside the scrolling sidebar', () => {
  const fixture = createFixture();
  fixture.buttonEvents.pointerenter({ pointerType: 'mouse' });
  assert.equal(fixture.tooltip.hidden, false);
  assert.equal(fixture.tooltip.textContent, 'คิวติดตั้ง');
  assert.equal(fixture.attributes.get('aria-label'), 'คิวติดตั้ง');
  assert.equal(fixture.attributes.get('aria-describedby'), 'existing-help sidebarMenuTooltip');
  assert.equal(fixture.tooltip.style.left, '88px');
  assert.equal(fixture.tooltip.style.top, '560px');
  assert.match(html, /<\/aside>\s*<div id="sidebarMenuTooltip" role="tooltip" hidden>/);
  assert.match(html, /#sidebarMenuTooltip\s*\{\s*position: fixed;/);
  fixture.buttonEvents.pointerleave();
  assert.equal(fixture.tooltip.hidden, true);
  assert.equal(fixture.attributes.get('aria-describedby'), 'existing-help');
});

test('keyboard focus shows the hint while expanded menus and touch do not', () => {
  const fixture = createFixture();
  fixture.buttonEvents.pointerenter({ pointerType: 'touch' });
  assert.equal(fixture.tooltip.hidden, true);
  fixture.buttonEvents.focus();
  assert.equal(fixture.tooltip.hidden, false);
  fixture.buttonEvents.blur();
  assert.equal(fixture.tooltip.hidden, true);
  vm.runInContext('isSidebarCollapsed = false', fixture.context);
  fixture.buttonEvents.pointerenter({ pointerType: 'mouse' });
  assert.equal(fixture.tooltip.hidden, true);
});

test('tooltip is dismissed on click, scrolling, viewport changes and Escape', () => {
  const fixture = createFixture();
  const dismissals = [
    fixture.buttonEvents.click,
    fixture.navigationEvents.scroll,
    fixture.windowEvents.resize,
    fixture.windowEvents.blur,
    () => fixture.documentEvents.keydown({ key: 'Escape' }),
  ];
  for (const dismiss of dismissals) {
    fixture.buttonEvents.focus();
    assert.equal(fixture.tooltip.hidden, false);
    dismiss();
    assert.equal(fixture.tooltip.hidden, true);
  }
});
