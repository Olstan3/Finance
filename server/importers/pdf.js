// PDF text extraction that keeps layout: text runs are grouped into lines by their vertical
// position and into "cells" by horizontal gaps, so statement columns survive extraction.

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function pdfToLines(buffer) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false, verbosity: 0, disableFontFace: true,
  });
  const doc = await task.promise;
  const lines = [];
  let chars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((i) => typeof i.str === 'string' && i.str.trim() !== '')
      .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.height) || Math.abs(i.transform[3]) || 10 }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);

    // group into lines by y
    const rows = [];
    for (const it of items) {
      const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2, it.h * 0.45));
      if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      const cells = [];
      let cur = null;
      for (const it of row.items) {
        const gap = cur ? it.x - cur.x1 : 0;
        const charW = it.w / Math.max(1, it.str.length) || it.h * 0.5;
        if (cur && gap <= Math.max(charW * 1.6, it.h * 0.8)) {
          cur.text += (gap > charW * 0.25 && !cur.text.endsWith(' ') ? ' ' : '') + it.str;
          cur.x1 = it.x + it.w;
        } else {
          if (cur) cells.push(cur);
          cur = { text: it.str, x0: it.x, x1: it.x + it.w };
        }
      }
      if (cur) cells.push(cur);
      let raw = '';
      for (const c of cells) {
        if (raw) raw += '  ';
        c.start = raw.length;
        raw += c.text.trim();
        c.end = raw.length;
        c.text = c.text.trim();
      }
      chars += raw.length;
      lines.push({ text: raw, raw, cells, positional: true, page: p, y: row.y });
    }
  }
  await doc.destroy();
  return { lines, scanned: chars < 20, pages: doc.numPages };
}
