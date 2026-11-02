"use client";

// 시간별 침수면적 (수심 0.1 m 이상, km²). 단일 계열 → 범례 없이 제목으로 이름. 가장 넓을 때를 점선으로 표시,
// 누르거나 올리면 그 시각 값을 읽어 준다.
import { useState, type PointerEvent } from "react";
import { hhmm } from "@/lib/format";

interface Props {
  times: string[];
  values: number[];
  height?: number;
  compact?: boolean; // 휴대폰 시트: 축 글자 줄임
}

const W = 600;

export default function AreaChart({ times, values, height = 72, compact = false }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  if (n < 2) return null;
  const H = height;
  const M = { t: 6, b: 2 }; // 그림은 가로로 늘려 그리므로(preserveAspectRatio none) 글자는 아래 HTML 줄에 둔다
  const vmax = Math.max(...values) * 1.08 || 1;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => H - M.b - (v / vmax) * (H - M.t - M.b);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${W},${y(0)}L0,${y(0)}Z`;
  const peak = values.indexOf(Math.max(...values));
  const shown = hover ?? peak;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const ticks = compact ? [0, n - 1] : [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];

  return (
    <figure className={`area-chart${compact ? " compact" : ""}`}>
      <figcaption>
        <span className="area-title">시간별 침수면적</span>
        <span className="area-read">
          <strong>{hhmm(times[shown])}</strong> {values[shown].toFixed(2)} km²
          {hover === null && <span className="muted"> · 가장 넓을 때</span>}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ height }}
        role="img"
        aria-label={`시간별 침수면적: ${hhmm(times[0])}부터 ${hhmm(times[n - 1])}까지, ${hhmm(times[peak])}에 ${values[peak].toFixed(2)} km²로 가장 넓음`}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="chart-base" vectorEffect="non-scaling-stroke" />
        <path d={area} className="chart-area" />
        <path d={line} className="chart-line" vectorEffect="non-scaling-stroke" />
        <line x1={x(shown)} x2={x(shown)} y1={M.t} y2={y(0)} className="chart-rule" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="chart-ticks muted" aria-hidden="true">
        {ticks.map((i) => (
          <span key={i}>{hhmm(times[i])}</span>
        ))}
      </div>
    </figure>
  );
}
