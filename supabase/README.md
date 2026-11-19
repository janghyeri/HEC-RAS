# supabase — 계산 요청 대기열과 결과 저장소

웹과 계산 PC는 직접 연결되지 않고 Supabase를 사이에 둡니다. 이 폴더에는 DB 표와 권한 규칙이 들어 있습니다.

## 들어 있는 것

`migrations/20261030000000_runs.sql` 하나로 아래를 만듭니다.

| 이름 | 내용 |
|---|---|
| `runs` 표 | 계산 요청 한 건 = 한 줄. 조건, 조건 해시, 상태(`queued` → `running` → `done`/`failed`/`canceled`), 진행 단계, 로그, 시간, KPI, 결과 파일 위치 |
| `worker_heartbeat` 표 | 계산 PC가 30초마다 남기는 '켜져 있음' 기록. 웹에 계산 서버 상태로 보입니다 |
| `claim_next_run()` | 계산 PC가 대기 중인 요청을 하나씩 겹치지 않게 가져가는 함수 |
| 대기 제한 | 대기 중인 요청은 전체 5건, 한 사람당 2건까지 |
| `results` 버킷 | 계산 결과 파일(공개 읽기) |

## 권한

- 결과와 계산 서버 상태는 누구나 읽을 수 있습니다(로그인 없이).
- 계산 요청은 로그인한 사용자만, 자기 이름의 `queued` 요청으로만 넣을 수 있습니다. 웹은 요청할 때 익명으로 로그인합니다.
- 사용자는 자기 요청이 대기 중일 때 취소만 할 수 있습니다.
- 계산 PC는 service_role 키로 접속해 위 규칙을 건너뜁니다. 이 키는 계산 PC의 `worker/.env`에만 둡니다.

## 새 프로젝트에 적용하기

1. Supabase에서 프로젝트를 만들고 Authentication → Sign In / Providers에서 **Anonymous sign-ins**를 켭니다.
2. 표를 만듭니다. Supabase CLI가 있으면 저장소 루트에서

   ```
   supabase link --project-ref <프로젝트 ID>
   supabase db push
   ```

   CLI가 없으면 `migrations/` 안의 SQL을 대시보드 SQL Editor에 붙여 넣어 실행합니다.
3. URL과 공개(anon) 키는 `web/.env.local`에, URL과 service_role 키는 계산 PC의 `worker/.env`에 넣습니다.

이 저장소는 Supabase의 GitHub 연동을 써서 `main`에 올린 `supabase/migrations`가 자동으로 반영됩니다.
이미 적용된 마이그레이션 파일은 고치지 말고, 바꿀 내용은 새 파일로 추가합니다.
