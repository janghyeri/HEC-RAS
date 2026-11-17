"use client";

// 분석·비교 (/analysis) — 과제 대시보드 항목 (docs/GUIDE.md §4.4).
//  1. 두 결과 비교: 기본은 하천 범람 vs 하천 범람 + 도시 침수(원인 지도·밀어서 비교·증감표).
//     2026-11-17 사용자 요청으로 웹 계산 결과를 포함한 아무 두 결과도 고를 수 있게 함 (원인 지도는 미리 만든 기본 쌍만).
//     고른 쌍은 주소에 ?a=…&b=… 로 남는다
//  2. 시간별 변화: 침수면적·하천 유량·하천 수위·맨홀 유입·측방 구조물 (조건을 골라 겹쳐 보기)
//  3. 해석 조건별 주요 결과 표 (게시된 조건 + 웹에서 계산이 끝난 결과)
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import TopBar from "./TopBar";
import LineChart, { type Series } from "./LineChart";
import type { CompareMode } from "./CompareMap";
import { hasVworld, type Basemap } from "@/lib/basemap";
import { hhmm, shortLabel } from "@/lib/format";
import {
  basePair,
  colorMap,
  compareBase,
  loadCompare,
  loadRunSummaries,
  loadSummaries,
  type CompareInfo,
  type Summary,
} from "@/lib/summary";
import { DATA_ROOT, type BBox, type MeshInfo, type ModelInfo } from "@/lib/data";

const CompareMap = dynamic(() => import("./CompareMap"), { ssr: false });

interface Row {
  key: string;
  label: string;
  unit: string;
  digits: number;
  time?: boolean;
  note?: string;
  get: (s: Summary) => number | string | null;
}

function minutes(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}

function lateralRs(name: string): string {
  return name.trim().split(/\s+/).at(-1) ?? name;
}

function rows(list: Summary[]): Row[] {
  const lat = list[0]?.kpi.lateral_structures ?? [];
  const base: Row[] = [
    { key: "a01", label: "침수면적 (0.1 m 이상)", unit: "km²", digits: 2, get: (s) => s.kpi.inundation_area_km2["ge_0.1m"] },
    { key: "a05", label: "· 0.5 m 이상", unit: "km²", digits: 2, get: (s) => s.kpi.inundation_area_km2["ge_0.5m"] },
    { key: "a10", label: "· 1.0 m 이상", unit: "km²", digits: 2, get: (s) => s.kpi.inundation_area_km2["ge_1.0m"] },
    { key: "a20", label: "· 2.0 m 이상", unit: "km²", digits: 2, get: (s) => s.kpi.inundation_area_km2["ge_2.0m"] },
    { key: "dur", label: "0.3 m 이상 1시간 넘게 침수", unit: "km²", digits: 2, get: (s) => s.kpi["duration_ge_0.3m"]?.area_km2_ge_1h ?? null },
    { key: "pk", label: "순간 최대 침수면적", unit: "km²", digits: 2, get: (s) => s.kpi.peak_instant_area.km2 },
    { key: "on", label: "침수 시작 시각", unit: "", digits: 0, time: true, get: (s) => s.kpi.onset_time },
    { key: "pt", label: "최대 침수 시각", unit: "", digits: 0, time: true, get: (s) => s.kpi.peak_instant_area.time },
    { key: "p99", label: "최대 침수심 (상위 1 %)", unit: "m", digits: 2, get: (s) => s.kpi.max_depth_m.p99_of_flooded },
    { key: "q", label: "하천 최대유량", unit: "m³/s", digits: 0, get: (s) => s.kpi.river.q_max_anywhere.q_max_m3s },
    { key: "ws0", label: "하구 최고 수위", unit: "EL. m", digits: 2, get: (s) => s.kpi.river.outlet?.ws_max_m ?? null },
    { key: "mh", label: "맨홀 유입 총량", unit: "만 m³", digits: 1, get: (s) => (s.kpi.internal_inflow?.total_volume_m3 ?? 0) / 1e4 },
  ];
  lat.forEach((l, i) =>
    base.push({
      key: `lat${i}`,
      label: `측방 구조물 RS ${lateralRs(l.name)} → 시가지`,
      unit: "만 m³",
      digits: 1,
      note: "참고값",
      get: (s) => {
        const v = s.kpi.lateral_structures?.find((x) => x.name === l.name)?.volume_to_2d_m3;
        return v === undefined ? null : v / 1e4;
      },
    }),
  );
  base.push(
    { key: "ve", label: "체적오차 (전체)", unit: "%", digits: 2, get: (s) => s.kpi.volume_error_pct?.total ?? null },
    { key: "vel", label: "· 좌안 2D", unit: "%", digits: 1, get: (s) => s.kpi.volume_error_pct?.left ?? null },
    { key: "ver", label: "· 우안 2D", unit: "%", digits: 1, get: (s) => s.kpi.volume_error_pct?.right ?? null },
  );
  return base;
}

function cell(r: Row, v: number | string | null): string {
  if (v === null || v === undefined) return "—";
  if (r.time) return hhmm(v as string);
  return (v as number).toLocaleString("ko-KR", { minimumFractionDigits: r.digits, maximumFractionDigits: r.digits });
}

function diff(r: Row, a: number | string | null, b: number | string | null): { text: string; rate: string } {
  if (a === null || b === null) return { text: "—", rate: "" };
  if (r.time) {
    const m = minutes(a as string, b as string);
    return { text: m === 0 ? "같음" : `${Math.abs(m)}분 ${m < 0 ? "빨라짐" : "늦어짐"}`, rate: "" };
  }
  const d = (b as number) - (a as number);
  const sign = d > 0 ? "+" : d < 0 ? "−" : "";
  const text = `${sign}${Math.abs(d).toLocaleString("ko-KR", { minimumFractionDigits: r.digits, maximumFractionDigits: r.digits })}`;
  const rate = r.unit === "%" || r.unit === "EL. m" || (a as number) === 0 ? "" : `${sign}${Math.abs((d / (a as number)) * 100).toFixed(0)} %`;
  return { text, rate };
}

function nameOf(s: Summary): string {
  return shortLabel(s.ref.label);
}

function shortOf(s: Summary, pair: { a: Summary; b: Summary } | null): string {
  if (pair && s === pair.a) return "하천 범람";
  if (pair && s === pair.b) return "+도시 침수";
  if (s.ref.run_id !== undefined) return `계산 ${s.ref.run_id}`;
  const f = s.ref.params?.internal_flow_factor;
  if (f !== undefined && Object.keys(s.ref.params ?? {}).length === 1) return `맨홀 ×${f}`;
  return shortLabel(s.ref.label).slice(0, 8);
}

function mapLink(s: Summary): string {
  return s.ref.run_id !== undefined ? `/?run=${s.ref.run_id}` : `/?s=${encodeURIComponent(s.ref.scenario_id)}`;
}

export default function AnalysisApp() {
  const [list, setList] = useState<Summary[] | null>(null);
  const [version, setVersion] = useState("");
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cmp, setCmp] = useState<CompareInfo | null>(null);
  const [mode, setMode] = useState<CompareMode>("cause");
  const [basemap, setBasemap] = useState<Basemap>(hasVworld() ? "photo" : "map");
  const [picked, setPicked] = useState<string[]>([]);
  const [station, setStation] = useState<string>("");
  const [structure, setStructure] = useState<string>("");
  const [view, setView] = useState<BBox | null>(null);
  const [sel, setSel] = useState<{ a: string; b: string } | null>(null);

  useEffect(() => {
    loadSummaries()
      .then(async ({ version, model, list }) => {
        setVersion(version);
        setModel(model);
        // 처음 지도 범위 = 2D 계산 격자 범위 (하천 상류 끝까지 넣으면 시가지가 작게 보임)
        fetch(`${DATA_ROOT}/${version}/mesh.json`)
          .then((r) => r.json() as Promise<MeshInfo>)
          .then((m) => setView(m.bbox_lonlat))
          .catch(() => setView(null));
        setList(list);
        const pair = basePair(list);
        if (pair) {
          setPicked([pair.a.ref.scenario_id, pair.b.ref.scenario_id]);
          loadCompare(version, pair.a.ref.scenario_id, pair.b.ref.scenario_id).then(setCmp);
        }
        const st = list[0]?.ts?.river_stations;
        const lat = list[0]?.kpi.lateral_structures?.[0];
        setStation(lat?.river_at_structure?.rs ?? st?.[0] ?? "");
        setStructure(lat?.name ?? "");
        const runs = await loadRunSummaries(version, model);
        if (runs.length) setList((l) => [...(l ?? []), ...runs]);
        // 주소의 ?a=…&b=… (예: 방금 계산한 결과와 기준 비교 링크)
        const q = new URLSearchParams(window.location.search);
        const all = [...list, ...runs];
        const qa = q.get("a"),
          qb = q.get("b");
        if (qa && qb && all.some((s) => s.ref.scenario_id === qa) && all.some((s) => s.ref.scenario_id === qb)) setSel({ a: qa, b: qb });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const pair = useMemo(() => (list ? basePair(list) : null), [list]);
  // 지금 비교하는 두 결과 (고르지 않았으면 기본 쌍)
  const cur = useMemo(() => {
    if (!list) return null;
    if (sel) {
      const a = list.find((s) => s.ref.scenario_id === sel.a);
      const b = list.find((s) => s.ref.scenario_id === sel.b);
      if (a && b) return { a, b };
    }
    return pair;
  }, [list, sel, pair]);
  const isBase = !!(cur && pair && cur.a === pair.a && cur.b === pair.b);
  const cmpCur = isBase ? cmp : null;
  const pick = (side: "a" | "b", id: string) => {
    if (!cur) return;
    const next = { a: side === "a" ? id : cur.a.ref.scenario_id, b: side === "b" ? id : cur.b.ref.scenario_id };
    setSel(next);
    setPicked((p) => Array.from(new Set([...p, next.a, next.b])));
    const q = new URLSearchParams(window.location.search);
    q.set("a", next.a);
    q.set("b", next.b);
    window.history.replaceState(null, "", `?${q.toString()}`);
  };
  const colors = useMemo(() => (list ? colorMap(list) : new Map<string, string>()), [list]);
  const R = useMemo(() => (list ? rows(list) : []), [list]);
  const shownList = (list ?? []).filter((s) => picked.includes(s.ref.scenario_id));
  const times = list?.find((s) => s.ts)?.ts?.times ?? [];
  const stations = list?.find((s) => s.ts)?.ts?.river_stations ?? [];
  const stIdx = stations.indexOf(station);
  const keyStations = useMemo(() => {
    if (!list?.length || !stations.length) return [];
    const k = list[0].kpi;
    const out: { rs: string; label: string }[] = [{ rs: stations[0], label: `상류 끝 RS ${stations[0]}` }];
    for (const l of k.lateral_structures ?? []) {
      const rs = l.river_at_structure?.rs;
      if (rs && !out.some((o) => o.rs === rs)) out.push({ rs, label: `측방 구조물 부근 RS ${rs}` });
    }
    if (k.river.q_max_anywhere?.rs && !out.some((o) => o.rs === k.river.q_max_anywhere.rs))
      out.push({ rs: k.river.q_max_anywhere.rs, label: `최대유량 지점 RS ${k.river.q_max_anywhere.rs}` });
    out.push({ rs: stations[stations.length - 1], label: `하구 RS ${stations[stations.length - 1]}` });
    return out;
  }, [list, stations]);

  const mk = (pick: (s: Summary) => (number | null)[] | null): Series[] =>
    shownList
      .map((s) => ({ s, v: pick(s) }))
      .filter((x): x is { s: Summary; v: (number | null)[] } => x.v !== null)
      .map(({ s, v }) => ({ id: s.ref.scenario_id, name: nameOf(s), short: shortOf(s, pair), color: colors.get(s.ref.scenario_id) ?? "#888", values: v }));

  const bbox: BBox | null = cmp?.wet_bbox ?? view ?? pair?.b.tiles.bounds ?? null;
  const optionLabel = (s: Summary) => (s.ref.run_id !== undefined ? `${shortLabel(s.ref.label)} (웹 계산)` : shortLabel(s.ref.label));

  return (
    <div className="run-app">
      <TopBar current="analysis" />
      <main className="runpage">
        <div className="run-wrap wide">
          <div className="run-intro">
            <h1>분석·비교</h1>
            <p>
              해석 조건별 주요 결과와 시간별 변화를 봅니다. 처음에는 하천 범람만 넣은 계산과 맨홀 월류(도시 침수)를 함께 넣은 계산을 나란히 두고, 웹에서 계산한
              결과를 포함해 다른 두 조건도 골라 비교할 수 있습니다.
            </p>
          </div>
          {error && <p className="warn small">자료를 불러오지 못했습니다: {error}</p>}
          {!list && !error && <p className="muted">자료를 불러오는 중…</p>}

          {list && pair && cur && (
            <section className="run-card" aria-labelledby="cmp-title">
              <div className="run-card-head">
                <h2 id="cmp-title">
                  {shortLabel(cur.a.ref.label)} vs {shortLabel(cur.b.ref.label)}
                </h2>
                <span className="muted small">모형 {version} · 최대 침수심 기준</span>
              </div>
              <div className="cmp-pick">
                <label className="field-inline">
                  <span>기준 (왼쪽)</span>
                  <select value={cur.a.ref.scenario_id} onChange={(e) => pick("a", e.target.value)}>
                    {list.map((s) => (
                      <option key={s.ref.scenario_id} value={s.ref.scenario_id} disabled={s === cur.b}>
                        {optionLabel(s)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-inline">
                  <span>비교 (오른쪽)</span>
                  <select value={cur.b.ref.scenario_id} onChange={(e) => pick("b", e.target.value)}>
                    {list.map((s) => (
                      <option key={s.ref.scenario_id} value={s.ref.scenario_id} disabled={s === cur.a}>
                        {optionLabel(s)}
                      </option>
                    ))}
                  </select>
                </label>
                {!isBase && (
                  <button type="button" className="link-btn" onClick={() => {
                      setSel(null);
                      const q = new URLSearchParams(window.location.search);
                      q.delete("a");
                      q.delete("b");
                      window.history.replaceState(null, "", q.toString() ? `?${q.toString()}` : window.location.pathname);
                    }}>
                    기본 비교로
                  </button>
                )}
              </div>
              <div className="cmp-tools">
                <div className="seg" role="radiogroup" aria-label="지도 보기">
                  <button type="button" role="radio" aria-checked={mode === "cause" && !!cmpCur} onClick={() => setMode("cause")} disabled={!cmpCur}>
                    원인 지도
                  </button>
                  <button type="button" role="radio" aria-checked={mode === "swipe" || !cmpCur} onClick={() => setMode("swipe")}>
                    밀어서 비교
                  </button>
                </div>
                {hasVworld() && (
                  <div className="seg small-seg" role="radiogroup" aria-label="배경지도">
                    <button type="button" role="radio" aria-checked={basemap === "photo"} onClick={() => setBasemap("photo")}>
                      항공사진
                    </button>
                    <button type="button" role="radio" aria-checked={basemap === "map"} onClick={() => setBasemap("map")}>
                      일반지도
                    </button>
                  </div>
                )}
              </div>
              <div className="cmp-grid">
                <div className="cmp-mapbox">
                  {bbox && (cmp || view) && (
                    <CompareMap
                      a={cur.a}
                      b={cur.b}
                      aLabel={shortLabel(cur.a.ref.label)}
                      bLabel={shortLabel(cur.b.ref.label)}
                      causeTiles={cmpCur ? `${compareBase(version, pair.a.ref.scenario_id, pair.b.ref.scenario_id)}/tiles/{z}/{x}/{y}.png?v=${encodeURIComponent(cmpCur.generated_at)}` : null}
                      causeBounds={pair.b.tiles.bounds}
                      mode={cmpCur ? mode : "swipe"}
                      basemap={basemap}
                      bbox={bbox}
                    />
                  )}
                </div>
                <div className="cmp-side">
                  {mode === "cause" && cmpCur ? (
                    <>
                      <ul className="cause-legend">
                        {cmp.categories.map((c) => (
                          <li key={c.id}>
                            <span className="cause-swatch" style={{ background: `rgb(${c.rgba[0]},${c.rgba[1]},${c.rgba[2]})` }} aria-hidden="true" />
                            <div>
                              <strong>{c.label}</strong>
                              <span className="muted small">{c.detail}</span>
                            </div>
                            <b>{c.area_km2.toFixed(2)} km²</b>
                          </li>
                        ))}
                      </ul>
                      <p className="muted small">
                        {shortLabel(pair.b.ref.label)}에서 잠긴 {cmp.area_b_km2.toFixed(2)} km² 가운데{" "}
                        {((cmp.categories.find((c) => c.key === "urban")?.area_km2 ?? 0) / cmp.area_b_km2 * 100).toFixed(0)} %는 도시 침수로만 잠겼고, 하천
                        범람으로 잠긴 곳의{" "}
                        {((cmp.categories.find((c) => c.key === "deeper")?.area_km2 ?? 0) / cmp.area_a_km2 * 100).toFixed(0)} %가 0.1 m 이상 더
                        깊어졌습니다
                        {cmp.deeper_added_depth_m ? ` (더 깊어진 곳의 중앙값 +${cmp.deeper_added_depth_m.p50.toFixed(2)} m)` : ""}.
                      </p>
                      <p className="muted small">2 m 지형 기준 최대 수심 래스터(2D 영역)로 나눈 값이라 주요 결과 표(셀 기준)와 1~3 % 다를 수 있습니다. 하천 물은 넣지 않았습니다.</p>
                    </>
                  ) : (
                    <>
                      <p className="cmp-hint">가운데 선을 좌우로 밀면 같은 자리를 두 계산으로 비교할 수 있습니다.</p>
                      <dl className="facts">
                        <dt>{shortLabel(cur.a.ref.label)} (왼쪽)</dt>
                        <dd>{cur.a.kpi.inundation_area_km2["ge_0.1m"].toFixed(2)} km²</dd>
                        <dt>{shortLabel(cur.b.ref.label)} (오른쪽)</dt>
                        <dd>{cur.b.kpi.inundation_area_km2["ge_0.1m"].toFixed(2)} km²</dd>
                      </dl>
                      {!isBase && <p className="muted small">원인 지도(하천 범람만·도시 침수로 더 깊어짐·도시 침수만)는 기본 두 조건으로만 미리 만들어 두었습니다.</p>}
                      <p className="muted small">색은 최대 침수심 등급 (0.1–0.5 / 0.5–1 / 1–2 / 2 m 이상, 진할수록 깊음).</p>
                    </>
                  )}
                </div>
              </div>

              <h3 className="sub-head">증감표</h3>
              <div className="table-scroll">
                <table className="kpi-table">
                  <thead>
                    <tr>
                      <th scope="col">항목</th>
                      <th scope="col">{shortLabel(cur.a.ref.label)}</th>
                      <th scope="col">{shortLabel(cur.b.ref.label)}</th>
                      <th scope="col">차이</th>
                      <th scope="col">증감률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {R.map((r) => {
                      const va = r.get(cur.a);
                      const vb = r.get(cur.b);
                      const d = diff(r, va, vb);
                      return (
                        <tr key={r.key}>
                          <th scope="row">
                            {r.label}
                            {r.unit && <span className="muted"> ({r.unit})</span>}
                            {r.note && <span className="tag-note">{r.note}</span>}
                          </th>
                          <td>{cell(r, va)}</td>
                          <td>{cell(r, vb)}</td>
                          <td>{d.text}</td>
                          <td className="muted">{d.rate}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted small">
                측방 구조물 RS 7.65는 같은 입력에서도 실행마다 월류 방향이 바뀌는 불안정 구간이라 측방 구조물 값은 참고값입니다. 좌안 2D 체적오차가 커서 좌안
                제내지 수심의 신뢰도는 낮습니다 (모형 설명 참고).
              </p>
            </section>
          )}

          {list && times.length > 1 && (
            <section className="run-card" aria-labelledby="ts-title">
              <div className="run-card-head">
                <h2 id="ts-title">시간별 변화</h2>
                <span className="muted small">10분 간격 · {hhmm(times[0])}–{hhmm(times[times.length - 1])}</span>
              </div>
              <div className="chips" role="group" aria-label="겹쳐 볼 해석 조건">
                {list.map((s) => {
                  const on = picked.includes(s.ref.scenario_id);
                  return (
                    <button
                      key={s.ref.scenario_id}
                      type="button"
                      className="chip-btn"
                      aria-pressed={on}
                      onClick={() =>
                        setPicked((p) => (on ? p.filter((x) => x !== s.ref.scenario_id) : [...p, s.ref.scenario_id]))
                      }
                    >
                      <i style={{ background: colors.get(s.ref.scenario_id) }} aria-hidden="true" />
                      {shortLabel(s.ref.label)}
                    </button>
                  );
                })}
              </div>
              {shownList.length === 0 ? (
                <p className="muted">위에서 해석 조건을 하나 이상 고르세요.</p>
              ) : (
                <div className="chart-grid">
                  <LineChart title="침수면적 (0.1 m 이상)" unit="km²" digits={2} times={times} series={mk((s) => s.ts?.["inundation_area_ge_0.1m_km2"] ?? null)} />
                  <LineChart
                    title="맨홀 유입 유량 (274곳 합계)"
                    unit="m³/s"
                    digits={1}
                    times={times}
                    series={mk((s) => ((s.kpi.internal_inflow?.count ?? 0) > 0 ? s.ts?.internal_inflow_total_m3s ?? null : null))}
                    note="하천 범람만 넣은 계산에는 맨홀 유입이 없습니다"
                  />
                  <div className="chart-span">
                    <label className="field-inline">
                      <span>하천 단면</span>
                      <select value={station} onChange={(e) => setStation(e.target.value)}>
                        {keyStations.map((k) => (
                          <option key={`k-${k.rs}`} value={k.rs}>
                            {k.label}
                          </option>
                        ))}
                        <optgroup label="모든 단면 (상류 → 하류)">
                          {stations.map((rs) => (
                            <option key={rs} value={rs}>
                              RS {rs}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </label>
                  </div>
                  <LineChart
                    title={`하천 유량 · RS ${station}`}
                    unit="m³/s"
                    digits={0}
                    times={times}
                    series={mk((s) => (s.ts && stIdx >= 0 ? s.ts.river_flow_m3s.map((r) => r[stIdx]) : null))}
                  />
                  <LineChart
                    title={`하천 수위 · RS ${station}`}
                    unit="EL. m"
                    digits={2}
                    zero={false}
                    times={times}
                    series={mk((s) => (s.ts && stIdx >= 0 ? s.ts.river_ws_m.map((r) => r[stIdx]) : null))}
                  />
                  {structure && (
                    <div className="chart-span">
                      <LineChart
                        title={`측방 구조물 RS ${lateralRs(structure)} 유량 (+ 하천 → 시가지)`}
                        unit="m³/s"
                        digits={1}
                        times={times}
                        series={mk((s) => s.ts?.lateral_flow_m3s?.[structure] ?? null)}
                        note="참고값 — 계산 중 10분 값이 크게 오르내리는 구간이 있습니다"
                      />
                      <label className="field-inline">
                        <span>측방 구조물</span>
                        <select value={structure} onChange={(e) => setStructure(e.target.value)}>
                          {(list[0].kpi.lateral_structures ?? []).map((l) => (
                            <option key={l.name} value={l.name}>
                              RS {lateralRs(l.name)} ({l.to_2d_area === "left" ? "좌안" : l.to_2d_area === "right" ? "우안" : l.to_2d_area} 2D)
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {list && (
            <section className="run-card" aria-labelledby="all-title">
              <div className="run-card-head">
                <h2 id="all-title">해석 조건별 주요 결과</h2>
                <span className="muted small">
                  게시된 조건 {list.filter((s) => s.ref.run_id === undefined).length}개
                  {list.some((s) => s.ref.run_id !== undefined) && ` · 웹 계산 ${list.filter((s) => s.ref.run_id !== undefined).length}건`}
                </span>
              </div>
              <div className="table-scroll">
                <table className="kpi-table all">
                  <thead>
                    <tr>
                      <th scope="col">항목</th>
                      {list.map((s) => (
                        <th key={s.ref.scenario_id} scope="col">
                          <i className="col-key" style={{ background: colors.get(s.ref.scenario_id) }} aria-hidden="true" />
                          <a href={mapLink(s)}>{shortLabel(s.ref.label)}</a>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {R.map((r) => (
                      <tr key={r.key}>
                        <th scope="row">
                          {r.label}
                          {r.unit && <span className="muted"> ({r.unit})</span>}
                        </th>
                        {list.map((s) => (
                          <td key={s.ref.scenario_id}>{cell(r, r.get(s))}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small">조건 이름을 누르면 침수 지도에서 그 결과를 엽니다. 웹 계산은 조건 설정·실행 화면에서 요청해 끝난 것입니다.</p>
            </section>
          )}

          <footer className="panel-foot">
            HEC-RAS 6.6 1D–2D 모의 결과(모형 {version || "—"})로 실제 침수와 다를 수 있습니다.
          </footer>
        </div>
      </main>
    </div>
  );
}
