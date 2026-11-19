import type { Metadata } from "next";
import ValidationApp from "@/components/ValidationApp";

export const metadata: Metadata = {
  title: "검증 — 힌남노 침수 다시보기",
  description: "냉천 하천 흔적수위(현장조사)와 계산 결과의 최고수위를 결과마다 비교하고, 변환 정확성·실행 재현성·체적오차를 함께 봅니다.",
};

export default function ValidationPage() {
  return <ValidationApp />;
}
