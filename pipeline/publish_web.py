"""변환 결과(export_web 출력) 중 웹 화면에 필요한 것만 web/public/data/ 로 옮기고 침수 타일을 만든다.

입력  <src>/index.json, <src>/<버전>/mesh*, <src>/<버전>/<시나리오>/*   (pipeline/export_web.py 출력)
출력  <dst>/index.json
      <dst>/<버전>/mesh.json, mesh_vertices.i32, mesh_offsets.u32, mesh_cells.f32, model.json
      <dst>/<버전>/<시나리오>/meta.json, kpi.json, cells_max.u8, frames_depth.u8, [manholes.geojson], tiles/

- 원자료 경로 같은 로컬 정보(meta.source_hdf)는 지운다.
- 타일 범위는 격자 범위(mesh.json bbox_lonlat)에서 읽는다 — 모형 값을 코드에 넣지 않는다.
- 검증: 타일(z 최대) 면적을 같은 cm 래스터의 0.1 m 이상 면적과 비교해 1 % 넘게 다르면 멈춘다(재표본 오차).
  kpi.json 래스터 검산값과의 차이도 함께 보고한다 — cm 반올림 때문에 0.095–0.1 m 화소가 들어가 약 1 % 크다.
  침수 화소 중심점(타일 vs 원 래스터)의 거리도 보고한다 (좌표 변환 확인).

사용 예 (저장소 루트에서)
  python -m pipeline.publish_web --src data/out --dst web/public/data --model-version v1
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
from pathlib import Path

import numpy as np

from . import tm_korea
from .web_tiles import MIN_DEPTH, read_depth, write_tiles

MESH_FILES = ("mesh.json", "mesh_vertices.i32", "mesh_offsets.u32", "mesh_cells.f32", "model.json")
SCENARIO_FILES = ("kpi.json", "cells_max.u8", "frames_depth.u8", "manholes.geojson")
AREA_TOL = 0.01


def publish(src: Path, dst: Path, model_version: str, zmin: int, zmax: int) -> list[dict]:
    index = json.loads((src / "index.json").read_text(encoding="utf-8"))
    scenarios = [s for s in index["scenarios"] if s["model_version"] == model_version]
    if not scenarios:
        raise SystemExit(f"{model_version} 시나리오가 index.json에 없음")
    ver_src, ver_dst = src / model_version, dst / model_version
    ver_dst.mkdir(parents=True, exist_ok=True)
    for f in MESH_FILES:
        shutil.copy2(ver_src / f, ver_dst / f)
    mesh = json.loads((ver_src / "mesh.json").read_text(encoding="utf-8"))
    bbox = mesh["bbox_lonlat"]

    report = []
    for s in scenarios:
        sid = s["scenario_id"]
        s_src, s_dst = ver_src / sid, ver_dst / sid
        if s_dst.exists():
            shutil.rmtree(s_dst)
        s_dst.mkdir(parents=True)
        meta = json.loads((s_src / "meta.json").read_text(encoding="utf-8"))
        meta.pop("source_hdf", None)
        meta["files"] = {k: v for k, v in meta["files"].items() if k in SCENARIO_FILES}
        for f in SCENARIO_FILES:
            if (s_src / f).exists():
                shutil.copy2(s_src / f, s_dst / f)
        r = meta["raster"]
        depth = read_depth(str(s_src / "max_depth_cm.png"))
        tiles = write_tiles(depth, r["origin_xy"], r["pixel_xy"], bbox, s_dst / "tiles", zmin, zmax)
        wet = depth >= MIN_DEPTH
        ref_cm = float(wet.sum()) * r["pixel_xy"][0] * r["pixel_xy"][1] / 1e6
        rr, cc = np.nonzero(wet)
        cx = r["origin_xy"][0] + (cc.mean() + 0.5) * r["pixel_xy"][0]
        cy = r["origin_xy"][1] - (rr.mean() + 0.5) * r["pixel_xy"][1]
        tx, ty = tm_korea.from_lonlat(*tiles["wet_centroid_lonlat"])
        centroid_shift_m = math.hypot(float(tx) - cx, float(ty) - cy)
        meta["files"]["tiles/"] = f"최대 수심 등급 PNG 타일 z{zmin}–{zmax} (XYZ), 설명은 tiles/tiles.json"
        (s_dst / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

        kpi = json.loads((s_src / "kpi.json").read_text(encoding="utf-8"))
        ref_kpi = kpi["inundation_area_km2_raster_check"]["ge_0.1m"]
        got = tiles["area_m2_zmax"] / 1e6
        diff = (got - ref_cm) / ref_cm
        report.append({"scenario": sid, "tiles": tiles["tiles"], "area_tiles_km2": round(got, 4),
                       "area_cm_raster_km2": round(ref_cm, 4), "diff_resample_pct": round(diff * 100, 2),
                       "area_kpi_raster_km2": ref_kpi, "diff_vs_kpi_pct": round((got - ref_kpi) / ref_kpi * 100, 2),
                       "wet_centroid_shift_m": round(centroid_shift_m, 2)})
        if abs(diff) > AREA_TOL:
            raise SystemExit(f"{sid}: 타일 면적 {got:.4f} km² 가 cm 래스터 면적 {ref_cm:.4f} km² 와 {diff:+.1%} 다름")

    (dst / "index.json").write_text(json.dumps({"scenarios": scenarios}, ensure_ascii=False, indent=1),
                                    encoding="utf-8")
    return report


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="export_web 출력 폴더 (index.json 있는 곳)")
    ap.add_argument("--dst", required=True, help="웹 공개 폴더, 보통 web/public/data")
    ap.add_argument("--model-version", required=True)
    ap.add_argument("--zmin", type=int, default=10)
    ap.add_argument("--zmax", type=int, default=16)
    a = ap.parse_args()
    for row in publish(Path(a.src), Path(a.dst), a.model_version, a.zmin, a.zmax):
        print(json.dumps(row, ensure_ascii=False))


if __name__ == "__main__":
    main()
