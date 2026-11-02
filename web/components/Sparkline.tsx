"use client";

// 선택한 격자의 10분 수심 곡선. 단일 계열이라 범례 없이 제목으로 이름을 대신한다.
// 0.3 m(지속시간 기준) 선을 점선으로 함께 그린다. 누르거나 올리면 그 시각 값을 보여준다.
import { useState, type PointerEvent } from "react";
import { hhmm } from "@/lib/format";

interface Props {
  times: string[];
  values: number[];
  threshold?: number;
  /** 기준선 이름 (기본 "0.3 m") */
  thresholdLabel?: string;
  /** 값이 기준선에 못 미쳐도 기준선이 보이게 세로축을 늘림 */
  fitThreshold?: boolean;
  /** 화면 읽기용 이름 (기본 "수심") */
  name?: string;
}

const W = 300;
const H = 104;
const M = { l: 30, r: 10, t: 10, b: 20 };

export default function Sparkline({ times, values, threshold = 0.3, thresholdLabel, fitThreshold = false, name = "수심" }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  if (n < 2) return null;
  const vmax = Math.max(0.5, ...values, fitThreshold ? threshold : 0) * 1.1;
  const x = (i: number) => M.l + (i / (n - 1)) * (W - M.l - M.r);
  const y = (v: number) => H - M.b - (v / vmax) * (H - M.t - M.b);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const peak = values.indexOf(Math.max(...values));
  const ticks = [0, Math.round((n - 1) / 2), n - 1];
  const yTicks = [0, Math.round((vmax / 1.1) * 10) / 10];

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - M.l) / (W - M.l - M.r)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const shown = hover ?? peak;

  return (
    <figure className="spark">
      <figcaption className="spark-read">
        <span>{hhmm(times[shown])}</span>
        <strong>{values[shown].toFixed(2)} m</strong>
        {hover === null && <span className="muted">최대</span>}
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`10분 간격 ${name} 변화, 최대 ${values[peak].toFixed(2)} m (${hhmm(times[peak])})`}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} className="spark-grid" />
            <text x={M.l - 4} y={y(v) + 3} textAnchor="end" className="spark-axis">
              {v.toFixed(1)}
            </text>
          </g>
        ))}
        {threshold < vmax && (
          <g>
            <line x1={M.l} x2={W - M.r} y1={y(threshold)} y2={y(threshold)} className="spark-threshold" />
            <text x={W - M.r} y={y(threshold) - 3} textAnchor="end" className="spark-axis">
              {thresholdLabel ?? `${threshold} m`}
            </text>
          </g>
        )}
        <path d={area} className="spark-area" />
        <path d={line} className="spark-line" />
        {ticks.map((i) => (
          <text key={i} x={x(i)} y={H - 5} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="spark-axis">
            {hhmm(times[i])}
          </text>
        ))}
        <line x1={x(shown)} x2={x(shown)} y1={M.t} y2={H - M.b} className="spark-rule" />
        <circle cx={x(shown)} cy={y(values[shown])} r={4} className="spark-dot" />
      </svg>
    </figure>
  );
}
