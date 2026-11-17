---
name: hecras-run
description: 웹 요청 또는 PC에서 HEC-RAS 계산 1건을 실행하고(입력 배율·조위 반영 → Ras.exe → 결과 변환·업로드) 결과가 기준과 맞는지 확인한다. 웹 계산이 멈췄거나, 새 조건을 미리 계산하거나, 워커를 다시 켤 때 사용.
---

# HEC-RAS 계산 1건 실행

전제: HEC-RAS 6.6이 설치된 Windows PC, 기준 복사본 `C:\Hec-Ras\HECRASMCP\Pohang_web`(영어 경로 — 한글 경로에서는 HEC-RAS가 멈춤),
코드 `C:\Hec-Ras\HECRASMCP\code`(저장소의 `pipeline/`·`worker/` 사본), 비밀값은 `code\worker\.env`(커밋 안 함).

1. 워커 켜기 (웹 요청을 받아 계산)
   - `C:\Hec-Ras\HECRASMCP\start_worker.bat` 더블클릭 → 웹 `/run` 화면의 '계산 서버'가 켜짐으로 바뀌는지 본다 (heartbeat).
   - PC 잠자기를 끈다. 워커 코드가 바뀌면 창을 닫고 다시 켠다.
2. 한 건의 흐름 (`worker/run_worker.py` → `worker/hecras_job.py`)
   - 입력 검사: 범위는 `pipeline/models/<버전>.json`의 `run.params` (워커가 다시 검사).
   - 기준 복사본을 작업 폴더(`jobs\run-<id>`)로 폴더째 복사 → u01 표에 배율·조위 보정 반영 (원본·기준 복사본은 고치지 않음).
   - `Ras.exe -c "<프로젝트>" "<계획>"` — 파일 이름은 따옴표 필수. Ras.exe는 1D 후처리 전에 돌아올 수 있으므로 결과 HDF에 `Complete Process`가 기록될 때까지 기다린다.
   - 변환: `pipeline.export_web` → `publish_web` → `river_publish.add_river_to_job` → `frames_web.make_frames(depth2m=True, tiles=True, flow2d=True)` (경사 수면).
   - Supabase Storage `results/<버전>/run-<id>/`에 올리고 `runs` 표 상태를 `done`으로.
3. PC에서 직접 (웹 없이)
   ```
   python -m worker.run_local --name <이름> --base S0-C --set internal_flow_factor=1.5 --set tide_offset_m=0.5 --compare --export
   ```
4. 확인
   - 배율 1.0 실행이 보유 결과와 같은지: `python -m worker.compare_results --a <기준 p03.hdf> --b <새 p03.hdf>` — 침수면적 ±1 %, 셀 최대수위 차이 99분위 0.02 m 이내면 '같음'.
   - 측방 구조물 RS 7.65는 실행마다 월류 방향이 바뀌는 불안정 구간이라 좌안 값은 참고만 한다.
   - 계산 시간(24코어): 부정류 1.5~3분 + 1D 후처리 약 4분, 변환·업로드 포함 1건 약 9분.
5. 같은 조건은 다시 계산하지 않는다 — 조건 해시(`worker/hecras_job.py params_hash` = 웹 `lib/runConfig.ts`)로 기존 결과에 연결.
6. 기록: `../../1. 과정/02_AI 활용 기록.md`에 한 줄.

입력 범위·결과 해석(같음 판정 기준 수용 등)은 사용자가 정한다.
