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

## 다음 (Step 5)

Supabase 대기 작업 조회 → `Pohang_web` 구조째 작업 폴더 복사 → `u01` 배율 적용 → HEC-RAS 계산 → `pipeline` 변환 → 업로드
