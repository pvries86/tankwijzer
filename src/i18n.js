'use strict';

// Minimal server-side i18n: user-facing texts are written inline as t(english, dutch).
// English stays the API default; the web UI sends its chosen language (Dutch by default).
const LANGS = ['nl', 'en'];

function normLang(v) {
  return String(v || '').toLowerCase().startsWith('nl') ? 'nl' : 'en';
}

function tr(lang) {
  const nl = normLang(lang) === 'nl';
  return (en, nlText) => (nl ? nlText : en);
}

/** Fixed-decimal number in the language's style (Dutch uses a decimal comma). */
function fmtNum(v, digits, lang) {
  const s = Number(v).toFixed(digits);
  return normLang(lang) === 'nl' ? s.replace('.', ',') : s;
}

module.exports = { LANGS, normLang, tr, fmtNum };
