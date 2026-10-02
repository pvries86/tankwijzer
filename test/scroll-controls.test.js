const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapGestures, backToTop } = require('../public/scroll-controls');

function target(extra = {}) {
  const listeners = {};
  return {
    ...extra,
    addEventListener(type, fn) { listeners[type] = fn; },
    fire(type, event = {}) {
      event.preventDefault = () => { event.defaultPrevented = true; };
      listeners[type](event);
      return event;
    },
  };
}
function handler() {
  return { active: true, enable() { this.active = true; }, disable() { this.active = false; } };
}

test('map wheel zoom requires modifier, click or focus and releases on leaving', () => {
  const map = { scrollWheelZoom: handler(), dragging: handler() };
  const container = target({ contains: (node) => node === 'child' });
  const hint = {};
  mapGestures(map, container, hint, (en, nl) => nl, false);
  assert.equal(map.scrollWheelZoom.active, false);
  assert.ok(!container.fire('wheel', {}).defaultPrevented);
  assert.equal(map.scrollWheelZoom.active, false);
  assert.match(hint.textContent, /Ctrl/);
  for (const modifier of ['ctrlKey', 'metaKey']) {
    assert.equal(container.fire('wheel', { [modifier]: true }).defaultPrevented, true);
    assert.equal(map.scrollWheelZoom.active, true);
    container.fire('wheel', {});
    assert.equal(map.scrollWheelZoom.active, false);
  }
  container.fire('click');
  container.fire('wheel');
  assert.equal(map.scrollWheelZoom.active, true);
  container.fire('mouseleave');
  assert.equal(map.scrollWheelZoom.active, false);
  container.fire('focusin');
  container.fire('focusout', { relatedTarget: 'child' });
  assert.equal(map.scrollWheelZoom.active, true);
  container.fire('focusout', { relatedTarget: null });
  assert.equal(map.scrollWheelZoom.active, false);
});

test('Mac hint and one-finger touch pass through without preventing page scroll', () => {
  const map = { scrollWheelZoom: handler(), dragging: handler() };
  const container = target();
  const hint = {};
  mapGestures(map, container, hint, (en) => en, true);
  container.fire('wheel');
  assert.match(hint.textContent, /⌘/);
  container.fire('pointerdown', { pointerType: 'touch' });
  assert.equal(map.dragging.active, false);
  container.fire('touchstart', { touches: [{}] });
  assert.match(hint.textContent, /two fingers/);
  container.fire('touchstart', { touches: [{}, {}] });
  assert.equal(hint.hidden, true);
  container.fire('pointerdown', { pointerType: 'mouse' });
  assert.equal(map.dragging.active, true);
});

test('back-to-top handles page/panel scrolling, footer clearance and reduced motion', () => {
  for (const reduced of [false, true]) {
    const calls = [];
    const button = target({ style: {}, getBoundingClientRect: () => ({ left: 340, right: 384, top: 720, bottom: 764 }) });
    const panel = target({ scrollTop: 0, scrollTo: (options) => calls.push(options) });
    const footer = target({ getBoundingClientRect: () => ({ top: 780 }) });
    const win = target({
      innerHeight: 800, scrollY: 0,
      requestAnimationFrame: (fn) => { fn(); return null; },
      matchMedia: () => ({ matches: reduced }),
      scrollTo: (options) => calls.push(options),
    });
    let focused = false;
    let controls = [];
    const doc = {
      querySelectorAll: () => controls,
      querySelector: () => ({ setAttribute() {}, focus() { focused = true; } }),
    };
    backToTop(button, [panel], footer, win, doc);
    assert.equal(button.hidden, true);
    panel.scrollTop = 300;
    panel.fire('scroll');
    assert.equal(button.hidden, false);
    assert.equal(button.style.bottom, '32px');
    controls = [{
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ left: 330, right: 390, top: 710, bottom: 750 }),
    }];
    win.fire('resize');
    assert.equal(button.style.bottom, '32px', 'does not jump above other controls');
    assert.equal(button.style.visibility, 'hidden', 'avoids covering other controls');
    controls = [];
    win.fire('resize');
    assert.equal(button.style.visibility, '', 'reappears when overlap ends');
    assert.equal(button.style.bottom, '32px');
    button.fire('click');
    assert.deepEqual(calls, Array(2).fill({ top: 0, behavior: reduced ? 'instant' : 'smooth' }));
    assert.equal(focused, true);
    panel.scrollTop = 0;
    panel.fire('scroll');
    assert.equal(button.hidden, true);
    win.scrollY = 400;
    win.fire('scroll');
    assert.equal(button.hidden, false);
  }
});
