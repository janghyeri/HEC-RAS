"use client";

// F-01 2D 최대 침수심 지도 (docs/PRD.md). 지도 + 설명판(휴대폰에서는 아래 시트).
import { useCallback, useEffect, useMemo, useState } from "react";
import MapView, { type Pick } from "./MapView";
import Sparkline from "./Sparkline";
import { CellIndex } from "@/lib/cells";
import {
  OSC_MIN_COUNT,
  cellResult,
  cellSeries,
  loadDataset,
  loadFrames,
  oscillationCount,
  type Dataset,
  type Scenario,
} from "@/lib/data";
import { DEPTH_CLASSES, depthClass } from "@/lib/depth";
import { hasVworld, type Basemap } from "@/lib/basemap";
import { duration, hhmm, km2, meters, shortLabel } from "@/lib/format";

interface Selection {
  lngLat: [number, number];
  cell: number; // -1 = 모의 범위 밖
}

function scenarioNote(s: Scenario): string {
  const n = s.kpi.internal_inflow?.count ?? 0;
  return n > 0 ? `냉천 범람 + 맨홀 ${n.toLocaleString("ko-KR")}곳 월류` : "냉천 범람만";
}

function defaultScenario(list: Scenario[]): string {
  const withInternal = list.find((s) => (s.kpi.internal_inflow?.count ?? 0) > 0);
  return (withInternal ?? list[0]).ref.scenario_id;
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

  useEffect(() => {
    loadDataset()
      .then((d) => {
        setData(d);
        setActiveId(defaultScenario(d.scenarios));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const index = useMemo(() => (data ? new CellIndex(data.mesh) : null), [data]);
  const active = data?.scenarios.find((s) => s.ref.scenario_id === activeId) ?? null;

  const onPick = useCallback(
    (p: Pick) => {
      if (!index) return;
      setSel({ lngLat: p.lngLat, cell: index.find(p.lngLat[0], p.lngLat[1]) });
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
  const cls = res ? depthClass(res.maxDepth) : null;

  return (
    <div className="app">
      {data && active ? (
        <MapView
          bbox={data.mesh.info.bbox_lonlat}
          scenarios={data.scenarios}
          activeId={activeId}
          basemap={basemap}
          showManholes={showManholes}
          selectedRing={ring}
          picked={sel?.lngLat ?? null}
          onPick={onPick}
        />
      ) : (
        <div className="map map-loading" aria-busy="true">
          <span>지도 자료를 불러오는 중…</span>
        </div>
      )}

      {hasVworld() && (
        <div className="basemap-switch" role="group" aria-label="배경지도">
          <button aria-pressed={basemap === "photo"} onClick={() => setBasemap("photo")}>
            항공사진
          </button>
          <button aria-pressed={basemap === "map"} onClick={() => setBasemap("map")}>
            일반지도
          </button>
        </div>
      )}

      <aside className={`panel ${sheetOpen ? "open" : "closed"}`} aria-label="침수 정보">
        <button className="sheet-handle" onClick={() => setSheetOpen((v) => !v)} aria-expanded={sheetOpen}>
          <span className="sheet-grip" aria-hidden="true" />
          <span className="sr-only">{sheetOpen ? "정보 접기" : "정보 펼치기"}</span>
        </button>

        <header className="panel-head">
          <h1>힌남노 침수 다시보기</h1>
          <p className="muted">2022년 9월 6일 · 포항 냉천 유역 · HEC-RAS 모의 결과</p>
        </header>

        {data && (
          <div className="seg" role="radiogroup" aria-label="해석 조건">
            {data.scenarios.map((s) => (
              <button
                key={s.ref.scenario_id}
                role="radio"
                aria-checked={s.ref.scenario_id === activeId}
                onClick={() => setActiveId(s.ref.scenario_id)}
              >
                <strong>{shortLabel(s.ref.label)}</strong>
                <span>{scenarioNote(s)}</span>
              </button>
            ))}
          </div>
        )}

        {sel && active && data && (
          <section className="pick" aria-live="polite">
            <div className="pick-head">
              <h2>선택한 곳</h2>
              <button className="link" onClick={() => setSel(null)}>
                닫기
              </button>
            </div>
            {sel.cell < 0 ? (
              <p className="muted">모의 범위(2D 계산 격자) 밖입니다. 냉천 주변 시가지를 눌러 보세요.</p>
            ) : res && res.maxDepth >= 0.1 ? (
              <>
                <div className="pick-main">
                  <span className="swatch" style={{ background: cls?.color }} aria-hidden="true" />
                  <div>
                    <strong className="big">{meters(res.maxDepth)}</strong>
                    <span className="muted"> 최대 수심 · {cls?.body}</span>
                  </div>
                </div>
                <dl className="facts">
                  <dt>가장 깊었던 시각</dt>
                  <dd>{hhmm(res.peakTime)}</dd>
                  <dt>0.3 m 이상 잠긴 시간</dt>
                  <dd>{duration(res.durationSec)}</dd>
                </dl>
                {series === null ? (
                  <p className="muted small">시간별 수심을 불러오는 중…</p>
                ) : series.length > 0 ? (
                  <>
                    <Sparkline times={active.meta.frames.times} values={series} />
                    {oscillationCount(series) >= OSC_MIN_COUNT && (
                      <p className="warn small">
                        <strong>주의</strong> 이 격자는 계산 중 수심이 10분 간격으로 크게 오르내리는 수치 진동이 있습니다. 최대 수심이
                        실제보다 크게 나왔을 수 있습니다.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="muted small">시간별 수심을 불러오지 못했습니다.</p>
                )}
                <p className="muted small">
                  값은 이 계산 격자(면적 {Math.round(res.area)} m²) 안 젖은 부분의 평균 수심입니다. 지도 색(2 m 지형 기준)과 조금
                  다를 수 있습니다.
                </p>
              </>
            ) : (
              <p className="muted">이 격자는 이 조건의 모의에서 0.1 m 이상 잠기지 않았습니다.</p>
            )}
          </section>
        )}

        {k && (
          <section aria-label="요약">
            <dl className="stats">
              <div>
                <dt>잠긴 면적 (0.1 m 이상)</dt>
                <dd>{km2(k.inundation_area_km2["ge_0.1m"])}</dd>
              </div>
              <div>
                <dt>침수 시작</dt>
                <dd>{hhmm(k.onset_time)}</dd>
              </div>
              <div>
                <dt>가장 넓게 잠긴 때</dt>
                <dd>
                  {hhmm(k.peak_instant_area.time)} <span className="muted small">{km2(k.peak_instant_area.km2)}</span>
                </dd>
              </div>
              <div>
                <dt>깊은 곳 수심 (상위 1 %)</dt>
                <dd>{meters(k.max_depth_m.p99_of_flooded, 1)}</dd>
              </div>
            </dl>
          </section>
        )}

        <section className="legend" aria-label="범례">
          <h2>최대 수심</h2>
          <ul>
            {DEPTH_CLASSES.map((c) => (
              <li key={c.range}>
                <span className="swatch" style={{ background: c.color }} aria-hidden="true" />
                <span className="legend-range">{c.range}</span>
                <span className="muted">{c.body}</span>
              </li>
            ))}
          </ul>
          {active?.hasManholes && (
            <label className="check">
              <input type="checkbox" checked={showManholes} onChange={(e) => setShowManholes(e.target.checked)} />
              <span className="dot" aria-hidden="true" /> 맨홀 월류 지점 보기
            </label>
          )}
          <p className="muted small">지도를 누르면 그 자리의 최대 수심과 시간별 변화를 볼 수 있습니다.</p>
        </section>

        <footer className="panel-foot">
          <p>
            모의 결과이며 실제 침수 흔적과 다를 수 있습니다. 모형 {data?.version ?? "—"} · 모의 시간{" "}
            {active ? `${hhmm(active.meta.frames.times[0])}–${hhmm(active.meta.frames.times.at(-1))}` : "—"}
          </p>
          <p>{hasVworld() ? "배경지도 © 국토교통부 브이월드" : "배경지도 © OpenStreetMap"}</p>
          {data && (
            <details>
              <summary>모형의 한계</summary>
              <ul>
                {data.model.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </details>
          )}
        </footer>
      </aside>
    </div>
  );
}
