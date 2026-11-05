"use client";

// 시간별 곡선 (여러 계열). 축은 하나만 쓴다 — 단위가 다른 양은 차트를 나눈다.
// 계열 색은 시나리오마다 고정(lib/scenarioColor), 2개 이상이면 범례를 늘 두고 4개 이하면 선 끝에 짧은 이름도 단다.
// 올리거나 누르면 세로선과 그 시각 값들을 보여 준다. '표로 보기'로 1시간 간격 값을 표로도 본다.
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { hhmm } from "@/lib/format";

export interface Series {
  id: string;
  name: string;
  /** 선 끝 이름 (짧게) */
  short: string;
  color: string;
  values: (number | null)[];
}

interface Props {
  title: string;
  unit: string;
  times: string[];
  series: Series[];
  digits?: number;
  height?: number;
  /** 세로축을 0에서 시작 (유량·면적). 수위는 false */
  zero?: boolean;
  /** 지금 보는 시각 (지도 재생과 맞출 때) */
  marker?: number | null;
  note?: string;
}

function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function fmt(v: number, digits: number): string {
  return v.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export default function LineChart({ title, unit, times, series, digits = 1, height = 190, zero = true, marker = null, note }: Props) {
  const box = useRef<HTMLDivElement>(null); // 그림 칸 (가로 폭을 재서 글자가 늘어나지 않게 실제 화소로 그린다)
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = times.length;
  const labels = series.length <= 4;
  const M = { l: 46, r: labels ? 74 : 12, t: 10, b: 24 };
  const H = height;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  const { lo, hi, ticks } = useMemo(() => {
    let a = all.length ? Math.min(...all) : 0;
    let b = all.length ? Math.max(...all) : 1;
    if (zero) a = Math.min(0, a);
    if (b - a < 1e-9) b = a + 1;
    const step = niceStep(b - a, 4);
    const lo = Math.floor(a / step) * step;
    const hi = Math.ceil(b / step) * step;
    const ticks: number[] = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { lo, hi, ticks };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, zero]);

  if (n < 2) return null;
  const pw = width - M.l - M.r;
  const x = (i: number) => M.l + (i / (n - 1)) * pw;
  const y = (v: number) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);
  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const xt = [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];
  const shown = hover ?? marker;

  // 선 끝 이름이 겹치지 않게 아래로 민다
  const ends = series
    .map((s) => {
      let i = s.values.length - 1;
      while (i >= 0 && (s.values[i] === null || !Number.isFinite(s.values[i] as number))) i--;
      return { s, yv: i >= 0 ? y(s.values[i] as number) : null };
    })
    .filter((e) => e.yv !== null)
    .sort((a, b) => (a.yv as number) - (b.yv as number));
  for (let k = 1; k < ends.length; k++) {
    if ((ends[k].yv as number) - (ends[k - 1].yv as number) < 13) ends[k].yv = (ends[k - 1].yv as number) + 13;
  }
  const over = ends.length ? (ends[ends.length - 1].yv as number) - (H - M.b - 2) : 0; // 아래로 넘치면 모두 위로
  if (over > 0) ends.forEach((e) => (e.yv = (e.yv as number) - over));

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - M.l) / pw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const hourly = times.map((t, i) => ({ t, i })).filter(({ t }) => t.slice(14, 16) === "00");

  return (
    <figure className="lchart">
      <figcaption className="lchart-head">
        <span className="lchart-title">
          {title} <span className="muted">({unit})</span>
        </span>
        {series.length > 1 && (
          <span className="lchart-legend">
            {series.map((s) => (
              <span key={s.id}>
                <i style={{ background: s.color }} aria-hidden="true" />
                {s.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div className="lchart-plot" ref={box}>
        <svg
          style={{ width: "100%", height: H }}
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          aria-label={`${title}: ${series.map((s) => s.name).join(", ")}, ${hhmm(times[0])}–${hhmm(times[n - 1])}`}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={M.l} x2={width - M.r} y1={y(v)} y2={y(v)} className={v === 0 ? "lchart-zero" : "lchart-grid"} />
              <text x={M.l - 6} y={y(v) + 4} className="lchart-axis" textAnchor="end">
                {fmt(v, Math.max(0, -Math.floor(Math.log10(Math.abs(ticks[1] - ticks[0]) || 1))))}
              </text>
            </g>
          ))}
          {xt.map((i) => (
            <text key={i} x={x(i)} y={H - 6} className="lchart-axis" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
              {hhmm(times[i])}
            </text>
          ))}
          {series.map((s) => (
            <path key={s.id} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {labels &&
            ends.map(({ s, yv }) => (
              <text key={s.id} x={width - M.r + 6} y={(yv as number) + 4} className="lchart-end">
                {s.short}
              </text>
            ))}
          {shown !== null && (
            <g>
              <line x1={x(shown)} x2={x(shown)} y1={M.t} y2={H - M.b} className="lchart-rule" />
              {series.map((s) => {
                const v = s.values[shown];
                return v === null || !Number.isFinite(v) ? null : (
                  <circle key={s.id} cx={x(shown)} cy={y(v)} r={4} fill={s.color} stroke="#ffffff" strokeWidth={2} />
                );
              })}
            </g>
          )}
        </svg>
        {shown !== null && (
          <div className="lchart-tip" style={{ left: Math.min(Math.max(x(shown) + 10, 0), width - 170) }}>
            <strong>{hhmm(times[shown])}</strong>
            {series.map((s) => {
              const v = s.values[shown];
              return (
                <span key={s.id}>
                  <i style={{ background: s.color }} aria-hidden="true" />
                  {s.name} <b>{v === null || !Number.isFinite(v) ? "—" : `${fmt(v, digits)} ${unit}`}</b>
                </span>
              );
            })}
          </div>
        )}
      </div>
      <div className="lchart-foot">
        {note && <span className="muted small">{note}</span>}
        <button type="button" className="link-btn small" onClick={() => setTable((v) => !v)} aria-expanded={table}>
          {table ? "표 닫기" : "표로 보기"}
        </button>
      </div>
      {table && (
        <div className="lchart-table">
          <table>
            <thead>
              <tr>
                <th>시각</th>
                {series.map((s) => (
                  <th key={s.id}>{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {hourly.map(({ t, i }) => (
                <tr key={t}>
                  <td>{hhmm(t)}</td>
                  {series.map((s) => {
                    const v = s.values[i];
                    return <td key={s.id}>{v === null || !Number.isFinite(v) ? "—" : fmt(v, digits)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
