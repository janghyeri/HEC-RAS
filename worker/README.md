# worker — 계산 PC에서 HEC-RAS를 돌리는 프로그램

웹에서 들어온 계산 요청을 하나씩 가져와 HEC-RAS로 계산하고, 결과를 웹에서 볼 수 있는 형식으로 바꿔 올립니다.
HEC-RAS가 설치된 Windows PC에서 켜 둡니다. 웹 서버(Vercel)와는 직접 연결되지 않고 Supabase를 사이에 둡니다.

## 계산 한 건이 처리되는 순서

1. Supabase `runs` 표에서 대기 중인 요청 하나를 가져옵니다(`claim_next_run`). 30초마다 '켜져 있음'을 기록해 웹에 계산 서버 상태가 보입니다.
2. 입력값이 허용 범위 안인지 다시 확인합니다. 범위는 코드가 아니라 `pipeline/models/v1.json`의 `run.params`에서 읽습니다.
3. 기준 모형 폴더를 작업 폴더(`JOBS_DIR\run-<번호>`)로 통째로 복사합니다. 지난 결과 파일은 복사하지 않습니다.
4. 복사본의 부정류 파일(`.u01`)에서 유입 수문곡선에 배율을 곱하거나 하구 수위에 보정값을 더합니다.
5. `Ras.exe -c "<프로젝트>" "<계획>"`으로 계산합니다. Ras.exe는 후처리가 끝나기 전에 돌아오므로,
   결과 HDF에 `Complete Process`가 기록되고 작업 폴더가 30초 동안 바뀌지 않을 때 끝난 것으로 봅니다.
6. `pipeline/`으로 결과 HDF를 지도 타일, 10분 수심 이미지, 하천 시계열, KPI, 침수 건물 수로 바꿉니다.
7. Supabase Storage `results/v1/run-<번호>/`에 올리고 요청 상태를 `done`으로 바꿉니다. 실패하면 `failed`와 로그를 남깁니다.

원본 모형 폴더와 기준 복사본은 건드리지 않습니다. 모든 수정은 작업 폴더에서만 합니다.

## 웹에서 바꿀 수 있는 조건

| 조건 | 부정류 파일에서 바꾸는 곳 | 범위 |
|---|---|---|
| 상류 유입 배율 `upstream_flow_factor` | 하천 상류 경계의 Flow Hydrograph | ×0.5–1.5 |
| 측방 유입 배율 `lateral_flow_factor` | Lateral Inflow Hydrograph (5곳) | ×0.5–1.5 |
| 맨홀 월류량 배율 `internal_flow_factor` | 2D 영역 안 Flow Hydrograph (274곳, 외수 + 내수 계산만) | ×0.5–1.5 |
| 하구 조위 보정 `tide_offset_m` | Stage Hydrograph | +0–1.0 m |

경계조건은 이름이 아니라 부정류 파일의 구조로 찾습니다. 모든 값이 기본값이면 파일을 고치지 않습니다.
조도계수는 지오메트리 파일을 고쳐야 해서 아직 넣지 않았습니다.

## 설치와 실행

필요한 것: Windows, HEC-RAS 6.6, Python 3.9 이상, 영어 경로에 둔 기준 모형 폴더.

```
pip install -r pipeline/requirements.txt
copy worker\.env.example worker\.env      :: Supabase URL·service_role 키, RAS_EXE, JOBS_DIR 입력
```

`.env`의 service_role 키는 DB 권한 규칙을 건너뛰는 키라 계산 PC에만 두고 커밋하지 않습니다(`.gitignore`에 있음).

명령은 모두 저장소 루트에서 실행합니다.

| 하고 싶은 일 | 명령 |
|---|---|
| Supabase 접속 확인 | `python -m worker.check_supabase` |
| Supabase 없이 한 건 시험 | `python -m worker.run_local --name test1 --base S0-C --set internal_flow_factor=1.5 --compare --export` |
| 워커 켜기 (요청을 계속 처리) | `python -m worker.run_worker` |
| 요청 하나만 처리하고 끝내기 | `python -m worker.run_worker --once` |
| 결과 두 개 비교 | `python -m worker.compare_results --a <기준 p03.hdf> --b <비교 p03.hdf>` |

`run_local`의 `--set`은 여러 번 쓸 수 있고(`--set tide_offset_m=0.5`), `--compare`는 기준 결과와 침수면적·셀 최대수위·하천 단면·측방 월류를 비교,
`--export`는 웹 파일과 지도 타일까지 만듭니다. 결과는 `JOBS_DIR\<이름>\`에 남습니다.

`start_worker.bat`은 워커를 더블클릭으로 켜고, 오류로 멈추면 30초 뒤 다시 켭니다.
계산 PC 폴더 맨 위(예: `C:\Hec-Ras\HECRASMCP\`)에 두고 저장소는 그 아래 `code\`에 둔다고 가정합니다.
나머지 `.bat` 파일은 계산 PC에서 결과 이미지를 다시 만들 때 쓴 보조 파일입니다.

## 기준 모형을 처음 준비할 때

원본 모형에는 지오메트리에 없는 경계조건이 남아 있었고 맨홀 유량이 DSS 파일에 연결되어 있어서, 웹 실행용 복사본을 한 번 정리했습니다.

```
python -m worker.prepare_base --project <기준 복사본>\NC090901\NC0909.prj
python -m worker.prepare_base --project <기준 복사본>\NC090902\NC090902.prj --dss-to-table
```

쓰지 않는 경계조건 165개를 지우고, 맨홀 274곳의 유량을 부정류 파일 안의 표로 옮겼습니다(원본은 `.u01.orig`로 백업).
정리한 복사본을 다시 계산해 원본과 비교했을 때 침수면적 차이는 ±0.3 % 이내였습니다.

## 겪었던 문제

- **경로에 한글이 있으면** HEC-RAS가 불안정합니다. 모형과 작업 폴더는 영어 경로에 둡니다.
- **파일 이름에 따옴표가 없으면** HEC-RAS가 '명령줄 매개변수 오류' 창을 띄우고 멈춥니다. 화면을 보는 사람이 없으면 알 수 없어서,
  지금은 따옴표를 붙여 실행하고(`hecras_job.py`의 `ras_command`) 멈췄을 때 HEC-RAS 창의 글자를 로그에 남깁니다(`ras_windows.py`).
- **좌안 측방 구조물 RS 7.65**는 같은 입력으로 다시 계산해도 월류 방향이 바뀌는 불안정한 곳입니다. 그래서 결과 비교는 침수면적 ±1 %,
  셀 최대수위 차이 99분위 0.02 m 이내를 '같음'으로 봅니다.

## 파일

| 파일 | 하는 일 |
|---|---|
| `run_worker.py` | 대기열에서 요청을 가져와 계산·변환·업로드, 상태 기록 |
| `hecras_job.py` | 계산 한 건: 입력 확인, 작업 폴더 복사, 부정류 파일 수정, Ras.exe 실행, 완료 확인 |
| `run_local.py` | Supabase 없이 PC에서 한 건 계산·비교·웹 파일 만들기 |
| `compare_results.py` | 두 결과 HDF 비교 (침수면적, 셀 수위, 하천 단면, 측방 월류, 체적오차) |
| `prepare_base.py` | 웹 실행용 기준 모형 정리 |
| `supabase_rest.py` | Supabase REST 호출 (표준 라이브러리만 사용) |
| `upload_extra.py`, `upload_frames.py` | 이미 계산한 결과에 이미지·건물 수 등을 추가로 만들어 올리기 |
| `ras_windows.py` | HEC-RAS 창이 떴는지 확인해 로그에 남기기 (Windows 전용) |
| `check_supabase.py` | `.env` 설정과 Supabase 접속 확인 |
| `dump_river_geom.py` | 하천(1D) 단면 위치·지형·수위를 결과 HDF에서 꺼내기 (하천 수면 지도용) |
