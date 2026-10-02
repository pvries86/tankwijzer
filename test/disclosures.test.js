const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transition, init } = require('../public/disclosures');

function node(details = false) {
  const animations = [];
  return {
    hidden: true, open: false, style: {}, animations,
    querySelector: () => ({ getBoundingClientRect: () => ({ height: 24 }) }),
    getBoundingClientRect() { return { height: details ? (this.open ? 200 : 24) : (this.hidden ? 0 : 200) }; },
    animate(frames, options) {
      const animation = { frames, options, cancel() { this.cancelled = true; } };
      animations.push(animation);
      return animation;
    },
  };
}
test('vehicle fields animate both ways and closed fields become inert', () => {
  global.matchMedia = () => ({ matches: false });
  const fields = node();
  transition(fields, true);
  assert.equal(fields.hidden, false);
  assert.equal(fields.inert, false);
  assert.deepEqual(fields.animations[0].frames, [{ height: '0px' }, { height: '200px' }]);
  fields.animations[0].onfinish();
  transition(fields, false);
  assert.equal(fields.hidden, false, 'still visible while collapsing');
  assert.equal(fields.inert, true);
  fields.animations[1].onfinish();
  assert.equal(fields.hidden, true);
  assert.equal(fields.style.overflow, '');
});
test('rapid reversal cancels old animation without letting it change the final state', () => {
  global.matchMedia = () => ({ matches: false });
  const details = node(true);
  transition(details, true, true);
  transition(details, false, true);
  assert.equal(details.animations[0].cancelled, true);
  assert.equal(details.animations[0].onfinish, null);
  details.animations[1].onfinish();
  assert.equal(details.open, false);
});
test('reduced motion and unsupported animation switch immediately', () => {
  global.matchMedia = () => ({ matches: true });
  const fields = node();
  transition(fields, true);
  assert.equal(fields.hidden, false);
  assert.equal(fields.animations.length, 0);
  transition(fields, false);
  assert.equal(fields.hidden, true);
  global.matchMedia = () => ({ matches: false });
  delete fields.animate;
  transition(fields, true);
  assert.equal(fields.hidden, false);
  assert.equal(fields.inert, false);
});
test('delegated summary click toggles details while leaving embedded controls alone', () => {
  global.matchMedia = () => ({ matches: true });
  let listener;
  init({ addEventListener(type, callback) { assert.equal(type, 'click'); listener = callback; } });
  const details = node(true);
  details.tagName = 'DETAILS';
  const summary = { parentElement: details };
  let prevented = false;
  listener({ target: { closest: (selector) => selector === 'summary' ? summary : null }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(details.open, true);
});
