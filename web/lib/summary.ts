// 분석·비교 화면 자료: 시나리오마다 kpi.json·meta.json·tiles.json·timeseries.json (격자 파일은 받지 않는다).
// 게시된 시나리오(/data) + 웹에서 계산한 결과(Supabase Storage, 완료된 것) — 새 계산이 끝나면 다시 열 때 함께 보인다.
import {
  DATA_ROOT,
  loadIndex,
  loadModelInfo,
  runRef,
  scenarioUrl,
  type KpiFull,
  type ModelInfo,
  type ScenarioMeta,
  type ScenarioRef,
  type TilesInfo,
  type Timeseries,
} from "./data";
import { hasSupabase, listRuns, resultsUrlBase } from "./supabase";

export interface Summary {
  ref: ScenarioRef;
  kpi: KpiFull;
  meta: ScenarioMeta;
  tiles: TilesInfo;
  ts: Timeseries | null;
}

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} 응답 ${r.status}`);
  return (await r.json()) as T;
}

export async function loadSummary(ref: ScenarioRef): Promise<Summary> {
  const [kpi, meta, tiles, ts] = await Promise.all([
    json<KpiFull>(scenarioUrl(ref, "kpi.json")),
    json<ScenarioMeta>(scenarioUrl(ref, "meta.json")),
    json<TilesInfo>(scenarioUrl(ref, "tiles/tiles.json")),
    json<Timeseries>(scenarioUrl(ref, "timeseries.json")).catch(() => null),
  ]);
  return { ref, kpi, meta, tiles, ts };
}

export async function loadSummaries(): Promise<{ version: string; model: ModelInfo; list: Summary[] }> {
  const { version, refs } = await loadIndex();
  const [model, list] = await Promise.all([loadModelInfo(version), Promise.all(refs.map(loadSummary))]);
  return { version, model, list };
}

/** 웹에서 계산이 끝난 결과 (최근 것부터 limit건). Supabase 설정이 없거나 실패하면 빈 목록 */
export async function loadRunSummaries(version: string, model: ModelInfo, limit = 6): Promise<Summary[]> {
  if (!hasSupabase()) return [];
  try {
    const rows = (await listRuns(version, 30)).filter((r) => r.status === "done" && r.files_prefix).slice(0, limit);
    const out = await Promise.all(rows.map((r) => loadSummary(runRef(r, resultsUrlBase(), model.run)).catch(() => null)));
    return out.filter((s): s is Summary => s !== null).sort((a, b) => (a.ref.run_id ?? 0) - (b.ref.run_id ?? 0));
  } catch {
    return [];
  }
}

/** 하천 범람(맨홀 유입 없음)·하천 범람 + 도시 침수(맨홀 유입 있음) 기준 두 시나리오 — 바꾼 입력이 없는 것 중에서 */
export function basePair(list: Summary[]): { a: Summary; b: Summary } | null {
  const plain = list.filter((s) => !s.ref.params && s.ref.run_id === undefined);
  const a = plain.find((s) => (s.kpi.internal_inflow?.count ?? 0) === 0);
  const b = plain.find((s) => (s.kpi.internal_inflow?.count ?? 0) > 0);
  return a && b ? { a, b } : null;
}

export interface CompareCategory {
  id: number;
  key: string;
  label: string;
  detail: string;
  rgba: [number, number, number, number];
  area_km2: number;
}

export interface CompareInfo {
  a: string;
  b: string;
  min_depth_m: number;
  deeper_m: number;
  categories: CompareCategory[];
  area_a_km2: number;
  area_b_km2: number;
  a_only_km2: number;
  /** 분류된 곳 범위(화소 1–99 %) — 처음 지도 범위 */
  wet_bbox?: [number, number, number, number];
  deeper_added_depth_m: { p50: number; p90: number } | null;
  basis: string;
  generated_at: string;
}

/** 원인 지도 (pipeline/compare_web.py): /data/<버전>/compare/<A>__<B>/ */
export function compareBase(version: string, a: string, b: string): string {
  return `${DATA_ROOT}/${version}/compare/${a}__${b}`;
}

export function loadCompare(version: string, a: string, b: string): Promise<CompareInfo | null> {
  return json<CompareInfo>(`${compareBase(version, a, b)}/compare.json`).catch(() => null);
}

// ------------------------------------------------------------------ 시나리오 색 (계열은 시나리오를 따라간다)
// 기준 두 조건이 1·2번(파랑·주황 — 주황은 지도의 맨홀 점과 같은 '도시 침수' 색), 나머지는 정해진 순서로.
const SLOTS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];

export function colorMap(list: Summary[]): Map<string, string> {
  const m = new Map<string, string>();
  const pair = basePair(list);
  const order = [
    ...(pair ? [pair.a, pair.b] : []),
    ...list.filter((s) => !pair || (s !== pair.a && s !== pair.b)),
  ];
  order.forEach((s, i) => m.set(s.ref.scenario_id, SLOTS[i % SLOTS.length]));
  return m;
}
