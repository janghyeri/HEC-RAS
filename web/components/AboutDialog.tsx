"use client";

// 모형 설명 — 계산 방법, 용어 뜻(디자인 '화면 용어 정리'), 모형의 한계, 자료 출처.
import { useEffect, useRef } from "react";
import type { ModelInfo } from "@/lib/data";
import type { RefLayer } from "@/lib/reference";

interface Props {
  open: boolean;
  onClose: () => void;
  model: ModelInfo | null;
  version: string | null;
  traceLayer: RefLayer | null;
  manholes: number;
}

export const SAFETY_GUIDE_URL = "https://www.safekorea.go.kr";

export default function AboutDialog({ open, onClose, model, version, traceLayer, manholes }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="about" onClose={onClose} aria-labelledby="about-title">
      <div className="about-head">
        <h2 id="about-title">모형 설명</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="about-body">
        <p>
          2022년 9월 6일 태풍 힌남노 때 포항 냉천 유역의 침수를 HEC-RAS 6.6 1D–2D 모형으로 다시 계산한 결과입니다. 냉천은 1차원
          하천으로, 시가지는 2차원 격자로 계산했습니다. 모형 {version ?? "—"}.
        </p>
        <h3>해석 조건</h3>
        <dl className="about-terms">
          <dt>하천 범람</dt>
          <dd>냉천 물이 제방을 넘어 시가지로 흘러든 침수 (외수)</dd>
          <dt>하천 범람 + 도시 침수</dt>
          <dd>위에 더해 맨홀 {manholes.toLocaleString("ko-KR")}곳에서 넘친 물(월류 유량)을 함께 넣어 계산한 침수 (외수 + 내수)</dd>
        </dl>
        <h3>용어</h3>
        <dl className="about-terms">
          <dt>침수면적</dt>
          <dd>최대 침수심이 0.1 m 이상인 면적</dd>
          <dt>최대 침수심</dt>
          <dd>모의 기간 중 가장 깊었던 수심 (2 m 지형 기준). 요약 값은 침수 화소의 상위 1 %(99분위)</dd>
          <dt>침수 시작 시각</dt>
          <dd>수심 0.1 m 이상 면적이 5 ha를 처음 넘은 10분 출력 시각 (선택한 곳: 수심 0.1 m를 처음 넘은 시각)</dd>
          <dt>최대 침수 시각</dt>
          <dd>침수면적이 가장 넓었던 시각 (선택한 곳: 수심이 가장 깊었던 시각)</dd>
          <dt>0.3 m 이상 침수 지속시간</dt>
          <dd>수심 0.3 m 이상이던 출력 수 × 10분</dd>
          <dt>시각</dt>
          <dd>24시간제, 한국 표준시</dd>
        </dl>
        {!!model?.notes.length && (
          <>
            <h3>모형의 한계</h3>
            <ul>
              {model.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </>
        )}
        <h3>자료 출처</h3>
        <ul>
          <li>침수 해석: HEC-RAS 6.6 (미 육군 공병단 수문공학센터)</li>
          <li>배경지도·항공사진: 국토교통부 브이월드</li>
          {traceLayer && (
            <li>
              실제 침수흔적: {traceLayer.source.provider}, {traceLayer.source.name} ({traceLayer.source.license}) —{" "}
              <a href={traceLayer.source.url} target="_blank" rel="noreferrer">
                재난안전데이터공유플랫폼
              </a>
            </li>
          )}
        </ul>
        <p className="muted small">
          컴퓨터로 다시 계산한 결과이며 실제 침수와 다를 수 있습니다. 실제 대피는 재난문자와 지자체 안내를 따르십시오.{" "}
          <a href={SAFETY_GUIDE_URL} target="_blank" rel="noreferrer">
            국민행동요령 (국민재난안전포털)
          </a>
        </p>
      </div>
    </dialog>
  );
}
