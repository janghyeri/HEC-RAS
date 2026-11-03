import type { Metadata } from "next";
import RunApp from "@/components/RunApp";

export const metadata: Metadata = {
  title: "조건 설정·실행 — 힌남노 침수 다시보기",
  description: "입력 조건(상류·측방 유입, 맨홀 월류량, 하류 조위)을 바꿔 HEC-RAS 1D–2D 침수 모형을 다시 계산하고 결과를 지도로 봅니다.",
};

export default function RunPage() {
  return <RunApp />;
}
