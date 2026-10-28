import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "힌남노 침수 다시보기",
  description:
    "2022년 태풍 힌남노 때 포항 냉천 유역의 하천 범람(외수)과 맨홀 월류(내수) 침수를 HEC-RAS 1D–2D 모형으로 해석한 결과를 지도로 보여줍니다.",
  applicationName: "힌남노 침수 다시보기",
  appleWebApp: { capable: true, title: "침수 다시보기", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1720" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
