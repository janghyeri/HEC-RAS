"use client";

// 화면 위 계산 진행 표시 (2026-11-23) — 다른 화면을 보는 동안에도 웹에서 요청한 계산이 어디까지 왔는지 보이게 한다.
//  - 대기 중·계산 중인 계산이 있으면: 번호, 단계(워커가 runs.progress에 쓰는 글), 지난 시간
//  - 끝난 지 15분 안이면: 걸린 시간 + 결과 지도·기준과 비교 바로가기 (닫으면 이 탭에서는 다시 안 뜸)
//  - 계산 서버(워커)는 1대라 한 번에 1건 — 가장 최근 것 하나만 보여 준다. 조건 설정·실행 화면(/run)에서는 그 화면이 자세히 보여 주므로 숨긴다.
import { useEffect, useState } from "react";
import { hasSupabase, latestRuns, type RunRow } from "@/lib/supabase";

const RECENT_MS = 15 * 60 * 1000;
const DISMISS_KEY = "hn-run-status-dismissed";

function minSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m ? `${m}분 ${String(s % 60).padStart(2, "0")}초` : `${s}초`;
}

function median(v: number[]): number | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

function dismissed(): number[] {
  try {
    return JSON.parse(sessionStorage.getItem(DISMISS_KEY) ?? "[]") as number[];
  } catch {
    return [];
  }
}

export default function RunStatus({ onMap = false }: { onMap?: boolean }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [closed, setClosed] = useState<number[]>([]);

  useEffect(() => setClosed(dismissed()), []);

  // 최근 계산 읽기: 진행 중이면 10초, 아니면 60초마다. 탭이 안 보일 때는 쉰다.
  useEffect(() => {
    if (!hasSupabase()) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stop = false;
    const tick = async () => {
      let active = false;
      try {
        const rows = await latestRuns(10);
        if (stop) return;
        setRuns(rows);
        active = rows.some((r) => r.status === "queued" || r.status === "running");
      } catch {
        /* 표시만 하는 기능 — 실패해도 조용히 다음에 다시 */
      }
      if (!stop) timer = setTimeout(tick, document.hidden ? 60000 : active ? 10000 : 60000);
    };
    const wake = () => {
      if (document.hidden || stop) return;
      if (timer) clearTimeout(timer);
      tick();
    };
    tick();
    document.addEventListener("visibilitychange", wake);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

  // 3시간 넘게 대기·계산 중으로 남은 행은 워커가 멈춘 흔적으로 보고 띄우지 않는다
  const live = (runs ?? []).filter((r) => now - Date.parse(r.created_at) < 3 * 3600 * 1000);
  const active = live.find((r) => r.status === "running") ?? live.find((r) => r.status === "queued") ?? null;
  const last = runs?.[0] ?? null;
  const recent =
    !active && last && (last.status === "done" || last.status === "failed") && last.finished_at && now - Date.parse(last.finished_at) < RECENT_MS
      ? last
      : null;
  const show = active ?? (recent && !closed.includes(recent.id) ? recent : null);

  // 지난 시간은 1초마다 (보일 때만)
  useEffect(() => {
    if (!show) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [show]);

  if (!show) return null;

  const typical = median((runs ?? []).filter((r) => r.status === "done" && r.wall_seconds).map((r) => Number(r.wall_seconds)));
  const close = () => {
    const next = Array.from(new Set([...closed, show.id]));
    setClosed(next);
    try {
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      /* 저장이 막혀 있으면 이번 화면에서만 닫힘 */
    }
  };

  let text: string;
  let state: "running" | "queued" | "done" | "failed";
  if (show.status === "running") {
    state = "running";
    const since = show.started_at ? (now - Date.parse(show.started_at)) / 1000 : 0;
    text = `${show.progress ?? "계산 중"} · ${minSec(since)} 지남${typical ? ` (보통 ${Math.round(typical / 60)}분 안팎)` : ""}`;
  } else if (show.status === "queued") {
    state = "queued";
    const waiting = (runs ?? []).filter((r) => r.status === "queued" && r.created_at < show.created_at).length;
    text = `대기 중${waiting ? ` · 앞에 ${waiting}건` : ""} · ${minSec((now - Date.parse(show.created_at)) / 1000)} 지남`;
  } else if (show.status === "done") {
    state = "done";
    text = `완료 · 걸린 시간 ${show.wall_seconds ? minSec(Number(show.wall_seconds)) : "—"}`;
  } else {
    state = "failed";
    text = "실패 — 로그에서 원인을 볼 수 있습니다";
  }

  return (
    <div className={`run-pill is-${state}${onMap ? " on-map" : ""}`} role="status" aria-live="polite">
      <span className="run-pill-dot" aria-hidden="true" />
      <span className="run-pill-text">
        <b>계산 {show.id}번</b> {text}
      </span>
      {state === "done" ? (
        <>
          <a className="run-pill-link" href={`/?run=${show.id}`}>
            결과 지도
          </a>
          <a className="run-pill-link" href={`/analysis?a=${encodeURIComponent(show.base)}&b=run-${show.id}`}>
            기준과 비교
          </a>
        </>
      ) : (
        <a className="run-pill-link" href="/run">
          {state === "failed" ? "로그 보기" : "진행 보기"}
        </a>
      )}
      {(state === "done" || state === "failed") && (
        <button type="button" className="run-pill-close" aria-label="닫기" onClick={close}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
    </div>
  );
}
