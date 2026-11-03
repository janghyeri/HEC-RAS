"use client";

// F-05 모의조건 설정·실행 (/run, docs/GUIDE.md §4.2.3, PLAN 5.6).
// 입력 범위는 /data/<버전>/model.json 의 run 블록에서 읽는다 (워커와 같은 파일). 요청은 Supabase runs 표에 'queued'로 넣고,
// 워커 PC가 가져가 HEC-RAS로 계산해 결과를 올린다. 같은 조건이 이미 있으면 새로 계산하지 않고 그 결과로 보낸다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SAFETY_GUIDE_URL } from "./AboutDialog";
import { loadIndex, loadModelInfo, type ScenarioRef } from "@/lib/data";
import { km2, shortLabel } from "@/lib/format";
import {
  changedParams,
  checkParams,
  describeParams,
  formatParamValue,
  paramsFor,
  paramsHash,
  shortParamLabel,
  snap,
  type RunConfig,
  type RunParam,
} from "@/lib/runConfig";
import {
  SupabaseError,
  cancelRun,
  currentSession,
  ensureSession,
  findActiveRun,
  getRun,
  hasSupabase,
  listRuns,
  listWorkers,
  requestRun,
  workerOnline,
  type RunRow,
  type RunStatus,
  type WorkerBeat,
} from "@/lib/supabase";

const STATUS_TEXT: Record<RunStatus, string> = {
  queued: "대기 중",
  running: "계산 중",
  done: "완료",
  failed: "실패",
  canceled: "취소됨",
};

const KST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 한국 시각 "11/3 08:58" */
function kst(iso: string | null): string {
  if (!iso) return "—";
  const part = Object.fromEntries(KST.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${Number(part.month)}/${Number(part.day)} ${part.hour}:${part.minute}`;
}

function minSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m ? `${m}분 ${String(s % 60).padStart(2, "0")}초` : `${s}초`;
}

function median(v: number[]): number | null {
  if (!v.length) return null;
  const a = [...v].sort((x, y) => x - y);
  const h = Math.floor(a.length / 2);
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
}

function inRange(p: RunParam, text: string): boolean {
  const v = Number(text);
  return text.trim() !== "" && Number.isFinite(v) && v >= p.min - 1e-9 && v <= p.max + 1e-9;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Setup {
  version: string;
  cfg: RunConfig;
  refs: ScenarioRef[];
  status: string | null;
}

interface Pre {
  ref: ScenarioRef;
  hash: string;
}

type Notice = { kind: "error" | "info"; text: string } | null;

export default function RunApp() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [base, setBase] = useState("");
  const [values, setValues] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // 숫자 칸에 입력 중인 글자
  const [formHash, setFormHash] = useState<string | null>(null);
  const [pre, setPre] = useState<Pre[]>([]);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [workers, setWorkers] = useState<WorkerBeat[] | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<RunRow | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const openRef = useRef<number | null>(null);
  openRef.current = openId;

  // ---------- 입력 설정 읽기
  useEffect(() => {
    (async () => {
      const { version, refs } = await loadIndex();
      const model = await loadModelInfo(version);
      if (!model.run) throw new Error(`모형 ${version}에 웹 실행 설정(run)이 없습니다`);
      const cfg = model.run;
      setSetup({ version, cfg, refs, status: cfg.params_status ?? null });
      const first = Object.keys(cfg.bases).at(-1) ?? ""; // 외수+내수(맨홀 포함)를 먼저
      setBase(first);
      setValues(Object.fromEntries(cfg.params.map((p) => [p.id, p.default])));
      // 미리 계산해 게시한 조건의 해시 — 같은 조건이면 바로 그 결과로 보낸다
      const list = await Promise.all(
        refs.map(async (ref) => {
          const b = ref.base ?? ref.scenario_id;
          if (!(b in cfg.bases)) return null;
          const c = checkParams(cfg, b, ref.params ?? {});
          return c.errors.length ? null : { ref, hash: await paramsHash(version, b, c.params) };
        }),
      );
      setPre(list.filter((x): x is Pre => x !== null));
    })().catch((e: unknown) => setSetupError(errText(e)));
    currentSession()
      .then((s) => setUserId(s?.user_id ?? null))
      .catch(() => setUserId(null));
  }, []);

  const cfg = setup?.cfg ?? null;
  const shown = useMemo(() => (cfg && base ? paramsFor(cfg, base) : []), [cfg, base]);
  const given = useMemo(() => Object.fromEntries(shown.map((p) => [p.id, values[p.id] ?? p.default])), [shown, values]);
  const checked = useMemo(() => (cfg && base ? checkParams(cfg, base, given) : null), [cfg, base, given]);
  const draftBad = shown.some((p) => p.id in drafts && !inRange(p, drafts[p.id]));
  const hidden = cfg && base ? cfg.params.filter((p) => !shown.includes(p)) : [];

  useEffect(() => {
    setFormHash(null);
    if (!setup || !checked || checked.errors.length) return;
    let stale = false;
    paramsHash(setup.version, base, checked.params).then((h) => {
      if (!stale) setFormHash(h);
    });
    return () => {
      stale = true;
    };
  }, [setup, base, checked]);

  // ---------- 요청 목록 · 계산 서버 상태 (대기·계산 중이 있으면 5초, 없으면 20초마다)
  const refresh = useCallback(async () => {
    if (!setup || !hasSupabase()) return;
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const [r, w] = await Promise.all([listRuns(setup.version), listWorkers()]);
      setRuns(r);
      setWorkers(w);
      setNetError(null);
      const id = openRef.current;
      if (id !== null) setDetail(await getRun(id, true));
    } catch (e) {
      setNetError(errText(e));
    }
    setNow(Date.now());
  }, [setup]);

  const hasActive = runs?.some((r) => r.status === "queued" || r.status === "running") ?? false;
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, hasActive ? 5000 : 20000);
    const onVis = () => !document.hidden && refresh();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh, hasActive]);

  // 계산 중 경과 시간 표시
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasActive]);

  // 로그 열기
  useEffect(() => {
    setDetail(null);
    if (openId === null) return;
    let stale = false;
    getRun(openId, true)
      .then((r) => {
        if (!stale) setDetail(r);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [openId]);

  // ---------- 같은 조건 찾기
  const matchPre = formHash ? pre.find((p) => p.hash === formHash) ?? null : null;
  const matchRun =
    formHash && !matchPre ? runs?.find((r) => r.params_hash === formHash && ["queued", "running", "done"].includes(r.status)) ?? null : null;

  const worker = workers?.[0] ?? null;
  const online = worker ? workerOnline(worker, now) : false;
  const queue = (runs ?? []).filter((r) => r.status === "queued").sort((a, b) => a.created_at.localeCompare(b.created_at));
  const running = (runs ?? []).filter((r) => r.status === "running");
  const typical = median((runs ?? []).filter((r) => r.status === "done" && r.wall_seconds).map((r) => Number(r.wall_seconds)));

  const setValue = (p: RunParam, v: number) => {
    setValues((o) => ({ ...o, [p.id]: snap(p, v) }));
    setDrafts((d) => {
      const { [p.id]: _, ...rest } = d;
      return rest;
    });
    setNotice(null);
  };

  // 숫자 칸: 입력 중인 글자는 그대로 두고(1. → 1.2), 범위 안 값이면 바로 반영. 칸을 벗어날 때 글자를 정리한다
  const onDraft = (p: RunParam, text: string) => {
    setDrafts((d) => ({ ...d, [p.id]: text }));
    if (inRange(p, text)) setValues((o) => ({ ...o, [p.id]: Math.round(Number(text) * 1e6) / 1e6 }));
    setNotice(null);
  };

  const onDraftDone = (p: RunParam) => {
    setDrafts((d) => {
      if (!(p.id in d) || !inRange(p, d[p.id])) return d;
      const { [p.id]: _, ...rest } = d;
      return rest;
    });
  };

  const resetAll = () => {
    if (!cfg) return;
    setValues(Object.fromEntries(cfg.params.map((p) => [p.id, p.default])));
    setDrafts({});
    setNotice(null);
  };

  const loadFrom = (r: RunRow) => {
    if (!cfg) return;
    setBase(r.base);
    setValues(Object.fromEntries(cfg.params.map((p) => [p.id, r.params[p.id] ?? p.default])));
    setDrafts({});
    setNotice({ kind: "info", text: `계산 ${r.id}번의 조건을 불러왔습니다.` });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submit = async () => {
    if (!setup || !checked || checked.errors.length || draftBad) return;
    setBusy(true);
    setNotice(null);
    try {
      const hash = await paramsHash(setup.version, base, checked.params);
      if (pre.some((p) => p.hash === hash)) return; // 화면에 '이미 계산된 결과' 안내가 뜬다
      const existing = await findActiveRun(setup.version, hash);
      if (existing) {
        setNotice({ kind: "info", text: `같은 조건이 이미 계산 ${existing.id}번으로 요청돼 있습니다 (${STATUS_TEXT[existing.status]}).` });
        setOpenId(existing.id);
        await refresh();
        return;
      }
      const session = await ensureSession();
      setUserId(session.user_id);
      const row = await requestRun(session, { model_version: setup.version, base, params: checked.params, params_hash: hash });
      setNotice({
        kind: "info",
        text: online
          ? `계산 ${row.id}번을 요청했습니다. 계산 서버가 차례대로 계산합니다.`
          : `계산 ${row.id}번을 요청했습니다. 계산 서버가 꺼져 있어, 서버가 켜지면 계산을 시작합니다.`,
      });
      setOpenId(row.id);
      await refresh();
    } catch (e) {
      if (e instanceof SupabaseError && e.code === "23505") {
        setNotice({ kind: "info", text: "같은 조건이 방금 요청됐습니다. 아래 목록에서 확인해 주세요." });
        await refresh();
      } else {
        setNotice({ kind: "error", text: `요청하지 못했습니다: ${errText(e)}` });
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (r: RunRow) => {
    try {
      const s = await currentSession();
      if (!s) throw new Error("이 브라우저에서 요청한 계산만 취소할 수 있습니다");
      const ok = await cancelRun(s, r.id);
      setNotice(ok ? { kind: "info", text: `계산 ${r.id}번을 취소했습니다.` } : { kind: "error", text: `계산 ${r.id}번은 이미 시작돼 취소할 수 없습니다.` });
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", text: `취소하지 못했습니다: ${errText(e)}` });
    }
  };

  const changed = cfg && checked ? describeParams(cfg, changedParams(cfg, checked.params)) : "";
  const canSubmit = hasSupabase() && !!checked && !checked.errors.length && !draftBad && !busy && !!formHash && !matchPre && !matchRun;

  return (
    <div className="run-app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-sub">
            2022년 9월 6일 태풍 힌남노<span className="wide-only"> · 경상북도 포항시 냉천</span>
          </span>
          <span className="brand-title">힌남노 침수 다시보기</span>
        </div>
        <nav className="topnav wide-only" aria-label="주 메뉴">
          <a href="/">침수 지도</a>
          <a href="/run" aria-current="page">
            조건 설정·실행
          </a>
          <a href={SAFETY_GUIDE_URL} target="_blank" rel="noreferrer">
            국민행동요령
          </a>
        </nav>
        <a className="top-link narrow-only" href="/">
          침수 지도
        </a>
      </header>

      <main className="runpage">
        <div className="run-wrap">
          <div className="run-intro">
            <h1>조건 설정·실행</h1>
            <p>
              입력 조건을 바꿔 HEC-RAS 6.6 1D–2D 모형을 다시 계산합니다. 계산은 연구실 PC가 한 번에 1건씩 맡고, 끝나면 침수 지도에서 다른 조건과
              함께 볼 수 있습니다.
            </p>
          </div>

          <section className="run-card server" aria-label="계산 서버 상태">
            <span className={`run-dot ${online ? "on" : "off"}`} aria-hidden="true" />
            <div>
              <strong>{!hasSupabase() ? "계산 서버 설정 없음" : workers === null ? "계산 서버 확인 중…" : online ? "계산 서버 켜짐" : "계산 서버 꺼짐"}</strong>
              <span className="muted small">
                {!hasSupabase()
                  ? " · 이 배포에는 Supabase 주소·공개 키가 없습니다"
                  : worker
                    ? online
                      ? ` · ${worker.info.cores ?? "?"}코어 PC${running.length ? ` · 계산 ${running.map((r) => r.id).join(", ")}번 진행 중` : " · 쉬는 중"} · 대기 ${queue.length}건`
                      : ` · 마지막 신호 ${kst(worker.last_seen)} · 요청은 대기열에 남고 서버가 켜지면 계산합니다`
                    : workers
                      ? " · 아직 연결된 계산 서버가 없습니다"
                      : ""}
              </span>
            </div>
          </section>
          {netError && <p className="warn small">Supabase에 연결하지 못했습니다: {netError}</p>}

          <div className="run-grid">
            {/* ---------- 입력 조건 ---------- */}
            <section className="run-card" aria-labelledby="form-title">
              <div className="run-card-head">
                <h2 id="form-title">입력 조건</h2>
                {setup && (
                  <span className="muted small">
                    모형 {setup.version}
                    {setup.status ? ` · 범위 ${setup.status}` : ""}
                  </span>
                )}
              </div>
              {setupError && <p className="warn small">입력 설정을 불러오지 못했습니다: {setupError}</p>}
              {!setup && !setupError && <p className="muted">입력 설정을 불러오는 중…</p>}
              {setup && cfg && (
                <>
                  <span className="field-label" id="base-title">
                    해석 조건
                  </span>
                  <div className="seg" role="radiogroup" aria-labelledby="base-title">
                    {Object.entries(cfg.bases).map(([id, b]) => (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={base === id}
                        onClick={() => {
                          setBase(id);
                          setNotice(null);
                        }}
                      >
                        {shortLabel(b.label)}
                      </button>
                    ))}
                  </div>

                  <div className="params">
                    {shown.map((p) => {
                      const v = values[p.id] ?? p.default;
                      const isDraft = p.id in drafts;
                      const bad = isDraft && !inRange(p, drafts[p.id]);
                      return (
                        <div key={p.id} className={`param ${v !== p.default ? "changed" : ""}`}>
                          <div className="param-head">
                            <label htmlFor={`n-${p.id}`}>{shortParamLabel(p)}</label>
                            <span className="param-value">{formatParamValue(p, v)}</span>
                          </div>
                          <div className="param-input">
                            <input
                              type="range"
                              min={p.min}
                              max={p.max}
                              step={p.step}
                              value={v}
                              onChange={(e) => setValue(p, Number(e.target.value))}
                              aria-label={`${p.label} 슬라이더`}
                            />
                            <input
                              id={`n-${p.id}`}
                              type="number"
                              inputMode="decimal"
                              min={p.min}
                              max={p.max}
                              step={p.step}
                              value={isDraft ? drafts[p.id] : v}
                              onChange={(e) => onDraft(p, e.target.value)}
                              onBlur={() => onDraftDone(p)}
                              aria-invalid={bad}
                            />
                          </div>
                          <div className="param-foot muted small">
                            <span>
                              {formatParamValue(p, p.min)} ~ {formatParamValue(p, p.max)} · 힌남노 값 {formatParamValue(p, p.default)}
                            </span>
                            {v !== p.default && (
                              <button type="button" className="link-btn" onClick={() => setValue(p, p.default)}>
                                힌남노 값으로
                              </button>
                            )}
                          </div>
                          {bad && (
                            <p className="field-error small">
                              {formatParamValue(p, p.min)} ~ {formatParamValue(p, p.max)} 사이 값을 넣어 주세요
                            </p>
                          )}
                        </div>
                      );
                    })}
                    {hidden.length > 0 && (
                      <p className="muted small">하천 범람 + 도시 침수에서만 바꿀 수 있는 항목: {hidden.map((p) => shortParamLabel(p)).join(", ")}</p>
                    )}
                  </div>

                  <dl className="facts run-summary">
                    <dt>바꾼 조건</dt>
                    <dd>{changed || "없음 (힌남노 조건 그대로)"}</dd>
                    <dt>예상 계산 시간</dt>
                    <dd>{typical ? `약 ${Math.round(typical / 60)}분 (최근 계산)` : "약 9분 (1D 후처리 포함)"}</dd>
                  </dl>

                  {matchPre && (
                    <p className="run-match">
                      이 조건은 이미 계산돼 있습니다 ({shortLabel(matchPre.ref.label)}).{" "}
                      <a href={`/?s=${encodeURIComponent(matchPre.ref.scenario_id)}`}>침수 지도에서 보기</a>
                    </p>
                  )}
                  {matchRun && (
                    <p className="run-match">
                      이 조건은 계산 {matchRun.id}번으로 요청돼 있습니다 ({STATUS_TEXT[matchRun.status]}).{" "}
                      {matchRun.status === "done" ? (
                        <a href={`/?run=${matchRun.id}`}>침수 지도에서 보기</a>
                      ) : (
                        <button type="button" className="link-btn" onClick={() => setOpenId(matchRun.id)}>
                          진행 상황 보기
                        </button>
                      )}
                    </p>
                  )}

                  <div className="run-actions">
                    <button type="button" className="btn-primary" disabled={!canSubmit} onClick={submit}>
                      {busy ? "요청 중…" : "계산 요청"}
                    </button>
                    <button type="button" className="btn-outline" onClick={resetAll}>
                      힌남노 조건으로
                    </button>
                  </div>
                  {notice && <p className={notice.kind === "error" ? "warn small" : "run-note small"}>{notice.text}</p>}
                  <p className="muted small">
                    요청하면 이 브라우저가 익명 사용자로 로그인됩니다 (계정·개인정보 없음). 대기는 전체 5건, 한 사람 2건까지이고, 같은 조건은 다시
                    계산하지 않습니다. 계산 결과는 모의값이며 실제와 다를 수 있습니다.
                  </p>
                </>
              )}
            </section>

            {/* ---------- 요청 목록 ---------- */}
            <section className="run-card" aria-labelledby="list-title">
              <div className="run-card-head">
                <h2 id="list-title">계산 요청</h2>
                <span className="muted small">최근 20건</span>
              </div>
              {!hasSupabase() && <p className="muted">Supabase 설정이 없어 목록을 볼 수 없습니다.</p>}
              {hasSupabase() && runs === null && !netError && <p className="muted">불러오는 중…</p>}
              {runs && runs.length === 0 && <p className="muted">아직 요청이 없습니다.</p>}
              {runs && runs.length > 0 && cfg && (
                <ul className="run-list">
                  {runs.map((r) => {
                    const mine = !!userId && r.requested_by === userId;
                    const pos = queue.findIndex((q) => q.id === r.id);
                    const open = openId === r.id;
                    const d = open && detail?.id === r.id ? detail : null;
                    return (
                      <li key={r.id} className={`run-item ${open ? "open" : ""}`}>
                        <div className="run-item-head">
                          <strong>계산 {r.id}</strong>
                          <span className={`status ${r.status}`}>{STATUS_TEXT[r.status]}</span>
                          {mine && <span className="tag">내 요청</span>}
                          <span className="muted small run-time">{kst(r.created_at)}</span>
                        </div>
                        <p className="run-cond">
                          {shortLabel(cfg.bases[r.base]?.label ?? r.base)}
                          {describeParams(cfg, r.params) ? ` · ${describeParams(cfg, r.params)}` : " · 힌남노 조건 그대로"}
                        </p>
                        <p className="muted small run-meta">
                          {r.status === "queued" && (pos + running.length === 0 ? "다음 차례" : `앞에 ${pos + running.length}건`)}
                          {r.status === "running" &&
                            `${r.progress ?? "계산 중"}${r.started_at ? ` · ${minSec((now - Date.parse(r.started_at)) / 1000)} 지남` : ""}`}
                          {r.status === "done" &&
                            `걸린 시간 ${r.wall_seconds ? minSec(Number(r.wall_seconds)) : "—"}${
                              r.area?.["ge_0.1m"] !== undefined ? ` · 침수면적(0.1 m 이상) ${km2(r.area["ge_0.1m"])}` : ""
                            }`}
                          {r.status === "failed" && (r.error ?? "실패")}
                          {r.status === "canceled" && "요청자가 취소함"}
                        </p>
                        <div className="run-item-actions">
                          {r.status === "done" && (
                            <a className="btn-outline" href={`/?run=${r.id}`}>
                              침수 지도에서 보기
                            </a>
                          )}
                          {mine && r.status === "queued" && (
                            <button type="button" className="btn-outline" onClick={() => cancel(r)}>
                              취소
                            </button>
                          )}
                          <button type="button" className="btn-outline" onClick={() => setOpenId(open ? null : r.id)} aria-expanded={open}>
                            {open ? "로그 닫기" : "로그"}
                          </button>
                          <button type="button" className="btn-outline" onClick={() => loadFrom(r)}>
                            이 조건 불러오기
                          </button>
                        </div>
                        {open && (
                          <div className="run-log">
                            {d === null ? (
                              <p className="muted small">로그를 불러오는 중…</p>
                            ) : (
                              <>
                                <p className="muted small">
                                  요청 {kst(d.created_at)} · 시작 {kst(d.started_at)} · 끝 {kst(d.finished_at)}
                                  {d.worker_id ? ` · 계산 서버 ${d.worker_id}` : ""}
                                </p>
                                {d.error && <p className="warn small">{d.error}</p>}
                                <pre>{d.log?.trim() || "아직 로그가 없습니다."}</pre>
                              </>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          <footer className="panel-foot">
            HEC-RAS 6.6 1D–2D 모의 결과(모형 {setup?.version ?? "—"})로 실제 침수와 다를 수 있습니다 · 계산 결과 저장 Supabase
          </footer>
        </div>
      </main>
    </div>
  );
}
