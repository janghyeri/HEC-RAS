// 냉천 흐름 표시 — 시각을 멈춰도 하천이 흐르는 모습 (river_flow.json, pipeline/river_flow.py).
// 하천 중심선을 따라 짧은 흰 줄(입자)을 흘려 보낸다. 빠르기는 그 시각 단면 평균 유속(유량 ÷ 흐름 단면적)을 SPEEDUP배 빠르게,
// 줄의 폭 방향 위치는 그 단면 수면 폭 안. 화면 표현용이며 수리 계산에는 쓰지 않는다.
// 3D 화면(public/view3d/view3d.js)에도 같은 계산이 있다 — 바꾸면 둘 다 바꾼다.
import { scenarioUrl, type ScenarioRef } from "./data";

export const SPEEDUP = 100; // 화면에서 실제보다 몇 배 빠르게 흘릴지

export interface RiverFlowData {
  centerline: [number, number][];
  length_m: number;
  xs: { rs: string[]; chainage_m: number[] };
  velocity_ms: number[][]; // [시각][단면]
  top_width_m: number[][];
}

const cache = new Map<string, Promise<RiverFlowData | null>>();

export function loadRiverFlow(ref: ScenarioRef): Promise<RiverFlowData | null> {
  const key = `${ref.url_base ?? ""}|${ref.path}`;
  let p = cache.get(key);
  if (!p) {
    p = fetch(scenarioUrl(ref, "river_flow.json"))
      .then((r) => (r.ok ? (r.json() as Promise<RiverFlowData>) : null))
      .catch(() => null);
    cache.set(key, p);
  }
  return p;
}

function lowerBound(a: number[], v: number): number {
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** 중심선 위 거리 s(m)에서의 위치·방향과 단면 값 보간 */
export class FlowModel {
  readonly length: number;
  private x: number[] = [];
  private y: number[] = [];
  private cum: number[] = [];
  private kx: number;
  private ky: number;
  private lat0: number;
  private scale: number; // 중심선 국지 좌표 길이 → 자료의 chainage(m) 비율

  constructor(readonly d: RiverFlowData) {
    this.lat0 = d.centerline.reduce((a, p) => a + p[1], 0) / d.centerline.length;
    this.kx = 111320 * Math.cos((this.lat0 * Math.PI) / 180);
    this.ky = 110540;
    let c = 0;
    d.centerline.forEach(([lon, lat], i) => {
      const x = lon * this.kx;
      const y = lat * this.ky;
      if (i) c += Math.hypot(x - this.x[i - 1], y - this.y[i - 1]);
      this.x.push(x);
      this.y.push(y);
      this.cum.push(c);
    });
    this.length = c;
    this.scale = d.length_m > 0 ? d.length_m / c : 1;
  }

  /** 거리 s에서 중심선 점(국지 m)과 단위 방향 */
  at(s: number): { x: number; y: number; tx: number; ty: number } {
    const i = Math.max(1, Math.min(this.cum.length - 1, lowerBound(this.cum, s)));
    const L = this.cum[i] - this.cum[i - 1] || 1;
    const f = Math.max(0, Math.min(1, (s - this.cum[i - 1]) / L));
    const dx = this.x[i] - this.x[i - 1];
    const dy = this.y[i] - this.y[i - 1];
    const n = Math.hypot(dx, dy) || 1;
    return { x: this.x[i - 1] + dx * f, y: this.y[i - 1] + dy * f, tx: dx / n, ty: dy / n };
  }

  private interp(table: number[][], s: number, t: number): number {
    const row = table[Math.max(0, Math.min(table.length - 1, t))];
    const ch = this.d.xs.chainage_m;
    const c = s * this.scale;
    const i = Math.max(1, Math.min(ch.length - 1, lowerBound(ch, c)));
    const L = ch[i] - ch[i - 1];
    const f = L > 0 ? Math.max(0, Math.min(1, (c - ch[i - 1]) / L)) : 0;
    return row[i - 1] * (1 - f) + row[i] * f;
  }

  velocity(s: number, t: number): number {
    return this.interp(this.d.velocity_ms, s, t);
  }

  width(s: number, t: number): number {
    return this.interp(this.d.top_width_m, s, t);
  }

  /** 중심선에서 옆으로 off(m) 떨어진 점의 경위도 */
  lonLat(s: number, off: number): [number, number] {
    const p = this.at(s);
    return [(p.x - p.ty * off) / this.kx, (p.y + p.tx * off) / this.ky];
  }
}

interface P {
  s: number;
  lane: number; // -1 ~ 1 (수면 폭 안 위치)
  age: number;
  life: number;
}

/** 흰 줄 입자들 — step()으로 움직이고 streaks()로 그릴 선분(꼬리→머리)과 투명도를 준다 */
export class FlowParticles {
  private ps: P[] = [];

  constructor(
    private readonly m: FlowModel,
    n = 420,
  ) {
    for (let i = 0; i < n; i++) this.ps.push(this.spawn(Math.random()));
  }

  private spawn(ageFrac = 0): P {
    const life = 3 + Math.random() * 4;
    return { s: Math.random() * this.m.length, lane: (Math.random() * 2 - 1) * 0.85, age: ageFrac * life, life };
  }

  step(dt: number, frame: number) {
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      const v = this.m.velocity(p.s, frame);
      p.s += v * dt * SPEEDUP;
      p.age += dt;
      if (p.age > p.life || p.s > this.m.length || p.s < 0) this.ps[i] = this.spawn();
    }
  }

  /** 각 입자의 [꼬리 경위도, 머리 경위도, 투명도]. 줄 길이는 빠를수록 길게 */
  streaks(frame: number): { tail: [number, number]; head: [number, number]; alpha: number }[] {
    const out = [];
    for (const p of this.ps) {
      const v = this.m.velocity(p.s, frame);
      if (!(v > 0.05)) continue;
      const half = this.m.width(p.s, frame) / 2;
      if (!(half > 1)) continue;
      const off = p.lane * half;
      const len = Math.max(12, Math.min(140, v * SPEEDUP * 0.22));
      const k = p.age / p.life;
      const alpha = Math.min(1, k * 4, (1 - k) * 4) * Math.min(1, 0.35 + v / 4);
      out.push({ tail: this.m.lonLat(Math.max(0, p.s - len), off), head: this.m.lonLat(p.s, off), alpha });
    }
    return out;
  }
}
