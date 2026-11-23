// 두 결과의 최대 수심 차이 지도 — 아무 두 결과(웹 계산 포함)를 브라우저에서 바로 나눈다.
//  자료: 각 결과의 depth2m/max.png (2 m 경위도 격자, 8비트 회색조 × 0.02 m, 지도·3D와 같은 경사 수면 — pipeline/frames_web.py)
//        + <버전>/area2d_2m.png (255 = 2D 셀 안). 하천(1D) 물은 넣지 않는다 (pipeline/compare_web.py와 같음).
//  기준: 침수 기준 수심 0.1 m, 깊이 차이 0.1 m — compare_web.py의 MIN_DEPTH·DEEPER_M과 같은 값 (docs/GUIDE.md §4.4.1).
//  미리 만든 원인 지도(기본 두 조건)는 그대로 두고, 다른 조합은 이 계산으로 보여 준다.

export const DIFF_MIN_DEPTH_M = 0.1;
export const DIFF_DELTA_M = 0.1;

export type DiffKey = "new" | "deeper" | "same" | "shallower" | "dried";

export interface DiffClass {
  id: number;
  key: DiffKey;
  label: string;
  detail: string;
  rgba: [number, number, number, number];
}

// 색: 비교 쪽이 나빠진 곳은 따뜻한 색(주황), 좋아진 곳은 차가운 색(보라), 비슷한 곳은 회청색.
// 수심 등급 색(파랑)과 겹치지 않게 파랑은 쓰지 않는다.
export const DIFF_CLASSES: DiffClass[] = [
  { id: 1, key: "new", label: "새로 잠김", detail: "기준에서 0.1 m 미만 → 비교에서 0.1 m 이상", rgba: [0xc8, 0x4a, 0x12, 230] },
  { id: 2, key: "deeper", label: "더 깊어짐", detail: "둘 다 잠김, 비교가 0.1 m 이상 깊음", rgba: [0xf0, 0x9a, 0x2c, 225] },
  { id: 3, key: "same", label: "비슷함", detail: "둘 다 잠김, 깊이 차이 0.1 m 미만", rgba: [0x9a, 0xab, 0xbd, 170] },
  { id: 4, key: "shallower", label: "얕아짐", detail: "둘 다 잠김, 비교가 0.1 m 이상 얕음", rgba: [0x8f, 0x7c, 0xd8, 225] },
  { id: 5, key: "dried", label: "안 잠기게 됨", detail: "기준에서 0.1 m 이상 → 비교에서 0.1 m 미만", rgba: [0x55, 0x3a, 0xa8, 230] },
];

export interface DepthGrid {
  width: number;
  height: number;
  bounds: [number, number, number, number]; // 서, 남, 동, 북
  step_m: number; // 화소값 1 = step_m 미터
  values: Uint8Array; // 화소값 (행 우선, 북쪽 행부터)
}

export interface DiffResult {
  width: number;
  height: number;
  classes: Uint8Array; // 0 = 둘 다 0.1 m 미만 또는 2D 밖, 1~5 = DIFF_CLASSES id
  area_km2: Record<DiffKey, number>;
  area_a_km2: number; // 기준 0.1 m 이상 (2D 안)
  area_b_km2: number; // 비교 0.1 m 이상 (2D 안)
  /** 더 깊어진 곳 / 얕아진 곳의 깊이 차이 중앙값 (m) */
  deeper_median_m: number | null;
  shallower_median_m: number | null;
  pixel_m2: number;
}

/** 위도에서 경도 1°, 위도 1°의 길이 (m) — pipeline/frames_web.py m_per_degree와 같은 식 */
export function mPerDegree(latDeg: number): [number, number] {
  const p = (latDeg * Math.PI) / 180;
  const mLat = 111132.954 - 559.822 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p);
  const mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p);
  return [mLon, mLat];
}

/** 화소 하나의 면적 (m²) — frames_web.py와 같이 격자 가운데 위도 기준 한 값 */
export function pixelArea(g: { width: number; height: number; bounds: [number, number, number, number] }): number {
  const [w, s, e, n] = g.bounds;
  const [mLon, mLat] = mPerDegree((s + n) / 2);
  return ((e - w) / g.width) * mLon * (((n - s) / g.height) * mLat);
}

function sameGrid(a: DepthGrid, b: DepthGrid): boolean {
  return a.width === b.width && a.height === b.height && a.bounds.every((v, i) => Math.abs(v - b.bounds[i]) < 1e-9);
}

/** 히스토그램(화소값 차이 0~255)에서 중앙값 */
function medianFromHist(hist: Uint32Array, count: number, step: number): number | null {
  if (!count) return null;
  let acc = 0;
  const half = count / 2;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= half) return i * step;
  }
  return null;
}

/**
 * 화소마다 분류. 문턱값은 화소값 단위 정수로 비교한다 (0.1 m ÷ 0.02 m = 5).
 * mask: 255 = 2D 셀 안 (없으면 전체).
 */
export function classifyDiff(a: DepthGrid, b: DepthGrid, mask: Uint8Array | null): DiffResult {
  if (!sameGrid(a, b)) throw new Error("두 결과의 수심 이미지 격자가 다릅니다 (모형 버전이 다를 수 있음)");
  if (Math.abs(a.step_m - b.step_m) > 1e-12) throw new Error("두 결과의 수심 단위가 다릅니다");
  const n = a.width * a.height;
  if (mask && mask.length !== n) throw new Error("2D 범위 이미지 크기가 수심 이미지와 다릅니다");
  const step = a.step_m;
  const wetMin = Math.round(DIFF_MIN_DEPTH_M / step);
  const dMin = Math.round(DIFF_DELTA_M / step);
  const out = new Uint8Array(n);
  const counts = new Float64Array(6);
  const histDeep = new Uint32Array(256);
  const histShallow = new Uint32Array(256);
  let nA = 0;
  let nB = 0;
  const va = a.values;
  const vb = b.values;
  for (let i = 0; i < n; i++) {
    if (mask && mask[i] !== 255) continue;
    const x = va[i];
    const y = vb[i];
    const wa = x >= wetMin;
    const wb = y >= wetMin;
    if (wa) nA++;
    if (wb) nB++;
    let c = 0;
    if (!wa && wb) c = 1;
    else if (wa && !wb) c = 5;
    else if (wa && wb) {
      const d = y - x;
      if (d >= dMin) {
        c = 2;
        histDeep[d]++;
      } else if (-d >= dMin) {
        c = 4;
        histShallow[-d]++;
      } else c = 3;
    }
    out[i] = c;
    counts[c]++;
  }
  const px = pixelArea(a);
  const km2 = (k: number) => Math.round(((counts[k] * px) / 1e6) * 10000) / 10000;
  return {
    width: a.width,
    height: a.height,
    classes: out,
    area_km2: { new: km2(1), deeper: km2(2), same: km2(3), shallower: km2(4), dried: km2(5) },
    area_a_km2: Math.round(((nA * px) / 1e6) * 10000) / 10000,
    area_b_km2: Math.round(((nB * px) / 1e6) * 10000) / 10000,
    deeper_median_m: medianFromHist(histDeep, counts[2], step),
    shallower_median_m: medianFromHist(histShallow, counts[4], step),
    pixel_m2: px,
  };
}

// 2 × 2 → 1 로 줄일 때 같은 수면 비교 순위: 바뀐 곳(새로 잠김·안 잠기게 됨·깊이 변화)을 '비슷함'보다 앞에 둔다
// — 작은 변화가 화면에서 사라지지 않게 (compare_web.py _downsample와 같은 생각)
const PRIORITY = [1, 5, 2, 4, 3];

/** 화면용 RGBA (factor 배 줄임). 줄인 칸의 분류 화소가 절반 미만이면 투명. */
export function diffRGBA(r: DiffResult, factor = 2): { width: number; height: number; rgba: Uint8ClampedArray } {
  const W = Math.ceil(r.width / factor);
  const H = Math.ceil(r.height / factor);
  const rgba = new Uint8ClampedArray(W * H * 4);
  const colors = new Map(DIFF_CLASSES.map((c) => [c.id, c.rgba]));
  const cnt = new Uint16Array(6);
  for (let Y = 0; Y < H; Y++) {
    for (let X = 0; X < W; X++) {
      cnt.fill(0);
      let total = 0;
      let cells = 0;
      for (let dy = 0; dy < factor; dy++) {
        const y = Y * factor + dy;
        if (y >= r.height) break;
        for (let dx = 0; dx < factor; dx++) {
          const x = X * factor + dx;
          if (x >= r.width) break;
          cells++;
          const c = r.classes[y * r.width + x];
          if (c) {
            cnt[c]++;
            total++;
          }
        }
      }
      if (!total || total * 2 < cells) continue;
      let best = 0;
      for (const k of PRIORITY) if (!best || cnt[k] > cnt[best]) best = k;
      const col = colors.get(best);
      if (!col) continue;
      const o = (Y * W + X) * 4;
      rgba[o] = col[0];
      rgba[o + 1] = col[1];
      rgba[o + 2] = col[2];
      rgba[o + 3] = col[3];
    }
  }
  return { width: W, height: H, rgba };
}
