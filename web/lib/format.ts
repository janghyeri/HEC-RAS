// 표시용 형식. 시각은 모형 입력 시각(KST, "+09:00")을 그대로 쓴다 — 브라우저 시간대로 바꾸지 않는다.

export function hhmm(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.slice(11, 16);
}

export function duration(sec: number): string {
  if (sec <= 0) return "없음";
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}분`;
  return r === 0 ? `${h}시간` : `${h}시간 ${r}분`;
}

export function meters(v: number, digits = 2): string {
  return `${v.toFixed(digits)} m`;
}

export function km2(v: number): string {
  return `${v.toFixed(2)} km²`;
}

/**
 * 화면에 쓰는 해석 조건 이름. 자료(kpi.json)의 이름은 수리 용어(외수·내수) 그대로 두고 화면에서만 바꾼다.
 * "힌남노 외수+내수" → "하천 범람 + 도시 침수", "힌남노 외수" → "하천 범람" (사건 이름은 제목에 이미 있음)
 */
export function shortLabel(label: string): string {
  return label
    .replace(/^힌남노\s*/, "")
    .replace(/외수\s*\+\s*내수/g, "하천 범람 + 도시 침수")
    .replace(/외수/g, "하천 범람")
    .replace(/내수/g, "도시 침수");
}
