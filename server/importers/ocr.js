// OCR for photographed or scanned receipts. Uses tesseract.js with the bundled English language
// data so it works fully offline. Both packages are optional dependencies; if they are not
// installed the importer says so instead of failing.

import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
let workerPromise = null;

export class OcrUnavailable extends Error {}

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    let createWorker;
    try { ({ createWorker } = await import('tesseract.js')); }
    catch { throw new OcrUnavailable('Image import needs the optional "tesseract.js" package (npm install tesseract.js @tesseract.js-data/eng).'); }
    let langPath;
    try { langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int'); } catch { /* falls back to the CDN */ }
    return createWorker('eng', 1, { ...(langPath ? { langPath, gzip: true } : {}), cachePath: path.join(os.tmpdir(), 'ledgerline-ocr'), logger: () => {} });
  })();
  workerPromise.catch(() => { workerPromise = null; });
  return workerPromise;
}

export async function ocrImage(buffer) {
  const worker = await getWorker();
  const { data } = await worker.recognize(buffer);
  return { text: data.text || '', confidence: data.confidence ?? null };
}

export async function shutdownOcr() {
  if (!workerPromise) return;
  try { const w = await workerPromise; await w.terminate(); } catch { /* ignore */ }
  workerPromise = null;
}
