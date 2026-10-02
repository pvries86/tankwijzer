'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Disclosures = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const running = new WeakMap();
  const desired = new WeakMap();
  function transition(node, open, details = false) {
    const previous = running.get(node);
    if (!previous && (details ? node.open : !node.hidden) === open) return;
    const from = node.getBoundingClientRect().height;
    if (previous) {
      previous.onfinish = null;
      previous.cancel();
      running.delete(node);
    }
    desired.set(node, open);
    const finish = () => {
      if (details) node.open = open;
      else {
        node.hidden = !open;
        node.inert = !open;
      }
      node.style.overflow = '';
      running.delete(node);
    };
    if (!node.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }
    if (details) node.open = true;
    else {
      node.hidden = false;
      node.inert = !open;
    }
    const to = open ? node.getBoundingClientRect().height
      : details ? node.querySelector('summary').getBoundingClientRect().height : 0;
    node.style.overflow = 'hidden';
    const animation = node.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: open ? 240 : 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
    running.set(node, animation);
    animation.onfinish = finish;
  }
  function init(doc) {
    doc.addEventListener('click', (event) => {
      const summary = event.target.closest('summary');
      if (!summary || event.target.closest('a, button, .info-tip')) return;
      const details = summary.parentElement;
      if (details.tagName !== 'DETAILS') return;
      event.preventDefault();
      transition(details, !(running.has(details) ? desired.get(details) : details.open), true);
    });
  }
  return { transition, init };
}));
