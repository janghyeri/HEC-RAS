// 비교용 실제 자료 (모의 결과가 아닌 것) — 지금은 행정안전부 침수흔적도.
// 목록은 /data/reference/index.json 에서 읽는다. 파일이 없으면 화면에 아무것도 나오지 않는다.
// 이용 조건(공공누리 제3유형: 출처표시·변경금지)에 따라 폴리곤·속성은 원자료 그대로 쓰고 화면에 출처를 적는다.

import { DATA_ROOT } from "./data";

export interface RefSource {
  name: string;
  provider: string;
  url: string;
  license: string;
  note?: string;
}

export interface RefLayer {
  id: string;
  label: string; // 화면 이름
  file: string; // /data/reference/ 안 파일
  source: RefSource;
  count?: number;
}

type Ring = [number, number][];
export interface TraceFeature {
  type: "Feature";
  properties: Record<string, string | number | null>;
  geometry: { type: "MultiPolygon"; coordinates: Ring[][] } | { type: "Polygon"; coordinates: Ring[] };
}
export interface TraceCollection {
  type: "FeatureCollection";
  features: TraceFeature[];
}

export async function loadReferenceIndex(): Promise<RefLayer[]> {
  try {
    const r = await fetch(`${DATA_ROOT}/reference/index.json`, { cache: "no-cache" });
    if (!r.ok) return [];
    const j = (await r.json()) as { layers?: RefLayer[] };
    return j.layers ?? [];
  } catch {
    return [];
  }
}

export async function loadTraces(layer: RefLayer): Promise<TraceCollection> {
  const r = await fetch(`${DATA_ROOT}/reference/${layer.file}`);
  if (!r.ok) throw new Error(`${layer.file}: ${r.status}`);
  return (await r.json()) as TraceCollection;
}

function inRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 경위도 점이 들어가는 침수흔적 폴리곤의 속성 (없으면 null). 구멍(안쪽 링)은 뺀다. */
export function traceAt(fc: TraceCollection, lon: number, lat: number): TraceFeature["properties"] | null {
  for (const f of fc.features) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) {
      if (p.length && inRing(p[0], lon, lat) && !p.slice(1).some((h) => inRing(h, lon, lat))) return f.properties;
    }
  }
  return null;
}

/** 원자료 침수수심(FLDN_DOWA) 표시 — 숫자면 m를 붙이고, 아니면 원문 그대로. */
export function traceDepthText(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? `${n} m` : String(v);
}
