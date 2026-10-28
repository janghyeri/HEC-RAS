// 화면에서 누른 위치가 어느 2D 격자(셀)인지 찾는다. 격자 4.4만 개를 지도 레이어로 올리지 않고
// 균일 격자 색인 + 다각형 내부 판정으로 찾는다 (휴대폰 메모리 부담을 줄이기 위해).

import type { Mesh } from "./data";

export class CellIndex {
  private readonly scale: number;
  private readonly w: number;
  private readonly s: number;
  private readonly bw: number;
  private readonly bh: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly bins: Int32Array[];

  constructor(private readonly mesh: Mesh, binsX = 160, binsY = 320) {
    const [w, s, e, n] = mesh.info.bbox_lonlat;
    this.scale = mesh.info.coordinate_scale;
    this.w = w;
    this.s = s;
    this.nx = binsX;
    this.ny = binsY;
    this.bw = (e - w) / binsX;
    this.bh = (n - s) / binsY;
    const lists: number[][] = Array.from({ length: binsX * binsY }, () => []);
    const { vertices: v, offsets: o } = mesh;
    for (let i = 0; i < mesh.info.n_cells; i++) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = o[i]; k < o[i + 1]; k++) {
        const x = v[2 * k] / this.scale, y = v[2 * k + 1] / this.scale;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      const bx0 = this.bx(x0), bx1 = this.bx(x1), by0 = this.by(y0), by1 = this.by(y1);
      for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) lists[by * binsX + bx].push(i);
    }
    this.bins = lists.map((l) => Int32Array.from(l));
  }

  private bx(x: number) {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.w) / this.bw)));
  }

  private by(y: number) {
    return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.s) / this.bh)));
  }

  /** 경위도 점을 포함하는 셀 번호, 없으면 -1 (모의 범위 밖) */
  find(lon: number, lat: number): number {
    const [w, s, e, n] = this.mesh.info.bbox_lonlat;
    if (lon < w || lon > e || lat < s || lat > n) return -1;
    const cand = this.bins[this.by(lat) * this.nx + this.bx(lon)];
    for (const i of cand) if (this.contains(i, lon, lat)) return i;
    return -1;
  }

  private contains(i: number, lon: number, lat: number): boolean {
    const { vertices: v, offsets: o } = this.mesh;
    const x = lon * this.scale, y = lat * this.scale;
    let inside = false;
    const a = o[i], b = o[i + 1];
    for (let k = a, j = b - 1; k < b; j = k++) {
      const xi = v[2 * k], yi = v[2 * k + 1], xj = v[2 * j], yj = v[2 * j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** 셀 다각형 (닫힌 고리, 경위도) */
  ring(i: number): [number, number][] {
    const { vertices: v, offsets: o } = this.mesh;
    const pts: [number, number][] = [];
    for (let k = o[i]; k < o[i + 1]; k++) pts.push([v[2 * k] / this.scale, v[2 * k + 1] / this.scale]);
    if (pts.length) pts.push(pts[0]);
    return pts;
  }
}
