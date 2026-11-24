// 차이 지도 분류 점검 (lib/diffmap.ts): 문턱값(0.1 m = 화소값 5)과 2D 범위, 면적, 줄인 그림을 작은 격자로 확인한다.
// 실행: web 폴더에서  npx tsx scripts/check-diffmap.ts
// 실제 자료 대조(2026-11-23): 게시 결과 depth2m/max.png 세 쌍을 numpy로 같은 규칙으로 나눈 값과 면적이 모두 같았다
//   (하천 범람 → + 도시 침수: 새로 잠김 1.5647, 더 깊어짐 1.1123, 비슷함 0.1012, 얕아짐 0.0025, 안 잠기게 됨 0.0011 km²).
import assert from "node:assert/strict";
import { classifyDiff, diffRGBA, DIFF_CLASSES, pixelArea, type DepthGrid } from "../lib/diffmap";

const bounds: [number, number, number, number] = [129.4, 35.95, 129.4001, 35.9501];
const grid = (values: number[], width: number): DepthGrid => ({
  width,
  height: values.length / width,
  bounds,
  step_m: 0.02,
  values: Uint8Array.from(values),
});

// 화소 하나씩: [기준, 비교] → 기대 분류
const cases: [number, number, number][] = [
  [0, 0, 0], // 둘 다 마름
  [4, 4, 0], // 0.08 m — 침수 아님
  [4, 5, 1], // 0.08 → 0.10 : 새로 잠김
  [5, 4, 5], // 0.10 → 0.08 : 안 잠기게 됨
  [5, 9, 3], // 0.10 → 0.18 : 차이 0.08 — 비슷함
  [5, 10, 2], // 0.10 → 0.20 : 차이 0.10 — 더 깊어짐
  [20, 15, 4], // 0.40 → 0.30 : 차이 0.10 — 얕아짐
  [20, 16, 3], // 0.40 → 0.32 : 비슷함
];
const a = grid(cases.map((c) => c[0]), cases.length);
const b = grid(cases.map((c) => c[1]), cases.length);
const r = classifyDiff(a, b, null);
assert.deepEqual(Array.from(r.classes), cases.map((c) => c[2]), "화소 분류");

// 2D 범위 밖(마스크 0)은 분류하지 않는다
const mask = Uint8Array.from(cases.map((_, i) => (i === 2 ? 0 : 255)));
const rm = classifyDiff(a, b, mask);
assert.equal(rm.classes[2], 0, "2D 밖은 0");
assert.equal(rm.classes[5], 2);

// 면적: 분류 화소 수 × 화소 면적
const px = pixelArea(a);
const km2 = (n: number) => Math.round(((n * px) / 1e6) * 10000) / 10000;
assert.equal(r.area_km2.same, km2(2));
assert.equal(r.area_a_km2, km2(5)); // 기준 0.1 m 이상: 5, 5, 5, 20, 20
assert.equal(r.area_b_km2, km2(5)); // 비교 0.1 m 이상: 5, 9, 10, 15, 16
assert.equal(r.deeper_median_m, 0.1);

// 기준과 비교를 바꾸면 새로 잠김 ↔ 안 잠기게 됨, 더 깊어짐 ↔ 얕아짐
const swap = classifyDiff(b, a, null);
const flip: Record<number, number> = { 0: 0, 1: 5, 5: 1, 2: 4, 4: 2, 3: 3 };
assert.deepEqual(Array.from(swap.classes), Array.from(r.classes).map((c) => flip[c]), "대칭");

// 격자가 다르면 오류
assert.throws(() => classifyDiff(a, grid([0, 0], 2), null));

// 줄인 그림: 2 × 2 칸에 분류 화소가 2개 이상이면 색, 바뀐 곳이 '비슷함'보다 먼저
const small = classifyDiff(grid([5, 5, 0, 0, 0, 0, 0, 0], 4), grid([9, 5, 0, 0, 5, 0, 0, 0], 4), null);
// 기준 [[5,5,0,0],[0,0,0,0]] → 비교 [[9,5,0,0],[5,0,0,0]] : 왼쪽 칸 = 비슷함 2 + 새로 잠김 1
const img = diffRGBA(small, 2);
assert.equal(img.width, 2);
assert.equal(img.height, 1);
const color = (id: number) => DIFF_CLASSES.find((c) => c.id === id)!.rgba;
assert.deepEqual(Array.from(img.rgba.slice(0, 4)), color(3), "왼쪽 칸은 개수가 많은 '비슷함'");
assert.equal(img.rgba[7], 0, "오른쪽 칸은 투명");

console.log("차이 지도 점검 통과 (분류 8칸, 2D 범위, 면적, 대칭, 줄인 그림)");
