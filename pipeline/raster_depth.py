"""2 m 지형(HEC-RAS Terrain)에 셀 수위를 얹어 수심 래스터를 만든다.

- 셀 다각형을 지형 격자에 래스터화해 화소마다 셀 번호를 정하고, 수심 = 셀 수위 − 지형 표고.
- 셀 안 수면은 수평으로 본다 (RAS Mapper의 'Horizontal' 표현). RAS Mapper 기본값이 '경사(Sloping)'
  표현이면 셀 경계 부근에서 차이가 날 수 있다 — 검증 시 이 점을 감안한다.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import tifffile
from PIL import Image, ImageDraw

# 수심 등급 색 (docs/GUIDE.md §4.4.1 등급: 0.1–0.5 / 0.5–1.0 / 1.0–2.0 / > 2.0 m)
# 단일 색상(파랑) 순서형 램프 — 밝은→어두운, 색각 이상 검사 통과 (#86b6ef #3987e5 #1c5cab #0d366b)
DEPTH_CLASSES = [
    (0.1, 0.5, (0x86, 0xB6, 0xEF, 210)),
    (0.5, 1.0, (0x39, 0x87, 0xE5, 220)),
    (1.0, 2.0, (0x1C, 0x5C, 0xAB, 230)),
    (2.0, 99.0, (0x0D, 0x36, 0x6B, 240)),
]


@dataclass
class Terrain:
    z: np.ndarray        # (rows, cols) float32, NaN = 자료 없음
    x0: float            # 왼쪽 위 모서리 x
    y0: float            # 왼쪽 위 모서리 y
    dx: float
    dy: float

    @property
    def shape(self):
        return self.z.shape


def read_terrain(path: str) -> Terrain:
    with tifffile.TiffFile(path) as tf:
        page = tf.pages[0]
        z = page.asarray().astype(np.float32)
        scale = page.tags[33550].value          # ModelPixelScale
        tie = page.tags[33922].value            # ModelTiepoint (i, j, k, x, y, z)
        nodata = page.tags.get(42113)
        if nodata is not None:
            z[z == float(nodata.value)] = np.nan
    return Terrain(z=z, x0=float(tie[3]), y0=float(tie[4]), dx=float(scale[0]), dy=float(scale[1]))


def rasterize_cells(polygons: list[np.ndarray], terrain: Terrain) -> np.ndarray:
    """셀 다각형(EPSG:5187 좌표 배열 목록)을 지형 격자에 그려 화소별 셀 번호(0부터, 없음 = -1)를 돌려준다."""
    rows, cols = terrain.shape
    img = Image.new("I", (cols, rows), 0)
    draw = ImageDraw.Draw(img)
    for i, poly in enumerate(polygons):
        c = (poly[:, 0] - terrain.x0) / terrain.dx - 0.5
        r = (terrain.y0 - poly[:, 1]) / terrain.dy - 0.5
        draw.polygon(list(zip(c.tolist(), r.tolist())), fill=i + 1)
    return np.asarray(img, dtype=np.int64) - 1


def depth_raster(cell_id: np.ndarray, cell_ws: np.ndarray, terrain: Terrain) -> np.ndarray:
    d = np.full(terrain.shape, np.nan, dtype=np.float32)
    m = (cell_id >= 0) & np.isfinite(terrain.z)
    d[m] = cell_ws[cell_id[m]] - terrain.z[m]
    d[~(d > 0)] = np.nan
    return d


def colorize(depth: np.ndarray, min_depth: float = 0.1) -> Image.Image:
    rgba = np.zeros(depth.shape + (4,), dtype=np.uint8)
    for lo, hi, color in DEPTH_CLASSES:
        m = (depth >= max(lo, min_depth)) & (depth < hi)
        rgba[m] = color
    return Image.fromarray(rgba, "RGBA")


def depth_cm_image(depth: np.ndarray) -> Image.Image:
    cm = np.nan_to_num(np.round(depth * 100.0), nan=0.0)
    return Image.fromarray(np.clip(cm, 0, 65535).astype(np.uint16), "I;16")


def corners(terrain: Terrain):
    """래스터 네 모서리 (왼위, 오위, 오아래, 왼아래) EPSG:5187."""
    rows, cols = terrain.shape
    x1 = terrain.x0 + cols * terrain.dx
    y1 = terrain.y0 - rows * terrain.dy
    return [(terrain.x0, terrain.y0), (x1, terrain.y0), (x1, y1), (terrain.x0, y1)]
