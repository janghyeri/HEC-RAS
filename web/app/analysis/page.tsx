import type { Metadata } from "next";
import AnalysisApp from "@/components/AnalysisApp";

export const metadata: Metadata = {
  title: "분석·비교 — 힌남노 침수 다시보기",
  description: "하천 범람과 하천 범람 + 도시 침수(맨홀 월류) 계산을 원인 지도·밀어서 비교·증감표로 비교하고, 침수면적·하천 유량·수위의 시간별 변화를 봅니다.",
};

export default function AnalysisPage() {
  return <AnalysisApp />;
}
