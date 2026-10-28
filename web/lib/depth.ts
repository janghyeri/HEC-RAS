// 수심 등급 (docs/GUIDE.md §4.4.1) — 색은 pipeline/raster_depth.py DEPTH_CLASSES와 같아야 한다.
// 단일 색상(파랑) 순서형, 밝은 → 어두운. 사람 키 기준: 무릎 0.5 m · 허리 1.0 m · 키 1.8 m.

export interface DepthClass {
  lo: number;
  hi: number;
  color: string;
  range: string;
  body: string;
}

export const DEPTH_CLASSES: DepthClass[] = [
  { lo: 0.1, hi: 0.5, color: "#86b6ef", range: "0.1–0.5 m", body: "무릎 아래" },
  { lo: 0.5, hi: 1.0, color: "#3987e5", range: "0.5–1.0 m", body: "무릎~허리" },
  { lo: 1.0, hi: 2.0, color: "#1c5cab", range: "1.0–2.0 m", body: "허리~키 높이" },
  { lo: 2.0, hi: Infinity, color: "#0d366b", range: "2.0 m 이상", body: "키보다 깊음" },
];

export function depthClass(d: number): DepthClass | null {
  return DEPTH_CLASSES.find((c) => d >= c.lo && d < c.hi) ?? null;
}
