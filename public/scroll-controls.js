'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScrollControls = api;
}(typeof self !== 'undefined' ? self : this, () => {
  function mapGestures(map, container, hint, translate, isMac) {
    let engaged = false;
    let timer;
    function showHint(touch) {
      hint.textContent = touch
        ? translate('Use two fingers to move the map', 'Gebruik twee vingers om de kaart te verplaatsen')
        : translate(`Use ${isMac ? '⌘' : 'Ctrl'} + scroll to zoom`, `Gebruik ${isMac ? '⌘' : 'Ctrl'} + scrollen om te zoomen`);
      hint.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => { hint.hidden = true; }, 1800);
    }
    const release = () => {
      engaged = false;
      map.scrollWheelZoom.disable();
      map.dragging.disable();
    };
    map.scrollWheelZoom.disable();
    map.dragging.disable();
    container.addEventListener('wheel', (event) => {
      if (engaged || event.ctrlKey || event.metaKey) {
        event.preventDefault();
        map.scrollWheelZoom.enable();
        hint.hidden = true;
      } else {
        map.scrollWheelZoom.disable();
        showHint(false);
      }
    }, { capture: true, passive: false });
    container.addEventListener('click', () => {
      engaged = true;
      map.scrollWheelZoom.enable();
      hint.hidden = true;
    });
    container.addEventListener('focusin', () => {
      engaged = true;
      map.scrollWheelZoom.enable();
    });
    container.addEventListener('mouseleave', release);
    container.addEventListener('focusout', (event) => {
      if (!container.contains(event.relatedTarget)) release();
    });
    // Leave one-finger gestures to the browser; Leaflet TouchZoom handles
    // both translation and zoom for two fingers without enabling dragging.
    container.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') map.dragging.enable();
      else map.dragging.disable();
    }, { capture: true, passive: true });
    container.addEventListener('mousedown', (event) => {
      if (!event.sourceCapabilities?.firesTouchEvents && !('ontouchstart' in container)) map.dragging.enable();
    }, { capture: true, passive: true });
    container.addEventListener('touchstart', (event) => {
      map.dragging.disable();
      if (event.touches.length === 1) showHint(true);
      else hint.hidden = true;
    }, { capture: true, passive: true });
  }

  function backToTop(button, panels, footer, win, doc) {
    function update() {
      button.hidden = Math.max(win.scrollY, ...panels.map((panel) => panel.scrollTop)) < 250;
      if (button.hidden) return;
      const bottom = Math.max(12, win.innerHeight - footer.getBoundingClientRect().top + 12);
      button.style.bottom = `${bottom}px`;
      button.style.visibility = '';
      // Hide during overlap instead of chasing controls as they scroll past.
      const controls = [...doc.querySelectorAll('a, button, summary, input, select')]
        .filter((control) => control !== button && control.getClientRects().length)
        .map((control) => control.getBoundingClientRect())
        .sort((a, b) => b.top - a.top);
      for (const rect of controls) {
        const own = button.getBoundingClientRect();
        if (rect.right > own.left - 8 && rect.left < own.right + 8 &&
            rect.bottom > own.top - 8 && rect.top < own.bottom + 8) {
          button.style.visibility = 'hidden';
          break;
        }
      }
    }
    let frame;
    function schedule() {
      if (frame) return;
      frame = win.requestAnimationFrame(() => { frame = null; update(); });
    }
    win.addEventListener('scroll', schedule, { passive: true });
    win.addEventListener('resize', schedule);
    panels.forEach((panel) => panel.addEventListener('scroll', schedule, { passive: true }));
    footer.addEventListener('toggle', schedule, true);
    button.addEventListener('click', () => {
      const behavior = win.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
      panels.forEach((panel) => panel.scrollTo({ top: 0, behavior }));
      win.scrollTo({ top: 0, behavior });
      const heading = doc.querySelector('h1');
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    });
    update();
  }
  return { mapGestures, backToTop };
}));
