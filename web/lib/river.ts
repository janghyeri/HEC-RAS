// 냉천 하천(1D) 단면 정보 — pipeline/river_publish.py 의 river.json.
// 지도에서 2D 격자 밖(하천 구간)을 누르면, 그 점을 감싸는 이웃 두 단면을 찾아 수위·하상을 거리로 보간해 보여준다.
import { scenarioUrl, type ScenarioRef } from "./data";

export interface RiverXS {
  rs: string;
  line: [number, number][]; // 절단선 [경도, 위도]
  bed_m: number | null; // 측량 하상 (단면 최저 표고)
  max_ws_m: number | null; // 최대 수위
  bank_left_m: number | null; // 주수로 경계(좌안) 지반고
  bank_right_m: number | null;
  levee_left_m: number | null; // HEC-RAS 제방 설정 높이 (대부분 없음)
  levee_right_m: number | null;
}

export interface RiverData {
  scenario_id: string;
  xs: RiverXS[];
}

const cache = new Map<string, Promise<RiverData | null>>();

/** river.json 이 없는 옛 자료면 null */
export function loadRiver(ref: ScenarioRef): Promise<RiverData | null> {
  const key = ref.path;
  let p = cache.get(key);
  if (!p) {
    p = fetch(scenarioUrl(ref, "river.json"))
      .then((r) => (r.ok ? (r.json() as Promise<RiverData>) : null))
      .catch(() => null);
    cache.set(key, p);
  }
  return p;
}

// 작은 범위라 경위도를 국지 평면(m)으로 바꿔 계산한다
function toLocal(lon: number, lat: number, lat0: number): [number, number] {
  return [lon * 111320 * Math.cos((lat0 * Math.PI) / 180), lat * 110540];
}

function distToLine(p: [number, number], line: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [x1, y1] = line[i];
    const [x2, y2] = line[i + 1];
    const vx = x2 - x1, vy = y2 - y1;
    const L2 = vx * vx + vy * vy;
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - x1) * vx + (p[1] - y1) * vy) / L2));
    best = Math.min(best, Math.hypot(p[0] - (x1 + t * vx), p[1] - (y1 + t * vy)));
  }
  return best;
}

function inside(p: [number, number], poly: [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export interface RiverPick {
  up: number; // 위쪽 단면 번호 (timeseries river_ws_m 열 번호와 같음)
  w: number; // 0 = 위쪽 단면, 1 = 아래쪽 단면
  nearest: number; // 더 가까운 단면 번호
  rs: string;
  maxWs: number | null; // 보간한 최대 수위
  bed: number | null; // 보간한 하상
  bankLow: number | null; // 두 단면 주수로 경계 지반고 가운데 낮은 값 (보간)
}

function lerp(a: number | null, b: number | null, w: number): number | null {
  return a === null || b === null ? null : a * (1 - w) + b * w;
}

/** 점이 하천 구간(이웃 두 단면 절단선 사이 사각형) 안이면 보간 결과, 아니면 null. pipeline/river_map.py와 같은 방법 */
export function riverAt(river: RiverData, lon: number, lat: number): RiverPick | null {
  const lat0 = lat;
  const p = toLocal(lon, lat, lat0);
  const lines = river.xs.map((x) => x.line.map(([a, b]) => toLocal(a, b, lat0)));
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i];
    let b = lines[i + 1];
    const same = Math.hypot(a[0][0] - b[0][0], a[0][1] - b[0][1]) + Math.hypot(a.at(-1)![0] - b.at(-1)![0], a.at(-1)![1] - b.at(-1)![1]);
    const flip = Math.hypot(a[0][0] - b.at(-1)![0], a[0][1] - b.at(-1)![1]) + Math.hypot(a.at(-1)![0] - b[0][0], a.at(-1)![1] - b[0][1]);
    if (flip < same) b = [...b].reverse();
    if (!inside(p, [...a, ...[...b].reverse()])) continue;
    const da = distToLine(p, a);
    const db = distToLine(p, lines[i + 1]);
    const w = da + db > 0 ? da / (da + db) : 0;
    const A = river.xs[i], B = river.xs[i + 1];
    const lowA = A.bank_left_m === null || A.bank_right_m === null ? null : Math.min(A.bank_left_m, A.bank_right_m);
    const lowB = B.bank_left_m === null || B.bank_right_m === null ? null : Math.min(B.bank_left_m, B.bank_right_m);
    const nearest = w < 0.5 ? i : i + 1;
    return { up: i, w, nearest, rs: river.xs[nearest].rs, maxWs: lerp(A.max_ws_m, B.max_ws_m, w), bed: lerp(A.bed_m, B.bed_m, w), bankLow: lerp(lowA, lowB, w) };
  }
  return null;
}
