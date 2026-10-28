import type { MetadataRoute } from "next";

// 휴대폰 "홈 화면에 추가" 때 앱처럼 열리게 하는 설정 (PWA). docs/GUIDE.md §4.4.5 모바일·앱 화면.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "힌남노 침수 다시보기",
    short_name: "침수 다시보기",
    description: "2022 태풍 힌남노 포항 냉천 침수 모의 결과 지도",
    lang: "ko",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f4f6f8",
    theme_color: "#1c5cab",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
