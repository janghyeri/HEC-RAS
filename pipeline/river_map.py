"""하천(1D) 구간 수면 지도 — 단면 수위를 단면 사이에 보간해 2 m 지형에서 뺀다.

웹 지도는 2D 셀 결과만 그려서 냉천 하천 구간(1D 단면)이 비어 보였다 (2026-11-02 사용자 지적).
HEC-RAS RAS Mapper의 1D 수면 그리기와 같은 방법을 쓴다.

  1. 이웃한 두 단면 절단선(i, i+1)으로 사각형(구간)을 만든다
  2. 구간 안 화소마다 두 절단선까지의 거리로 수위를 선형 보간한다
        WS = (WS_i · d_{i+1} + WS_{i+1} · d_i) / (d_i + d_{i+1})
  3. 수심 = WS − 지형(2 m DEM). 0보다 큰 곳만 물
  4. 2D 셀이 덮는 화소는 빼고(2D 결과가 우선), 하천 구간에만 그린다
  5. (thalweg을 주면) 지형이 단면 측량 하상(최저 표고 보간값)보다 bed_tol 넘게 낮은 화소는 하상 높이로 본다
     — 2 m DEM에 군데군데 작은 구덩이(예: 주변 101 m인데 한 화소 3.8 m)가 있어 수심이 수십 m로 나오는 것을 막는다
       (2026-11-02 확인: S0-C 하천 화소 27.6만 개 중 542개가 10 m 넘게 나옴)

침수면적 KPI(docs/GUIDE.md §4.4.1)는 2D 셀 기준 그대로이고, 이 수면은 지도 표시에만 쓴다.
좌표는 모두 EPSG:5187 (HEC-RAS 좌표계).
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw


def _dist_to_polyline(px: np.ndarray, py: np.ndarray, line: np.ndarray) -> np.ndarray:
    """점들(px, py)에서 꺾은선(line, (k, 2))까지 최단 거리."""
    d = np.full(px.shape, np.inf)
    for (x1, y1), (x2, y2) in zip(line[:-1], line[1:]):
        vx, vy = x2 - x1, y2 - y1
        L2 = vx * vx + vy * vy
        if L2 == 0:
            t = np.zeros_like(px)
        else:
            t = np.clip(((px - x1) * vx + (py - y1) * vy) / L2, 0.0, 1.0)
        dx, dy = px - (x1 + t * vx), py - (y1 + t * vy)
        d = np.minimum(d, np.hypot(dx, dy))
    return d


def reach_quads(cutlines: list[np.ndarray]) -> list[np.ndarray]:
    """이웃 단면 절단선으로 구간 다각형을 만든다. 절단선 방향(왼쪽→오른쪽)이 같다고 보고,
    반대로 그려진 선은 꼬이지 않게 뒤집는다."""
    quads = []
    for a, b in zip(cutlines[:-1], cutlines[1:]):
        same = np.hypot(*(a[0] - b[0])) + np.hypot(*(a[-1] - b[-1]))
        flip = np.hypot(*(a[0] - b[-1])) + np.hypot(*(a[-1] - b[0]))
        bb = b if same <= flip else b[::-1]
        quads.append(np.vstack([a, bb[::-1]]))
    return quads


def river_depth(cutlines: list[np.ndarray], ws: np.ndarray, z: np.ndarray, x0: float, y0: float,
                dx: float, dy: float, exclude: np.ndarray | None = None,
                thalweg: np.ndarray | None = None, bed_tol: float = 0.5) -> np.ndarray:
    """단면 수위 ws(단면 순서, 상류→하류)로 하천 구간 수심 래스터를 만든다 (물 없는 곳 NaN).

    cutlines : 단면 절단선 목록 [(k, 2) EPSG:5187], ws와 같은 순서
    z, x0, y0, dx, dy : 지형 격자 (x0, y0 = 왼쪽 위 모서리, 행은 아래로 증가)
    exclude  : True인 화소는 그리지 않음 (2D 셀이 덮는 곳)
    thalweg  : 단면별 최저 표고(측량 하상). 주면 지형 구덩이를 하상 − bed_tol로 올려서 계산
    """
    rows, cols = z.shape
    quads = reach_quads(cutlines)
    img = Image.new("I", (cols, rows), 0)
    draw = ImageDraw.Draw(img)
    for k, q in enumerate(quads):
        c = (q[:, 0] - x0) / dx - 0.5
        r = (y0 - q[:, 1]) / dy - 0.5
        draw.polygon(list(zip(c.tolist(), r.tolist())), fill=k + 1)
    seg = np.asarray(img, dtype=np.int64) - 1          # 화소별 구간 번호 (-1 = 하천 구간 밖)

    out = np.full(z.shape, np.nan, dtype=np.float32)
    for k in range(len(quads)):
        rr, cc = np.nonzero(seg == k)
        if rr.size == 0 or not (np.isfinite(ws[k]) and np.isfinite(ws[k + 1])):
            continue
        px = x0 + (cc + 0.5) * dx
        py = y0 - (rr + 0.5) * dy
        da = _dist_to_polyline(px, py, cutlines[k])
        db = _dist_to_polyline(px, py, cutlines[k + 1])
        w = np.where(da + db > 0, da / (da + db), 0.0)
        wsp = ws[k] * (1 - w) + ws[k + 1] * w
        zz = z[rr, cc]
        if thalweg is not None:
            bed = thalweg[k] * (1 - w) + thalweg[k + 1] * w
            zz = np.maximum(zz, bed - bed_tol)
        d = wsp - zz
        out[rr, cc] = np.where(d > 0, d, np.nan)
    if exclude is not None:
        out[exclude] = np.nan
    return out


def merge_depth(depth_2d: np.ndarray, depth_river: np.ndarray) -> np.ndarray:
    """2D 수심이 있는 화소는 2D, 없는 곳만 하천 수심 (지도 표시용)."""
    out = depth_2d.astype(np.float32).copy()
    use = ~(np.isfinite(out) & (out > 0)) & np.isfinite(depth_river)
    out[use] = depth_river[use]
    return out
