# pipeline — HEC-RAS 결과(HDF) → 웹 형식 변환

- Step 3에서 작성
- 입력: `NC0909.p03.hdf`(외수), `NC090902.p03.hdf`(외수+내수), 2 m 지형 `Terrain.all.tif`
- 출력: 셀 지도(EPSG:4326), 최대 수심, 10분 프레임 70개(Uint8, 0.05 m 단위), 하천·측방 월류 시계열, `kpi.json`
- HDF 경로 표: docs/GUIDE.md §4.3.2 / 출력 형식: §5.1
- 수심은 셀 수위 − 2 m 지형으로 계산 (셀 최저표고 기준 금지)
