'use strict';

(function () {
  const bubble = document.createElement('div');
  bubble.id = 'info-popover';
  bubble.className = 'info-popover';
  bubble.setAttribute('role', 'tooltip');
  bubble.hidden = true;
  document.body.append(bubble);
  let active;

  function close() {
    if (active) {
      active.setAttribute('aria-expanded', 'false');
      active.removeAttribute('aria-describedby');
    }
    active = null;
    bubble.hidden = true;
  }
  function open(tip) {
    close();
    active = tip;
    tip.setAttribute('role', 'button');
    tip.setAttribute('aria-expanded', 'true');
    tip.setAttribute('aria-describedby', bubble.id);
    bubble.textContent = tip.getAttribute('aria-label') || tip.title;
    bubble.hidden = false;
    const rect = tip.getBoundingClientRect();
    const width = bubble.getBoundingClientRect().width;
    const height = bubble.getBoundingClientRect().height;
    bubble.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
    bubble.style.top = `${Math.max(12, rect.bottom + height + 20 < innerHeight ? rect.bottom + 8 : rect.top - height - 8)}px`;
  }
  function toggle(tip) {
    if (active === tip) close();
    else open(tip);
  }
  document.addEventListener('click', (event) => {
    const tip = event.target.closest('.info-tip');
    if (tip) {
      event.preventDefault();
      toggle(tip);
    } else if (!bubble.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
    const tip = event.target.closest('.info-tip');
    if (tip && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      toggle(tip);
    }
  });
  document.addEventListener('focusout', (event) => {
    if (event.target === active) close();
  });
  document.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  function enhance() {
    for (const tip of document.querySelectorAll('.info-tip')) {
      tip.setAttribute('role', 'button');
      if (!tip.hasAttribute('aria-expanded')) tip.setAttribute('aria-expanded', 'false');
    }
    if (active && !active.isConnected) close();
  }
  enhance();
  new MutationObserver(enhance).observe(document.querySelector('main'), { childList: true, subtree: true });
}());
