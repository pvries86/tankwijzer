const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const html = readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const js = readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

test('app sources and README contain no em dash punctuation', () => {
  const root = path.join(__dirname, '..');
  function check(file) {
    assert.ok(!readFileSync(file, 'utf8').includes(String.fromCharCode(0x2014)), file);
  }
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(js|html|css|svg|json)$/.test(entry.name)) check(file);
    }
  }
  walk(path.join(root, 'public'));
  walk(path.join(root, 'src'));
  check(path.join(root, 'README.md'));
});

test('every static info tip is keyboard focusable and labelled (NL + EN)', () => {
  const tips = html.match(/<span[^>]*class="info-tip"[^>]*>/g) || [];
  assert.ok(tips.length >= 8);
  for (const tag of tips) {
    assert.match(tag, /tabindex="0"/, tag);
    assert.match(tag, /aria-label="[^"]+"/, tag);
    if (!tag.includes('id="priority-tip"')) assert.match(tag, /data-en-aria-label="[^"]+"/, tag);
    assert.doesNotMatch(tag, /aria-label="[^"]*</, tag);
  }
});

test('no info tip is nested inside an element whose content is swapped by data-en', () => {
  assert.doesNotMatch(html, /data-en="[^"]*"[^>]*>[^<]*<span class="info-tip"/);
});

test('no "[object" leaks in UI sources', () => {
  assert.ok(!html.includes('[object'));
  assert.ok(!js.includes('[object'));
});

test('recommendation filters null children (DOM replaceChildren would print "null")', () => {
  const m = js.match(/function renderRecommendation[\s\S]*?\n  \}\n/);
  assert.ok(m);
  assert.match(m[0], /replaceChildren\(\.\.\.\[[\s\S]*\]\.filter\(Boolean\)\)/);
});

test('high confidence is not labelled; medium/low have a reason', () => {
  const m = js.match(/const CONFIDENCE_LABEL = \(\) => \(\{([\s\S]*?)\n  \}\);/);
  assert.ok(m, 'CONFIDENCE_LABEL found');
  assert.doesNotMatch(m[1], /\bhigh\s*:/);
  assert.match(m[1], /medium\s*:/);
  assert.match(m[1], /low\s*:/);
  assert.equal((m[1].match(/reason\s*:/g) || []).length, 2);
});

test('map scrolling and back-to-top are accessible and wired', () => {
  assert.match(html, /id="back-to-top"[^>]*type="button"[^>]*hidden[^>]*aria-label="Terug naar boven"[^>]*data-en-aria-label="Back to top"/);
  assert.match(html, /src="scroll-controls.js"/);
  assert.match(js, /scrollWheelZoom: false/);
  assert.match(js, /ScrollControls\.backToTop/);
  assert.match(js, /ScrollControls\.mapGestures/);
  const css = readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
  assert.match(css, /#map\.leaflet-container\s*\{\s*touch-action: auto/);
});

test('info tips use a touch and keyboard operable popover with plain-text explanations', () => {
  assert.match(html, /src="info-tips.js"/);
  const tips = readFileSync(path.join(__dirname, '../public/info-tips.js'), 'utf8');
  assert.match(tips, /addEventListener\('click'/);
  assert.match(tips, /event\.key === 'Enter'/);
  assert.match(tips, /event\.key === ' '/);
  assert.match(tips, /event\.key === 'Escape'/);
  assert.match(tips, /bubble\.textContent = /);
  assert.match(tips, /aria-expanded/);
});

test('balanced driving preference is the default while remembered choices are preserved', () => {
  assert.match(html, /<option value="balanced" selected/);
  const priority = html.match(/<select id="priority">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...priority.matchAll(/value="([^"]+)"/g)].map((m) => m[1]), ['balanced', 'hassle', 'cheapest', 'custom']);
  assert.match(js, /setPriority\(prefs\.priority \|\| 'balanced', prefs\)/);
  assert.match(js, /if \(!presets\[name\]\) name = 'balanced'/);
  assert.match(js, /if \(!prefs\.balancedDefaultApplied\)/);
  assert.match(js, /prefs\.priority === 'cheapest'/);
  assert.match(js, /balancedDefaultApplied: true/);
});
