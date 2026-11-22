// Tiny fetch wrapper. Throws ApiError with the server's friendly message and field name.

export class ApiError extends Error {
  constructor(message, status, field) { super(message); this.status = status; this.field = field; }
}
const listeners = new Set();
export const onLocked = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

async function request(method, url, body, opts = {}) {
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) { init.body = body; init.headers['Content-Type'] = 'application/octet-stream'; }
    else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  }
  let res;
  try { res = await fetch(url, init); }
  catch { throw new ApiError('Cannot reach the Ledgerline server. Is it still running?', 0); }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && data?.locked) listeners.forEach((f) => f());
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status, data?.field);
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
  upload: (url, file) => request('POST', url, file),
};

export const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, v === true ? '1' : v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
