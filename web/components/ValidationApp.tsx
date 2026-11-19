"use client";

// 검증 화면: 하천 흔적수위(현장조사) vs 모형 1D 최고수위 — 결과마다(웹 계산 포함) 브라우저에서 계산한다.
// 비교 방법은 pipeline/trace_levels.py와 같다: river.json 단면별 최고수위를 하구 누가거리(= 단면 번호 km)로 선형 보간, 차이 = 모형 − 흔적.
// 판정(받아들일 수 있는지, 원인)은 화면에서 하지 않는다. 숫자와 조건만 보인다.
import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";
import TopBar from "./TopBar";
import { DATA_ROOT } from "@/lib/data";
import { shortLabel } from "@/lib/format";
import { loadRiver, type RiverData } from "@/lib/river";
import { colorMap, loadRunSummaries, loadSummaries, type Summary } from "@/lib/summary";

interface SurveyRow {
  station: string;
  dist_m: number;
  plan_fwl_m: number | null;
  trace_left_m: number | null;
  trace_right_m: number | null;
  levee_survey_left_m: number | null;
  levee_survey_right_m: number | null;
  note: string | null;
}

interface TraceFile {
  model_version: string;
  source: { name: string; provider: string; date: string; citation: string; note: string };
  rs_basis: string;
  method: string;
  caveat: string;
  survey: SurveyRow[];
}

interface CheckRow {
  stage: string;
  what: string;
  result: string;
  verdict: string;
  date: string;
}

interface Point {
  station: string;
  dist_m: number;
  side: "left" | "right";
  trace: number;
  model: number;
  diff: number;
}

interface Metrics {
  n: number;
  rmse: number;
  bias: number;
  mae: number;
  maxAbs: number;
  lower: number;
}

// ------------------------------------------------------------------ 계산 (pipeline/trace_levels.py와 같은 식)
function profile(river: RiverData): { xs: number[]; ws: number[]; bed: number[] } {
  const pts = river.xs
    .filter((x) => x.max_ws_m !== null)
    .map((x) => ({ rs: parseFloat(x.rs), ws: x.max_ws_m as number, bed: x.bed_m ?? NaN }))
    .sort((a, b) => a.rs - b.rs || a.ws - b.ws);
  return { xs: pts.map((p) => p.rs), ws: pts.map((p) => p.ws), bed: pts.map((p) => p.bed) };
}

function interp(x: number, xs: number[], ys: number[]): number | null {
  if (!xs.length || x < xs[0] || x > xs[xs.length - 1]) return null;
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const x0 = xs[i - 1],
        x1 = xs[i];
      if (x1 === x0) return ys[i];
      const w = (x - x0) / (x1 - x0);
      return ys[i - 1] * (1 - w) + ys[i] * w;
    }
  }
  return ys[ys.length - 1];
}

function compare(survey: SurveyRow[], river: RiverData): { points: Point[]; m: Metrics | null } {
  // python sorted()는 (rs, ws) 순 — 같은 RS면 낮은 수위가 먼저. 여기서도 같게 정렬한다
  const { xs, ws } = profile(river);
  const points: Point[] = [];
  for (const s of survey) {
    const m = interp(s.dist_m / 1000, xs, ws);
    if (m === null) continue;
    for (const side of ["left", "right"] as const) {
      const t = side === "left" ? s.trace_left_m : s.trace_right_m;
      if (t === null) continue;
      points.push({ station: s.station, dist_m: s.dist_m, side, trace: t, model: m, diff: m - t });
    }
  }
  const n = points.length;
  if (!n) return { points, m: null };
  const d = points.map((p) => p.diff);
  return {
    points,
    m: {
      n,
      rmse: Math.sqrt(d.reduce((a, v) => a + v * v, 0) / n),
      bias: d.reduce((a, v) => a + v, 0) / n,
      mae: d.reduce((a, v) => a + Math.abs(v), 0) / n,
      maxAbs: Math.max(...d.map(Math.abs)),
      lower: d.filter((v) => v < 0).length,
    },
  };
}

const f2 = (v: number) => v.toFixed(2);
const sgn = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;
const nameOf = (s: Summary) => (s.ref.run_id !== undefined ? `${shortLabel(s.ref.label)} (웹 계산)` : shortLabel(s.ref.label));

// ------------------------------------------------------------------ 그림 공통
function niceTicks(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / Math.max(1, count);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [box, w];
}

const INK = "#1f2a37";
const BED = "#9aa3ad";

function Marker({ x, y, side, color }: { x: number; y: number; side: "left" | "right"; color: string }) {
  // 좌안 = 채운 원, 우안 = 속이 빈 원 (색만으로 구분하지 않게 모양을 다르게)
  return side === "left" ? (
    <circle cx={x} cy={y} r={4.5} fill={color} stroke="#ffffff" strokeWidth={1.5} />
  ) : (
    <circle cx={x} cy={y} r={4} fill="#ffffff" stroke={color} strokeWidth={2} />
  );
}

/** 종단: 하상·모형 최고수위(선) + 흔적수위(점). 거리 = 하구에서 km */
function ProfileChart({ river, survey, points, color, label }: { river: RiverData; survey: SurveyRow[]; points: Point[]; color: string; label: string }) {
  const [box, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const H = 300;
  const M = { l: 46, r: 14, t: 12, b: 30 };
  const xMax = Math.ceil((Math.max(...survey.map((s) => s.dist_m)) / 1000 + 0.4) * 2) / 2;
  const prof = profile(river);
  const inRange = prof.xs.map((x, i) => ({ x, ws: prof.ws[i], bed: prof.bed[i] })).filter((p) => p.x <= xMax);
  const vals = [...inRange.map((p) => p.ws), ...inRange.map((p) => p.bed).filter(Number.isFinite), ...points.map((p) => p.trace)];
  const lo = Math.floor(Math.min(...vals) / 5) * 5;
  const hi = Math.ceil(Math.max(...vals) / 5) * 5;
  const pw = width - M.l - M.r;
  const X = (km: number) => M.l + (km / xMax) * pw;
  const Y = (v: number) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);
  const line = (k: "ws" | "bed") =>
    inRange
      .filter((p) => Number.isFinite(p[k]))
      .map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p[k]).toFixed(1)}`)
      .join("");
  const stations = survey.filter((s) => points.some((p) => p.station === s.station));
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const km = ((e.clientX - r.left - M.l) / pw) * xMax;
    let best = -1,
      bd = Infinity;
    stations.forEach((s, i) => {
      const d = Math.abs(s.dist_m / 1000 - km);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best >= 0 && bd < 0.4 ? best : null);
  };
  const hs = hover !== null ? stations[hover] : null;
  const hp = hs ? points.filter((p) => p.station === hs.station) : [];
  return (
    <figure className="lchart">
      <figcaption className="lchart-head">
        <span className="lchart-title">
          냉천 종단 — 모형 최고수위와 흔적수위 <span className="muted">(EL. m)</span>
        </span>
        <span className="lchart-legend">
          <span>
            <i style={{ background: color }} aria-hidden="true" />
            모형 최고수위 ({label})
          </span>
          <span>
            <svg width="12" height="12" aria-hidden="true">
              <circle cx="6" cy="6" r="4.5" fill={INK} />
            </svg>
            흔적 좌안
          </span>
          <span>
            <svg width="12" height="12" aria-hidden="true">
              <circle cx="6" cy="6" r="4" fill="#fff" stroke={INK} strokeWidth="2" />
            </svg>
            흔적 우안
          </span>
          <span>
            <i style={{ background: BED }} aria-hidden="true" />
            하상
          </span>
        </span>
      </figcaption>
      <div className="lchart-plot" ref={box}>
        <svg
          style={{ width: "100%", height: H }}
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          aria-label={`냉천 하구에서 ${xMax} km까지 종단. 모형 최고수위 선과 흔적수위 ${points.length}개`}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {niceTicks(lo, hi, 5).map((v) => (
            <g key={v}>
              <line x1={M.l} x2={width - M.r} y1={Y(v)} y2={Y(v)} className="lchart-grid" />
              <text x={M.l - 6} y={Y(v) + 4} className="lchart-axis" textAnchor="end">
                {v}
              </text>
            </g>
          ))}
          {niceTicks(0, xMax, 6).map((v) => (
            <text key={v} x={X(v)} y={H - 10} className="lchart-axis" textAnchor="middle">
              {v} km
            </text>
          ))}
          <text x={width - M.r} y={H - 10} className="lchart-axis" textAnchor="end" dy={-12}>
            하구에서 거리 →
          </text>
          <path d={line("bed")} fill="none" stroke={BED} strokeWidth={1.5} />
          <path d={line("ws")} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
          {points.map((p) => (
            <Marker key={p.station + p.side} x={X(p.dist_m / 1000)} y={Y(p.trace)} side={p.side} color={INK} />
          ))}
          {hs && <line x1={X(hs.dist_m / 1000)} x2={X(hs.dist_m / 1000)} y1={M.t} y2={H - M.b} className="lchart-rule" />}
        </svg>
        {hs && (
          <div className="lchart-tip" style={{ left: Math.min(Math.max(X(hs.dist_m / 1000) + 10, 0), width - 190) }}>
            <strong>
              {hs.station} · {(hs.dist_m / 1000).toFixed(2)} km
            </strong>
            {hp.map((p) => (
              <span key={p.side}>
                흔적 {p.side === "left" ? "좌안" : "우안"} <b>{f2(p.trace)}</b>
              </span>
            ))}
            {hp[0] && (
              <span>
                <i style={{ background: color }} aria-hidden="true" />
                모형 <b>{f2(hp[0].model)}</b>
              </span>
            )}
            {hp.map((p) => (
              <span key={"d" + p.side}>
                차이({p.side === "left" ? "좌" : "우"}) <b>{sgn(p.diff)} m</b>
              </span>
            ))}
            {hs.note && <span className="muted">{hs.note}</span>}
          </div>
        )}
      </div>
    </figure>
  );
}

/** 지점별 차이 (모형 − 흔적). 0 선 아래 = 모형이 낮음 */
function DiffChart({ survey, points, color }: { survey: SurveyRow[]; points: Point[]; color: string }) {
  const [box, width] = useWidth();
  const H = 170;
  const M = { l: 46, r: 14, t: 10, b: 26 };
  const xMax = Math.ceil((Math.max(...survey.map((s) => s.dist_m)) / 1000 + 0.4) * 2) / 2;
  const ext = Math.max(0.5, ...points.map((p) => Math.abs(p.diff)));
  const lim = Math.ceil(ext * 2) / 2;
  const pw = width - M.l - M.r;
  const X = (km: number) => M.l + (km / xMax) * pw;
  const Y = (v: number) => M.t + (1 - (v + lim) / (2 * lim)) * (H - M.t - M.b);
  return (
    <figure className="lchart">
      <figcaption className="lchart-head">
        <span className="lchart-title">
          지점별 차이 = 모형 − 흔적 <span className="muted">(m, 0보다 아래면 모형이 낮음)</span>
        </span>
      </figcaption>
      <div className="lchart-plot" ref={box}>
        <svg style={{ width: "100%", height: H }} viewBox={`0 0 ${width} ${H}`} role="img" aria-label="지점별 수위 차이">
          {niceTicks(-lim, lim, 4).map((v) => (
            <g key={v}>
              <line x1={M.l} x2={width - M.r} y1={Y(v)} y2={Y(v)} className={v === 0 ? "lchart-zero" : "lchart-grid"} />
              <text x={M.l - 6} y={Y(v) + 4} className="lchart-axis" textAnchor="end">
                {v > 0 ? `+${v}` : v}
              </text>
            </g>
          ))}
          {niceTicks(0, xMax, 6).map((v) => (
            <text key={v} x={X(v)} y={H - 8} className="lchart-axis" textAnchor="middle">
              {v} km
            </text>
          ))}
          {points.map((p) => (
            <g key={p.station + p.side}>
              <line x1={X(p.dist_m / 1000)} x2={X(p.dist_m / 1000)} y1={Y(0)} y2={Y(p.diff)} stroke={color} strokeWidth={1.5} opacity={0.5} />
              <Marker x={X(p.dist_m / 1000)} y={Y(p.diff)} side={p.side} color={color} />
            </g>
          ))}
        </svg>
      </div>
    </figure>
  );
}

// ------------------------------------------------------------------ 화면
export default function ValidationApp() {
  const [list, setList] = useState<Summary[] | null>(null);
  const [rivers, setRivers] = useState<Map<string, RiverData | null>>(new Map());
  const [trace, setTrace] = useState<TraceFile | null>(null);
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [selId, setSelId] = useState<string>("");
  const [table, setTable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSummaries()
      .then(async ({ version, model, list }) => {
        setList(list);
        const tf = await fetch(`${DATA_ROOT}/${version}/validation/trace_levels.json`, { cache: "no-cache" })
          .then((r) => (r.ok ? (r.json() as Promise<TraceFile>) : null))
          .catch(() => null);
        setTrace(tf);
        fetch(`${DATA_ROOT}/${version}/validation/checks.json`, { cache: "no-cache" })
          .then((r) => (r.ok ? r.json() : { rows: [] }))
          .then((j: { rows: CheckRow[] }) => setChecks(j.rows ?? []))
          .catch(() => setChecks([]));
        const base = list.find((s) => s.ref.run_id === undefined && !s.ref.params && (s.kpi.internal_inflow?.count ?? 0) > 0);
        setSelId(base?.ref.scenario_id ?? list[0]?.ref.scenario_id ?? "");
        const runs = await loadRunSummaries(version, model);
        const all = [...list, ...runs];
        if (runs.length) setList(all);
        const rv = await Promise.all(all.map(async (s) => [s.ref.scenario_id, await loadRiver(s.ref)] as const));
        setRivers(new Map(rv));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const colors = useMemo(() => (list ? colorMap(list) : new Map<string, string>()), [list]);
  const results = useMemo(() => {
    if (!list || !trace) return [];
    return list.map((s) => {
      const rv = rivers.get(s.ref.scenario_id) ?? null;
      return { s, rv, ...(rv ? compare(trace.survey, rv) : { points: [] as Point[], m: null }) };
    });
  }, [list, rivers, trace]);
  const cur = results.find((r) => r.s.ref.scenario_id === selId) ?? null;
  const curColor = cur ? colors.get(cur.s.ref.scenario_id) ?? "#2a78d6" : "#2a78d6";

  return (
    <div className="run-app">
      <TopBar current="validation" />
      <main className="runpage">
        <div className="run-wrap">
          <section className="run-intro">
            <h1>검증</h1>
            <p>
              계산 결과를 실제 기록과 비교합니다. 하천 흔적수위 비교는 결과마다(웹에서 계산한 결과 포함) 이 화면에서 바로 계산합니다. 차이를 받아들일 수 있는지와
              원인은 이 화면에서 판정하지 않습니다.
            </p>
          </section>

          {error && <p className="field-error">자료를 읽지 못했습니다: {error}</p>}

          <section className="run-card" aria-labelledby="tr-title">
            <div className="run-card-head">
              <h2 id="tr-title">하천 흔적수위 vs 모형 최고수위</h2>
              {cur && list && (
                <label className="field-inline">
                  결과
                  <select value={selId} onChange={(e) => setSelId(e.target.value)}>
                    {list.map((s) => (
                      <option key={s.ref.scenario_id} value={s.ref.scenario_id}>
                        {nameOf(s)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {(!trace || rivers.size === 0) && !error && <p className="muted">결과별 하천 단면 자료를 불러오는 중…</p>}
            {trace && cur?.m && cur.rv && (
              <>
                <dl className="metric-row">
                  <div>
                    <dt>RMSE</dt>
                    <dd>{f2(cur.m.rmse)} m</dd>
                  </div>
                  <div>
                    <dt>편의 (모형 − 흔적 평균)</dt>
                    <dd>{sgn(cur.m.bias)} m</dd>
                  </div>
                  <div>
                    <dt>MAE</dt>
                    <dd>{f2(cur.m.mae)} m</dd>
                  </div>
                  <div>
                    <dt>최대 차이</dt>
                    <dd>{f2(cur.m.maxAbs)} m</dd>
                  </div>
                  <div>
                    <dt>모형이 낮은 곳</dt>
                    <dd>
                      {cur.m.lower} / {cur.m.n}
                    </dd>
                  </div>
                </dl>
                <ProfileChart river={cur.rv} survey={trace.survey} points={cur.points} color={curColor} label={nameOf(cur.s)} />
                <DiffChart survey={trace.survey} points={cur.points} color={curColor} />
                <div className="lchart-foot">
                  <span className="muted small">
                    흔적수위: {trace.source.provider}({trace.source.date.slice(0, 4)}), 「{trace.source.name.split(" — ")[0]}」 ({trace.source.date}) — 측점{" "}
                    {trace.survey.length}개, 값 {cur.m.n}개
                  </span>
                  <button type="button" className="link-btn small" onClick={() => setTable((v) => !v)} aria-expanded={table}>
                    {table ? "표 닫기" : "지점별 표"}
                  </button>
                </div>
                {table && (
                  <div className="lchart-table">
                    <table>
                      <thead>
                        <tr>
                          <th>측점</th>
                          <th>하구에서 (km)</th>
                          <th>흔적 좌안</th>
                          <th>흔적 우안</th>
                          <th>모형</th>
                          <th>차이 좌</th>
                          <th>차이 우</th>
                          <th>비고</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trace.survey.map((s) => {
                          const L = cur.points.find((p) => p.station === s.station && p.side === "left");
                          const R = cur.points.find((p) => p.station === s.station && p.side === "right");
                          const m = (L ?? R)?.model;
                          return (
                            <tr key={s.station}>
                              <td>{s.station}</td>
                              <td>{(s.dist_m / 1000).toFixed(3)}</td>
                              <td>{s.trace_left_m === null ? "—" : f2(s.trace_left_m)}</td>
                              <td>{s.trace_right_m === null ? "—" : f2(s.trace_right_m)}</td>
                              <td>{m === undefined ? "—" : f2(m)}</td>
                              <td>{L ? sgn(L.diff) : "—"}</td>
                              <td>{R ? sgn(R.diff) : "—"}</td>
                              <td className="muted">{s.note ?? ""}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
            {trace && cur && !cur.rv && rivers.size > 0 && <p className="muted">이 결과에는 하천 단면 자료(river.json)가 없습니다.</p>}

            {trace && results.some((r) => r.m) && (
              <div className="table-scroll">
                <table className="kpi-table">
                  <thead>
                    <tr>
                      <th scope="col">결과</th>
                      <th scope="col">RMSE (m)</th>
                      <th scope="col">편의 (m)</th>
                      <th scope="col">MAE (m)</th>
                      <th scope="col">최대 차이 (m)</th>
                      <th scope="col">모형이 낮은 곳</th>
                      <th scope="col">체적오차 전체 / 좌안 / 우안 (%)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map(({ s, m }) => {
                      const ve = s.kpi.volume_error_pct;
                      return (
                        <tr key={s.ref.scenario_id} aria-current={s.ref.scenario_id === selId ? "true" : undefined}>
                          <th scope="row">
                            <i className="col-key" style={{ background: colors.get(s.ref.scenario_id) }} aria-hidden="true" />
                            {nameOf(s)}
                          </th>
                          <td>{m ? f2(m.rmse) : "—"}</td>
                          <td>{m ? sgn(m.bias) : "—"}</td>
                          <td>{m ? f2(m.mae) : "—"}</td>
                          <td>{m ? f2(m.maxAbs) : "—"}</td>
                          <td>{m ? `${m.lower} / ${m.n}` : "—"}</td>
                          <td>{ve ? `${ve.total.toFixed(2)} / ${ve.left.toFixed(1)} / ${ve.right.toFixed(1)}` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {trace && (
              <ul className="note-list muted small">
                <li>비교 위치: {trace.rs_basis}.</li>
                <li>계산: {trace.method}.</li>
                <li>주의: {trace.caveat}. {trace.source.note}.</li>
              </ul>
            )}
          </section>

          {checks.length > 0 && (
            <section className="run-card" aria-labelledby="ck-title">
              <div className="run-card-head">
                <h2 id="ck-title">다른 검증</h2>
              </div>
              <div className="table-scroll">
                <table className="kpi-table check-table">
                  <thead>
                    <tr>
                      <th scope="col">단계</th>
                      <th scope="col">비교</th>
                      <th scope="col">결과</th>
                      <th scope="col">판정</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((c, i) => (
                      <tr key={i}>
                        <th scope="row">{c.stage}</th>
                        <td>{c.what}</td>
                        <td>{c.result}</td>
                        <td>{c.verdict}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small">
                체적오차는 위 표의 각 결과 값(HEC-RAS 체적 수지). 침수흔적도: 행정안전부, 재난안전데이터공유플랫폼 오픈API DSSP-IF-00117 (공공누리 제3유형).
              </p>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
