# pipeline — HEC-RAS 결과를 웹 자료로 바꾸기

HEC-RAS 계획 결과 파일(`p##.hdf`)에서 필요한 값만 꺼내 웹 지도와 대시보드가 쓰는 작은 파일들로 바꿉니다.
계산 PC의 워커가 계산이 끝날 때마다 이 코드를 부르고, 미리 계산한 결과도 같은 코드로 만들었습니다.

셀 수, 시각, 경계 이름 같은 모형 값은 코드에 적지 않고 HDF와 `models/<버전>.json`에서 읽습니다.
보완한 모형으로 바꾸면 버전(`v2`)을 올리고 같은 명령을 다시 돌리면 됩니다.

## 설치

```
pip install -r pipeline/requirements.txt     # numpy, h5py, Pillow, tifffile
```

좌표 변환(EPSG:5187 ↔ 경위도)은 `tm_korea.py`에 직접 구현해 pyproj 없이 돌아갑니다.

## 기본 사용법

명령은 저장소 루트에서 실행합니다.

```
:: 1) 결과 HDF → 웹 자료 (시나리오 하나에 약 15초)
python -m pipeline.export_web ^
  --hdf <모형 폴더>\NC090902\NC090902.p03.hdf ^
  --terrain <모형 폴더>\NC090901\Terrain\Terrain.all.tif ^
  --model-version v1 --scenario S0-C --label "힌남노 외수+내수" --out data/out

:: 2) 웹에 필요한 것만 web/public/data 로 옮기고 지도 타일 만들기
python -m pipeline.publish_web --src data/out --dst web/public/data --model-version v1

:: 3) 침수 건물 수 (결과 폴더마다)
python -m pipeline.buildings_kpi --result-dir web/public/data/v1/S0-C

:: 4) 하천 흔적수위 비교
python -m pipeline.trace_levels --publish
```

같은 모형 버전의 격자는 처음 한 번만 만들고, 격자가 다른 결과가 들어오면 멈춥니다(버전을 올려야 한다는 뜻).

## 계산 기준

- **수심**은 셀 최저표고가 아니라 2 m 지형에서 잰 값입니다.
- **침수**는 수심 0.1 m 이상, **침수면적**은 HEC-RAS 셀 표고-체적 표로 계산합니다. 하천(1D) 안의 물은 넣지 않습니다.
- **침수 시작**은 0.1 m 이상 잠긴 면적이 5 ha를 처음 넘은 시각입니다.
- **대표 최대 수심**은 작은 웅덩이에 휘둘리지 않도록 침수 화소의 99분위 값을 씁니다.
- **지도 이미지**는 셀 안 수면을 평평하게 두지 않고 셀 꼭짓점 수위를 이어 경사지게 그립니다(RAS Mapper의 sloping과 같은 원리).
  KPI는 셀 기준 값을 그대로 씁니다.
- **침수 건물**은 2D 범위 안 건물(국토교통부 GIS건물통합정보 12,131동) 가운데 외곽선 안 최대 수심이 기준 이상인 건물입니다.

자세한 정의는 [`docs/GUIDE.md`](../docs/GUIDE.md) §4.4.1에 있습니다.

## 파일

| 파일 | 하는 일 |
|---|---|
| `hecras_hdf.py` | 결과 HDF에서 셀 격자, 표고-체적 표, 최대·시간별 수위, 하천 단면, 측방 구조물, 경계 유입 읽기 |
| `subgrid.py` | 셀 표고-체적 표로 젖은 면적·체적·평균 수심 계산 |
| `raster_depth.py` | 셀 수위를 2 m 지형에 얹어 수심 래스터 만들기 |
| `sloping.py` | 경사 수면 수심 계산 |
| `export_web.py` | 위를 묶어 웹 자료 출력 (KPI, 시계열, 프레임, 격자) |
| `publish_web.py` | 웹에 필요한 파일만 `web/public/data/`로 옮기기 |
| `web_tiles.py` | 최대 수심 래스터 → 웹 지도 타일(PNG) |
| `frames_web.py` | 10분 간격 수심 이미지 (지도 재생, 3D 물 표면) |
| `compare_web.py` | 두 계산을 비교한 원인 지도 (하천 범람만 / 도시 침수로 더 깊어짐 / 도시 침수로만 잠김) |
| `buildings_kpi.py` | 침수 건물 수 |
| `river_map.py`, `river_publish.py` | 하천(1D) 구간 수면 지도와 단면별 수위 자료 |
| `river_flow.py`, `flow2d_web.py` | 3D '흐름 보기'용 하천·범람원 흐름 자료 |
| `trace_levels.py` | 하천 흔적수위와 모형 최고수위 비교 |
| `flood_trace.py` | 침수흔적도와 모의 범위 비교 (2022년 포항 자료가 없어 지금은 쓰지 않음) |
| `admin_web.py`, `area_mask_web.py` | 행정동 경계, 2D 계산 범위 이미지 |
| `tm_korea.py` | 좌표 변환 |
| `models/v1.json` | 모형 버전 설명, 웹에서 바꿀 조건과 범위, 주의 사항 |
| `data/` | 건물 외곽선, 흔적수위 표 등 계산에 쓰는 작은 자료 |

## 시험

```
python -m pytest pipeline/tests
```
