---
name: hdf-to-web
description: HEC-RAS 계획 결과(p##.hdf)를 웹 지도·대시보드용 파일로 변환하고 기준값과 대조한다. 새 시나리오 결과가 나왔거나 모형 버전을 바꿀 때 사용.
---

# HEC-RAS 결과 → 웹 파일 변환

1. 입력 확인
   - 결과 HDF가 완성됐는지: HDF 계산 메시지에 `Complete Process`가 있어야 한다 (Ras.exe -c는 후처리 전에 돌아올 수 있음).
   - 지형: `C:\Hec-Ras\HECRASMCP\Pohang_web\NC090901\Terrain\Terrain.all.tif`
   - 모형 버전(`v1` 등)과 시나리오 ID(`S0-E`, `S0-C`, `S3-tide050` 등)를 정한다. 모형 설명은 `pipeline/models/<버전>.json`.
2. 변환
   ```
   python -m pipeline.export_web --hdf <p03.hdf> --terrain <Terrain.all.tif> --model-version <버전> --scenario <ID> --label "<이름>" --out data/out
   ```
   격자가 기존 버전과 다르다고 멈추면 모형 버전을 올린다 (docs/GUIDE.md §4.1.7).
3. 대조 (출력의 `kpi.json`)
   - 기준 시나리오는 `1. 과정/표·수치/KPI_기준시나리오.md` 값과 같아야 한다 (침수면적 ±1 %).
   - `inundation_area_km2`(표고-체적 표)와 `..._raster_check`(2 m 래스터) 차이가 5 %를 넘으면 원인을 확인한다.
   - 하천 최대유량은 상류 → 하류로 커지는지, 측방 구조물 순 월류 체적의 부호를 본다.
4. 기록: `../../1. 과정/02_AI 활용 기록.md`에 한 줄, 새 기준 수치는 `표·수치`에 추가.

수리학적 해석(값이 맞는지 판단)은 사용자가 한다. 이 Skill은 변환과 대조까지만 한다.
