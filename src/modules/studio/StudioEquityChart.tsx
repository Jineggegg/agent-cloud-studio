import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

import type { T212Point } from '@/shared/types';

const HEIGHT = 220;
const PAD = { top: 16, right: 56, bottom: 26, left: 4 };

/** Used by StudioTrading212 to draw the account value over time as one 2px line with a crosshair tooltip. */
export function StudioEquityChart({ points, format, axisFormat = format }: {
  points: T212Point[]; format: (value: number) => string;
  // Gridline labels drop decimals; tooltips keep full precision.
  axisFormat?: (value: number) => string;
}) {
  const gradientId = useId();
  const frame = useRef<HTMLDivElement>(null);
  // Measured width keeps text and markers undistorted at every container size.
  const [width, setWidth] = useState(600);
  // Index of the point under the pointer or keyboard focus; null hides the crosshair.
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const node = frame.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    const times = points.map(point => Date.parse(point.at));
    const values = points.map(point => point.value);
    const minT = Math.min(...times); const maxT = Math.max(...times);
    const low = Math.min(...values); const high = Math.max(...values);
    const span = high - low || Math.max(1, Math.abs(high) * 0.01);
    const minV = low - span * 0.12; const maxV = high + span * 0.12;
    const x = (t: number) => PAD.left + (maxT === minT ? 0.5 : (t - minT) / (maxT - minT)) * (width - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - (v - minV) / (maxV - minV)) * (HEIGHT - PAD.top - PAD.bottom);
    const coords = points.map((point, index) => ({ x: x(times[index]), y: y(point.value) }));
    const line = coords.map((c, i) => `${i ? 'L' : 'M'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
    const area = coords.length ? `${line} L${coords.at(-1)!.x.toFixed(1)},${HEIGHT - PAD.bottom} L${coords[0].x.toFixed(1)},${HEIGHT - PAD.bottom} Z` : '';
    // Round gridlines to clean steps (1, 2 or 5 x 10^n) so axis labels read as plain numbers.
    const rough = (maxV - minV) / 3;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 5, 10].map(f => f * magnitude).find(s => s >= rough) ?? rough;
    const ticks: number[] = [];
    for (let tick = Math.ceil(minV / step) * step; tick <= maxV && ticks.length < 8; tick += step) ticks.push(tick);
    return { coords, line, area, ticks, y, minT, maxT };
  }, [points, width]);

  if (points.length < 2) return null;
  const up = points.at(-1)!.value >= points[0].value;
  const dateLabel = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    // Until the first measurement the SVG may be scaled, so map client pixels into viewBox units.
    const px = (event.clientX - box.left) * (width / box.width);
    let best = 0;
    geometry.coords.forEach((c, i) => { if (Math.abs(c.x - px) < Math.abs(geometry.coords[best].x - px)) best = i; });
    setActive(best);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    setActive(previous => Math.min(points.length - 1, Math.max(0, (previous ?? points.length - 1) + step)));
  };
  const point = active === null ? null : points[active];
  const coord = active === null ? null : geometry.coords[active];

  return <div className={`equity-chart ${up ? 'gain' : 'loss'}`} ref={frame}>
    <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" tabIndex={0} onKeyDown={onKey}
      aria-label={`总资产曲线，从 ${format(points[0].value)} 到 ${format(points.at(-1)!.value)}，左右方向键查看各点`}
      onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setActive(null)} onBlur={() => setActive(null)}>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.14" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {geometry.ticks.map(tick => <g key={tick}>
        <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={geometry.y(tick)} y2={geometry.y(tick)} />
        <text className="chart-axis" x={width - PAD.right + 8} y={geometry.y(tick) + 4}>{axisFormat(tick)}</text>
      </g>)}
      <path d={geometry.area} fill={`url(#${gradientId})`} />
      <path d={geometry.line} className="chart-line" />
      <circle className="chart-end" cx={geometry.coords.at(-1)!.x} cy={geometry.coords.at(-1)!.y} r={4} />
      {coord && <>
        <line className="chart-crosshair" x1={coord.x} x2={coord.x} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
        <circle className="chart-dot" cx={coord.x} cy={coord.y} r={5} />
      </>}
      <text className="chart-axis" x={PAD.left} y={HEIGHT - 6}>{new Date(geometry.minT).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</text>
      <text className="chart-axis" x={width - PAD.right} y={HEIGHT - 6} textAnchor="end">{new Date(geometry.maxT).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</text>
    </svg>
    {point && coord && <div className="chart-tooltip" role="status" style={{ left: Math.min(Math.max(coord.x, 70), width - 70), top: Math.max(coord.y - 58, 0) }}>
      <strong>{format(point.value)}</strong><span>{dateLabel(point.at)}</span>
    </div>}
    <details className="chart-table">
      <summary>数据表</summary>
      <table>
        <thead><tr><th scope="col">时间</th><th scope="col">总资产</th></tr></thead>
        <tbody>{points.slice(-50).reverse().map(row => <tr key={row.at}><td>{dateLabel(row.at)}</td><td>{format(row.value)}</td></tr>)}</tbody>
      </table>
    </details>
  </div>;
}
