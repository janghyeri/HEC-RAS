"""2 m 최대 수심 래스터(EPSG:5187 격자) → 웹 메르카토르 PNG 타일 (XYZ, 256 px).

- 가장 큰 줌(기본 16, 화소 약 1.9 m)에서 화소 중심마다 경위도 → EPSG:5187 → 원 래스터 화소(가장 가까운 값)를 읽는다.
- 작은 줌은 2 × 2 화소를 묶어 만든다: 4개 중 2개 이상이 수심 0.1 m 이상이면 표시하고, 수심은 그 화소들의 평균.
- 색은 raster_depth.DEPTH_CLASSES (docs/GUIDE.md §4.4.1 등급), 0.1 m 미만은 투명.
- 범위 안 타일은 비어 있어도 모두 쓴다 (지도에서 404 요청이 생기지 않게).

사용 예 (보통은 publish_web.py가 부른다)
  python -m pipeline.web_tiles --depth-cm data/out/v1/S0-C/max_depth_cm.png --meta data/out/v1/S0-C/meta.json \
      --bbox 129.389 35.943 129.425 36.012 --out web/public/data/v1/S0-C/tiles
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

from . import tm_korea
from .raster_depth import colorize

TILE = 256
R_EARTH = 6378137.0
MIN_DEPTH = 0.1


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def global_px_to_lonlat(px, py, z):
    """전역 화소 좌표(줌 z, 256 px 타일) → 경위도 (배열 가능)."""
    n = TILE * 2 ** z
    lon = px / n * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * py / n))))
    return lon, lat


def tile_range(bbox, z):
    """bbox(서, 남, 동, 북) 를 덮는 타일 번호 범위 (x0, y0, x1, y1), 끝 포함."""
    w, s, e, n = bbox
    x0, y0 = lonlat_to_tile(w, n, z)
    x1, y1 = lonlat_to_tile(e, s, z)
    return int(math.floor(x0)), int(math.floor(y0)), int(math.floor(x1)), int(math.floor(y1))


def read_depth(depth_cm_png: str) -> np.ndarray:
    cm = np.asarray(Image.open(depth_cm_png), dtype=np.float32)
    return cm / 100.0  # 0 = 마름 또는 자료 없음


def render_mosaic(depth, origin_xy, pixel_xy, bbox, zmin, zmax):
    """줌 zmax 모자이크 (zmin 타일 경계에 맞춤). 반환: 수심 배열(NaN = 마름), zmax 기준 시작 타일 (tx0, ty0)."""
    x0z, y0z, x1z, y1z = tile_range(bbox, zmin)
    f = 2 ** (zmax - zmin)
    tx0, ty0 = x0z * f, y0z * f
    nx, ny = (x1z - x0z + 1) * f, (y1z - y0z + 1) * f
    mosaic = np.full((ny * TILE, nx * TILE), np.nan, dtype=np.float32)
    ox, oy = origin_xy
    dx, dy = pixel_xy
    rows, cols = depth.shape
    bx0, by0, bx1, by1 = tile_range(bbox, zmax)
    j, i = np.mgrid[0:TILE, 0:TILE]
    for ty in range(by0, by1 + 1):
        for tx in range(bx0, bx1 + 1):
            px = tx * TILE + i + 0.5
            py = ty * TILE + j + 0.5
            lon, lat = global_px_to_lonlat(px, py, zmax)
            x, y = tm_korea.from_lonlat(lon, lat)
            c = np.floor((x - ox) / dx).astype(np.int64)
            r = np.floor((oy - y) / dy).astype(np.int64)
            ok = (c >= 0) & (c < cols) & (r >= 0) & (r < rows)
            tile = np.full((TILE, TILE), np.nan, dtype=np.float32)
            tile[ok] = depth[r[ok], c[ok]]
            tile[~(tile >= MIN_DEPTH)] = np.nan
            mr, mc = (ty - ty0) * TILE, (tx - tx0) * TILE
            mosaic[mr:mr + TILE, mc:mc + TILE] = tile
    return mosaic, tx0, ty0


def downsample(mosaic):
    """2 × 2 → 1: 0.1 m 이상 화소가 2개 이상이면 그 화소들의 평균 수심, 아니면 NaN."""
    h, w = mosaic.shape
    blk = mosaic.reshape(h // 2, 2, w // 2, 2)
    wet = np.isfinite(blk)
    cnt = wet.sum(axis=(1, 3))
    s = np.where(wet, blk, 0.0).sum(axis=(1, 3))
    out = np.full((h // 2, w // 2), np.nan, dtype=np.float32)
    m = cnt >= 2
    out[m] = s[m] / cnt[m]
    return out


def mosaic_area_m2(mosaic, ty0, z, min_depth=MIN_DEPTH):
    """모자이크에서 수심 ≥ min_depth 면적 (메르카토르 화소의 지상 크기, 행마다 위도 반영)."""
    rows = np.arange(mosaic.shape[0]) + 0.5 + ty0 * TILE
    _, lat = global_px_to_lonlat(np.zeros_like(rows), rows, z)
    res = 2 * math.pi * R_EARTH * np.cos(np.radians(lat)) / (TILE * 2 ** z)
    wet_per_row = np.sum(mosaic >= min_depth, axis=1)
    return float(np.sum(wet_per_row * res ** 2))


def write_tiles(depth, origin_xy, pixel_xy, bbox, out_dir, zmin=12, zmax=16):
    out_dir = Path(out_dir)
    mosaic, tx0, ty0 = render_mosaic(depth, origin_xy, pixel_xy, bbox, zmin, zmax)
    stats = {"area_m2_zmax": mosaic_area_m2(mosaic, ty0, zmax)}
    wet = np.argwhere(np.isfinite(mosaic))
    if len(wet):
        cy, cx = wet.mean(axis=0)
        lon, lat = global_px_to_lonlat(cx + 0.5 + tx0 * TILE, cy + 0.5 + ty0 * TILE, zmax)
        stats["wet_centroid_lonlat"] = [float(lon), float(lat)]
    n_tiles = 0
    level, ltx0, lty0 = mosaic, tx0, ty0
    for z in range(zmax, zmin - 1, -1):
        bx0, by0, bx1, by1 = tile_range(bbox, z)
        for ty in range(by0, by1 + 1):
            for tx in range(bx0, bx1 + 1):
                mr, mc = (ty - lty0) * TILE, (tx - ltx0) * TILE
                tile = level[mr:mr + TILE, mc:mc + TILE]
                p = out_dir / str(z) / str(tx) / f"{ty}.png"
                p.parent.mkdir(parents=True, exist_ok=True)
                colorize(tile, min_depth=MIN_DEPTH).save(p, optimize=True)
                n_tiles += 1
        if z > zmin:
            level = downsample(level)
            ltx0, lty0 = ltx0 // 2, lty0 // 2
    stats["tiles"] = n_tiles
    meta = {"format": "png", "tile_size": TILE, "minzoom": zmin, "maxzoom": zmax, "bounds": list(bbox),
            "scheme": "xyz", "min_depth_m": MIN_DEPTH, **stats}
    (out_dir / "tiles.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return meta


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--depth-cm", required=True, help="max_depth_cm.png (16비트, cm)")
    ap.add_argument("--meta", required=True, help="같은 시나리오 meta.json (raster.origin_xy, pixel_xy)")
    ap.add_argument("--bbox", type=float, nargs=4, required=True, metavar=("W", "S", "E", "N"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--zmin", type=int, default=12)
    ap.add_argument("--zmax", type=int, default=16)
    a = ap.parse_args()
    r = json.loads(Path(a.meta).read_text(encoding="utf-8"))["raster"]
    meta = write_tiles(read_depth(a.depth_cm), r["origin_xy"], r["pixel_xy"], a.bbox, a.out, a.zmin, a.zmax)
    print(json.dumps(meta, ensure_ascii=False))


if __name__ == "__main__":
    main()
