"""10분 간격 침수심 이미지 — 지도 시간 재생과 3D 지면 덮기용 (docs/GUIDE.md §4.4.2·§4.4.5, PLAN 7.1).

출력 (<out> = 시나리오 웹 폴더, 예: web/public/data/v1/S0-C)
  frames/000.png … frames/069.png   지도 출력 시각마다 한 장. 경위도 격자(EPSG:4326, 화소 약 4 m)
  frames/frames.json                시각·범위·크기·화소 크기·프레임별 침수면적

계산
  - 2D: 화소마다 그 자리 셀의 그 시각 수위 − 2 m 지형 (최대 수심 지도와 같은 방식, raster_depth.depth_raster)
  - 하천(1D): 그 시각 단면 수위를 이웃 단면 사이에 거리로 보간 − 2 m 지형 (river_map.river_depth와 같은 방식,
    지형 구덩이는 측량 하상 − 0.5 m까지, 2D 영역 안은 그리지 않음). 하천 물은 침수면적에 넣지 않는다
  - 색은 최대 수심 지도와 같은 4등급 (raster_depth.DEPTH_CLASSES), 0.1 m 미만은 투명
  - 경위도 격자로 만드는 까닭: 브이월드 3D(Cesium)는 이미지를 경위도 사각형에만 덮을 수 있다.
    EPSG:5187 격자를 그대로 덮으면 자오선 수렴각(약 0.24°) 때문에 12 km 범위 끝에서 50 m 가까이 어긋난다

확인: 프레임별 2D 침수면적(화소 기준)을 셀 표고-체적 표 기준 침수면적(timeseries.json)과 비교해 frames.json에 남긴다.

사용 (워커 PC, code 폴더에서)
  python -m pipeline.frames_web --hdf <p03.hdf> --terrain <Terrain.all.tif> --out <시나리오 웹 폴더> --scenario S0-C
  python -m pipeline.frames_web --job S0-C=<hdf> --job S0-E=<hdf> --terrain <tif> --out-root <폴더> --zip
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from . import tm_korea
from .raster_depth import DEPTH_CLASSES
from .river_map import _dist_to_polyline, reach_quads

STEP_M = 4.0
MIN_DEPTH = 0.1
BED_TOL = 0.5


# ---------------------------------------------------------------- 격자
def m_per_degree(lat_deg: float) -> tuple[float, float]:
    """위도 lat에서 경도 1°, 위도 1°의 길이 (m, GRS80 근사식)."""
    p = math.radians(lat_deg)
    m_lat = 111132.954 - 559.822 * math.cos(2 * p) + 1.175 * math.cos(4 * p)
    m_lon = 111412.84 * math.cos(p) - 93.5 * math.cos(3 * p)
    return m_lon, m_lat


def lonlat_grid(bbox, step_m: float = STEP_M) -> dict:
    """bbox(서, 남, 동, 북)를 덮는 경위도 격자. 화소 크기는 중심 위도에서 step_m."""
    w, s, e, n = bbox
    m_lon, m_lat = m_per_degree((s + n) / 2)
    dlon, dlat = step_m / m_lon, step_m / m_lat
    width = int(math.ceil((e - w) / dlon))
    height = int(math.ceil((n - s) / dlat))
    return {"west": w, "north": n, "dlon": dlon, "dlat": dlat, "width": width, "height": height,
            "bounds": [w, n - height * dlat, w + width * dlon, n]}


# ---------------------------------------------------------------- 표본 추출기
class FrameSampler:
    """출력 화소 → 2 m 지형 화소(가장 가까운 것) 대응을 한 번 계산해 두고, 시각마다 수위만 바꿔 수심을 만든다."""

    def __init__(self, z: np.ndarray, x0: float, y0: float, dx: float, dy: float, cell_id: np.ndarray,
                 grid: dict, river: dict | None = None):
        self.grid = grid
        H, W = grid["height"], grid["width"]
        lon = grid["west"] + (np.arange(W) + 0.5) * grid["dlon"]
        lat = grid["north"] - (np.arange(H) + 0.5) * grid["dlat"]
        LON, LAT = np.meshgrid(lon, lat)
        x, y = tm_korea.from_lonlat(LON.ravel(), LAT.ravel())
        c = np.floor((x - x0) / dx).astype(np.int64)
        r = np.floor((y0 - y) / dy).astype(np.int64)
        rows, cols = z.shape
        inside = (c >= 0) & (c < cols) & (r >= 0) & (r < rows)
        idx = np.flatnonzero(inside)
        zz = z[r[idx], c[idx]]
        ok = np.isfinite(zz)
        idx, zz = idx[ok], zz[ok]
        self.n = H * W
        self.pix = idx                                  # 지형 자료가 있는 출력 화소 (평탄화 번호)
        self.z = zz.astype(np.float32)
        self.cell = cell_id[r[idx], c[idx]].astype(np.int64)     # -1 = 2D 셀 밖
        self.river = None
        if river is not None:
            self._init_river(river, x[idx], y[idx], r[idx], c[idx], z.shape, x0, y0, dx, dy)

    def _init_river(self, river, px, py, rr, cc, shape, x0, y0, dx, dy):
        rows, cols = shape
        cut = river["cut"]
        quads = reach_quads(cut)
        img = Image.new("I", (cols, rows), 0)
        draw = ImageDraw.Draw(img)
        for k, q in enumerate(quads):
            draw.polygon(list(zip(((q[:, 0] - x0) / dx - 0.5).tolist(), ((y0 - q[:, 1]) / dy - 0.5).tolist())), fill=k + 1)
        seg = np.asarray(img, dtype=np.int64)[rr, cc] - 1
        in2d = Image.new("L", (cols, rows), 0)
        d2 = ImageDraw.Draw(in2d)
        for p in river["areas2d"]:
            d2.polygon(list(zip(((p[:, 0] - x0) / dx - 0.5).tolist(), ((y0 - p[:, 1]) / dy - 0.5).tolist())), fill=1)
        in2d = np.asarray(in2d, dtype=bool)[rr, cc]
        use = np.flatnonzero((seg >= 0) & ~in2d)
        k = seg[use]
        w = np.zeros(use.size, dtype=np.float64)
        for kk in np.unique(k):
            m = k == kk
            da = _dist_to_polyline(px[use][m], py[use][m], cut[kk])
            db = _dist_to_polyline(px[use][m], py[use][m], cut[kk + 1])
            w[m] = np.where(da + db > 0, da / (da + db), 0.0)
        bed = river["bed"]
        zr = self.z[use].astype(np.float64)
        zr = np.maximum(zr, bed[k] * (1 - w) + bed[k + 1] * w - BED_TOL)
        self.river = {"use": use, "k": k, "w": w, "z": zr}

    def depth(self, cell_ws: np.ndarray, xs_ws: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
        """한 시각의 수심 (출력 격자 H×W, 마른 곳 NaN). 두 번째 값은 2D 화소 표시(True = 2D 셀 수심)."""
        H, W = self.grid["height"], self.grid["width"]
        d = np.full(self.n, np.nan, dtype=np.float32)
        is2d = np.zeros(self.n, dtype=bool)
        m = self.cell >= 0
        v = cell_ws[self.cell[m]] - self.z[m]
        sel = self.pix[m]
        wet = v > 0
        d[sel[wet]] = v[wet]
        is2d[sel[wet]] = True
        if self.river is not None and xs_ws is not None:
            R = self.river
            ws_a, ws_b = xs_ws[R["k"]], xs_ws[R["k"] + 1]
            ok = np.isfinite(ws_a) & np.isfinite(ws_b)
            wsp = ws_a * (1 - R["w"]) + ws_b * R["w"]
            dr = wsp - R["z"]
            pick = ok & (dr > 0)
            tgt = self.pix[R["use"][pick]]
            free = ~is2d[tgt]                       # 2D 수심이 있는 곳은 2D 우선 (river_map.merge_depth와 같음)
            d[tgt[free]] = dr[pick][free]
        return d.reshape(H, W), is2d.reshape(H, W)


# ---------------------------------------------------------------- 이미지
def _palette_image(depth: np.ndarray) -> Image.Image:
    """등급 번호(0 = 투명, 1~4) 팔레트 PNG — RGBA보다 훨씬 작다."""
    idx = np.zeros(depth.shape, dtype=np.uint8)
    for i, (lo, hi, _) in enumerate(DEPTH_CLASSES, start=1):
        idx[(depth >= max(lo, MIN_DEPTH)) & (depth < hi)] = i
    img = Image.fromarray(idx, "P")
    pal = [0, 0, 0]
    alpha = [0]
    for _, _, (r, g, b, a) in DEPTH_CLASSES:
        pal += [r, g, b]
        alpha.append(a)
    img.putpalette(pal + [0] * (768 - len(pal)))
    img.info["transparency"] = bytes(alpha)
    return img


def write_frames(sampler: FrameSampler, ws_frames: np.ndarray, times: list[str], out: Path,
                 xs_ws_frames: np.ndarray | None = None, area_ref_km2: list[float] | None = None,
                 meta: dict | None = None) -> dict:
    """ws_frames (시각 × 셀) → out/frames/*.png + frames.json. area_ref_km2: 셀 표고-체적 표 기준 프레임별 침수면적."""
    fdir = out / "frames"
    if fdir.exists():
        shutil.rmtree(fdir)
    fdir.mkdir(parents=True)
    g = sampler.grid
    m_lon, m_lat = m_per_degree((g["bounds"][1] + g["bounds"][3]) / 2)
    pix_m2 = (g["dlon"] * m_lon) * (g["dlat"] * m_lat)
    area2d, area_river, sizes = [], [], []
    for t in range(ws_frames.shape[0]):
        d, is2d = sampler.depth(ws_frames[t], None if xs_ws_frames is None else xs_ws_frames[t])
        wet = np.isfinite(d) & (d >= MIN_DEPTH)
        area2d.append(round(float((wet & is2d).sum()) * pix_m2 / 1e6, 4))
        area_river.append(round(float((wet & ~is2d).sum()) * pix_m2 / 1e6, 4))
        p = fdir / f"{t:03d}.png"
        _palette_image(d).save(p, optimize=True)
        sizes.append(p.stat().st_size)
    check = None
    if area_ref_km2 is not None and len(area_ref_km2) == len(area2d):
        rel = [abs(a - b) / b for a, b in zip(area2d, area_ref_km2) if b >= 0.05]
        check = {"area_2d_vs_cell_table_max_rel": round(max(rel), 4) if rel else None,
                 "note": "프레임 2D 침수면적(화소, 0.1 m 이상)과 셀 표고-체적 표 기준 침수면적(timeseries.json) 비교, "
                         "0.05 km² 이상인 프레임만. 화소 크기·셀 안 수면 수평 가정 때문에 몇 % 차이가 날 수 있다"}
    info = {
        **(meta or {}),
        "count": int(ws_frames.shape[0]),
        "times": times,
        "files": "frames/{i:03d}.png",
        "crs": "EPSG:4326 (경위도 격자)",
        "bounds": [round(v, 8) for v in g["bounds"]],          # 서, 남, 동, 북
        "width": g["width"],
        "height": g["height"],
        "pixel_m": STEP_M,
        "min_depth_m": MIN_DEPTH,
        "classes": [{"lo": lo, "hi": hi if hi < 90 else None, "rgba": list(c)} for lo, hi, c in DEPTH_CLASSES],
        "includes_river": xs_ws_frames is not None,
        "area_2d_km2": area2d,
        "area_river_km2": area_river,
        "check": check,
        "bytes_total": int(sum(sizes)),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": "수심 = 그 시각 셀 수위(2D) 또는 단면 수위 보간(하천) − 2 m 지형. 하천 물은 침수면적에 넣지 않음",
    }
    (fdir / "frames.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    return info


def bbox_of(polys: list[np.ndarray], cutlines: list[np.ndarray] | None = None, pad_m: float = 50.0) -> list[float]:
    """2D 셀 다각형 ∪ 하천 단면 절단선의 경위도 범위 (+ 여유)."""
    pts = [np.concatenate(polys)]
    if cutlines:
        pts.append(np.concatenate(cutlines))
    xy = np.concatenate(pts)
    x0, y0 = xy.min(axis=0) - pad_m
    x1, y1 = xy.max(axis=0) + pad_m
    lon, lat = tm_korea.to_lonlat(np.array([x0, x1, x0, x1]), np.array([y0, y0, y1, y1]))
    return [float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())]


# ---------------------------------------------------------------- HEC-RAS 결과에서 (워커 PC)
def make_frames(hdf: Path, terrain_tif: Path, out: Path, scenario: str, model_version: str) -> dict:
    """결과 HDF·지형으로 out/frames/ 를 만든다. out/meta.json이 있으면 파일 목록에 frames/를 더한다."""
    from worker.dump_river_geom import dump_hdf

    from .export_web import build_mesh
    from .hecras_hdf import read_plan
    from .raster_depth import rasterize_cells, read_terrain
    from .river_publish import load_river

    plan = read_plan(str(hdf))
    terrain = read_terrain(str(terrain_tif))
    mesh = build_mesh(plan)
    cell_id = rasterize_cells(mesh["polygons"], terrain)
    # Windows에서는 열린 파일을 지울 수 없다 → npz는 with로 열고 닫은 뒤 임시 폴더를 지운다 (2026-11-11 PC 오류 WinError 32)
    tmp = Path(tempfile.mkdtemp(prefix="frames_"))
    try:
        npz = tmp / f"river_{scenario}.npz"
        dump_hdf(scenario, Path(hdf), tmp)
        rv = load_river(npz)
        with np.load(npz) as g:
            xs_ws = np.array(g["|Results|Unsteady|Output|Output Blocks|Base Output|Unsteady Time Series|Cross Sections|Water Surface"],
                             dtype=np.float64)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    ws_frames = np.concatenate([a.ws_frames for a in plan.areas], axis=1)
    if xs_ws.shape[0] != ws_frames.shape[0]:
        raise ValueError(f"하천 단면 시각 수 {xs_ws.shape[0]} ≠ 2D 출력 시각 수 {ws_frames.shape[0]}")
    bbox = bbox_of(mesh["polygons"], rv["cut"])
    grid = lonlat_grid(bbox)
    sampler = FrameSampler(terrain.z, terrain.x0, terrain.y0, terrain.dx, terrain.dy, cell_id, grid,
                           {"cut": rv["cut"], "bed": rv["bed"], "areas2d": rv["areas2d"]})
    ref = None
    ts = out / "timeseries.json"
    if ts.exists():
        ref = json.loads(ts.read_text(encoding="utf-8")).get("inundation_area_ge_0.1m_km2")
    info = write_frames(sampler, ws_frames, _iso_times(plan.times), out, xs_ws, ref,
                        {"model_version": model_version, "scenario_id": scenario})
    meta_p = out / "meta.json"
    if meta_p.exists():
        meta = json.loads(meta_p.read_text(encoding="utf-8"))
        meta.setdefault("files", {})["frames/"] = (f"10분 침수심 이미지 {info['count']}장 (경위도 격자, 화소 {STEP_M:g} m) — "
                                                  "시간 재생·3D 지면 덮기, 설명은 frames/frames.json")
        meta_p.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return info


def _iso_times(times) -> list[str]:
    from .export_web import _iso

    return [_iso(t) for t in times]


def _zip_dir(src: Path, dst: Path):
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_STORED) as z:     # PNG는 이미 압축됨
        for p in sorted(src.rglob("*")):
            if p.is_file():
                z.write(p, p.relative_to(src.parent).as_posix())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--terrain", required=True)
    ap.add_argument("--model-version", default="v1")
    ap.add_argument("--hdf")
    ap.add_argument("--scenario")
    ap.add_argument("--out", help="시나리오 웹 폴더 (frames/를 여기에 만든다)")
    ap.add_argument("--job", action="append", default=[], help="시나리오=HDF (여러 번), --out-root와 함께")
    ap.add_argument("--out-root", help="--job 출력 위치: <out-root>/<버전>/<시나리오>/frames")
    ap.add_argument("--zip", action="store_true", help="시나리오마다 <out-root>/<시나리오>_frames.zip도 만든다")
    a = ap.parse_args()
    jobs = []
    if a.hdf:
        jobs.append((a.scenario, Path(a.hdf), Path(a.out)))
    for j in a.job:
        sid, _, h = j.partition("=")
        jobs.append((sid, Path(h), Path(a.out_root) / a.model_version / sid))
    report = []
    for sid, h, out in jobs:
        print(f"[{datetime.now():%H:%M:%S}] {sid}: {h}", flush=True)
        try:
            out.mkdir(parents=True, exist_ok=True)
            info = make_frames(h, Path(a.terrain), out, sid, a.model_version)
            line = {"scenario": sid, "ok": True, "count": info["count"], "size": [info["width"], info["height"]],
                    "MB": round(info["bytes_total"] / 1e6, 2), "check": info["check"],
                    "peak_area_2d_km2": max(info["area_2d_km2"])}
            if a.zip and a.out_root:
                zp = Path(a.out_root) / f"{sid}_frames.zip"
                _zip_dir(out / "frames", zp)
                line["zip"] = str(zp)
        except Exception as e:  # 한 시나리오가 실패해도 나머지는 계속
            line = {"scenario": sid, "ok": False, "error": f"{type(e).__name__}: {e}"}
        print(json.dumps(line, ensure_ascii=False), flush=True)
        report.append(line)
    if a.out_root:
        Path(a.out_root).mkdir(parents=True, exist_ok=True)
        (Path(a.out_root) / "frames_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1),
                                                            encoding="utf-8")


if __name__ == "__main__":
    main()
