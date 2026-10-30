# worker — HEC-RAS 실행 워커 (Windows)

- HEC-RAS 6.6이 설치된 Windows PC에서 실행
- 웹 실행용 기준 모형: `C:\Hec-Ras\HECRASMCP\Pohang_web` (영어 경로 — HEC-RAS가 한글 경로에서 불안정)
- 설계: docs/GUIDE.md §4.3.1–4.3.2
- 작업 폴더(`worker/jobs/`)와 HEC-RAS 원자료는 커밋하지 않음

## 지금 있는 스크립트 (Step 1)

| 파일 | 하는 일 |
|---|---|
| `prepare_base.py` | 기준 u01 만들기 — 지오메트리에 없는 경계조건 제거, `--dss-to-table`이면 DSS 연결 유량을 결과 HDF의 Event Conditions 값으로 u01 표 전환. 원본은 `.u01.orig`로 백업 |
| `compare_results.py` | 두 p##.hdf 비교 — 침수면적(0.1·0.5·1.0 m), 셀 최대수위 차이 분위, 하천 단면, 측방 월류(방향 바뀜 표시), 체적오차. 침수면적 ±1 %·99분위 0.02 m 이내면 "같음" |
| `run_baseline.bat` | `Pohang_web` 두 계획을 HEC-RAS 명령줄로 재실행, 로그는 `C:\Hec-Ras\HECRASMCP\run_baseline.log` |

```
pip install h5py numpy
python prepare_base.py --project C:\Hec-Ras\HECRASMCP\Pohang_web\NC090901\NC0909.prj
python prepare_base.py --project C:\Hec-Ras\HECRASMCP\Pohang_web\NC090902\NC090902.prj --dss-to-table
python compare_results.py --a C:\Hec-Ras\KNUWATER\Pohang\NC090902\NC090902.p03.hdf --b C:\Hec-Ras\HECRASMCP\Pohang_web\NC090902\NC090902.p03.hdf
```

2026-10-19에 두 프로젝트 모두 적용 완료 (제거 165개, 전환 274개, 총 유입 체적 5,167,897 → 5,167,898 m³).
2026-10-28 재실행·비교 결과 원본과 같음 (침수면적 ±0.3 % 이내). 계산 전체 6~8분 중 1D 후처리 약 4분.

## Step 5 — 웹 실행 워커 (2026-10-30 작성)

| 파일 | 하는 일 |
|---|---|
| `hecras_job.py` | 작업 1건: 입력 검사(범위는 `pipeline/models/<버전>.json` `run.params`) → `Pohang_web` 폴더 구조째 복사(지난 결과 파일 제외) → `u01` 표에 배율·보정 적용 → (선택) 1D 후처리 끄기 → `Ras.exe -c` → 결과가 다 쓰일 때까지 대기 |
| `run_local.py` | Supabase 없이 PC에서 작업 1건 시험 — 기준 결과와 비교, 빠진 HDF 자료 목록, 웹 파일·타일 만들기, `report.json` |
| `run_worker.py` | Supabase 대기열(`runs`)에서 작업을 가져와 계산 → 결과를 Storage `results/<버전>/run-<id>/`에 올림, 30초마다 `worker_heartbeat` |
| `supabase_rest.py` | Supabase REST 최소 클라이언트 (표준 라이브러리만) |
| `.env.example` | 워커 설정 예 — 실제 키는 `worker/.env`에만 (커밋 금지) |

입력 항목과 u01 반영 (경계 종류는 u01 구조로 판별, 이름을 코드에 적지 않음)

| 항목 | u01에서 바꾸는 표 | 기본 | 범위 (초안, 사용자 확정 전) |
|---|---|---|---|
| `upstream_flow_factor` 상류 유입 배율 | 하천 경계의 `Flow Hydrograph` | 1.0 | 0.5–1.5 |
| `lateral_flow_factor` 측방 유입 배율 | `Lateral Inflow Hydrograph` 5개 | 1.0 | 0.5–1.5 |
| `internal_flow_factor` 맨홀 월류량 배율 (외수+내수만) | 2D 경계의 `Flow Hydrograph` 274개 | 1.0 | 0–1.5 |
| `tide_offset_m` 하류 조위 보정 | `Stage Hydrograph` (+값) | 0 | 0–1.0 m |
| 조도계수 배율 | 지오메트리 수정 필요 — 다음 단계 | | |

- 모든 값이 기본값이면 u01을 건드리지 않는다 (기준 결과와 같은 입력).
- 시험 (2026-10-30, 실제 u01): 맨홀 ×1.5 → 274개 표 합계 정확히 1.5배(8칸 반올림 오차 ≤ 5×10⁻⁶ m³/s), 조위 +0.5 m → 205개 값 모두 +0.5, 표 밖의 줄 5,238줄 중 바뀐 줄 0.
- `Ras.exe -c`는 후처리 전에 돌아온다 (10/28 기록: NC0909는 Ras.exe가 돌아온 뒤 약 1분 30초 동안 O03·p03.hdf를 더 씀) → 작업 폴더가 30초 동안 그대로이고 계산 메시지에 `Complete Process`가 있을 때 완료로 본다. HEC-RAS가 쓰는 중인 HDF는 열지 않는다.

PC 시험: `C:\Hec-Ras\HECRASMCP\test_step5.bat` (T1 배율 1.0·후처리 끔 → 기준 결과와 비교, T2 맨홀 ×1.5·후처리 끔)
