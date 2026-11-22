// Readers for structured and semi-structured file formats: OFX/QFX, QIF, DOCX, HTML, EML.

import { unzipSync, strFromU8 } from 'fflate';
import { parseDate, cleanDescription } from './parse.js';

// ---------------------------------------------------------------- OFX / QFX

export function parseOfx(text) {
  const items = [];
  const warnings = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, 'i'));
    return m ? m[1].trim() : '';
  };
  for (const b of blocks) {
    const amt = Number(tag(b, 'TRNAMT').replace(/,/g, ''));
    if (Number.isNaN(amt)) continue;
    const name = tag(b, 'NAME'), memo = tag(b, 'MEMO'), payee = tag(b, 'PAYEE');
    const desc = cleanDescription([name || payee, memo && memo !== name ? memo : ''].filter(Boolean).join(' – '));
    items.push({
      date: parseDate(tag(b, 'DTPOSTED')) || parseDate(tag(b, 'DTUSER')), description: desc || '(no description)', amount: Math.round(amt * 100),
      balance: null, flags: [], raw: `${tag(b, 'TRNTYPE')} ${name} ${memo}`.trim(), confidence: 0.98, kind: 'row', externalId: tag(b, 'FITID') || null,
    });
  }
  const cur = text.match(/<CURDEF>\s*([A-Z]{3})/i)?.[1];
  if (cur && cur !== 'GBP') warnings.push(`This file is in ${cur}, not GBP. Amounts have not been converted.`);
  if (!items.length) warnings.push('No transactions were found in this OFX file.');
  return { items, warnings, meta: { currency: cur || null } };
}

// ---------------------------------------------------------------- QIF

export function parseQif(text) {
  const items = [];
  let cur = {};
  const flush = () => {
    if (cur.amount != null) {
      items.push({
        date: cur.date || null, description: cleanDescription([cur.payee, cur.memo].filter(Boolean).join(' – ')) || '(no description)', amount: cur.amount,
        balance: null, flags: cur.date ? [] : ['no_date'], raw: JSON.stringify(cur).slice(0, 200), confidence: 0.95, kind: 'row',
      });
    }
    cur = {};
  };
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (!line) continue;
    const code = line[0], v = line.slice(1).trim();
    if (code === '!') continue;
    if (code === '^') { flush(); continue; }
    if (code === 'D') cur.date = parseDate(v.replace(/'\s*(\d{2})$/, '/20$1').replace(/\s+/g, '')) || parseDate(v);
    else if (code === 'T' || code === 'U') cur.amount = Math.round(Number(v.replace(/,/g, '')) * 100);
    else if (code === 'P') cur.payee = v;
    else if (code === 'M') cur.memo = v;
  }
  flush();
  return { items, warnings: items.length ? [] : ['No transactions were found in this QIF file.'], meta: {} };
}

// ---------------------------------------------------------------- HTML / DOCX / EML to text

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", pound: '£', euro: '€', ndash: '–', mdash: '—', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', copy: '©', times: '×' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>|<br\s*\/?>/gi, '\n')
      .replace(/<\/(td|th)>/gi, '  ')
      .replace(/<[^>]+>/g, ''),
  ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

export function docxToText(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const xmlOf = (name) => (files[name] ? strFromU8(files[name]) : '');
  const toText = (xml) => decodeEntities(
    xml
      .replace(/<w:tab\s*\/>/g, '  ')
      .replace(/<w:br\s*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tc>/g, '  ')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
  const headers = Object.keys(files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)).sort().map((n) => toText(xmlOf(n)));
  const body = toText(xmlOf('word/document.xml'));
  if (!body.trim() && !files['word/document.xml']) throw new Error('This does not look like a Word (.docx) document.');
  // Headers/footers often carry the company name and VAT number, so they go first.
  return [...headers.filter((h) => h.trim()), body].join('\n').replace(/\n{3,}/g, '\n\n');
}

function decodeBody(body, encoding) {
  const enc = (encoding || '').toLowerCase();
  if (enc.includes('base64')) return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc.includes('quoted-printable')) {
    const bytes = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8');
  }
  return body;
}

function splitHeaders(part) {
  const idx = part.search(/\r?\n\r?\n/);
  const head = idx >= 0 ? part.slice(0, idx) : part;
  const body = idx >= 0 ? part.slice(idx).replace(/^\r?\n\r?\n/, '') : '';
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return { headers, body };
}

export function emlToText(raw) {
  const { headers, body } = splitHeaders(raw);
  const pick = (hd, bd) => {
    const ct = hd['content-type'] || 'text/plain';
    const boundary = ct.match(/boundary="?([^";]+)"?/i)?.[1];
    if (/multipart\//i.test(ct) && boundary) {
      const parts = bd.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith('--')).map(splitHeaders);
      const plain = parts.map((p) => pick(p.headers, p.body)).find((x) => x && x.type === 'plain');
      const html = parts.map((p) => pick(p.headers, p.body)).find((x) => x && x.type === 'html');
      return plain || html || null;
    }
    const text = decodeBody(bd, hd['content-transfer-encoding']);
    if (/text\/html/i.test(ct)) return { type: 'html', text: htmlToText(text) };
    if (/text\/plain/i.test(ct) || !/^(image|application|audio|video)\//i.test(ct)) return { type: 'plain', text };
    return null;
  };
  const picked = pick(headers, body);
  const head = [headers.from && `From: ${headers.from}`, headers.subject && `Subject: ${headers.subject}`, headers.date && `Date: ${headers.date}`].filter(Boolean).join('\n');
  return `${head}\n\n${picked?.text || ''}`;
}
