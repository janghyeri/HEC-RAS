"""HEC-RAS 결과(p##.hdf) → 웹 지도·대시보드용 파일 (작업 진행 가이드 Step 3, docs/GUIDE.md §5.1).

출력 (out_root/<model_version>/)
  mesh.json, mesh_vertices.i32, mesh_offsets.u32, mesh_centers.i32, mesh_cells.f32  — 격자 (모형 버전당 1벌)
  [mesh.geojson]                                                                     — --geojson 일 때
  <scenario_id>/meta.json        파일 목록·시각·양자화 규칙
  <scenario_id>/kpi.json         침수면적·시각·하천·측방 월류·체적오차 (docs/GUIDE.md §4.4.1)
  <scenario_id>/timeseries.json  하천 단면 유량·수위, 측방 구조물, 맨홀 유입 합계, 침수면적 곡선
  <scenario_id>/frames_depth.u8  (프레임 × 셀) 젖은 부분 평균 수심, 0.05 m 단위
  <scenario_id>/frames_wet.u8    (프레임 × 셀) 젖은 면적 비율 × 255
  <scenario_id>/cells_max.u8     (4 × 셀) 최대 수심 · 최대 젖은 비율 · 최대 시각 프레임 · 0.3 m 이상 지속 프레임 수
  <scenario_id>/max_depth.png    2 m 최대 수심 등급 색 (투명 배경)  + max_depth_cm.png (16비트, cm)
  <scenario_id>/manholes.geojson 2D 내부 유입 경계(맨홀) 위치·첨두·체적 (있을 때)

좌표: 정수 1e-7 도 (경도, 위도). 시각: 모형 입력 시각(KST)을 +09:00으로 표기.
모형 값은 모두 HDF에서 읽는다 (CLAUDE.md 모형 버전 규칙).

사용 예
  python -m pipeline.export_web --hdf C:\\Hec-Ras\\HECRASMCP\\Pohang_web\\NC090902\\NC090902.p03.hdf ^
      --terrain C:\\Hec-Ras\\HECRASMCP\\Pohang_web\\NC090901\\Terrain\\Terrain.all.tif ^
      --model-version v1 --scenario S0-C --label "힌남노 외수+내수" --out data/out --geojson
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

_trapz = getattr(np, "trapezoid", None) or np.trapz  # numpy 1.x(Anaconda 구버전)에서도 동작

from . import tm_korea
from .hecras_hdf import read_plan
from .raster_depth import colorize, corners, depth_cm_image, depth_raster, rasterize_cells, read_terrain
from .subgrid import SubgridTable

DEPTH_STEP = 0.05          # m — 프레임 수심 양자화 간격
AREA_THRESHOLDS = (0.1, 0.5, 1.0, 2.0)
ONSET_AREA_M2 = 50_000     # 침수 시작 판정: 수심 0.1 m 이상 면적이 5 ha를 처음 넘는 시각
DURATION_DEPTH = 0.3       # m — 지속시간 기준 수심
COORD_SCALE = 1e7


def _iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S") + "+09:00"


def _q_depth(d):
    return np.clip(np.round(d / DEPTH_STEP), 0, 255).astype(np.uint8)


def _q_frac(f):
    return np.clip(np.round(f * 255), 0, 255).astype(np.uint8)


def _lonlat_i32(xy):
    lon, lat = tm_korea.to_lonlat(xy[:, 0], xy[:, 1])
    return np.stack([np.round(lon * COORD_SCALE), np.round(lat * COORD_SCALE)], axis=1).astype(np.int32)


def _ll(x, y):
    lon, lat = tm_korea.to_lonlat(x, y)
    return [round(float(lon), 6), round(float(lat), 6)]


def build_mesh(plan):
    polys, centers, cell_area, zmin, areas = [], [], [], [], []
    offset = 0
    for a in plan.areas:
        for row in a.cell_fp_index:
            idx = row[row >= 0]
            polys.append(a.facepoints[idx])
        centers.append(a.center)
        cell_area.append(a.cell_area)
        zmin.append(a.zmin)
        areas.append({"name": a.name, "offset": offset, "count": a.n_cells})
        offset += a.n_cells
    h = hashlib.sha1()
    for p in polys:
        h.update(np.ascontiguousarray(p, dtype=np.float64).tobytes())
    return {
        "polygons": polys,
        "centers": np.concatenate(centers),
        "cell_area": np.concatenate(cell_area),
        "zmin": np.concatenate(zmin),
        "areas": areas,
        "hash": h.hexdigest()[:16],
    }


def write_mesh(mesh, out: Path, model_version: str, geojson: bool):
    out.mkdir(parents=True, exist_ok=True)
    counts = np.array([len(p) for p in mesh["polygons"]], dtype=np.uint32)
    offsets = np.concatenate([[0], np.cumsum(counts)]).astype(np.uint32)
    verts = _lonlat_i32(np.concatenate(mesh["polygons"]))
    verts.tofile(out / "mesh_vertices.i32")
    offsets.tofile(out / "mesh_offsets.u32")
    _lonlat_i32(mesh["centers"]).tofile(out / "mesh_centers.i32")
    np.stack([mesh["cell_area"], mesh["zmin"]], axis=1).astype(np.float32).tofile(out / "mesh_cells.f32")
    lon = verts[:, 0] / COORD_SCALE
    lat = verts[:, 1] / COORD_SCALE
    meta = {
        "model_version": model_version,
        "geometry_hash": mesh["hash"],
        "n_cells": int(len(counts)),
        "n_vertices": int(len(verts)),
        "areas": mesh["areas"],
        "bbox_lonlat": [float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())],
        "coordinate_scale": COORD_SCALE,
        "source_crs": "EPSG:5187",
        "files": {
            "mesh_vertices.i32": "int32 [경도, 위도] × 1e7, 셀 순서대로 이어 붙임 (다각형은 닫지 않음)",
            "mesh_offsets.u32": "uint32 (셀 수 + 1) — 셀 i의 꼭짓점은 [offsets[i], offsets[i+1])",
            "mesh_centers.i32": "int32 [경도, 위도] × 1e7, 셀 중심",
            "mesh_cells.f32": "float32 [셀 면적 m2, 셀 최저표고 m]",
        },
    }
    if geojson:
        feats = []
        for i in range(len(counts)):
            ring = verts[offsets[i]:offsets[i + 1]] / COORD_SCALE
            ring = np.vstack([ring, ring[:1]])
            feats.append({"type": "Feature", "id": i,
                          "properties": {"i": i, "area_m2": round(float(mesh["cell_area"][i]), 1)},
                          "geometry": {"type": "Polygon", "coordinates": [np.round(ring, 7).tolist()]}})
        (out / "mesh.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                                     separators=(",", ":")), encoding="utf-8")
        meta["files"]["mesh.geojson"] = "셀 다각형 GeoJSON (속성 i = 셀 번호)"
    (out / "mesh.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return meta


def _nearest_station(stations, rs_value):
    vals = np.array([float(s) for s in stations])
    return int(np.argmin(np.abs(vals - rs_value)))


def export(hdf: str, terrain_path: str, out_root: str, model_version: str, scenario: str,
           label: str, geojson: bool = False, base: str | None = None, params: dict | None = None) -> dict:
    """base·params: 웹 실행 결과일 때 기준 시나리오와 바꾼 입력 (index.json에 그대로 적어 화면이 묶어 보여 줌)"""
    plan = read_plan(hdf)
    out_ver = Path(out_root) / model_version
    out = out_ver / scenario
    out.mkdir(parents=True, exist_ok=True)

    mesh = build_mesh(plan)
    mesh_meta_path = out_ver / "mesh.json"
    if mesh_meta_path.exists():
        old = json.loads(mesh_meta_path.read_text(encoding="utf-8"))
        if old["geometry_hash"] != mesh["hash"]:
            raise SystemExit(f"격자가 {model_version}의 기존 mesh와 다릅니다 — 모형 버전을 올려야 합니다")
        if geojson and not (out_ver / "mesh.geojson").exists():
            write_mesh(mesh, out_ver, model_version, geojson)
    else:
        write_mesh(mesh, out_ver, model_version, geojson)

    T = len(plan.times)
    dt_s = (plan.times[1] - plan.times[0]).total_seconds() if T > 1 else 600.0
    tables = [SubgridTable(a.ve_info, a.ve_values, a.cell_area) for a in plan.areas]
    n_cells = sum(a.n_cells for a in plan.areas)
    cell_area = mesh["cell_area"]

    # ---- 프레임별 셀 수심
    frames_depth = np.zeros((T, n_cells), dtype=np.uint8)
    frames_wet = np.zeros((T, n_cells), dtype=np.uint8)
    deep03 = np.zeros((T, n_cells), dtype=bool)
    area_series = np.zeros(T)
    for t in range(T):
        parts_d, parts_w, parts_03 = [], [], []
        for a, sg in zip(plan.areas, tables):
            ws = a.ws_frames[t]
            d, w = sg.depth_metrics(ws)
            parts_d.append(d)
            parts_w.append(w)
            parts_03.append(sg.area_deeper_than(ws, DURATION_DEPTH) >= 0.5 * a.cell_area)
            area_series[t] += sg.area_deeper_than(ws, 0.1).sum()
        frames_depth[t] = _q_depth(np.concatenate(parts_d))
        frames_wet[t] = _q_frac(np.concatenate(parts_w))
        deep03[t] = np.concatenate(parts_03)
    frames_depth.tofile(out / "frames_depth.u8")
    frames_wet.tofile(out / "frames_wet.u8")

    # ---- 최대값 (모형의 셀 최대 수위 기준)
    md, mw, area_by_h = [], [], {h: 0.0 for h in AREA_THRESHOLDS}
    for a, sg in zip(plan.areas, tables):
        d, w = sg.depth_metrics(a.max_ws)
        md.append(d)
        mw.append(w)
        for h in AREA_THRESHOLDS:
            area_by_h[h] += sg.area_deeper_than(a.max_ws, h).sum()
    max_depth = np.concatenate(md)
    peak_frame = np.where(frames_depth.max(axis=0) > 0, frames_depth.argmax(axis=0), 255).astype(np.uint8)
    dur_frames = np.clip(deep03.sum(axis=0), 0, 255).astype(np.uint8)
    np.stack([_q_depth(max_depth), _q_frac(np.concatenate(mw)), peak_frame, dur_frames]).tofile(out / "cells_max.u8")

    # ---- 2 m 수심 래스터
    terrain = read_terrain(terrain_path)
    cell_id = rasterize_cells(mesh["polygons"], terrain)
    max_ws_all = np.concatenate([a.max_ws for a in plan.areas])
    depth = depth_raster(cell_id, max_ws_all, terrain)
    colorize(depth).save(out / "max_depth.png", optimize=True)
    depth_cm_image(depth).save(out / "max_depth_cm.png", optimize=True)
    pix = terrain.dx * terrain.dy
    raster_area = {h: float(np.sum(depth >= h) * pix) for h in AREA_THRESHOLDS}
    rmax = np.unravel_index(np.nanargmax(depth), depth.shape)
    rmax_xy = (terrain.x0 + (rmax[1] + 0.5) * terrain.dx, terrain.y0 - (rmax[0] + 0.5) * terrain.dy)
    raster_corners = [_ll(x, y) for x, y in corners(terrain)]

    # ---- 시각 KPI
    onset_idx = next((i for i, v in enumerate(area_series) if v > ONSET_AREA_M2), None)
    peak_idx = int(np.argmax(area_series))
    dur_area_1h = float(cell_area[dur_frames * dt_s >= 3600].sum())

    # ---- 하천 단면
    # 최댓값은 계산 간격(30초) 기준 요약값을 쓴다 — 10분 출력 시계열의 최댓값보다 정확
    st = plan.xs_stations
    qmax, wsmax = plan.xs_max_flow[0], plan.xs_max_ws[0]
    t0 = plan.times[0]

    def _at(days):
        return _iso(t0 + timedelta(days=float(days)))

    def xs_summary(i):
        return {"rs": st[i], "q_max_m3s": round(float(qmax[i]), 1), "q_max_time": _at(plan.xs_max_flow[2, i]),
                "ws_max_m": round(float(wsmax[i]), 2), "ws_max_time": _at(plan.xs_max_ws[2, i])}

    river = {"upstream": xs_summary(0), "outlet": xs_summary(len(st) - 1),
             "q_max_anywhere": xs_summary(int(np.argmax(qmax)))}

    # ---- 측방 구조물
    lateral = []
    for name, v in plan.lateral.items():
        q = v["flow"]
        pos = float(_trapz(np.clip(q, 0, None), dx=dt_s))
        neg = float(_trapz(np.clip(q, None, 0), dx=dt_s))
        m = re.search(r"(\d+\.\d+)$", name)
        near = xs_summary(_nearest_station(st, float(m.group(1)))) if m else None
        lateral.append({"name": name, "to_2d_area": v["area2d"],
                        "peak_m3s": round(float(q.max()), 1), "min_m3s": round(float(q.min()), 1),
                        "volume_to_2d_m3": round(pos), "volume_back_to_river_m3": round(-neg),
                        "net_volume_m3": round(pos + neg),
                        "drains_back_to_river": bool(q.min() < -1.0), "river_at_structure": near})

    # ---- 2D 내부 유입 경계 (맨홀)
    inflow_feats, inflow_total, inflow_series = [], 0.0, np.zeros(T)
    t_frames_days = np.array([(t - plan.times[0]).total_seconds() / 86400 for t in plan.times])
    for name, (td, q) in plan.bc_flows.items():
        m = re.match(r"2D: (.+?) BCLine: (.+)$", name)
        if not m:
            continue
        key = (m.group(1).strip(), m.group(2).strip())
        line = plan.bc_lines.get(key)
        if line is None or line[2] != "Internal":
            continue
        vol = float(_trapz(q, td * 86400))
        inflow_total += vol
        inflow_series += np.interp(t_frames_days, td, q, left=0, right=0)
        inflow_feats.append({"type": "Feature",
                             "properties": {"name": key[1], "area2d": key[0], "peak_m3s": round(float(q.max()), 3),
                                            "volume_m3": round(vol, 1)},
                             "geometry": {"type": "Point", "coordinates": _ll(line[0], line[1])}})
    if inflow_feats:
        (out / "manholes.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": inflow_feats},
                                                         ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # 모형 버전 설명·주의 사항: 사람이 쓰는 자료 파일 pipeline/models/<버전>.json → 출력 폴더에도 복사
    model_file = Path(__file__).parent / "models" / f"{model_version}.json"
    model_info = json.loads(model_file.read_text(encoding="utf-8")) if model_file.exists() else {}
    if model_info:
        (out_ver / "model.json").write_text(json.dumps(model_info, ensure_ascii=False, indent=1), encoding="utf-8")

    km2 = lambda v: round(v / 1e6, 4)  # noqa: E731
    kpi = {
        "model_version": model_version,
        "scenario_id": scenario,
        "label": label,
        "solution": plan.summary.get("Solution"),
        "compute_seconds": plan.compute_tasks,
        "time_window": plan.time_window,
        "inundation_area_km2": {f"ge_{h}m": km2(area_by_h[h]) for h in AREA_THRESHOLDS},
        "inundation_area_km2_raster_check": {f"ge_{h}m": km2(raster_area[h]) for h in AREA_THRESHOLDS},
        "depth_class_area_km2": {
            "0.1-0.5": km2(area_by_h[0.1] - area_by_h[0.5]),
            "0.5-1.0": km2(area_by_h[0.5] - area_by_h[1.0]),
            "1.0-2.0": km2(area_by_h[1.0] - area_by_h[2.0]),
            "gt_2.0": km2(area_by_h[2.0]),
        },
        "max_depth_m": {"value": round(float(np.nanmax(depth)), 2), "lonlat": _ll(*rmax_xy),
                        "p99_of_flooded": round(float(np.nanpercentile(depth[depth >= 0.1], 99)), 2),
                        "area_ge_3m_ha": round(float(np.sum(depth >= 3.0) * pix / 1e4), 2)},
        "onset_time": _iso(plan.times[onset_idx]) if onset_idx is not None else None,
        "peak_instant_area": {"km2": km2(area_series[peak_idx]), "time": _iso(plan.times[peak_idx])},
        "duration_ge_0.3m": {"area_km2_ge_1h": km2(dur_area_1h),
                             "max_hours": round(float(dur_frames.max()) * dt_s / 3600, 2)},
        "flooded_buildings": None,
        "river": river,
        "lateral_structures": lateral,
        "internal_inflow": {"count": len(inflow_feats), "total_volume_m3": round(inflow_total)},
        "volume_error_pct": {k: round(float(v), 3) for k, v in plan.volume_error_pct.items()},
        "model_notes": model_info.get("notes", []),
        "definitions": {
            "inundation_area": "셀 표고-체적 표로 계산한 '수심 ≥ h' 면적 (최대 수위 기준). raster_check는 2 m 지형 래스터로 계산한 같은 값",
            "onset_time": f"수심 0.1 m 이상 면적이 {ONSET_AREA_M2 / 1e4:.0f} ha를 처음 넘은 출력 시각",
            "duration": f"셀 면적의 절반 이상이 수심 {DURATION_DEPTH} m 이상인 출력 시각 수 × 출력 간격",
            "max_depth": "2 m 화소 최댓값은 작은 웅덩이에 민감하므로 침수 화소(≥ 0.1 m) 수심의 99분위(p99_of_flooded)를 함께 본다",
            "flooded_buildings": "건물 GIS 확보 전 (null)",
        },
    }
    (out / "kpi.json").write_text(json.dumps(kpi, ensure_ascii=False, indent=1), encoding="utf-8")

    ts = {
        "times": [_iso(t) for t in plan.times],
        "river_stations": st,
        "river_flow_m3s": np.round(plan.xs_flow, 1).tolist(),
        "river_ws_m": np.round(plan.xs_ws, 2).tolist(),
        "lateral_flow_m3s": {k: np.round(v["flow"], 2).tolist() for k, v in plan.lateral.items()},
        "internal_inflow_total_m3s": np.round(inflow_series, 2).tolist(),
        "inundation_area_ge_0.1m_km2": np.round(area_series / 1e6, 4).tolist(),
    }
    (out / "timeseries.json").write_text(json.dumps(ts, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    meta = {
        "model_version": model_version,
        "scenario_id": scenario,
        "label": label,
        "source_hdf": str(hdf),
        "plan_title": plan.plan_title,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n_cells": n_cells,
        "geometry_hash": mesh["hash"],
        "frames": {"count": T, "step_seconds": dt_s, "times": [_iso(t) for t in plan.times]},
        "quantization": {"depth_step_m": DEPTH_STEP, "wet_fraction_scale": 255, "no_peak_frame": 255},
        "raster": {"width": int(terrain.shape[1]), "height": int(terrain.shape[0]), "pixel_m": terrain.dx,
                   "origin_xy": [terrain.x0, terrain.y0], "pixel_xy": [terrain.dx, terrain.dy],
                   "crs": "EPSG:5187", "origin_note": "왼쪽 위 모서리, 행은 아래로 증가",
                   "corners_lonlat": raster_corners, "order": "왼위, 오위, 오아래, 왼아래",
                   "water_surface": "셀 안 수평"},
        "files": {
            "frames_depth.u8": "uint8 (프레임 × 셀): 젖은 부분 평균 수심 / 0.05 m",
            "frames_wet.u8": "uint8 (프레임 × 셀): 젖은 면적 비율 × 255",
            "cells_max.u8": "uint8 (4 × 셀): [최대 수심/0.05, 최대 젖은 비율×255, 최대 시각 프레임(255=마름), 0.3 m 이상 지속 프레임 수]",
            "max_depth.png": "RGBA 2 m 최대 수심 등급 색",
            "max_depth_cm.png": "16비트 2 m 최대 수심 (cm)",
            "kpi.json": "핵심 지표",
            "timeseries.json": "시계열",
            **({"manholes.geojson": "2D 내부 유입 경계 위치·첨두·체적"} if inflow_feats else {}),
        },
    }
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    index_path = Path(out_root) / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"scenarios": []}
    index["scenarios"] = [s for s in index["scenarios"]
                          if not (s["model_version"] == model_version and s["scenario_id"] == scenario)]
    entry = {"model_version": model_version, "scenario_id": scenario, "label": label,
             "path": f"{model_version}/{scenario}", "generated_at": meta["generated_at"]}
    if base:
        entry["base"] = base
    if params:
        entry["params"] = params
    index["scenarios"].append(entry)
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    return kpi


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hdf", required=True)
    ap.add_argument("--terrain", required=True)
    ap.add_argument("--out", default="data/out")
    ap.add_argument("--model-version", required=True)
    ap.add_argument("--scenario", required=True)
    ap.add_argument("--label", default="")
    ap.add_argument("--geojson", action="store_true", help="mesh.geojson도 만든다")
    a = ap.parse_args()
    kpi = export(a.hdf, a.terrain, a.out, a.model_version, a.scenario, a.label, a.geojson)
    print(json.dumps({k: kpi[k] for k in ("inundation_area_km2", "inundation_area_km2_raster_check",
                                          "max_depth_m", "onset_time", "peak_instant_area")},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
