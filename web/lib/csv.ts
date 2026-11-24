// 표·그래프 값을 CSV로 내려받기 (엑셀에서 한글이 깨지지 않게 UTF-8 BOM을 붙인다).
export type CsvCell = string | number | null | undefined;

function esc(v: CsvCell): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: CsvCell[][]): string {
  return rows.map((r) => r.map(esc).join(",")).join("\r\n");
}

export function downloadCsv(fileName: string, rows: CsvCell[][]): void {
  const blob = new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 소수 자리를 맞춘 숫자 (CSV에는 천 단위 쉼표 없이) */
export function round(v: number | null | undefined, digits: number): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}
