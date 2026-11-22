import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { html } from './ui.js';
import { gbp, compactGBP } from '../util.js';

// Grouped column chart for two or more series over categories (e.g. money in vs money out by tax month).
// Spec: columns <= 24px, 4px rounded data end / square baseline, 2px surface gap between adjacent columns,
// hairline solid grid, legend always present for >= 2 series, hover + keyboard tooltip listing every series
// (values lead, names follow, line keys not boxes), selective direct label on the single largest column,
// and a table-view twin so no value is gated behind hover.

const MAX_BAR = 24, GAP = 2, R = 4;

function niceTicks(max) {
  if (max <= 0) return { top: 100, ticks: [0, 50, 100] };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v));
  return { top, ticks };
}

function colPath(x, y, w, h) {
  // rounded data end (top), square baseline
  const r = Math.min(R, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

export function GroupedColumns({ data, series, height = 260, ariaLabel, loading, unit = 'p' }) {
  const wrap = useRef();
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState(null);
  const [tableView, setTableView] = useState(false);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const M = { t: 14, r: 8, b: 26, l: 52 };
  const plotW = width - M.l - M.r, plotH = height - M.t - M.b;
  const maxVal = Math.max(0, ...data.flatMap((d) => series.map((s) => d.values[s.key] || 0)));
  const { top, ticks } = useMemo(() => niceTicks(maxVal), [maxVal]);
  const y = (v) => M.t + plotH - (Math.max(0, v) / top) * plotH;
  const band = plotW / Math.max(1, data.length);
  const barW = Math.max(3, Math.min(MAX_BAR, (band * 0.72 - GAP * (series.length - 1)) / series.length));
  const groupW = barW * series.length + GAP * (series.length - 1);
  const every = band < 34 ? 2 : 1;

  // the single largest column gets a direct label; everything else is carried by axis + tooltip + table
  let peak = null;
  data.forEach((d, i) => series.forEach((s, j) => { const v = d.values[s.key] || 0; if (!peak || v > peak.v) peak = { v, i, j }; }));

  const tipFor = active != null ? data[active] : null;
  const tipX = active != null ? M.l + band * active + band / 2 : 0;
  const tipTop = tipFor ? Math.min(...series.map((s) => y(tipFor.values[s.key] || 0))) : 0;
  const fmtV = (p) => gbp(p, { dp: 0 });
  const total = data.reduce((a, d) => a + series.reduce((b, s) => b + (d.values[s.key] || 0), 0), 0);

  return html`<div>
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div class="legend" role="list">${series.map((s) => html`<span role="listitem"><i style=${`background:var(${s.color})`}></i>${s.name}</span>`)}</div>
      <button class="btn ghost small" aria-pressed=${tableView} onClick=${() => setTableView((v) => !v)}>${tableView ? 'View chart' : 'View as table'}</button>
    </div>
    ${tableView ? html`<div class="table-wrap"><table><caption class="sr-only">${ariaLabel}</caption>
        <thead><tr><th>Period</th>${series.map((s) => html`<th class="num">${s.name}</th>`)}${series.length === 2 && html`<th class="num">Difference</th>`}</tr></thead>
        <tbody>${data.map((d) => html`<tr><td>${d.label}</td>${series.map((s) => html`<td class="num">${gbp(d.values[s.key] || 0)}</td>`)}${series.length === 2 && html`<td class="num">${gbp((d.values[series[0].key] || 0) - (d.values[series[1].key] || 0))}</td>`}</tr>`)}</tbody></table></div>`
      : html`<div class=${`chart${loading ? ' is-loading' : ''}`} ref=${wrap} style=${`height:${height}px`} onPointerLeave=${() => setActive(null)}>
      <svg width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`} role="img" aria-label=${ariaLabel}>
        ${ticks.map((t) => html`<g key=${t}><line class="gridline" x1=${M.l} x2=${width - M.r} y1=${y(t)} y2=${y(t)} /><text class="tick" x=${M.l - 8} y=${y(t) + 4} text-anchor="end">${compactGBP(t)}</text></g>`)}
        <line class="baseline" x1=${M.l} x2=${width - M.r} y1=${y(0)} y2=${y(0)} />
        ${data.map((d, i) => {
          const gx = M.l + band * i + (band - groupW) / 2;
          return html`<g key=${d.label}>
            ${series.map((s, j) => { const v = d.values[s.key] || 0; const bx = gx + j * (barW + GAP); const bh = y(0) - y(v); return html`<path d=${colPath(bx, y(v), barW, bh)} fill=${`var(${s.color})`} />`; })}
            ${i % every === 0 && html`<text class="xlabel" x=${M.l + band * i + band / 2} y=${height - 8} text-anchor="middle">${d.label.split(' ')[0]}</text>`}
          </g>`;
        })}
        ${peak && peak.v > 0 && (() => { const d = data[peak.i]; const gx = M.l + band * peak.i + (band - groupW) / 2 + peak.j * (barW + GAP) + barW / 2; const label = fmtV(peak.v); const fits = gx > M.l + 20 && gx < width - M.r - 20; return fits && html`<text class="barlabel" x=${gx} y=${y(peak.v) - 5} text-anchor="middle">${label}</text>`; })()}
        ${data.map((d, i) => html`<rect key=${'h' + d.label} class=${`hit${active === i ? ' on' : ''}`} x=${M.l + band * i} y=${M.t} width=${band} height=${plotH + 2} tabindex="0"
          aria-label=${`${d.label}: ${series.map((s) => `${s.name} ${fmtV(d.values[s.key] || 0)}`).join(', ')}`}
          onPointerEnter=${() => setActive(i)} onPointerMove=${() => setActive(i)} onFocus=${() => setActive(i)} onBlur=${() => setActive(null)} />`)}
      </svg>
      ${tipFor && html`<div class="tip" role="status" style=${`left:${Math.min(Math.max(tipX, 90), width - 90)}px;top:${Math.max(tipTop - 8, 70)}px`}>
        <div class="t-head">${tipFor.label}</div>
        ${series.map((s) => html`<div class="t-row"><span class="t-key" style=${`background:var(${s.color})`}></span><span class="t-name">${s.name}</span><span class="t-val">${gbp(tipFor.values[s.key] || 0)}</span></div>`)}
      </div>`}
    </div>`}
    ${total === 0 && !tableView && html`<p class="muted small" style="margin:6px 0 0">No income or expenses recorded in this period yet.</p>`}
  </div>`;
}
