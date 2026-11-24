# 힌남노 침수 다시보기 — 에이전트 컨텍스트

> 개발에 쓴 AI 코딩 도구(Claude Code)가 작업 전에 읽는 지침 — 모형 요약, 폴더 구조, 지켜야 할 규칙.

## 목적
HEC-RAS 6.6 1D–2D로 해석한 2022 힌남노 포항 냉천 외수·내수 침수를 웹에서
조건 설정→실행→시각화→시나리오 비교→배포. 시민용 공개 화면(주소 검색, 시간대별·3D 재현)도 제공.
과제 평가 기준과 요구사항은 docs/GUIDE.md §2.

## 모형 요약
- NC090901 = 외수, NC090902 = 외수+내수(맨홀 274개 월류 유량). 계획 p03, 지오메트리 g03, 부정류 u01
- 2D: left 18,087셀 + right 25,861셀, 1D: 냉천 RS 13.434→0.000, 측방 구조물 RS 7.64·7.65
- 모의 2022-09-06 02:00~13:30, 지도 출력 10분(70프레임), 좌표계 EPSG:5187, 지형 2 m DEM
- 계산 시간 (24코어): 부정류 1.5~3분 + 1D 후처리 약 4분 = 전체 6~8분 (웹 실행도 1D 후처리를 켠다 — 2026-11-02 결정. 끄면 약 4분이고 2D 결과는 같음). Ras.exe -c는 후처리 전에 돌아올 수 있음 → 결과 HDF에 "Complete Process"가 기록된 뒤 읽는다
- Ras.exe 명령줄의 프로젝트·계획 파일 이름은 반드시 따옴표로 감싼다. 없으면 HEC-RAS가 '명령줄 매개변수 오류' 창을 띄우고 멈춘다 (worker/hecras_job.py ras_command)
- 측방 구조물 RS 7.65는 같은 입력에서도 실행마다 월류 방향이 바뀌는 불안정 구간 (docs/GUIDE.md §4.1.5). 결과 비교는 침수면적 ±1 %·셀 수위 99분위 0.02 m 기준
- HDF 경로 표: docs/GUIDE.md §4.3.2

## 구조
- web/: Next.js(App Router, TS) + shadcn/ui + MapLibre GL(2D, 브이월드 항공사진) + 브이월드 WebGL 3D 지도(3D, Cesium 기반), Supabase 연동. 3D 화면의 물은 수심을 지면에 덮어 그리고 숫자는 2 m DEM 기준 (docs/GUIDE.md §4.4.5). Vercel Root Directory = web, 배포 주소 https://hinnamno-flood.vercel.app (프로젝트 hinnamno-flood)
- web/app/run (components/RunApp.tsx, lib/supabase.ts·runConfig.ts): 조건 설정·실행. 로그인은 Supabase 익명 로그인(2026-11-02 결정), supabase-js 없이 REST. 입력 범위는 /data/<버전>/model.json의 run 블록(= pipeline/models/<버전>.json), 조건 해시는 worker/hecras_job.py params_hash와 같은 글자로 계산(바꾸면 둘 다). 결과는 지도 `/?run=<번호>` (Storage results/<버전>/run-<id>/)
- web/app/analysis (AnalysisApp·CompareMap·LineChart, lib/summary.ts): 분석·비교 — 아무 두 결과 비교(웹 계산 포함, 2026-11-17), 원인 지도는 기본 쌍만(pipeline/compare_web.py). 시간별 변화는 기간(시작–끝)·하천 단면 선택에 따라 그래프와 '기간 요약'이 바뀜(2026-11-18). 차이 지도(2026-11-23, lib/diffmap.ts·diffmapLoad.ts): 아무 두 결과의 depth2m/max.png × area2d_2m.png를 브라우저에서 새로 잠김·더 깊어짐·비슷함·얕아짐·안 잠기게 됨으로 나눔(0.1 m 두 기준은 compare_web.py와 같은 값), 점검 npm run check-diffmap
- web/components/RunStatus.tsx (TopBar 안): 모든 화면 위 계산 진행 표시 — 최근 runs에서 대기·계산 중(번호·progress·지난 시간) 또는 끝난 지 15분 안(결과 지도·기준과 비교 링크). /run에서는 숨김, /3d는 HTML 화면이라 없음
- web/app/3d/route.ts + public/view3d/: 3D 재현. 브이월드 초기화 스크립트가 document.write를 써서 React 페이지가 아니라 HTML을 직접 돌려준다. 시간대별 이미지는 각 결과의 frames/(4 m 등급)·depth2m/(2 m 연속 수심 + max.png, 3D 물이 이것을 씀 — DEPTH_SRC: 연속 파랑·0.5/1/2 m 등수심선) (pipeline/frames_web.py, 경위도 격자). 웹 수심 이미지(frames/·depth2m/·tiles/)는 경사 수면(pipeline/sloping.py, RAS Mapper sloping과 같은 원리 — 2026-11-17 사용자 결정), KPI는 셀 기준 그대로. '물 높이 3D'(view3d.js SHEET_SRC·buildSheet, buildings.js hnFlood): 수면 = 브이월드 지면(sampleTerrain 15) + 수심, 건물 벽은 둘레 수심까지 잠긴 색, 하천(1D) 물은 data/v1/area2d_2m.png로 빼고 세우지 않음. 흐름 보기(3D에만): river_flow.json(pipeline/river_flow.py) + flow2d.json·bin(pipeline/flow2d_web.py, Face Velocity → 셀 유속). 건물은 public/view3d/buildings.js가 GIS건물통합정보(브이월드 데이터 API LT_C_BLDGINFO, JSONP)로 직접 세움 — 실패 시 브이월드 LoD1 상자. 셰이더를 고치면 배포 화면에서 그리기 오류가 없는지 꼭 확인 (오류 나면 Cesium이 화면 갱신을 멈춤 — 숨은 브라우저 창에서는 viewer.render()를 직접 불러야 그려짐)
- 행정구역: web/public/data/admin/boundaries.geojson (pipeline/admin_web.py, 통계청 SGIS 행정동 2022-07 / vuski/admdongkor 가공, 출처 표시 필수)
- worker/: Python, HEC-RAS 명령줄(Ras.exe -c)을 직접 불러 실행, h5py로 HDF 읽기 (Windows PC) — ras-commander는 쓰지 않음. 워커 PC에서는 start_worker.bat(worker/start_worker.bat 사본) 더블클릭
- pipeline/: HDF → 웹 형식(PMTiles/Uint8 프레임/KPI JSON) 변환. 하천(1D) 수면 지도는 pipeline/river_map.py·river_publish.py (단면 수위 보간, 침수면적 KPI에는 미포함)
- web/app/validation (ValidationApp): 검증 — 하천 흔적수위(한국수자원조사기술원 2022.9.13 현장조사, pipeline/data/trace_levels_20220913.csv) vs 결과별 1D 최고수위(river.json, 누가거리 = 단면 번호 km로 선형 보간)를 브라우저에서 계산(웹 계산 포함), 종단·지점별 차이·RMSE/편의, 다른 검증 표(data/v1/validation/checks.json). 같은 계산을 pipeline/trace_levels.py가 하고 --publish로 validation/trace_levels.json을 만든다. 판정은 화면에서 하지 않음 (2026-11-19)
- 침수 건물 수: pipeline/buildings_kpi.py (건물 외곽선 × depth2m/max.png, 2D 범위 안 건물만) — 건물 자료 pipeline/data/buildings_v1.json.gz(브이월드 LT_C_BLDGINFO, 3D buildings.js와 같은 타일·규칙으로 2026-11-19 받음), 범위 이미지 사본 pipeline/data/area2d_2m_v1.png. 워커가 웹 계산마다 buildings.json을 만들어 올림. `--check`로 게시 결과 4개 대조 (2026-11-19)
- mcp/: (선택) MCP 서버 mcp/hinnamno_mcp.py — 표준 라이브러리 stdio(JSON-RPC), 웹과 같은 공개 키+익명 로그인, 도구 8개(조회·비교·기간 요약·계산 요청은 confirm 2단계·상태). 시험 mcp/tests/test_mcp.py(가짜 사이트·Supabase). PC 사본 C:\Hec-Ras\HECRASMCP\code\mcp, 확인 mcp_check.bat (2026-11-18)
- supabase/: 테이블 정의 (docs/GUIDE.md §5.2)

## 작업 방식 (과목 강의자료 기준, 상세: 로컬 '1. 과정/03_강의자료 방법 적용.md')
- 기능마다 DEFINE → PROMPT → BUILD → TEST → REFINE. 바로 구현하지 말고 /brainstorming → /write-plan → /execute-plan (Superpowers).
- PRD 기능 항목마다 PROBLEM · DATA · DOMAIN LOGIC · VALIDATION 네 칸을 채운다.
- 외부 서비스(Vercel, Supabase)는 MCP가 아니라 CLI + Skill로 다룬다. MCP는 HEC-RAS 연계(mcp/)에만 쓴다.
- 반복 절차는 .claude/skills/ 에 Skill로 저장한다 (hdf-to-web, deploy, hecras-run, ai-log).
- UI 문구·색은 "AI스럽지 않게": 과장된 맞장구·이모지 문구 금지, 사실·숫자 위주, 물·지도 중심의 차분한 색.
- 수리학적 판단(배율 범위, 체적오차 수용 여부, 검증 해석)은 사용자가 정한다. AI는 구현·실행·정리를 맡는다.

## 규칙
- 수리학적 정의(침수 기준 수심, KPI 공식)는 docs/GUIDE.md §4.4.1을 따른다. 임의로 바꾸지 않는다.
- 수심은 셀 최저표고가 아니라 2 m 지형 기준으로 계산한다.
- 원본 HEC-RAS 폴더(C:\Hec-Ras\KNUWATER\Pohang)는 수정 금지.
- 웹 실행용 기준 복사본은 C:\Hec-Ras\HECRASMCP\Pohang_web (HEC-RAS는 영어 경로에서 실행 — 경로에 한글 금지). 워커는 이것을 작업마다 폴더 구조째 복사해서 실행한다.
- 기준 복사본의 u01은 worker/prepare_base.py로 정리됨 (미사용 경계 165개 제거, 맨홀 274개 유량 DSS → 표). 결과 동일성은 worker/compare_results.py로 확인.
- 모형 버전: 지금은 v1 (Pohang_web). 좌안 2D·RS 7.65 보완한 v2로 나중에 결과만 교체한다 (docs/GUIDE.md §4.1.7). 그래서 코드에 모형 값(셀 수, 시각 범위, 경계 이름 목록 등)을 박아 넣지 말고 HDF·설정 파일에서 읽는다. 모든 결과·KPI에 model_version을 기록하고, 비교는 같은 버전끼리만 한다.
- HEC-RAS 원자료와 키·비밀값은 커밋하지 않는다 (.gitignore, .env).
- 기능 하나 끝날 때마다 실행·확인한다.
- 로컬 작업 폴더에서 작업할 때는 ../../1. 과정/02_AI 활용 기록.md 에 한 줄 기록하고, 단계가 끝나면 ../../1. 과정/01_작업 진행 가이드.md 진행 현황판을 갱신한다.
- docs/GUIDE.md는 로컬 '1. 과정/00_프로젝트 가이드라인.md'의 사본이다. 설계가 바뀌면 둘 다 고친다.
- 배포는 Vercel(GitHub 연동, push하면 배포), DB는 Supabase GitHub 연동 — `supabase/migrations`를 main에 올리면 반영된다. 이미 적용된 마이그레이션 파일은 고치지 말고 새 파일을 추가한다 (2026-11-02).
