# 힌남노 침수 다시보기 — 에이전트 컨텍스트

## 목적
HEC-RAS 6.6 1D–2D로 해석한 2022 힌남노 포항 냉천 외수·내수 침수를 웹에서
조건 설정→실행→시각화→시나리오 비교→배포. 시민용 공개 화면(주소 검색, 시간대별·3D 재현)도 제공.
과제 평가 기준과 요구사항은 docs/GUIDE.md §2.

## 모형 요약
- NC090901 = 외수, NC090902 = 외수+내수(맨홀 274개 월류 유량). 계획 p03, 지오메트리 g03, 부정류 u01
- 2D: left 18,087셀 + right 25,861셀, 1D: 냉천 RS 13.434→0.000, 측방 구조물 RS 7.64·7.65
- 모의 2022-09-06 02:00~13:30, 지도 출력 10분(70프레임), 좌표계 EPSG:5187, 지형 2 m DEM
- 계산 시간 (24코어): 부정류 1.5~3분 + 1D 후처리 약 4분 = 전체 6~8분. Ras.exe -c는 후처리 전에 돌아올 수 있음 → 결과 HDF에 "Complete Process"가 기록된 뒤 읽는다
- 측방 구조물 RS 7.65는 같은 입력에서도 실행마다 월류 방향이 바뀌는 불안정 구간 (docs/GUIDE.md §4.1.5). 결과 비교는 침수면적 ±1 %·셀 수위 99분위 0.02 m 기준
- HDF 경로 표: docs/GUIDE.md §4.3.2

## 구조
- web/: Next.js(App Router, TS) + shadcn/ui + MapLibre GL + deck.gl, Supabase 연동. Vercel Root Directory = web
- worker/: Python, ras-commander로 HEC-RAS 실행, HDF 읽기 (Windows PC)
- pipeline/: HDF → 웹 형식(PMTiles/Uint8 프레임/KPI JSON) 변환
- mcp/: (선택) FastMCP 서버
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
- 배포는 Vercel CLI, DB는 Supabase CLI 사용.
