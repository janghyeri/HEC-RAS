# mcp — HEC-RAS 침수 결과 MCP 서버 (선택 과제)

AI(Claude Desktop 등)가 자연어로 냉천 힌남노 HEC-RAS 결과를 조회·비교하고, 새 조건의 계산을 웹과 같은 대기열에 요청하게 하는 서버.
외부 패키지 없이 Python 3.9+ 표준 라이브러리만 쓴다 (MCP stdio, 줄 단위 JSON-RPC 2.0).

| 도구 | 하는 일 |
|---|---|
| `describe_model` | 모형 요약, 웹에서 바꿀 수 있는 조건·범위, 주의 사항 |
| `list_results` | 게시된 결과(S0-E, S0-C, S2-mh050, S2-mh150)와 웹 계산 목록·상태 |
| `get_kpi` | 결과 하나의 KPI (침수면적, 침수 시작, 하천 첨두유량, 하구 수위, 침수 건물, 체적오차 …) |
| `compare_results` | 두 결과의 KPI 차이·증감률 |
| `get_timeseries_summary` | 기간·하천 단면을 골라 최대유량·최고수위, 최대 침수면적, 맨홀 유입량, 측방 구조물 월류량 |
| `request_run` | 새 조건 계산 요청 — `confirm=false`(기본)는 조건·조건 해시·기존 결과 재사용 여부만, `confirm=true`일 때만 대기열에 넣음 |
| `get_run_status` | 웹 계산 상태·진행 단계·경과 시간, 끝나면 침수면적과 화면 주소 |
| `worker_status` | 계산 서버(워커 PC) 켜짐 여부와 대기 중인 계산 |

## 원칙

- 웹과 같은 길만 쓴다: 공개 자료(배포 사이트 `/data/…`, Storage 공개 결과)와 Supabase **공개(anon) 키 + 익명 로그인**.
  service_role 키는 쓰지 않으며, 대기 제한(전체 5건·1인 2건)·같은 조건 재사용은 DB 권한(RLS)이 그대로 적용된다.
- 조건 범위 검사와 조건 해시는 `worker/hecras_job.py`의 `validate_params`·`params_hash`와 같은 규칙 (시험에서 웹 계산 1의 해시와 일치 확인).
- 익명 로그인 세션은 사용자 폴더 `.hinnamno_mcp_session.json`에 두고 다시 써서, 요청할 때마다 익명 사용자를 새로 만들지 않는다.
- 수치는 결과 파일에서 읽은 값을 그대로 돌려준다. 해석·판단은 사용자가 한다.

## 설정 (Claude Desktop, Windows)

`%APPDATA%\Claude\claude_desktop_config.json`의 `mcpServers`에 추가하고 Claude Desktop을 다시 연다.

```json
{
  "mcpServers": {
    "hinnamno-flood": {
      "command": "C:\\Users\\<사용자>\\anaconda3\\python.exe",
      "args": ["C:\\Hec-Ras\\HECRASMCP\\code\\mcp\\hinnamno_mcp.py"],
      "env": {
        "HINNAMNO_SITE": "https://<배포 주소>",
        "HINNAMNO_SUPABASE_URL": "https://<프로젝트>.supabase.co",
        "HINNAMNO_SUPABASE_ANON_KEY": "<web/.env.local 의 NEXT_PUBLIC_SUPABASE_ANON_KEY>"
      }
    }
  }
}
```

설정 확인 (읽기만 함): 같은 환경 변수로 `python mcp\hinnamno_mcp.py --check`

## 시험

`python mcp/tests/test_mcp.py` — 가짜 사이트(`web/public/data`)와 가짜 Supabase를 띄워 실제 서비스에 닿지 않고
연결·도구 목록·KPI·비교·시계열 요약·계산 요청(확인 단계, 해시, 세션 재사용)·상태 조회를 확인한다.

## 대화 예

- "하천 범람만일 때와 도시 침수를 넣었을 때 침수면적이 얼마나 달라?" → `compare_results(S0-E, S0-C)`
- "06시부터 09시까지 RS 7.6 단면 최대 유량은?" → `get_timeseries_summary(S0-C, rs=7.600, start=06:00, end=09:00)`
- "맨홀 월류량 1.2배, 조위 0.3 m 올려서 계산해 줘" → `request_run(...)`로 조건 확인 → 사용자가 확인하면 `confirm=true`
