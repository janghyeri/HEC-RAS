-- 웹 실행 작업 대기열 · 결과 · 계산 서버 상태 (작업 진행 가이드 Step 5, docs/GUIDE.md §5.2)
--
-- 흐름: 웹(로그인 사용자)이 runs에 'queued' 행을 넣는다 → 워커 PC가 claim_next_run()으로 하나 가져가
--       'running' → HEC-RAS 계산·변환 → 결과 파일을 Storage 'results' 버킷에 올리고 'done'(또는 'failed').
-- 권한: 워커는 service_role 키(워커 PC의 .env에만)로 접속해 RLS를 우회한다. 웹 브라우저는 anon 키만 쓴다.
-- 모형 값(입력 범위 등)은 여기 적지 않는다 — pipeline/models/<버전>.json 이 기준이고 워커가 다시 검사한다.

create table if not exists public.runs (
  id             bigint generated always as identity primary key,
  model_version  text        not null,
  base           text        not null,                 -- 기준 시나리오: S0-E / S0-C
  params         jsonb       not null default '{}'::jsonb,
  params_hash    text        not null,                 -- 같은 조건 재사용 (worker/hecras_job.py params_hash)
  label          text,
  status         text        not null default 'queued'
                 check (status in ('queued', 'running', 'done', 'failed', 'canceled')),
  is_precomputed boolean     not null default false,   -- 미리 계산해 둔 시나리오 (S1~S4)
  postprocess    boolean     not null default true,    -- 1D 후처리 실행 여부 (2026-11-02: 웹 실행도 정석대로 켬)
  requested_by   uuid        default auth.uid(),
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  worker_id      text,
  progress       text,                                 -- 사람이 읽는 진행 단계 (복사 / 계산 중 / 변환 / 올리는 중)
  log            text,
  error          text,
  wall_seconds   numeric,
  ras_seconds    jsonb,                                -- HEC-RAS 계산 단계별 시간 (계산 메시지)
  kpi            jsonb,                                -- pipeline.export_web 의 kpi.json
  files_prefix   text,                                 -- Storage 'results' 버킷 안 경로: <버전>/run-<id>
  constraint runs_params_is_object check (jsonb_typeof(params) = 'object')
);

create index if not exists runs_status_created on public.runs (status, created_at);
-- 같은 조건이 대기·계산 중이거나 끝났으면 새로 넣지 않는다 (실패·취소는 다시 넣을 수 있음)
create unique index if not exists runs_hash_active
  on public.runs (model_version, params_hash) where status in ('queued', 'running', 'done');

create table if not exists public.worker_heartbeat (
  worker_id   text primary key,
  last_seen   timestamptz not null default now(),
  info        jsonb       not null default '{}'::jsonb   -- HEC-RAS 버전, 코어 수, 모형 버전, 지금 하는 작업
);

-- ------------------------------------------------------------------ 대기열 제한
-- 워커 1대 = 한 번에 1건. 전체 대기 작업은 5건, 사용자 1명은 2건까지 (가이드라인 §4.5.3)
create or replace function public.runs_queue_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n_all  int;
  n_user int;
begin
  if new.status <> 'queued' then
    return new;
  end if;
  select count(*) into n_all from public.runs where status in ('queued', 'running');
  select count(*) into n_user from public.runs
    where status in ('queued', 'running') and requested_by is not distinct from new.requested_by;
  if n_all >= 5 then
    raise exception '대기 중인 계산이 많습니다 (최대 5건). 잠시 뒤 다시 요청해 주세요.' using errcode = 'P0001';
  end if;
  if new.requested_by is not null and n_user >= 2 then
    raise exception '한 사람이 동시에 요청할 수 있는 계산은 2건입니다.' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists runs_queue_limit on public.runs;
create trigger runs_queue_limit before insert on public.runs
  for each row execute function public.runs_queue_limit();

-- ------------------------------------------------------------------ 워커가 작업 하나 가져가기
create or replace function public.claim_next_run(p_worker text, p_model_versions text[])
returns setof public.runs
language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.runs r
     set status = 'running', started_at = now(), worker_id = p_worker, progress = '작업 폴더 준비'
   where r.id = (
     select q.id from public.runs q
      where q.status = 'queued' and q.model_version = any (p_model_versions)
      order by q.created_at
      limit 1
      for update skip locked)
  returning r.*;
end $$;

revoke all on function public.claim_next_run(text, text[]) from public, anon, authenticated;
grant execute on function public.claim_next_run(text, text[]) to service_role;

-- ------------------------------------------------------------------ 행 단위 권한 (RLS)
alter table public.runs enable row level security;
alter table public.worker_heartbeat enable row level security;

-- 결과는 누구나 본다 (시민 화면·분석 화면)
drop policy if exists runs_read on public.runs;
create policy runs_read on public.runs for select to anon, authenticated using (true);

-- 계산 요청은 로그인한 사용자만, 'queued' 상태로 자기 이름으로만
drop policy if exists runs_request on public.runs;
create policy runs_request on public.runs for insert to authenticated
  with check (status = 'queued' and requested_by = auth.uid() and is_precomputed = false
              and started_at is null and finished_at is null and kpi is null and files_prefix is null);

-- 자기 요청이 아직 대기 중이면 취소만 할 수 있다
drop policy if exists runs_cancel on public.runs;
create policy runs_cancel on public.runs for update to authenticated
  using (requested_by = auth.uid() and status = 'queued')
  with check (requested_by = auth.uid() and status = 'canceled');

drop policy if exists heartbeat_read on public.worker_heartbeat;
create policy heartbeat_read on public.worker_heartbeat for select to anon, authenticated using (true);

grant select on public.runs, public.worker_heartbeat to anon, authenticated;
grant insert, update on public.runs to authenticated;
-- 사용자가 고칠 수 있는 열을 status로 한정 (취소용). 나머지 열은 워커(service_role)만
revoke update on public.runs from authenticated;
grant update (status) on public.runs to authenticated;

-- ------------------------------------------------------------------ 결과 파일 버킷 (공개 읽기)
insert into storage.buckets (id, name, public)
values ('results', 'results', true)
on conflict (id) do nothing;
