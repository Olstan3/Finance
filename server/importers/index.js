// Import dispatcher: look at a file (name + magic bytes), pick the right reader, and return
// normalised candidate transactions. Pure – no database access.

import path from 'node:path';
import { parseCsv, tableToItems } from './table.js';
import { extractFromLines, linesFromText } from './extract.js';
import { parseOfx, parseQif, docxToText, htmlToText, emlToText } from './formats.js';
import { pdfToLines } from './pdf.js';
import { ocrImage, OcrUnavailable } from './ocr.js';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

export function sniffKind(filename, buf) {
  const ext = path.extname(filename || '').toLowerCase();
  const head = Buffer.from(buf.subarray(0, 16));
  const ascii = head.toString('latin1');
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'image';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image';
  if (ascii.startsWith('GIF8') || ascii.startsWith('BM') || (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP')) return 'image';
  if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) || (head[0] === 0x4d && head[1] === 0x4d && head[3] === 0x2a)) return 'image';
  if (ascii.startsWith('PK')) return ext === '.docx' || ext === '.dotx' ? 'docx' : ext === '.xlsx' || ext === '.xlsm' ? 'xlsx' : ext === '.xls' ? 'xls' : 'zip';
  if (['.xls'].includes(ext)) return 'xls';
  if (['.ofx', '.qfx'].includes(ext)) return 'ofx';
  if (ext === '.qif') return 'qif';
  if (['.htm', '.html'].includes(ext)) return 'html';
  if (ext === '.eml') return 'eml';
  const sample = decodeText(buf.subarray(0, 4096));
  if (/OFXHEADER|<OFX>/i.test(sample)) return 'ofx';
  if (/^!Type:/m.test(sample)) return 'qif';
  if (/^From:.*\n[\s\S]*^(Subject|Date|Content-Type):/im.test(sample) && ext !== '.csv') return 'eml';
  if (['.csv', '.tsv'].includes(ext)) return 'csv';
  if (/<html|<table|<!doctype html/i.test(sample)) return 'html';
  return ext === '.txt' || ext === '' || ext === '.log' || ext === '.text' ? 'text' : 'text';
}

/** Does text look like a delimited table rather than prose? */
function looksTabular(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  if (lines.length < 2) return false;
  return ['\t', ',', ';', '|'].some((d) => lines.filter((l) => l.split(d).length >= 3).length >= Math.max(2, lines.length * 0.7));
}

function fromText(text, ctx, kind) {
  const r = extractFromLines(linesFromText(text), ctx);
  return { kind, mode: r.mode, items: r.items, warnings: r.warnings, text };
}

/**
 * @param file { filename, buffer }
 * @param ctx  { profile }  (used to decide whether an invoice is yours or a supplier's)
 */
export async function parseUpload({ filename, buffer }, ctx = {}) {
  if (!buffer?.length) return { kind: 'empty', mode: 'empty', items: [], warnings: ['The file is empty.'] };
  const kind = sniffKind(filename, buffer);
  switch (kind) {
    case 'csv': {
      const text = decodeText(buffer);
      const rows = parseCsv(text);
      const t = tableToItems(rows, ctx);
      if (t.items.length) return { kind, mode: 'table', ...t, text: text.slice(0, 20000) };
      const alt = fromText(text, ctx, kind);
      return alt.items.length ? { ...alt, warnings: [...t.warnings, ...alt.warnings] } : { kind, mode: 'table', ...t };
    }
    case 'xlsx': {
      let sheets;
      try { sheets = await readExcel(buffer); } catch (e) { return { kind, mode: 'error', items: [], warnings: [`Could not read this spreadsheet: ${e.message}`] }; }
      let best = null;
      for (const s of sheets) {
        const r = tableToItems(s.data, ctx);
        if (!best || r.items.length > best.items.length) best = { ...r, sheet: s.sheet };
      }
      return { kind, mode: 'table', ...(best || { items: [], warnings: ['No sheets found.'] }) };
    }
    case 'xls':
      return { kind, mode: 'error', items: [], warnings: ['Old .xls files are not supported. Save the sheet as .xlsx or .csv and import that.'] };
    case 'ofx': { const r = parseOfx(decodeText(buffer)); return { kind, mode: 'ofx', ...r }; }
    case 'qif': { const r = parseQif(decodeText(buffer)); return { kind, mode: 'qif', ...r }; }
    case 'pdf': {
      let res;
      try { res = await pdfToLines(buffer); } catch (e) { return { kind, mode: 'error', items: [], warnings: [`Could not read this PDF (${e.message}). If it is password protected, remove the password first.`] }; }
      if (res.scanned) return { kind, mode: 'scanned', items: [], warnings: ['This PDF has no text layer (it looks like a scan). Upload it as a JPG/PNG photo instead so it can be read with OCR, or paste the text.'] };
      const r = extractFromLines(res.lines, ctx);
      return { kind, mode: r.mode, items: r.items, warnings: r.warnings, text: res.lines.map((l) => l.text).join('\n').slice(0, 20000), meta: { pages: res.pages } };
    }
    case 'docx': {
      let text;
      try { text = docxToText(buffer); } catch (e) { return { kind, mode: 'error', items: [], warnings: [e.message] }; }
      return fromText(text, ctx, kind);
    }
    case 'html': return fromText(htmlToText(decodeText(buffer)), ctx, kind);
    case 'eml': return fromText(emlToText(decodeText(buffer)), ctx, kind);
    case 'image': {
      let ocr;
      try { ocr = await ocrImage(buffer); }
      catch (e) {
        return { kind, mode: 'error', items: [], warnings: [e instanceof OcrUnavailable ? e.message : `OCR failed: ${e.message}`] };
      }
      const r = fromText(ocr.text, ctx, kind);
      r.warnings.unshift(`Text was read from the image by OCR (confidence ${Math.round(ocr.confidence ?? 0)}%). Check the amounts carefully.`);
      for (const it of r.items) { it.confidence = Math.min(it.confidence, 0.75); it.flags.push('ocr'); }
      return r;
    }
    case 'zip': return { kind, mode: 'error', items: [], warnings: ['Zip archives are not supported – unzip and upload the files inside.'] };
    default: {
      const text = decodeText(buffer);
      if (looksTabular(text)) {
        const t = tableToItems(parseCsv(text), ctx);
        if (t.items.length) return { kind: 'csv', mode: 'table', ...t, text: text.slice(0, 20000) };
      }
      return fromText(text, ctx, 'text');
    }
  }
}

async function readExcel(buffer) {
  const mod = await import('read-excel-file/node');
  const out = await mod.default(buffer);
  if (Array.isArray(out)) return out; // v8+: [{ sheet, data }]
  return [{ sheet: 'Sheet1', data: out }];
}
