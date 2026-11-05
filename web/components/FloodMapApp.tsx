"use client";

// F-01 2D 최대 침수심 지도 (docs/PRD.md). 디자인 최종안(2026-11-02): 위쪽 남색 머리글은 A안, 내용은 최종안
// (해석 조건 · 주요 결과 표 · 시간별 침수면적 그래프 · 사람 키 범례). 휴대폰은 아래 시트, PC는 왼쪽 정보판.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView, { type Pick } from "./MapView";
import Sparkline from "./Sparkline";
import AreaChart from "./AreaChart";
import PersonLevel from "./PersonLevel";
import SearchBox, { type Place } from "./SearchBox";
import AboutDialog, { SAFETY_GUIDE_URL } from "./AboutDialog";
import TopBar from "./TopBar";
import { CellIndex } from "@/lib/cells";
import { loadRiver, riverAt, type RiverData } from "@/lib/river";
import {
  OSC_MIN_COUNT,
  baseOf,
  cellResult,
  cellSeries,
  frameCorners,
  frameUrl,
  loadFramesInfo,
  loadDataset,
  loadFrames,
  loadScenario,
  loadTimeseries,
  manholeFactor,
  oscillationCount,
  runRef,
  type BBox,
  type Dataset,
  type FramesInfo,
  type Scenario,
  type Timeseries,
} from "@/lib/data";
import { describeParams } from "@/lib/runConfig";
import { getRun, hasSupabase, resultsUrlBase } from "@/lib/supabase";
import { DEPTH_CLASSES, depthClass } from "@/lib/depth";
import { hasVworld, type Basemap } from "@/lib/basemap";
import { duration, hhmm, km2, meters, shortLabel } from "@/lib/format";
import { loadReferenceIndex, loadTraces, traceAt, traceDepthText, type RefLayer, type TraceCollection } from "@/lib/reference";

interface Selection {
  lngLat: [number, number];
  cell: number; // -1 = 모의 범위 밖
  title?: string; // 검색으로 고른 곳 이름
}

const LEGEND_LEVEL = [0.5, 1.0, 1.6, 2.2]; // 범례 그림 속 물 높이 (m) — 각 등급의 윗부분

const RUN_STATUS: Record<string, string> = { queued: "대기 중", running: "계산 중", failed: "실패", canceled: "취소됨" };

/**
 * 주소의 ?run=<번호> — 웹에서 요청한 계산 결과를 Supabase Storage에서 읽어 시나리오 목록에 더한다.
 * 지도는 처음 만들 때 시나리오 타일을 모두 등록하므로, 자료를 화면에 넘기기 전에 불러 둔다.
 */
async function withRequestedRun(d: Dataset): Promise<{ data: Dataset; runId: string | null; note: string | null }> {
  const id = Number(new URLSearchParams(location.search).get("run"));
  if (!Number.isInteger(id) || id <= 0) return { data: d, runId: null, note: null };
  if (!hasSupabase()) return { data: d, runId: null, note: "계산 결과 서버(Supabase) 설정이 없어 계산 결과를 불러오지 못했습니다." };
  try {
    const row = await getRun(id);
    if (!row) return { data: d, runId: null, note: `계산 ${id}번을 찾지 못했습니다.` };
    if (row.status !== "done" || !row.files_prefix)
      return { data: d, runId: null, note: `계산 ${id}번은 아직 결과가 없습니다 (${RUN_STATUS[row.status] ?? row.status}).` };
    if (row.model_version !== d.version)
      return { data: d, runId: null, note: `계산 ${id}번은 모형 ${row.model_version} 결과라 지금 지도(모형 ${d.version})와 함께 보이지 않습니다.` };
    const sc = await loadScenario(runRef(row, resultsUrlBase(), d.model.run));
    return { data: { ...d, scenarios: [...d.scenarios, sc] }, runId: sc.ref.scenario_id, note: null };
  } catch (e) {
    return { data: d, runId: null, note: `계산 ${id}번 결과를 불러오지 못했습니다 (${e instanceof Error ? e.message : String(e)}).` };
  }
}

function defaultScenario(list: Scenario[]): string {
  // 처음 화면: 바꾼 입력이 없는(실제 사건 재현) 조건 가운데 도시 침수(맨홀)를 넣은 것
  const withInternal = list.find((s) => !s.ref.params && (s.kpi.internal_inflow?.count ?? 0) > 0);
  return (withInternal ?? list[0]).ref.scenario_id;
}

function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M14 4h6v6M20 4l-9 9M19 14v6H4V5h6" />
    </svg>
  );
}

export default function FloodMapApp() {
  const [data, setData] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState("");
  const [basemap, setBasemap] = useState<Basemap>(hasVworld() ? "photo" : "map");
  const [showManholes, setShowManholes] = useState(false);
  const [sel, setSel] = useState<Selection | null>(null);
  const [series, setSeries] = useState<number[] | null>(null);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [traceLayer, setTraceLayer] = useState<RefLayer | null>(null);
  const [traces, setTraces] = useState<TraceCollection | null>(null);
  const [showTraces, setShowTraces] = useState(false);
  const [ts, setTs] = useState<Timeseries | null>(null);
  const [river, setRiver] = useState<RiverData | null>(null);
  const [about, setAbout] = useState(false);
  const [focus, setFocus] = useState<{ lngLat: [number, number]; zoom: number; seq: number } | null>(null);
  const [runNote, setRunNote] = useState<string | null>(null);
  // 시간대별 재생 (10분 침수심 이미지). frameIdx = null 이면 최대 침수심 지도
  const [framesInfo, setFramesInfo] = useState<FramesInfo | null>(null);
  const [frameIdx, setFrameIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const preloaded = useRef<string>("");

  // 비교용 실제 침수흔적 (있을 때만)
  useEffect(() => {
    loadReferenceIndex()
      .then((layers) => {
        const l = layers[0];
        if (!l) return;
        setTraceLayer(l);
        return loadTraces(l).then(setTraces);
      })
      .catch(() => setTraces(null));
  }, []);

  useEffect(() => {
    loadDataset()
      .then(withRequestedRun)
      .then(({ data: d, runId, note }) => {
        setData(d);
        // ?s=<시나리오 ID> 로 미리 계산된 조건을 바로 열 수 있다 (/run 에서 같은 조건을 찾았을 때)
        const want = new URLSearchParams(location.search).get("s");
        setActiveId(runId ?? (d.scenarios.some((s) => s.ref.scenario_id === want) ? (want as string) : defaultScenario(d.scenarios)));
        setRunNote(note);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const index = useMemo(() => (data ? new CellIndex(data.mesh) : null), [data]);
  const active = data?.scenarios.find((s) => s.ref.scenario_id === activeId) ?? null;
  const internalCount = Math.max(0, ...(data?.scenarios.map((s) => s.kpi.internal_inflow?.count ?? 0) ?? [0]));
  // 해석 조건 묶음: 기준 시나리오(하천 범람 / 하천 범람 + 도시 침수)별로, 안에서는 맨홀 월류량 배율 순서.
  // 웹에서 요청한 계산(run_id)은 여러 입력을 바꿀 수 있어 배율 줄과 따로 '웹 계산' 줄에 둔다.
  const groups = useMemo(() => {
    const m = new Map<string, Scenario[]>();
    for (const s of data?.scenarios ?? []) {
      const k = baseOf(s.ref);
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return [...m.entries()].map(([base, all]) => {
      const list = all.filter((s) => s.ref.run_id === undefined);
      return {
        base,
        list: [...list].sort((a, b) => manholeFactor(a.ref) - manholeFactor(b.ref)),
        runs: all.filter((s) => s.ref.run_id !== undefined),
        main: list.find((s) => !s.ref.params) ?? list[0] ?? all[0],
      };
    });
  }, [data]);
  const activeGroup = active ? groups.find((g) => g.base === baseOf(active.ref)) ?? null : null;

  // 냉천 하천 단면 (하천 구간을 눌렀을 때)
  useEffect(() => {
    setRiver(null);
    if (!active) return;
    let stale = false;
    loadRiver(active.ref).then((r) => {
      if (!stale) setRiver(r);
    });
    return () => {
      stale = true;
    };
  }, [active]);

  // 10분 침수심 이미지 설명 (없으면 재생 버튼을 숨김)
  useEffect(() => {
    setFramesInfo(null);
    if (!active) return;
    let stale = false;
    loadFramesInfo(active.ref).then((f) => {
      if (!stale) setFramesInfo(f);
    });
    return () => {
      stale = true;
    };
  }, [active]);

  // 재생: 0.5초에 10분씩, 끝나면 멈춤
  useEffect(() => {
    if (!playing || !framesInfo) return;
    const t = setInterval(() => {
      setFrameIdx((i) => {
        const next = i === null ? 0 : i + 1;
        if (next >= framesInfo.count - 1) setPlaying(false);
        return Math.min(next, framesInfo.count - 1);
      });
    }, 500);
    return () => clearInterval(t);
  }, [playing, framesInfo]);

  // 처음 시간대별로 볼 때 이미지 70장을 미리 받아 둔다 (재생이 끊기지 않게)
  useEffect(() => {
    if (!active || !framesInfo || frameIdx === null) return;
    const key = `${active.ref.scenario_id}|${framesInfo.generated_at}`;
    if (preloaded.current === key) return;
    preloaded.current = key;
    for (let i = 0; i < framesInfo.count; i++) {
      const img = new Image();
      img.src = frameUrl(active.ref, framesInfo, i);
    }
  }, [active, framesInfo, frameIdx]);

  // 시간별 침수면적
  useEffect(() => {
    setTs(null);
    if (!active) return;
    let stale = false;
    loadTimeseries(active.ref).then((t) => {
      if (!stale) setTs(t);
    });
    return () => {
      stale = true;
    };
  }, [active]);

  const onPick = useCallback(
    (p: Pick) => {
      if (!index) return;
      setSel({ lngLat: p.lngLat, cell: index.find(p.lngLat[0], p.lngLat[1]) });
      setSheetOpen(true);
    },
    [index],
  );

  const onPlace = useCallback(
    (p: Place) => {
      if (!index) return;
      setSel({ lngLat: [p.lon, p.lat], cell: index.find(p.lon, p.lat), title: p.title });
      setFocus((f) => ({ lngLat: [p.lon, p.lat], zoom: 16, seq: (f?.seq ?? 0) + 1 }));
      setSheetOpen(true);
    },
    [index],
  );

  // 선택한 격자의 시간별 수심 (프레임 파일은 처음 누를 때 내려받음)
  useEffect(() => {
    setSeries(null);
    if (!data || !active || !sel || sel.cell < 0) return;
    let stale = false;
    loadFrames(active.ref)
      .then((f) => {
        if (!stale) setSeries(cellSeries(active, f, data.mesh.info.n_cells, sel.cell));
      })
      .catch(() => {
        if (!stale) setSeries([]);
      });
    return () => {
      stale = true;
    };
  }, [data, active, sel]);

  const ring = useMemo(() => (index && sel && sel.cell >= 0 ? index.ring(sel.cell) : null), [index, sel]);

  // 처음 화면: 격자 전체가 아니라 가장 넓게 잠긴 조건의 침수 범위(0.1 m 이상 셀)에 맞춘다
  const viewBbox = useMemo((): BBox | null => {
    if (!data) return null;
    const { mesh } = data;
    const s = [...data.scenarios].sort((a, b) => b.kpi.inundation_area_km2["ge_0.1m"] - a.kpi.inundation_area_km2["ge_0.1m"])[0];
    const step = s.meta.quantization.depth_step_m;
    const sc = mesh.info.coordinate_scale;
    let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity;
    for (let i = 0; i < mesh.info.n_cells; i++) {
      if (s.cellsMax[i] * step < 0.1) continue;
      for (let k = mesh.offsets[i]; k < mesh.offsets[i + 1]; k++) {
        const x = mesh.vertices[2 * k] / sc, y = mesh.vertices[2 * k + 1] / sc;
        if (x < w) w = x;
        if (x > e) e = x;
        if (y < so) so = y;
        if (y > n) n = y;
      }
    }
    return Number.isFinite(w) ? [w, so, e, n] : mesh.info.bbox_lonlat;
  }, [data]);

  if (error) {
    return (
      <main className="fallback">
        <h1>힌남노 침수 다시보기</h1>
        <p>자료를 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.</p>
        <p className="muted small">{error}</p>
      </main>
    );
  }

  const k = active?.kpi;
  const res = data && active && sel && sel.cell >= 0 ? cellResult(active, data.mesh, sel.cell) : null;
  // 2D 격자 밖이면 하천 구간인지 본다
  const rp = sel && sel.cell < 0 && river ? riverAt(river, sel.lngLat[0], sel.lngLat[1]) : null;
  const riverWs = rp && ts && ts.river_ws_m.length ? ts.river_ws_m.map((row) => row[rp.up] * (1 - rp.w) + row[rp.up + 1] * rp.w) : null;
  const riverDepth = riverWs && rp?.bed != null ? riverWs.map((v) => Math.max(0, v - (rp.bed as number))) : null;
  const riverPeak = riverWs ? riverWs.indexOf(Math.max(...riverWs)) : -1;
  const cls = res ? depthClass(res.maxDepth) : null;
  const traceHere = traces && sel ? traceAt(traces, sel.lngLat[0], sel.lngLat[1]) : null;
  const areaSeries = ts?.["inundation_area_ge_0.1m_km2"] ?? null;
  const onsetHere = series && series.length ? series.findIndex((v) => v >= 0.1) : -1;
  const compare =
    data && sel && sel.cell >= 0
      ? data.scenarios.map((s) => ({ s, d: cellResult(s, data.mesh, sel.cell).maxDepth }))
      : [];
  const compareMax = Math.max(0.1, ...compare.map((c) => c.d));
  const toggleBasemap = () => setBasemap((b) => (b === "photo" ? "map" : "photo"));

  const legendItems = DEPTH_CLASSES.map((c, i) => ({ ...c, level: LEGEND_LEVEL[i] ?? c.lo }));

  const timeMode = frameIdx !== null && framesInfo !== null;
  const frame = timeMode && active && framesInfo ? { url: frameUrl(active.ref, framesInfo, frameIdx as number), corners: frameCorners(framesInfo) } : null;
  const togglePlay = () => {
    if (!framesInfo) return;
    if (playing) return setPlaying(false);
    if (frameIdx === null || frameIdx >= framesInfo.count - 1) setFrameIdx(0);
    setPlaying(true);
  };
  const playBtn = framesInfo ? (
    <button type="button" className="play-btn" onClick={togglePlay} aria-label={playing ? "멈춤" : "시간대별 재생"} title={playing ? "멈춤" : "02:00부터 10분씩 재생"}>
      {playing ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M7 4l13 8-13 8z" />
        </svg>
      )}
    </button>
  ) : null;
  const maxBtn = timeMode ? (
    <button
      type="button"
      className="link-btn max-btn"
      onClick={() => {
        setPlaying(false);
        setFrameIdx(null);
      }}
    >
      최대 침수심 보기
    </button>
  ) : null;
  const pick = framesInfo
    ? (i: number) => {
        setPlaying(false);
        setFrameIdx(i);
      }
    : undefined;
  const timelineWide =
    areaSeries && active ? (
      <AreaChart times={active.meta.frames.times} values={areaSeries} height={56} current={timeMode ? frameIdx : null} onPick={pick} lead={playBtn} tail={maxBtn} />
    ) : null;
  const timelineNarrow =
    areaSeries && active ? (
      <AreaChart times={active.meta.frames.times} values={areaSeries} height={44} compact current={timeMode ? frameIdx : null} onPick={pick} lead={playBtn} tail={maxBtn} />
    ) : null;
  const legendTitle = timeMode && active ? `침수심 (m) · ${hhmm(active.meta.frames.times[frameIdx as number])}` : "최대 침수심 (m)";

  return (
    <div className="app">
      <TopBar current="map" onAbout={() => setAbout(true)} />

      {/* ---------- 지도 ---------- */}
      <main id="map" className="stage" aria-label="침수 지도">
        {data && active ? (
          <MapView
            bbox={viewBbox ?? data.mesh.info.bbox_lonlat}
            scenarios={data.scenarios}
            activeId={activeId}
            basemap={basemap}
            showManholes={showManholes}
            traces={traces}
            showTraces={showTraces}
            selectedRing={ring}
            picked={sel?.lngLat ?? null}
            onPick={onPick}
            focus={focus}
            onToggleBasemap={toggleBasemap}
            frame={frame}
          />
        ) : (
          <div className="map map-loading" aria-busy="true">
            <span>지도 자료를 불러오는 중…</span>
          </div>
        )}

        <SearchBox className="search-float narrow-only" bbox={data?.mesh.info.bbox_lonlat ?? null} onSelect={onPlace} />

        {hasVworld() && (
          <div className="basemap-switch wide-only" role="group" aria-label="배경지도">
            <button type="button" aria-pressed={basemap === "photo"} onClick={() => setBasemap("photo")}>
              항공사진
            </button>
            <button type="button" aria-pressed={basemap === "map"} onClick={() => setBasemap("map")}>
              일반지도
            </button>
          </div>
        )}

        <div className="map-legend narrow-only" aria-label="최대 침수심 범례">
          <span className="map-legend-title">{legendTitle}</span>
          {DEPTH_CLASSES.map((c) => (
            <span key={c.range} className="map-legend-row">
              <span className="chip" style={{ background: c.color }} aria-hidden="true" />
              <span className="map-legend-range">{c.range.replace(" m", "")}</span>
              <span className="muted">{c.body}</span>
            </span>
          ))}
        </div>

        {timelineWide && (
          <section className="timeline-card wide-only" aria-label="시간별 침수면적">
            {timelineWide}
          </section>
        )}
      </main>

      {/* ---------- 정보판 (휴대폰: 아래 시트) ---------- */}
      <aside className={`panel ${sheetOpen ? "open" : "closed"}`} aria-label="침수 정보">
        <button type="button" className="sheet-handle" onClick={() => setSheetOpen((v) => !v)} aria-expanded={sheetOpen}>
          <span className="sheet-grip" aria-hidden="true" />
          <span className="sr-only">{sheetOpen ? "정보 접기" : "정보 펼치기"}</span>
        </button>

        <SearchBox className="wide-only" bbox={data?.mesh.info.bbox_lonlat ?? null} onSelect={onPlace} />

        {sel && active && data && (
          <section className="pick" aria-live="polite" aria-label="선택한 곳의 침수 정보">
            <div className="pick-head">
              <div>
                <h2>{sel.title ?? "선택한 곳"}</h2>
                <span className="tag">{shortLabel(active.ref.label)}</span>
              </div>
              <button type="button" className="icon-btn" onClick={() => setSel(null)} aria-label="선택한 곳 닫기">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            {sel.cell < 0 && rp ? (
              <div className="river-info">
                <p className="river-head">
                  <strong>냉천 하천 구간</strong>
                  <span className="muted small"> · 단면 RS {rp.rs} 부근 (1D 계산)</span>
                </p>
                <dl className="facts">
                  <dt>최고 수위</dt>
                  <dd>
                    {rp.maxWs !== null ? `EL. ${rp.maxWs.toFixed(2)} m` : "—"}
                    {riverPeak >= 0 && ` (${hhmm(active.meta.frames.times[riverPeak])})`}
                  </dd>
                  <dt>하상 높이</dt>
                  <dd>{rp.bed !== null ? `EL. ${rp.bed.toFixed(2)} m` : "—"}</dd>
                  <dt>최대 수심</dt>
                  <dd>{rp.maxWs !== null && rp.bed !== null ? meters(rp.maxWs - rp.bed) : "—"}</dd>
                  <dt>둑 높이 (주수로 경계, 낮은 쪽)</dt>
                  <dd>{rp.bankLow !== null ? `EL. ${rp.bankLow.toFixed(2)} m` : "—"}</dd>
                  <dt>최고 수위와 둑</dt>
                  <dd>
                    {rp.maxWs === null || rp.bankLow === null
                      ? "—"
                      : rp.maxWs > rp.bankLow
                        ? `둑보다 ${(rp.maxWs - rp.bankLow).toFixed(2)} m 높음 — 물이 넘침`
                        : `둑까지 ${(rp.bankLow - rp.maxWs).toFixed(2)} m 남음`}
                  </dd>
                </dl>
                {riverDepth && rp.bed !== null && rp.bankLow !== null && (
                  <>
                    <span className="sub-title">시간별 하천 수심 (하상 기준)</span>
                    <Sparkline
                      times={active.meta.frames.times}
                      values={riverDepth}
                      threshold={Math.round((rp.bankLow - rp.bed) * 100) / 100}
                      thresholdLabel="둑 높이"
                      fitThreshold
                      name="하천 수심"
                    />
                  </>
                )}
                <p className="muted small">단면 수위를 단면 사이에 거리로 보간한 값입니다. 하천 물은 침수면적에 넣지 않습니다.</p>
              </div>
            ) : sel.cell < 0 ? (
              <p className="muted">모의 범위(2D 계산 격자·하천 구간) 밖입니다. 냉천과 주변 시가지를 눌러 보세요.</p>
            ) : res && res.maxDepth >= 0.1 ? (
              <>
                <div className="pick-main">
                  <PersonLevel
                    depth={res.maxDepth}
                    color={cls?.color ?? "#1c5cab"}
                    width={40}
                    height={100}
                    label={`성인 키 1.8 m 기준 수위 표시, ${cls?.body ?? ""}`}
                  />
                  <div>
                    <span className="muted">최대 침수심</span>
                    <strong className="big">{meters(res.maxDepth)}</strong>
                    <span className="muted small class-line">
                      <span className="chip" style={{ background: cls?.color }} aria-hidden="true" />
                      {cls?.range} 등급 · {cls?.body}
                    </span>
                  </div>
                </div>
                <dl className="facts">
                  {timeMode && series && series.length > 0 && (
                    <>
                      <dt>{hhmm(active.meta.frames.times[frameIdx as number])} 수심</dt>
                      <dd>{series[frameIdx as number] >= 0.1 ? meters(series[frameIdx as number]) : "0.1 m 미만"}</dd>
                    </>
                  )}
                  <dt>침수 시작 시각</dt>
                  <dd>{series === null ? "…" : onsetHere >= 0 ? hhmm(active.meta.frames.times[onsetHere]) : "—"}</dd>
                  <dt>최대 침수 시각</dt>
                  <dd>{hhmm(res.peakTime)}</dd>
                  <dt>0.3 m 이상 침수 지속시간</dt>
                  <dd>{duration(res.durationSec)}</dd>
                </dl>
                {compare.length > 1 && (
                  <div className="compare">
                    <span className="sub-title">해석 조건별 최대 침수심</span>
                    {compare.map(({ s, d }) => (
                      <div key={s.ref.scenario_id} className="compare-row">
                        <span>{shortLabel(s.ref.label)}</span>
                        <span className="bar" aria-hidden="true">
                          <span style={{ width: `${(d / compareMax) * 100}%`, background: depthClass(d)?.color ?? "#C9D2DB" }} />
                        </span>
                        <strong>{d >= 0.1 ? meters(d) : "0.1 m 미만"}</strong>
                      </div>
                    ))}
                  </div>
                )}
                {series === null ? (
                  <p className="muted small">시간별 수심을 불러오는 중…</p>
                ) : series.length > 0 ? (
                  <>
                    <span className="sub-title">시간별 침수심</span>
                    <Sparkline times={active.meta.frames.times} values={series} />
                    {oscillationCount(series) >= OSC_MIN_COUNT && (
                      <p className="warn small">
                        <strong>주의</strong> 이 격자는 계산 중 수심이 10분 간격으로 크게 오르내리는 수치 진동이 있습니다. 최대 침수심이
                        실제보다 크게 나왔을 수 있습니다.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="muted small">시간별 수심을 불러오지 못했습니다.</p>
                )}
                <p className="muted small">
                  계산 격자(면적 {Math.round(res.area)} m²) 안 젖은 부분의 평균 수심입니다. 지도 색(2 m 지형 기준)과 조금 다를 수
                  있습니다.
                </p>
              </>
            ) : (
              <p className="muted">이 격자는 이 조건의 모의에서 0.1 m 이상 잠기지 않았습니다.</p>
            )}
            {traces && traceLayer && sel.cell >= 0 && (
              <p className="trace-note small">
                <span className="swatch-trace" aria-hidden="true" />
                {traceHere ? (
                  <>
                    실제 침수흔적 구역입니다
                    {traceDepthText(traceHere.FLDN_DOWA) ? ` · 기록된 침수심 ${traceDepthText(traceHere.FLDN_DOWA)}` : ""}
                    {traceHere.FLDN_DST_NM ? ` · ${traceHere.FLDN_DST_NM}` : ""}
                  </>
                ) : (
                  "실제 침수흔적 구역 밖입니다"
                )}
                <span className="muted"> (출처: {traceLayer.source.name})</span>
              </p>
            )}
          </section>
        )}

        {data && (
          <section className="cond" aria-labelledby="cond-title">
            <h2 id="cond-title" className="wide-only">
              해석 조건
            </h2>
            <div className="seg" role="radiogroup" aria-label="해석 조건">
              {groups.map((g) => (
                <button
                  key={g.base}
                  type="button"
                  role="radio"
                  aria-checked={activeGroup?.base === g.base}
                  onClick={() => setActiveId(g.main.ref.scenario_id)}
                >
                  {shortLabel(g.main.ref.label)}
                </button>
              ))}
            </div>
            {activeGroup && activeGroup.list.length > 1 && (
              <div className="factor">
                <span id="factor-title">맨홀 월류량</span>
                <div
                  className="seg"
                  role="radiogroup"
                  aria-labelledby="factor-title"
                  style={{ gridTemplateColumns: `repeat(${activeGroup.list.length}, minmax(0, 1fr))` }}
                >
                  {activeGroup.list.map((s) => {
                    const f = manholeFactor(s.ref);
                    return (
                      <button
                        key={s.ref.scenario_id}
                        type="button"
                        role="radio"
                        aria-checked={s.ref.scenario_id === activeId}
                        aria-label={`맨홀 월류량 ${f}배${s.ref.params ? " (가정)" : " (힌남노 계산값)"}`}
                        onClick={() => setActiveId(s.ref.scenario_id)}
                      >
                        ×{f}
                        {!s.ref.params && <small> 실제</small>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {activeGroup && activeGroup.runs.length > 0 && (
              <div className="factor">
                <span id="run-title">웹 계산</span>
                <div
                  className="seg"
                  role="radiogroup"
                  aria-labelledby="run-title"
                  style={{ gridTemplateColumns: `repeat(${activeGroup.runs.length}, minmax(0, 1fr))` }}
                >
                  {activeGroup.runs.map((s) => (
                    <button
                      key={s.ref.scenario_id}
                      type="button"
                      role="radio"
                      aria-checked={s.ref.scenario_id === activeId}
                      aria-label={`웹에서 요청한 계산 ${s.ref.run_id}번`}
                      onClick={() => setActiveId(s.ref.scenario_id)}
                    >
                      계산 {s.ref.run_id}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="cond-note">
              하천 범람: 냉천 월류 · 도시 침수: 맨홀 {internalCount.toLocaleString("ko-KR")}곳 월류 유량을 함께 넣어 계산
              {activeGroup && activeGroup.list.length > 1 && " · 맨홀 월류량: 힌남노 때 계산한 맨홀 유량에 곱한 배율 (×1이 실제 사건, 나머지는 가정)"}
            </p>
            {active?.ref.run_id !== undefined && (
              <p className="cond-note">
                <strong>계산 {active.ref.run_id}</strong> 바꾼 조건: {describeParams(data.model.run ?? { bases: {}, params: [] }, active.ref.params) || "없음 (힌남노 조건 그대로)"}{" "}
                · <a href="/run">조건 설정·실행</a>
              </p>
            )}
            {runNote && <p className="warn small">{runNote}</p>}
          </section>
        )}

        {k && (
          <section aria-labelledby="kpi-title">
            <h2 id="kpi-title" className="wide-only">
              주요 결과
            </h2>
            <dl className="kpi">
              <div>
                <dt>침수면적 (0.1 m 이상)</dt>
                <dd>{km2(k.inundation_area_km2["ge_0.1m"])}</dd>
              </div>
              <div>
                <dt>침수 시작 시각</dt>
                <dd>{hhmm(k.onset_time)}</dd>
              </div>
              <div>
                <dt>최대 침수 시각</dt>
                <dd>
                  {hhmm(k.peak_instant_area.time)} <span className="kpi-sub">{km2(k.peak_instant_area.km2)}</span>
                </dd>
              </div>
              <div>
                <dt>최대 침수심 (상위 1 %)</dt>
                <dd>{meters(k.max_depth_m.p99_of_flooded, 1)}</dd>
              </div>
              {k["duration_ge_0.3m"] && (
                <div className="wide-only-flex">
                  <dt>0.3 m 이상 1시간 넘게 침수</dt>
                  <dd>{km2(k["duration_ge_0.3m"].area_km2_ge_1h)}</dd>
                </div>
              )}
            </dl>
          </section>
        )}

        {timelineNarrow && (
          <section className="narrow-only timeline-sheet" aria-label="시간별 침수면적">
            {timelineNarrow}
          </section>
        )}

        <section className="legend wide-only" aria-labelledby="legend-title">
          <h2 id="legend-title">{timeMode ? `${legendTitle.replace(" (m)", "")} 범례` : "최대 침수심 범례"}</h2>
          <ul>
            {legendItems.map((c) => (
              <li key={c.range}>
                <PersonLevel depth={c.level} color={c.color} />
                <strong>{c.range}</strong>
                <span className="muted">{c.body}</span>
              </li>
            ))}
          </ul>
          {active?.tiles.includes_river && (
            <p className="muted small">냉천 물길(하천 구간)도 같은 색으로 그렸습니다. 하천 물은 침수면적에 넣지 않습니다.</p>
          )}
        </section>

        {(active?.hasManholes || (traceLayer && traces)) && (
          <section className="layers" aria-label="지도에 함께 보기">
            {active?.hasManholes && (
              <label className="check">
                <input type="checkbox" checked={showManholes} onChange={(e) => setShowManholes(e.target.checked)} />
                <span className="dot" aria-hidden="true" /> 맨홀 월류 지점 보기
              </label>
            )}
            {traceLayer && traces && (
              <>
                <label className="check">
                  <input type="checkbox" checked={showTraces} onChange={(e) => setShowTraces(e.target.checked)} />
                  <span className="swatch-trace" aria-hidden="true" /> {traceLayer.label} 보기
                </label>
                {showTraces && (
                  <p className="muted small source-line">
                    출처: {traceLayer.source.provider}, {traceLayer.source.name} ({traceLayer.source.license}). {traceLayer.source.note}
                  </p>
                )}
              </>
            )}
          </section>
        )}

        <div className="actions">
          <a className="btn-outline" href={SAFETY_GUIDE_URL} target="_blank" rel="noreferrer">
            국민행동요령 <ExternalIcon />
          </a>
          <button type="button" className="btn-outline" onClick={() => setAbout(true)}>
            모형 설명
          </button>
          {!sel && <span className="muted small hint">지도를 누르면 그 자리의 침수심을 볼 수 있습니다</span>}
        </div>

        <footer className="panel-foot">
          HEC-RAS 1D–2D 모의 결과(모형 {data?.version ?? "—"})로 실제 침수와 다를 수 있습니다 ·{" "}
          {hasVworld() ? "배경지도 © 국토교통부 브이월드" : "배경지도 © OpenStreetMap"}
          {traceLayer && <> · 침수흔적 © 행정안전부</>}
        </footer>
      </aside>

      <AboutDialog
        open={about}
        onClose={() => setAbout(false)}
        model={data?.model ?? null}
        version={data?.version ?? null}
        traceLayer={traceLayer}
        manholes={internalCount}
      />
    </div>
  );
}
