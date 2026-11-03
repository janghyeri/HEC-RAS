// 웹 실행 입력 조건 — pipeline/models/<버전>.json 의 run 블록(웹 공개본: /data/<버전>/model.json)을 읽는다.
// 범위 검사와 조건 해시는 worker/hecras_job.py validate_params · params_hash 와 똑같이 계산한다
// (같은 조건이면 같은 해시 → 이미 계산된 결과를 다시 쓴다, 가이드라인 §4.2.3). 워커도 범위를 다시 검사한다.

export interface RunParam {
  id: string;
  label: string;
  target: string;
  op: "mul" | "add";
  min: number;
  max: number;
  step: number;
  default: number;
  bases?: string[];
}

export interface RunConfig {
  bases: Record<string, { label: string; prj?: string; plan?: string }>;
  params: RunParam[];
  params_status?: string;
}

export function paramsFor(cfg: RunConfig, base: string): RunParam[] {
  return cfg.params.filter((p) => (p.bases ?? Object.keys(cfg.bases)).includes(base));
}

/** Python round(v, 6) — 화면 값(0.05 간격)에서는 반올림 방식 차이가 나지 않는다 */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export interface Checked {
  params: Record<string, number>; // 기준에 쓰는 항목 전부 (빠진 것은 기본값)
  errors: string[];
}

/** worker/hecras_job.py validate_params 와 같은 규칙. 오류가 있으면 errors에 사람이 읽는 문장 */
export function checkParams(cfg: RunConfig, base: string, given: Record<string, number>): Checked {
  const errors: string[] = [];
  if (!(base in cfg.bases)) errors.push(`기준 시나리오 ${base} 없음`);
  const known = new Map(cfg.params.map((p) => [p.id, p]));
  for (const k of Object.keys(given)) if (!known.has(k)) errors.push(`알 수 없는 입력 항목: ${k}`);
  const out: Record<string, number> = {};
  for (const p of cfg.params) {
    if (!(p.bases ?? Object.keys(cfg.bases)).includes(base)) {
      if (p.id in given && Number(given[p.id]) !== p.default) errors.push(`${p.label}은(는) 이 해석 조건에 쓸 수 없습니다`);
      continue;
    }
    const v = Number(given[p.id] ?? p.default);
    if (!Number.isFinite(v) || v < p.min - 1e-9 || v > p.max + 1e-9) {
      errors.push(`${p.label}: ${p.min}–${p.max} 사이 값을 넣어 주세요`);
      continue;
    }
    out[p.id] = round6(v);
  }
  return { params: out, errors };
}

/** Python repr(float) 과 같은 숫자 글자 (1 → "1.0", 0.5 → "0.5", 1e-05) */
export function pyFloat(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`숫자가 아님: ${v}`);
  if (v === 0) return Object.is(v, -0) ? "-0.0" : "0.0";
  const a = Math.abs(v);
  if (a >= 1e16 || a < 1e-4) {
    const [m, e] = v.toExponential().split("e");
    const n = Number(e);
    return `${m}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  const s = String(v);
  return s.includes(".") ? s : `${s}.0`;
}

/** json.dumps(obj, sort_keys=True, ensure_ascii=False) — 숫자는 모두 float로 쓴다 */
export function pyJson(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "number") return pyFloat(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}: ${pyJson(o[k])}`)
    .join(", ")}}`;
}

/** worker/hecras_job.py params_hash: sha256(json.dumps({"v","base","p"}, sort_keys=True))[:16] */
export async function paramsHash(modelVersion: string, base: string, params: Record<string, number>): Promise<string> {
  const s = pyJson({ v: modelVersion, base, p: params });
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** 기본값에서 바꾼 항목만 */
export function changedParams(cfg: RunConfig, params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of cfg.params) if (p.id in params && params[p.id] !== p.default) out[p.id] = params[p.id];
  return out;
}

function unitOf(label: string): string {
  return label.match(/\(([^)]+)\)\s*$/)?.[1] ?? "";
}

/** 화면용 짧은 이름: "상류 유입 배율" → "상류 유입", "하류 조위 보정 (m)" → "하류 조위 보정" */
export function shortParamLabel(p: RunParam): string {
  return p.label.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*배율$/, "");
}

export function formatParamValue(p: RunParam, v: number): string {
  if (p.op === "mul") return `×${v}`;
  const u = unitOf(p.label);
  return `${v > 0 ? "+" : ""}${v}${u ? ` ${u}` : ""}`;
}

/** 바꾼 조건 한 줄: "맨홀 월류량 ×1.5 · 하류 조위 보정 +0.5 m". 바꾼 것이 없으면 빈 글자 */
export function describeParams(cfg: RunConfig, params: Record<string, number> | undefined): string {
  if (!params) return "";
  return cfg.params
    .filter((p) => p.id in params && params[p.id] !== p.default)
    .map((p) => `${shortParamLabel(p)} ${formatParamValue(p, params[p.id])}`)
    .join(" · ");
}

/** 슬라이더 값을 간격(step)에 맞춘다 */
export function snap(p: RunParam, v: number): number {
  const k = Math.round((v - p.min) / p.step);
  return round6(Math.min(p.max, Math.max(p.min, p.min + k * p.step)));
}
