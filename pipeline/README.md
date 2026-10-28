# pipeline — HEC-RAS 결과(HDF) → 웹 형식 변환

작업 진행 가이드 Step 3. 설계: docs/GUIDE.md §4.3.2(HDF 경로), §4.4.1(KPI), §5.1(출력 형식).

## 설치

```
pip install -r pipeline/requirements.txt      # numpy, h5py, Pillow, tifffile
```

좌표 변환(EPSG:5187 → WGS84)은 `tm_korea.py`에 직접 구현해 pyproj가 필요 없다 (검증: `python -m pipeline.tests.test_tm_korea`).

## 실행

저장소 루트에서:

```
python -m pipeline.export_web ^
  --hdf C:\Hec-Ras\HECRASMCP\Pohang_web\NC090902\NC090902.p03.hdf ^
  --terrain C:\Hec-Ras\HECRASMCP\Pohang_web\NC090901\Terrain\Terrain.all.tif ^
  --model-version v1 --scenario S0-C --label "힌남노 외수+내수" --out data/out --geojson
```

시나리오 하나에 약 15초. 같은 모형 버전의 격자(mesh)는 한 번만 만들고, 격자가 다르면 멈춘다(버전을 올려야 함).

## 모듈

| 파일 | 역할 |
|---|---|
| `hecras_hdf.py` | p##.hdf에서 셀 격자·표고-체적 표·최대/프레임 수위·하천 단면·측방 구조물·경계 유입 읽기 |
| `subgrid.py` | 셀 표고-체적 표로 젖은 면적·체적·평균 수심, '수심 ≥ h' 면적 (벡터화) |
| `raster_depth.py` | 셀 다각형을 2 m 지형에 래스터화 → 수심 래스터, 등급 색 PNG, 16비트 cm PNG |
| `tm_korea.py` | EPSG:5187 ↔ WGS84 (Krüger 급수) |
| `export_web.py` | 위를 묶어 웹 파일 출력 (출력 목록은 파일 머리 설명) |
| `models/v1.json` | 모형 버전 설명·주의 사항 → kpi.json `model_notes`로 들어감 |

## 출력 요약 (data/out/<모형 버전>/)

- 격자: `mesh.json`, `mesh_vertices.i32`, `mesh_offsets.u32`, `mesh_centers.i32`, `mesh_cells.f32`, (`mesh.geojson`), `model.json`
- 시나리오: `meta.json`, `kpi.json`, `timeseries.json`, `frames_depth.u8`, `frames_wet.u8`, `cells_max.u8`, `max_depth.png`, `max_depth_cm.png`, (`manholes.geojson`)
- `index.json`: 변환된 시나리오 목록

## 정의 메모

- 셀 수심은 **젖은 부분 평균 수심** = 체적 ÷ 젖은 면적. 셀 최저표고 기준 수심은 쓰지 않는다.
- 침수면적은 셀 표고-체적 표 기준이 주 값, 2 m 래스터 기준은 검산값 (v1에서 래스터가 2~4 % 크게 나옴 — RAS Mapper 래스터로 확정 예정).
- 2 m 수심 래스터는 셀 안 수면을 수평으로 둔다.
- 최대 침수심은 작은 웅덩이에 민감하므로 침수 화소 99분위 값을 함께 본다.
- 하천 최대 유량·수위는 계산 간격 기준 요약값(Summary Output)을 쓴다.
