"""하천(1D) 수면을 2D 최대 수심 지도에 더해 지도 타일을 다시 만들고, 하천 단면 정보(river.json)를 쓴다.

입력
  --dump      worker/dump_river_geom.py 출력 폴더 (river_<시나리오>.npz, terrain.npz)
  --depth-cm  pipeline/export_web.py 의 max_depth_cm.png (2D 최대 수심, cm, 지형 격자와 같은 크기)
  --dst       웹 공개 폴더의 시나리오 폴더 (예: web/public/data/v1/S0-C) — tiles/ 를 다시 만든다

하는 일
  1. 단면 절단선·최대 수위·측량 하상으로 하천 구간 수심 (pipeline/river_map.py)
  2. 2D 수심이 있는 곳은 2D, 없는 하천 구간만 하천 수심으로 합친 지도 → 타일 z10–16
     (타일 범위 = 2D 격자 범위 ∪ 하천 범위 — 상류 하천은 2D 격자 밖까지 이어진다)
  3. river.json: 단면별 위치(경위도)·측량 하상·제방 높이·최대 수위 — 지도에서 하천을 누르면 보여 준다
  4. meta.json 파일 목록에 river.json·하천 포함 표시

침수면적 KPI는 2D 셀 기준 그대로다 (kpi.json은 건드리지 않음).
"""
from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from . import tm_korea
from .river_map import merge_depth, river_depth
from .web_tiles import MIN_DEPTH, read_depth, write_tiles

OUT = "/Results/Unsteady/Output/Output Blocks/Base Output"


def _k(g, path):
    return g[path.replace("/", "|")]


def load_river(npz: Path) -> dict:
    """dump_river_geom 출력에서 단면 자료를 꺼낸다 (단면 순서 = 결과 순서, 상류→하류)."""
    g = np.load(npz)
    att = _k(g, "/Geometry/Cross Sections/Attributes")
    rs = [r.decode().strip() for r in att["RS"]]
    rs_res = [r.decode().strip() for r in _k(g, "/Results/Unsteady/Geometry Info/Cross Section Attributes")["Station"]]
    if rs != rs_res:
        raise ValueError(f"{npz.name}: 지오메트리와 결과의 단면 순서가 다름")
    info = _k(g, "/Geometry/Cross Sections/Polyline Info")
    pts = _k(g, "/Geometry/Cross Sections/Polyline Points")
    cut = [pts[s:s + n].astype(float) for s, n, *_ in info]
    sei = _k(g, "/Geometry/Cross Sections/Station Elevation Info")
    sev = _k(g, "/Geometry/Cross Sections/Station Elevation Values")
    profiles = [sev[s:s + n].astype(float) for s, n in sei]
    bed = np.array([p[:, 1].min() for p in profiles])

    def at_station(p, st):
        return float(np.interp(st, p[:, 0], p[:, 1])) if np.isfinite(st) else float("nan")

    bank_l = np.array([at_station(p, s) for p, s in zip(profiles, att["Left Bank"].astype(float))])
    bank_r = np.array([at_station(p, s) for p, s in zip(profiles, att["Right Bank"].astype(float))])
    max_ws = _k(g, f"{OUT}/Summary Output/Cross Sections/Maximum Water Surface")[0].astype(float)
    pinfo = _k(g, "/Geometry/2D Flow Areas/Polygon Info")
    ppts = _k(g, "/Geometry/2D Flow Areas/Polygon Points")
    areas2d = [ppts[s:s + n].astype(float) for s, n, *_ in pinfo]
    return {"rs": rs, "cut": cut, "bed": bed, "max_ws": max_ws, "bank_l": bank_l, "bank_r": bank_r,
            "levee_l": att["Left Levee Elev"].astype(float), "levee_r": att["Right Levee Elev"].astype(float),
            "areas2d": areas2d}


def mask_polygons(polys: list[np.ndarray], shape, x0, y0, dx, dy) -> np.ndarray:
    img = Image.new("L", (shape[1], shape[0]), 0)
    draw = ImageDraw.Draw(img)
    for p in polys:
        draw.polygon(list(zip(((p[:, 0] - x0) / dx - 0.5).tolist(), ((y0 - p[:, 1]) / dy - 0.5).tolist())), fill=1)
    return np.asarray(img, dtype=bool)


def _r(v, n=2):
    return None if not np.isfinite(v) else round(float(v), n)


def river_json(rv: dict, scenario: str) -> dict:
    xs = []
    for i, rs in enumerate(rv["rs"]):
        lon, lat = tm_korea.to_lonlat(rv["cut"][i][:, 0], rv["cut"][i][:, 1])
        xs.append({"rs": rs, "line": [[round(float(a), 6), round(float(b), 6)] for a, b in zip(lon, lat)],
                   "bed_m": _r(rv["bed"][i]), "max_ws_m": _r(rv["max_ws"][i]),
                   "bank_left_m": _r(rv["bank_l"][i]), "bank_right_m": _r(rv["bank_r"][i]),
                   "levee_left_m": _r(rv["levee_l"][i]), "levee_right_m": _r(rv["levee_r"][i])})
    return {"scenario_id": scenario,
            "note": "냉천 1D 단면 (상류→하류, timeseries.json river_ws_m 열 순서와 같음). 높이는 EL. m. "
                    "bank = 주수로 경계(좌·우안) 지반고, levee = HEC-RAS 제방 설정 높이(없으면 null)",
            "xs": xs}


def publish_river(dst: Path, depth_cm: Path, dump: Path, scenario: str, mesh_bbox, zmin=10, zmax=16,
                  index_path: Path | None = None) -> dict:
    """index_path를 주면 그 index.json의 이 시나리오 generated_at도 맞춘다 (화면이 새 타일을 받게)"""
    t = np.load(dump / "terrain.npz")
    z = t["z"]
    x0, y0, dx, dy = (float(v) for v in t["transform"])
    rv = load_river(dump / f"river_{scenario}.npz")
    in2d = mask_polygons(rv["areas2d"], z.shape, x0, y0, dx, dy)
    river = river_depth(rv["cut"], rv["max_ws"], z, x0, y0, dx, dy, exclude=in2d, thalweg=rv["bed"])
    d2 = read_depth(str(depth_cm))
    if d2.shape != z.shape:
        raise ValueError(f"2D 수심 격자 {d2.shape}와 지형 {z.shape}가 다름")
    d2 = np.where(d2 > 0, d2, np.nan)
    merged = merge_depth(d2, river)

    # 타일 범위: 2D 격자 범위 ∪ 하천 물 범위
    rr, cc = np.nonzero(np.isfinite(river) & (river >= MIN_DEPTH))
    xs = x0 + (np.array([cc.min(), cc.max() + 1])) * dx
    ys = y0 - (np.array([rr.min(), rr.max() + 1])) * dy
    lon, lat = tm_korea.to_lonlat(np.array([xs[0], xs[1], xs[0], xs[1]]), np.array([ys[0], ys[0], ys[1], ys[1]]))
    bbox = [min(mesh_bbox[0], float(lon.min())), min(mesh_bbox[1], float(lat.min())),
            max(mesh_bbox[2], float(lon.max())), max(mesh_bbox[3], float(lat.max()))]

    tiles_dir = dst / "tiles"
    if tiles_dir.exists():
        shutil.rmtree(tiles_dir)
    tiles = write_tiles(merged, (x0, y0), (dx, dy), bbox, tiles_dir, zmin, zmax)
    tiles["includes_river"] = True
    (tiles_dir / "tiles.json").write_text(json.dumps(tiles, ensure_ascii=False, indent=1), encoding="utf-8")

    (dst / "river.json").write_text(json.dumps(river_json(rv, scenario), ensure_ascii=False, separators=(",", ":")),
                                    encoding="utf-8")
    meta_p = dst / "meta.json"
    meta = json.loads(meta_p.read_text(encoding="utf-8"))
    meta["files"]["river.json"] = "냉천 1D 단면 위치·하상·제방 높이·최대 수위 (지도에서 하천을 누를 때)"
    meta["files"]["tiles/"] = (f"최대 수심 등급 PNG 타일 z{zmin}–{zmax} (XYZ) — 2D 셀 수심 + 하천(1D) 구간 수면, "
                               "설명은 tiles/tiles.json")
    meta["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    meta_p.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    if index_path is not None and index_path.exists():
        idx = json.loads(index_path.read_text(encoding="utf-8"))
        for s in idx.get("scenarios", []):
            if s.get("scenario_id") == scenario:
                s["generated_at"] = meta["generated_at"]
        index_path.write_text(json.dumps(idx, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    wet2d = np.isfinite(d2) & (d2 >= MIN_DEPTH)
    wetr = np.isfinite(river) & (river >= MIN_DEPTH)
    return {"scenario": scenario, "tiles": tiles["tiles"], "bounds": [round(v, 6) for v in bbox],
            "area_2d_km2": round(float(wet2d.sum()) * dx * dy / 1e6, 4),
            "area_river_km2": round(float(wetr.sum()) * dx * dy / 1e6, 4),
            "area_tiles_km2": round(tiles["area_m2_zmax"] / 1e6, 4),
            "river_depth_p50_p99_max_m": [round(float(np.nanpercentile(river, 50)), 2),
                                          round(float(np.nanpercentile(river, 99)), 2), round(float(np.nanmax(river)), 2)],
            "generated_at": meta["generated_at"]}


def add_river_to_job(job_dir: Path, hdf: Path, terrain_tif: Path, model_version: str, scenario: str) -> dict:
    """워커 작업 폴더에서: 결과 HDF·지형으로 하천 자료를 꺼내(job/river) web_pub 타일에 하천 수면을 더한다.
    export_web → publish_web 다음에 부른다 (run_local, run_worker)."""
    from worker.dump_river_geom import dump_hdf, dump_terrain

    rdir = job_dir / "river"
    rdir.mkdir(parents=True, exist_ok=True)
    dump_terrain(terrain_tif, rdir)
    dump_hdf(scenario, hdf, rdir)
    pub = job_dir / "web_pub"
    bbox = json.loads((pub / model_version / "mesh.json").read_text(encoding="utf-8"))["bbox_lonlat"]
    return publish_river(pub / model_version / scenario, job_dir / "web_out" / model_version / scenario / "max_depth_cm.png",
                         rdir, scenario, bbox, index_path=pub / "index.json")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dump", required=True)
    ap.add_argument("--depth-cm", required=True)
    ap.add_argument("--dst", required=True, help="웹 공개 폴더의 시나리오 폴더")
    ap.add_argument("--scenario", required=True)
    ap.add_argument("--mesh", required=True, help="웹 공개 폴더의 mesh.json (2D 격자 범위)")
    ap.add_argument("--index", default=None, help="웹 공개 폴더의 index.json (generated_at 맞춤)")
    a = ap.parse_args()
    bbox = json.loads(Path(a.mesh).read_text(encoding="utf-8"))["bbox_lonlat"]
    print(json.dumps(publish_river(Path(a.dst), Path(a.depth_cm), Path(a.dump), a.scenario, bbox,
                                   index_path=Path(a.index) if a.index else None), ensure_ascii=False))


if __name__ == "__main__":
    main()
