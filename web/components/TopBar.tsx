"use client";

// 모든 화면 공통 머리글 (디자인 최종안 A안: 남색 띠). PC는 주 메뉴, 휴대폰은 메뉴 버튼을 누르면 펼친다.
import { useEffect, useRef, useState } from "react";
import { SAFETY_GUIDE_URL } from "./AboutDialog";
import RunStatus from "./RunStatus";

export type Page = "map" | "3d" | "analysis" | "validation" | "run";

const LINKS: { page: Page; href: string; label: string }[] = [
  { page: "map", href: "/", label: "침수 지도" },
  { page: "3d", href: "/3d", label: "3D 재현" },
  { page: "analysis", href: "/analysis", label: "분석·비교" },
  { page: "validation", href: "/validation", label: "검증" },
  { page: "run", href: "/run", label: "조건 설정·실행" },
];

function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M14 4h6v6M20 4l-9 9M19 14v6H4V5h6" />
    </svg>
  );
}

export default function TopBar({ current, onAbout }: { current: Page; onAbout?: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  return (
    <>
    <header className="topbar">
      <div className="brand">
        <span className="brand-sub">
          2022년 9월 6일 태풍 힌남노<span className="wide-only"> · 경상북도 포항시 냉천</span>
        </span>
        <span className="brand-title">힌남노 침수 다시보기</span>
      </div>
      <nav className="topnav wide-only" aria-label="주 메뉴">
        {LINKS.map((l) => (
          <a key={l.page} href={current === l.page && l.page === "map" ? "#map" : l.href} aria-current={current === l.page ? "page" : undefined}>
            {l.label}
          </a>
        ))}
        {onAbout && (
          <button type="button" onClick={onAbout}>
            모형 설명
          </button>
        )}
        <a href={SAFETY_GUIDE_URL} target="_blank" rel="noreferrer">
          국민행동요령 <ExternalIcon />
        </a>
      </nav>
      <div className="menu-wrap narrow-only" ref={box}>
        <button type="button" className="menu-btn" aria-label="메뉴" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        {open && (
          <ul className="menu-list">
            {LINKS.map((l) => (
              <li key={l.page}>
                <a href={l.href} aria-current={current === l.page ? "page" : undefined}>
                  {l.label}
                </a>
              </li>
            ))}
            {onAbout && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onAbout();
                  }}
                >
                  모형 설명
                </button>
              </li>
            )}
            <li>
              <a href={SAFETY_GUIDE_URL} target="_blank" rel="noreferrer">
                국민행동요령 <ExternalIcon />
              </a>
            </li>
          </ul>
        )}
      </div>
    </header>
    {current !== "run" && <RunStatus onMap={current === "map"} />}
    </>
  );
}
