# 힌남노 침수 다시보기 · Hinnamno Flood Replay

2022년 태풍 힌남노 때 포항 냉천 유역의 **HEC-RAS 6.6 1D–2D 외수·내수 침수해석**을 웹에서
**조건 설정 → 모델 실행 → 지도·3D 시각화 → 시나리오 비교**까지 할 수 있게 연결한 웹서비스.
웹에서 누른 조건으로 연구실 PC의 HEC-RAS가 실제로 다시 계산하고, 결과는 약 9분 뒤 대시보드에 자동으로 올라온다.

> 경북대학교 CVLE0764 개수로 및 유사이동론 (김병현 교수님) · 2026-2학기 과제
> "바이브 코딩을 활용한 수리·수문 모델 기반 웹앱 개발 및 배포" · 장혜리

## 과제 요구와 구현

| 요구 | 구현 | 코드 |
|---|---|---|
| (1) 모의조건 설정 | 상류·측방 유입 ×0.5–1.5, 맨홀 월류량 ×0.5–1.5, 하류 조위 +0–1.0 m (범위는 `pipeline/models/v1.json`) | `web/app/run`, `web/components/RunApp.tsx` |
| (2) 모델 실행 | Supabase 대기열 → Windows 워커가 기준 모형을 복사·u01 수정 → `Ras.exe -c` → 결과 HDF 완료 확인 | `worker/run_worker.py`, `worker/hecras_job.py` |
| (3) 결과 시각화 | KPI 표, 최대 침수심 지도(2 m 지형·경사 수면), 10분 재생, 지점 수심 시계열, 하천 유량·수위, 3D 물 높이·건물 잠김 | `web/components/FloodMapApp.tsx`, `web/app/3d`, `web/public/view3d` |
| (4) 시나리오 비교 | 아무 두 결과(웹 계산 포함) 스와이프 비교·KPI 증감표, 기간·단면 선택에 따른 그래프·기간 요약, 원인 지도 | `web/components/AnalysisApp.tsx`, `pipeline/compare_web.py` |
| (5) 배포 | GitHub → Vercel 자동 배포, `supabase/migrations` → DB 자동 반영 | `web/`, `supabase/` |
| (선택) MCP | AI가 자연어로 결과 조회·조건 실행 요청 (표준 라이브러리만 쓰는 stdio 서버) | `mcp/` |

## 구성

```
브라우저 (Next.js, Vercel) ──요청──▶ Supabase (runs 대기열 · Storage · 익명 로그인)
        ▲                                        │ 작업 가져감 / 결과 업로드
        └──────────── 결과 읽기 ◀────────────────┘
                                          계산 워커 (Windows PC, HEC-RAS 6.6, Python)
```

| 폴더 | 내용 | 실행 위치 |
|---|---|---|
| `web/` | Next.js 웹앱 — 조건 설정·실행, 침수 지도, 분석·비교, 3D 재현 | Vercel (Root Directory = `web`) |
| `worker/` | HEC-RAS 실행 워커 — 작업 조회·입력 수정·계산·결과 업로드 (`start_worker.bat`) | HEC-RAS 6.6 설치 Windows PC |
| `pipeline/` | 결과 HDF → 웹 형식 (KPI, 지도 타일, 10분 수심 이미지, 경사 수면, 하천 시계열, 침수 건물 수) | 워커와 공유 |
| `mcp/` | (선택) MCP 서버 — 결과 조회·비교·실행 요청 | 로컬 (Claude Desktop 등) |
| `supabase/` | DB 테이블·권한 정의 | Supabase |
| `docs/` | 설계 문서 `GUIDE.md`, 기능 명세 `PRD.md`, 계획 `PLAN.md` | — |
| `.claude/skills/` | 반복 절차 Skill (`hdf-to-web`, `hecras-run`, `deploy`, `ai-log`) | Claude Code |

## 모형

| 항목 | 내용 |
|---|---|
| 1D 하천 | 냉천 RS 13.434(상류) → 0.000(하구) |
| 2D 범람원 | 좌안 18,087 + 우안 25,861 = 43,948셀, 2 m DEM, EPSG:5187 |
| 1D–2D 연결 | 측방 구조물 RS 7.64(우안)·7.65(좌안) |
| 기준 계산 | 외수 NC090901(S0-E), 외수+내수 NC090902(S0-C, 맨홀 274개 월류 유량) |
| 모의 기간 | 2022-09-06 02:00–13:30, 지도 출력 10분(70장) |

자세한 내용은 [`docs/GUIDE.md`](docs/GUIDE.md) §4.1. 수리학적 정의(침수 기준 수심 0.1 m, KPI 공식)는 §4.4.1.

## 검증 (요약)

| 단계 | 결과 |
|---|---|
| 변환 정확성 | 웹 지도 면적 vs 2 m 래스터 +0.17~0.21 %, 0.1 m 이상 셀 수 브라우저 = 파이썬 |
| 실행 재현성 | 기준 복사본 재실행 침수면적 ±0.3 %, 셀 최대수위 차이 99분위 ≤ 0.017 m (`worker/compare_results.py`) |
| 모델 정확성 | 체적오차 전체 1.02 % (S0-C), 좌안 2D 10.1 % — 측방 구조물 RS 7.65 불안정. 침수흔적도 CSI·흔적수위는 자료 확보 중 (`pipeline/flood_trace.py`) |

## 실행

- **웹 (개발)**: `cd web && npm install && npm run dev` — `web/.env.example`을 `web/.env.local`로 복사해 키를 넣는다.
- **워커 (Windows PC)**: `worker/.env.example` → `worker/.env` (service_role 키는 이 PC에만), `start_worker.bat` 더블클릭.
- **로컬 계산·비교**: `python -m worker.run_local --name <이름> --base S0-C --set internal_flow_factor=1.5 --compare --export`
- **시험**: `python -m pytest pipeline/tests`

## 데이터 정책과 출처

- HEC-RAS 원자료(`*.hdf`, `*.dss`, 지형 `*.tif`)와 키·비밀값은 저장소에 올리지 않는다. 웹에는 변환된 결과만 올린다.
- 침수 해석: HEC-RAS 6.6 (U.S. Army Corps of Engineers, Hydrologic Engineering Center)
- 배경지도·항공사진·3D 지도·건물: 국토교통부 브이월드, GIS건물통합정보
- 행정구역: 통계청 SGIS 행정동 경계(2022-07, 공공누리 제1유형), vuski/admdongkor 가공(CC BY 4.0)
- 검증(예정): 행정안전부 「침수흔적도」, 재난안전데이터공유플랫폼 오픈API DSSP-IF-00117 (공공누리 제3유형)

## 개발 방식

Claude Code로 바이브 코딩. 기능마다 DEFINE → PROMPT → BUILD → TEST → REFINE, 반복 절차는 `.claude/skills/`에 저장.
코드·실행·정리는 AI가, 수리학적 판단(입력 범위, 판정 기준, 모형 보완 방향)은 작성자가 정했다. 에이전트 컨텍스트는 [`CLAUDE.md`](CLAUDE.md).
