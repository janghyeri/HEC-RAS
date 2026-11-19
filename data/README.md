# data

계산 PC에서 작업할 때 쓰는 임시 폴더입니다. 안의 내용은 저장소에 올리지 않습니다.

- `raw/` — HEC-RAS 원자료 사본
- `out/` — `pipeline.export_web`이 만든 변환 결과. 웹에 필요한 것만 `pipeline.publish_web`으로 `web/public/data/`에 옮깁니다.

계산에 쓰는 작은 자료(건물 외곽선, 흔적수위 표 등)는 `pipeline/data/`에 있습니다.
