'use strict';

const zlib = require('zlib');

/** Decode a PDF literal string body (between parentheses). */
function decodePdfString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[++i];
    if (n === undefined) break;
    if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1] || '')) oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else {
      out += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[n] ?? n;
    }
  }
  return out;
}

/** Extract positioned text items from all (Flate or uncompressed) content streams. */
function extractPdfText(buffer) {
  const src = buffer.toString('latin1');
  const items = [];
  const streamRe = /stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end < 0) break;
    const raw = buffer.subarray(start, end);
    let text;
    try {
      text = zlib.inflateSync(raw).toString('latin1');
    } catch {
      text = raw.toString('latin1');
    }
    let x = 0;
    let y = 0;
    const tokenRe = /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm|([-\d.]+)\s+([-\d.]+)\s+Td|\(((?:\\.|[^\\)])*)\)\s*Tj/gs;
    let t;
    while ((t = tokenRe.exec(text))) {
      if (t[5] !== undefined) {
        x = Number(t[5]);
        y = Number(t[6]);
      } else if (t[7] !== undefined) {
        x += Number(t[7]);
        y += Number(t[8]);
      } else {
        const str = decodePdfString(t[9]);
        if (str.trim()) items.push({ x, y, text: str.trim() });
      }
    }
    streamRe.lastIndex = end + 'endstream'.length;
  }
  return items;
}

function groupRows(items) {
  const rows = [];
  for (const it of items) {
    let row = rows.find((r) => Math.abs(r.y - it.y) < 1.5);
    if (!row) {
      row = { y: it.y, cells: [] };
      rows.push(row);
    }
    row.cells.push(it);
  }
  for (const r of rows) r.cells.sort((a, b) => a.x - b.x);
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => r.cells.map((c) => c.text));
}

function parseEuroNumber(s) {
  const m = /(-?\d+(?:[.,]\d+)?)/.exec(s || '');
  return m ? Number(m[1].replace(',', '.')) : NaN;
}

const FOD_PRODUCTS = {
  e10: /^Benzine 95 RON E10$/i,
  e5_95: /^Benzine 95 RON E5$/i,
  e5_98: /^Benzine 98 RON E5$/i,
  diesel: /^Diesel B7$/i,
  lpg: /^Autogas LPG$/i,
};

/**
 * Parse the FOD Economie "Officiële maximumprijzen" PDF.
 * Returns { validFrom: 'YYYY-MM-DD'|null, listNo, prices: { e10: 2.011, ... } } (EUR/L incl. VAT).
 */
function parseFodMaxPricePdf(buffer) {
  const rows = groupRows(extractPdfText(buffer));
  let validFrom = null;
  let listNo = null;
  const prices = {};
  for (const cells of rows) {
    const joined = cells.join(' ');
    const d = /geldig vanaf\s*:?\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(joined);
    if (d) validFrom = `${d[3]}-${d[2]}-${d[1]}`;
    const l = /Lijst nr:?\s*(\S+)/i.exec(joined);
    if (l) listNo = l[1];
    const label = cells[0];
    if (!cells.some((c) => /aan de pomp/i.test(c))) continue;
    for (const [fuel, re] of Object.entries(FOD_PRODUCTS)) {
      if (re.test(label) && prices[fuel] === undefined) {
        const incl = parseEuroNumber(cells[cells.length - 1]);
        if (Number.isFinite(incl) && incl > 0.3 && incl < 10) prices[fuel] = incl;
      }
    }
  }
  return { validFrom, listNo, prices };
}

module.exports = { parseFodMaxPricePdf, decodePdfString };
