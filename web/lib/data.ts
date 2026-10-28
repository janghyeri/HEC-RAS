// 웹 공개 자료(web/public/data, pipeline/publish_web.py 출력)를 읽는다.
// 모형 값(시나리오 목록, 셀 수, 시각, 범위)은 모두 파일에서 읽고 코드에 넣지 않는다 (CLAUDE.md 모형 버전 규칙).

export const DATA_ROOT = "/data";

export type BBox = [number, number, number, number]; // 서, 남, 동, 북

export interface ScenarioRef {
  model_version: string;
  scenario_id: string;
  label: string;
  path: string;
  generated_at: string;
}

export interface MeshInfo {
  model_version: string;
  n_cells: number;
  n_vertices: number;
  bbox_lonlat: BBox;
  coordinate_scale: number;
}

export interface Mesh {
  info: MeshInfo;
  vertices: Int32Array; // [경도, 위도] × scale, 셀 순서대로
  offsets: Uint32Array; // 셀 i 꼭짓점 = [offsets[i], offsets[i+1])
  cellArea: Float32Array; // m²
}

export interface ModelInfo {
  model_version: string;
  description: string;
  notes: string[];
}

export interface Kpi {
  label: string;
  inundation_area_km2: Record<string, number>;
  depth_class_area_km2: Record<string, number>;
  max_depth_m: { value: number; p99_of_flooded: number };
  onset_time: string | null;
  peak_instant_area: { km2: number; time: string };
  internal_inflow: { count: number; total_volume_m3: number };
  river: { q_max_anywhere: { rs: string; q_max_m3s: number; q_max_time: string } };
}

export interface ScenarioMeta {
  scenario_id: string;
  label: string;
  frames: { count: number; step_seconds: number; times: string[] };
  quantization: { depth_step_m: number; no_peak_frame: number };
  files: Record<string, string>;
}

export interface TilesInfo {
  minzoom: number;
  maxzoom: number;
  tile_size: number;
  bounds: BBox;
}

export interface Scenario {
  ref: ScenarioRef;
  meta: ScenarioMeta;
  kpi: Kpi;
  tiles: TilesInfo;
  cellsMax: Uint8Array; // (4 × 셀) [최대 수심/step, 최대 젖은 비율, 최대 시각 프레임, 0.3 m 이상 지속 프레임 수]
  hasManholes: boolean;
}

export interface Dataset {
  version: string;
  model: ModelInfo;
  mesh: Mesh;
  scenarios: Scenario[];
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} 응답 ${r.status}`);
  return (await r.json()) as T;
}

async function getBin(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} 응답 ${r.status}`);
  return r.arrayBuffer();
}

/** 버전 문자열 비교: v1 < v2 < v10 */
function versionKey(v: string): number {
  const m = v.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

export async function loadDataset(): Promise<Dataset> {
  const index = await getJSON<{ scenarios: ScenarioRef[] }>(`${DATA_ROOT}/index.json`);
  if (!index.scenarios.length) throw new Error("시나리오가 없습니다");
  const version = index.scenarios
    .map((s) => s.model_version)
    .sort((a, b) => versionKey(a) - versionKey(b))
    .at(-1) as string;
  const refs = index.scenarios.filter((s) => s.model_version === version);
  const base = `${DATA_ROOT}/${version}`;

  const [info, model, vbuf, obuf, cbuf] = await Promise.all([
    getJSON<MeshInfo>(`${base}/mesh.json`),
    getJSON<ModelInfo>(`${base}/model.json`),
    getBin(`${base}/mesh_vertices.i32`),
    getBin(`${base}/mesh_offsets.u32`),
    getBin(`${base}/mesh_cells.f32`),
  ]);
  const cells = new Float32Array(cbuf);
  const cellArea = new Float32Array(info.n_cells);
  for (let i = 0; i < info.n_cells; i++) cellArea[i] = cells[2 * i];
  const mesh: Mesh = { info, vertices: new Int32Array(vbuf), offsets: new Uint32Array(obuf), cellArea };

  const scenarios = await Promise.all(
    refs.map(async (ref): Promise<Scenario> => {
      const p = `${DATA_ROOT}/${ref.path}`;
      const [meta, kpi, tiles, cm] = await Promise.all([
        getJSON<ScenarioMeta>(`${p}/meta.json`),
        getJSON<Kpi>(`${p}/kpi.json`),
        getJSON<TilesInfo>(`${p}/tiles/tiles.json`),
        getBin(`${p}/cells_max.u8`),
      ]);
      return { ref, meta, kpi, tiles, cellsMax: new Uint8Array(cm), hasManholes: "manholes.geojson" in meta.files };
    }),
  );
  return { version, model, mesh, scenarios };
}

const framesCache = new Map<string, Promise<Uint8Array>>();

/** 10분 프레임 수심 (프레임 × 셀) — 처음 필요할 때 한 번만 내려받는다. */
export function loadFrames(ref: ScenarioRef): Promise<Uint8Array> {
  const key = ref.path;
  let p = framesCache.get(key);
  if (!p) {
    p = getBin(`${DATA_ROOT}/${ref.path}/frames_depth.u8`).then((b) => new Uint8Array(b));
    p.catch(() => framesCache.delete(key));
    framesCache.set(key, p);
  }
  return p;
}

export interface CellResult {
  maxDepth: number; // m, 젖은 부분 평균 수심의 최댓값
  peakTime: string | null; // ISO
  durationSec: number; // 0.3 m 이상 지속
  area: number; // m²
}

export function cellResult(s: Scenario, mesh: Mesh, i: number): CellResult {
  const n = mesh.info.n_cells;
  const q = s.meta.quantization;
  const depth = s.cellsMax[i] * q.depth_step_m;
  const peak = s.cellsMax[2 * n + i];
  const dur = s.cellsMax[3 * n + i];
  return {
    maxDepth: depth,
    peakTime: peak === q.no_peak_frame ? null : s.meta.frames.times[peak] ?? null,
    durationSec: dur * s.meta.frames.step_seconds,
    area: mesh.cellArea[i],
  };
}

export function cellSeries(s: Scenario, frames: Uint8Array, nCells: number, i: number): number[] {
  const step = s.meta.quantization.depth_step_m;
  const out: number[] = [];
  for (let t = 0; t < s.meta.frames.count; t++) out.push(frames[t * nCells + i] * step);
  return out;
}

/** 수치 진동 판정 기준: 10분 간격 수심이 이 값보다 크게 오르내리기를 OSC_MIN_COUNT번 이상 반복 (pipeline/models/v1.json 주의 사항과 같은 기준) */
export const OSC_STEP_M = 0.3;
export const OSC_MIN_COUNT = 5;

export function oscillationCount(series: number[], step = OSC_STEP_M): number {
  let n = 0;
  for (let t = 2; t < series.length; t++) {
    const a = series[t - 1] - series[t - 2];
    const b = series[t] - series[t - 1];
    if (a * b < 0 && Math.abs(a) > step && Math.abs(b) > step) n++;
  }
  return n;
}
