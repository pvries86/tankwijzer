const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

test('touch opens the explanation once; synthetic click does not close it', () => {
  const listeners = {};
  const attributes = { 'aria-label': 'Uitleg over verbruik' };
  const tip = {
    isConnected: true,
    getAttribute: (key) => attributes[key],
    setAttribute: (key, value) => { attributes[key] = value; },
    hasAttribute: (key) => key in attributes,
    removeAttribute: (key) => { delete attributes[key]; },
    closest: () => tip,
    getBoundingClientRect: () => ({ left: 300, top: 100, bottom: 120 }),
  };
  const bubble = {
    style: {}, setAttribute() {}, contains: () => false,
    getBoundingClientRect: () => ({ width: 250, height: 60 }),
  };
  const document = {
    createElement: () => bubble,
    body: { append() {} },
    querySelectorAll: () => [tip],
    querySelector: () => ({}),
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
  };
  const context = {
    document, innerWidth: 390, innerHeight: 844, Date,
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} },
  };
  runInNewContext(readFileSync(join(__dirname, '../public/info-tips.js'), 'utf8'), context);
  const fire = (type, extra = {}) => {
    const event = { target: tip, preventDefault() {}, ...extra };
    listeners[type].forEach((fn) => fn(event));
  };
  fire('pointerup', { pointerType: 'touch' });
  assert.equal(bubble.hidden, false);
  assert.equal(bubble.textContent, attributes['aria-label']);
  assert.equal(attributes['aria-expanded'], 'true');
  assert.equal(bubble.style.left, '128px', 'kept within mobile viewport');
  fire('click');
  assert.equal(bubble.hidden, false, 'compatibility click is ignored');
  fire('pointerup', { pointerType: 'touch' });
  assert.equal(bubble.hidden, true, 'second tap closes');
  fire('keydown', { key: 'Enter' });
  assert.equal(bubble.hidden, false);
  fire('keydown', { key: 'Escape' });
  assert.equal(bubble.hidden, true);
});
