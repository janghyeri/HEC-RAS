"""두 시나리오 최대 수심(2 m 래스터)으로 침수 원인 지도를 만든다 — 하천 범람(A) vs 하천 범람 + 도시 침수(B).
docs/GUIDE.md §4.4.1 '내수 기여(복합에서만 잠긴 면적, 더 깊어진 면적)', §4.4.2 '외수/내수 원인 지도'.

분류 (2 m 화소, 2D 영역만 — 하천 물은 넣지 않음)
  1 하천 범람으로 잠김        A ≥ 0.1 m 이고 B − A < DEEPER_M (도시 침수를 더해도 거의 같음, B가 더 얕은 화소 포함)
  2 도시 침수로 더 깊어짐      A ≥ 0.1 m 이고 B − A ≥ DEEPER_M
  3 도시 침수로만 잠김         A < 0.1 m 이고 B ≥ 0.1 m
  0 둘 다 0.1 m 미만 (투명)

출력: <out>/tiles/{z}/{x}/{y}.png (XYZ, 지도 타일과 같은 범위·줌), <out>/compare.json (분류별 면적·검산)
검산: 면적(3) − 면적(A만 잠김) = 면적(B ≥ 0.1) − 면적(A ≥ 0.1) (같은 2 m 래스터 기준, kpi.json의 raster_check와 같은 값)

사용 (저장소 루트)
  python -m pipeline.compare_web --a data/out/v1/S0-E/max_depth_cm.png --b data/out/v1/S0-C/max_depth_cm.png \
      --meta web/public/data/v1/S0-C/meta.json --tiles-json web/public/data/v1/S0-C/tiles/tiles.json \
      --out web/public/data/v1/compare/S0-E__S0-C --a-id S0-E --b-id S0-C
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

from . import tm_korea
from .web_tiles import TILE, global_px_to_lonlat, pad_even, tile_range

MIN_DEPTH = 0.1
DEEPER_M = 0.1   # '더 깊어짐' 기준 — 침수 기준 수심과 같은 0.1 m (화면 문구에 적는다)

CATEGORIES = [
    {"id": 1, "key": "river", "label": "하천 범람으로 잠김", "detail": f"도시 침수를 더해도 깊이 차이 {DEEPER_M} m 미만",
     "rgba": [0x2A, 0x78, 0xD6, 215]},
    {"id": 2, "key": "deeper", "label": "도시 침수로 더 깊어짐", "detail": f"하천 범람만일 때보다 {DEEPER_M} m 이상 깊음",
     "rgba": [0x1B, 0xAF, 0x7A, 225]},
    {"id": 3, "key": "urban", "label": "도시 침수로만 잠김", "detail": "하천 범람만으로는 0.1 m 미만",
     "rgba": [0xEB, 0x68, 0x34, 225]},
]


def classify(a: np.ndarray, b: np.ndarray, deeper: float = DEEPER_M) -> np.ndarray:
    wa, wb = a >= MIN_DEPTH, b >= MIN_DEPTH
    cat = np.zeros(a.shape, dtype=np.uint8)
    cat[wa & ((b - a) < deeper)] = 1
    cat[wa & ((b - a) >= deeper)] = 2
    cat[~wa & wb] = 3
    return cat


def _mosaic(cat, origin_xy, pixel_xy, bbox, zmax):
    bx0, by0, bx1, by1 = tile_range(bbox, zmax)
    mosaic = np.zeros(((by1 - by0 + 1) * TILE, (bx1 - bx0 + 1) * TILE), dtype=np.uint8)
    ox, oy = origin_xy
    dx, dy = pixel_xy
    rows, cols = cat.shape
    j, i = np.mgrid[0:TILE, 0:TILE]
    for ty in range(by0, by1 + 1):
        for tx in range(bx0, bx1 + 1):
            lon, lat = global_px_to_lonlat(tx * TILE + i + 0.5, ty * TILE + j + 0.5, zmax)
            x, y = tm_korea.from_lonlat(lon, lat)
            c = np.floor((x - ox) / dx).astype(np.int64)
            r = np.floor((oy - y) / dy).astype(np.int64)
            ok = (c >= 0) & (c < cols) & (r >= 0) & (r < rows)
            tile = np.zeros((TILE, TILE), dtype=np.uint8)
            tile[ok] = cat[r[ok], c[ok]]
            mosaic[(ty - by0) * TILE:(ty - by0 + 1) * TILE, (tx - bx0) * TILE:(tx - bx0 + 1) * TILE] = tile
    return mosaic, bx0, by0


def _downsample(m: np.ndarray) -> np.ndarray:
    """2 × 2 → 1: 분류된 화소가 2개 이상이면 가장 많은 분류 (같으면 도시 침수 쪽 우선 — 작은 면적이 사라지지 않게)."""
    h, w = m.shape
    blk = m.reshape(h // 2, 2, w // 2, 2)
    counts = np.stack([(blk == k).sum(axis=(1, 3)) for k in (1, 2, 3)], axis=-1)
    total = counts.sum(axis=-1)
    best = np.zeros((h // 2, w // 2), dtype=np.uint8)
    top = np.zeros((h // 2, w // 2), dtype=np.int64)
    for k in (1, 2, 3):                 # 나중 분류가 같은 개수면 이긴다
        c = counts[..., k - 1]
        win = c >= top
        best[win & (c > 0)] = k
        top = np.maximum(top, c)
    best[total < 2] = 0
    return best


def _png(tile: np.ndarray) -> Image.Image:
    img = Image.fromarray(tile, "P")
    pal, alpha = [0, 0, 0], [0]
    for c in CATEGORIES:
        pal += c["rgba"][:3]
        alpha.append(c["rgba"][3])
    img.putpalette(pal + [0] * (768 - len(pal)))
    img.info["transparency"] = bytes(alpha)
    return img


def write_tiles(cat, origin_xy, pixel_xy, bbox, out_dir: Path, zmin=10, zmax=16) -> int:
    level, tx0, ty0 = _mosaic(cat, origin_xy, pixel_xy, bbox, zmax)
    n = 0
    for z in range(zmax, zmin - 1, -1):
        bx0, by0, bx1, by1 = tile_range(bbox, z)
        for ty in range(by0, by1 + 1):
            for tx in range(bx0, bx1 + 1):
                mr, mc = (ty - ty0) * TILE, (tx - tx0) * TILE
                p = out_dir / str(z) / str(tx) / f"{ty}.png"
                p.parent.mkdir(parents=True, exist_ok=True)
                _png(level[mr:mr + TILE, mc:mc + TILE]).save(p, optimize=True)
                n += 1
        if z > zmin:
            level, tx0, ty0 = pad_even(level.astype(np.float32), tx0, ty0)
            level = _downsample(np.nan_to_num(level).astype(np.uint8))
            tx0, ty0 = tx0 // 2, ty0 // 2
    return n


def build(a_png: Path, b_png: Path, meta: dict, bbox, out: Path, a_id: str, b_id: str, zmin=10, zmax=16) -> dict:
    a = np.asarray(Image.open(a_png), dtype=np.float32) / 100.0
    b = np.asarray(Image.open(b_png), dtype=np.float32) / 100.0
    if a.shape != b.shape:
        raise ValueError(f"래스터 크기가 다름 {a.shape} {b.shape}")
    r = meta["raster"]
    origin, pixel = tuple(r["origin_xy"]), tuple(r["pixel_xy"])
    pix_m2 = pixel[0] * pixel[1]
    cat = classify(a, b)
    tiles_dir = out / "tiles"
    n = write_tiles(cat, origin, pixel, bbox, tiles_dir, zmin, zmax)
    (tiles_dir / "tiles.json").write_text(json.dumps({"format": "png", "tile_size": TILE, "minzoom": zmin, "maxzoom": zmax,
                                                      "bounds": list(bbox), "scheme": "xyz", "tiles": n,
                                                      "categories": CATEGORIES}, ensure_ascii=False, indent=1),
                                          encoding="utf-8")
    km2 = lambda m: round(float(m.sum()) * pix_m2 / 1e6, 4)  # noqa: E731
    wa, wb = a >= MIN_DEPTH, b >= MIN_DEPTH
    a_only = wa & ~wb
    d = (b - a)[cat == 2]
    areas = {c["key"]: km2(cat == c["id"]) for c in CATEGORIES}
    rr, cc = np.nonzero(cat > 0)                  # 분류된 곳 범위 (화면 처음 범위, 흩어진 작은 화소는 빼려고 1–99 %)
    c0, c1 = np.percentile(cc, [1, 99])
    r0, r1 = np.percentile(rr, [1, 99])
    xs = origin[0] + np.array([c0, c1 + 1]) * pixel[0]
    ys = origin[1] - np.array([r0, r1 + 1]) * pixel[1]
    lon, lat = tm_korea.to_lonlat(np.array([xs[0], xs[1], xs[0], xs[1]]), np.array([ys[0], ys[0], ys[1], ys[1]]))
    wet_bbox = [round(float(lon.min()), 6), round(float(lat.min()), 6), round(float(lon.max()), 6), round(float(lat.max()), 6)]
    info = {
        "a": a_id, "b": b_id,
        "min_depth_m": MIN_DEPTH, "deeper_m": DEEPER_M,
        "categories": [{**c, "area_km2": areas[c["key"]]} for c in CATEGORIES],
        "area_a_km2": km2(wa), "area_b_km2": km2(wb),
        "a_only_km2": km2(a_only),
        "wet_bbox": wet_bbox,
        "deeper_added_depth_m": {"p50": round(float(np.median(d)), 2), "p90": round(float(np.percentile(d, 90)), 2)} if d.size else None,
        "check": {"urban_minus_a_only_km2": round(areas["urban"] - km2(a_only), 4),
                  "area_b_minus_a_km2": round(km2(wb) - km2(wa), 4)},
        "basis": "2 m 지형 기준 최대 수심 래스터(2D 영역), kpi.json의 inundation_area_km2_raster_check와 같은 기준",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (out / "compare.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    return info


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--a", required=True, help="A 시나리오 max_depth_cm.png (하천 범람)")
    ap.add_argument("--b", required=True, help="B 시나리오 max_depth_cm.png (하천 범람 + 도시 침수)")
    ap.add_argument("--meta", required=True, help="래스터 원점이 적힌 meta.json")
    ap.add_argument("--tiles-json", required=True, help="범위를 맞출 tiles.json (B 시나리오)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--a-id", default="S0-E")
    ap.add_argument("--b-id", default="S0-C")
    a = ap.parse_args()
    meta = json.loads(Path(a.meta).read_text(encoding="utf-8"))
    bbox = json.loads(Path(a.tiles_json).read_text(encoding="utf-8"))["bounds"]
    info = build(Path(a.a), Path(a.b), meta, bbox, Path(a.out), a.a_id, a.b_id)
    print(json.dumps({k: info[k] for k in ("categories", "area_a_km2", "area_b_km2", "a_only_km2", "check",
                                           "deeper_added_depth_m")}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
