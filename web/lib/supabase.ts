// Supabase 접속 — 패키지 없이 REST로 부른다. 브라우저는 공개(anon) 키만 쓰고, 무엇을 할 수 있는지는 DB 권한(RLS)이 정한다
// (supabase/migrations/20261030000000_runs.sql): 결과 읽기는 누구나, 계산 요청은 로그인 사용자만, 취소는 자기 대기 요청만.
// 로그인은 익명 로그인 (2026-11-02 사용자 결정) — 브라우저마다 익명 사용자 1명이 생기고, 계정·비밀번호는 없다.

export const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const RESULTS_BUCKET = "results";

export function hasSupabase(): boolean {
  return SUPABASE_URL.length > 0 && ANON_KEY.length > 0;
}

/** 워커가 올린 결과 파일의 공개 주소 앞부분 (뒤에 files_prefix/파일 이름) */
export function resultsUrlBase(): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${RESULTS_BUCKET}`;
}

export class SupabaseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const AUTH_MESSAGES: Record<string, string> = {
  anonymous_provider_disabled: "익명 로그인이 꺼져 있습니다 (Supabase → Authentication → Sign In / Providers).",
  over_request_rate_limit: "요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요.",
};

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  if (!hasSupabase()) throw new SupabaseError("Supabase 설정(NEXT_PUBLIC_SUPABASE_URL·ANON_KEY)이 없습니다.", 0);
  const { token, headers, ...rest } = init;
  const r = await fetch(SUPABASE_URL + path, {
    ...rest,
    cache: "no-store",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${token ?? ANON_KEY}`,
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(headers as Record<string, string> | undefined),
    },
  });
  const text = await r.text();
  const body = text ? parse(text) : null;
  if (!r.ok) {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, string | undefined>;
    const code = b.code ?? b.error_code;
    const msg = (code && AUTH_MESSAGES[code]) || b.message || b.msg || b.error_description || `응답 ${r.status}`;
    throw new SupabaseError(msg, r.status, code);
  }
  return body as T;
}

// ------------------------------------------------------------------ 익명 로그인
export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // 초 (Unix)
  user_id: string;
}

interface AuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
  user: { id: string };
}

const STORE_KEY = "hinnamno.session.v1";
let memorySession: Session | null = null; // 브라우저 저장소를 못 쓸 때(사생활 보호 창 등)

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Session) : memorySession;
  } catch {
    return memorySession;
  }
}

function writeSession(s: Session | null) {
  memorySession = s;
  try {
    if (s) localStorage.setItem(STORE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* 저장소를 못 쓰면 이 창에서만 유지 */
  }
}

function toSession(a: AuthResponse): Session {
  const s: Session = {
    access_token: a.access_token,
    refresh_token: a.refresh_token,
    expires_at: a.expires_at ?? Math.floor(Date.now() / 1000) + a.expires_in,
    user_id: a.user.id,
  };
  writeSession(s);
  return s;
}

let refreshing: Promise<Session | null> | null = null;
let signingIn: Promise<Session> | null = null;

/** 저장된 세션 (만료 1분 전이면 갱신). 로그인한 적이 없으면 null — 여기서는 익명 사용자를 새로 만들지 않는다 */
export function currentSession(): Promise<Session | null> {
  const s = readSession();
  if (!s) return Promise.resolve(null);
  if (s.expires_at - 60 > Date.now() / 1000) return Promise.resolve(s);
  refreshing ??= call<AuthResponse>("/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  })
    .then(toSession)
    .catch(() => {
      writeSession(null);
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** 세션이 없으면 익명으로 로그인한다 (계산을 요청할 때만 부른다) */
export async function ensureSession(): Promise<Session> {
  const s = await currentSession();
  if (s) return s;
  signingIn ??= call<AuthResponse>("/auth/v1/signup", { method: "POST", body: JSON.stringify({ data: {} }) })
    .then(toSession)
    .finally(() => {
      signingIn = null;
    });
  return signingIn;
}

// ------------------------------------------------------------------ 계산 요청 (runs)
export type RunStatus = "queued" | "running" | "done" | "failed" | "canceled";

export interface RunRow {
  id: number;
  model_version: string;
  base: string;
  params: Record<string, number>;
  params_hash: string;
  label: string | null;
  status: RunStatus;
  requested_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  worker_id: string | null;
  progress: string | null;
  error: string | null;
  wall_seconds: number | null;
  files_prefix: string | null;
  /** kpi.inundation_area_km2 만 (목록에서 kpi 전체를 받지 않음) */
  area: Record<string, number> | null;
  log?: string | null;
}

const RUN_COLS =
  "id,model_version,base,params,params_hash,label,status,requested_by,created_at,started_at,finished_at,worker_id," +
  "progress,error,wall_seconds,files_prefix,area:kpi->inundation_area_km2";

const enc = encodeURIComponent;

export function listRuns(modelVersion: string, limit = 20): Promise<RunRow[]> {
  return call<RunRow[]>(`/rest/v1/runs?select=${RUN_COLS}&model_version=eq.${enc(modelVersion)}&order=created_at.desc&limit=${limit}`);
}

/** 모든 모형 버전의 최근 계산 (화면 위 계산 진행 표시용) */
export function latestRuns(limit = 10): Promise<RunRow[]> {
  return call<RunRow[]>(`/rest/v1/runs?select=${RUN_COLS}&order=created_at.desc&limit=${limit}`);
}

export async function getRun(id: number, withLog = false): Promise<RunRow | null> {
  const rows = await call<RunRow[]>(`/rest/v1/runs?select=${RUN_COLS}${withLog ? ",log" : ""}&id=eq.${id}`);
  return rows[0] ?? null;
}

/** 같은 조건으로 대기·계산 중이거나 끝난 요청 (DB도 같은 조건을 두 번 넣지 못하게 막는다) */
export async function findActiveRun(modelVersion: string, paramsHash: string): Promise<RunRow | null> {
  const rows = await call<RunRow[]>(
    `/rest/v1/runs?select=${RUN_COLS}&model_version=eq.${enc(modelVersion)}&params_hash=eq.${enc(paramsHash)}` +
      `&status=in.(queued,running,done)&order=created_at.desc&limit=1`,
  );
  return rows[0] ?? null;
}

export interface RunRequest {
  model_version: string;
  base: string;
  params: Record<string, number>;
  params_hash: string;
}

/** 'queued' 행 넣기 — 요청자(requested_by)·상태·1D 후처리는 DB 기본값 */
export async function requestRun(session: Session, req: RunRequest): Promise<RunRow> {
  const rows = await call<RunRow[]>(`/rest/v1/runs?select=${RUN_COLS}`, {
    method: "POST",
    token: session.access_token,
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(req),
  });
  return rows[0];
}

/** 자기 요청이 아직 대기 중일 때만 취소된다. 취소됐으면 true */
export async function cancelRun(session: Session, id: number): Promise<boolean> {
  const rows = await call<RunRow[]>(`/rest/v1/runs?id=eq.${id}&status=eq.queued&select=id`, {
    method: "PATCH",
    token: session.access_token,
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "canceled" }),
  });
  return rows.length > 0;
}

// ------------------------------------------------------------------ 계산 서버 상태
export interface WorkerBeat {
  worker_id: string;
  last_seen: string;
  info: { host?: string; cores?: number; model_versions?: string[]; current_run?: number | null; check?: boolean };
}

/** 워커는 30초마다 상태를 쓴다 (worker/run_worker.py). 이보다 오래 소식이 없으면 꺼진 것으로 본다 */
export const WORKER_ONLINE_SEC = 90;

export function listWorkers(): Promise<WorkerBeat[]> {
  return call<WorkerBeat[]>("/rest/v1/worker_heartbeat?select=worker_id,last_seen,info&order=last_seen.desc");
}

export function workerOnline(w: WorkerBeat, now = Date.now()): boolean {
  return now - Date.parse(w.last_seen) < WORKER_ONLINE_SEC * 1000;
}
