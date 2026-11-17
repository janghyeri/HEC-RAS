"""frames_web 검증 (가짜 지형·셀): 표본 추출기가 '셀 수위 − 지형'을 경위도 격자에서 그대로 재현하는지,
하천 보간·2D 우선·등급 색·frames.json. `python -m pytest pipeline/tests/test_frames_web.py`
실제 자료 대조(11/5): S0-C 최대 수심 래스터와 2D 화소 99.4 %, 하천 최대 수심(river_depth)과 99.98 % 일치."""
import json

import numpy as np
from PIL import Image

from pipeline import frames_web as F
from pipeline import tm_korea


def _setup(with_river=False):
    # 원점 부근 400 m × 400 m, 2 m 지형: 동쪽으로 갈수록 1 m/100 m 높아짐
    x0, y0 = 234000.0, 382400.0
    rows = cols = 200
    xs = x0 + (np.arange(cols) + 0.5) * 2
    z = np.tile(((xs - x0) / 100.0).astype(np.float32), (rows, 1))
    cell_id = np.full((rows, cols), -1, dtype=np.int64)
    cell_id[:, :100] = 0          # 서쪽 절반 = 셀 0
    cell_id[:, 100:150] = 1       # 그 옆 = 셀 1, 동쪽 끝은 2D 밖
    lon, lat = tm_korea.to_lonlat(np.array([x0, x0 + 400]), np.array([y0 - 400, y0]))
    grid = F.lonlat_grid([lon[0], lat[0], lon[1], lat[1]], 4.0)
    river = None
    if with_river:   # 동쪽 끝(2D 밖)에 남북 방향 단면 두 개
        cut = [np.array([[x0 + 310, y0 - 20], [x0 + 390, y0 - 20]]), np.array([[x0 + 310, y0 - 380], [x0 + 390, y0 - 380]])]
        river = {"cut": cut, "bed": np.array([3.0, 3.0]), "areas2d": [np.array([[x0, y0], [x0 + 300, y0], [x0 + 300, y0 - 400], [x0, y0 - 400]])]}
    return F.FrameSampler(z, x0, y0, 2.0, 2.0, cell_id, grid, river), grid


def test_cell_depth():
    smp, grid = _setup()
    d, is2d = smp.depth(np.array([1.5, 0.2]))
    assert d.shape == (grid["height"], grid["width"])
    wet = np.isfinite(d)
    assert wet.any() and is2d[wet].all()
    # 셀 0: 지형 0~2 m, 수위 1.5 → 최대 수심 1.5 m 근처, 셀 1(지형 2~3 m, 수위 0.2)은 마름
    assert 1.4 < np.nanmax(d) <= 1.5
    assert np.nanmin(d) > 0


def test_river_fills_outside_2d_only():
    smp, _ = _setup(with_river=True)
    d, is2d = smp.depth(np.array([1.0, -9.0]), np.array([4.0, 4.0]))
    riv = np.isfinite(d) & ~is2d
    assert riv.any()
    # 지형 3.1~4 m, 하천 수위 4 m → 하천 수심 0~0.9 m
    assert np.nanmax(d[riv]) < 1.0


def test_png_and_json(tmp_path):
    smp, _ = _setup()
    ws = np.array([[0.0, 0.0], [1.5, 0.2], [0.6, 0.0]])
    info = F.write_frames(smp, ws, ["t0", "t1", "t2"], tmp_path, None, None, {"scenario_id": "X"})
    assert info["count"] == 3 and info["area_2d_km2"][0] == 0
    assert info["area_2d_km2"][1] > info["area_2d_km2"][2] > 0
    img = Image.open(tmp_path / "frames" / "001.png")
    assert img.mode == "P" and img.size == (info["width"], info["height"])
    meta = json.loads((tmp_path / "frames" / "frames.json").read_text(encoding="utf-8"))
    w, s, e, n = meta["bounds"]
    assert w < e and s < n and meta["files"] == "frames/{i:03d}.png"


# ---------------------------------------------------------------- 경사 수면·연속 수심 (2026-11-17)
def _sloping_setup():
    """10 m 사각 셀 6 × 5개 (60 m × 50 m), 2 m 지형: 동쪽으로 1 m/100 m."""
    from pipeline.raster_depth import Terrain, rasterize_cells
    from pipeline.sloping import SlopingMesh

    x0, y0 = 234000.0, 382400.0
    nx, ny, H = 6, 5, 10.0
    fx, fy = np.meshgrid(x0 + np.arange(nx + 1) * H, y0 - np.arange(ny + 1) * H)
    fp = np.stack([fx.ravel(), fy.ravel()], axis=1)
    cells, cen = [], []
    for j in range(ny):
        for i in range(nx):
            a = j * (nx + 1) + i
            cells.append([a, a + 1, a + 1 + nx + 1, a + nx + 1])
            cen.append([x0 + (i + 0.5) * H, y0 - (j + 0.5) * H])
    idx = np.array(cells)
    faces = sorted({(min(c[k], c[(k + 1) % 4]), max(c[k], c[(k + 1) % 4])) for c in cells for k in range(4)})
    rows, cols = 30, 35
    xs = x0 + (np.arange(cols) + 0.5) * 2
    z = np.tile(((xs - x0) / 100.0).astype(np.float32), (rows, 1))
    terr = Terrain(z=z, x0=x0, y0=y0, dx=2.0, dy=2.0)
    polys = [fp[c] for c in cells]
    cell_id = rasterize_cells(polys, terr)
    sl = SlopingMesh([{"center": np.array(cen), "facepoints": fp, "cell_fp_index": idx, "zmin": np.zeros(len(cells)),
                       "faces_fp": np.array(faces), "faces_zmin": np.zeros(len(faces))}])
    lon, lat = tm_korea.to_lonlat(np.array([x0, x0 + 70]), np.array([y0 - 60, y0]))
    grid = F.lonlat_grid([lon[0], lat[0], lon[1], lat[1]], 2.0)
    return terr, cell_id, sl, grid, np.array(cen), polys


def test_depth_gray_encoding():
    d = np.array([[np.nan, -0.1, 0.004, 0.1], [0.5, 1.0, 5.1, 9.0]], dtype=np.float32)
    v = np.asarray(F._depth_gray(d))
    assert v.tolist() == [[0, 0, 1, 5], [25, 50, 255, 255]]


def test_sloping_flat_equals_horizontal_and_linear_is_smooth():
    terr, cell_id, sl, grid, cen, _ = _sloping_setup()
    hor = F.FrameSampler(terr.z, terr.x0, terr.y0, 2.0, 2.0, cell_id, grid)
    slo = F.FrameSampler(terr.z, terr.x0, terr.y0, 2.0, 2.0, cell_id, grid, None, sl)
    ws = np.full(len(cen), 0.8)
    a, _ = hor.depth(ws)
    b, _ = slo.depth(ws)
    assert np.allclose(np.nan_to_num(a), np.nan_to_num(b), atol=1e-5)
    # 서→동으로 수위가 셀마다 계단(0.1 m)일 때: 수평은 셀 경계에서 0.1 m 뛰고, 경사 수면은 화소 사이 차이가 작다
    ws2 = 0.8 + 0.1 * np.floor((cen[:, 0] - terr.x0) / 10.0)
    a, _ = hor.depth(ws2)
    b, _ = slo.depth(ws2)
    da = np.nanmax(np.abs(np.diff(a, axis=1)))
    db = np.nanmax(np.abs(np.diff(b, axis=1)))
    assert db < da


def test_write_depth_frames_and_max(tmp_path):
    terr, cell_id, sl, grid, cen, _ = _sloping_setup()
    smp = F.FrameSampler(terr.z, terr.x0, terr.y0, 2.0, 2.0, cell_id, grid, None, sl)
    ws = np.stack([np.zeros(len(cen)), np.full(len(cen), 0.6)])
    info = F.write_depth_frames(smp, ws, ["t0", "t1"], tmp_path, None, np.full(len(cen), 0.7), None,
                                {"scenario_id": "X"})
    assert info["count"] == 2 and info["area_2d_km2"][0] == 0 and info["area_2d_km2"][1] > 0
    assert info["max"]["area_2d_km2"] >= info["area_2d_km2"][1]
    im = Image.open(tmp_path / "depth2m" / "001.png")
    assert im.mode == "L" and im.size == (info["width"], info["height"])
    v = np.asarray(im)
    assert 0 < v.max() <= round(0.6 / F.DEPTH_STEP) and (tmp_path / "depth2m" / "max.png").exists()
    meta = json.loads((tmp_path / "depth2m" / "frames.json").read_text(encoding="utf-8"))
    assert meta["encoding"]["step_m"] == F.DEPTH_STEP and meta["files"] == "depth2m/{i:03d}.png"


def test_sloping_max_depth_dem():
    terr, cell_id, sl, grid, cen, _ = _sloping_setup()
    d = F.sloping_max_depth_dem(sl, np.full(len(cen), 0.5), terr, cell_id, chunk=100)
    m = cell_id >= 0
    exp = 0.5 - terr.z
    assert np.allclose(d[m & (exp > 0)], exp[m & (exp > 0)], atol=1e-5)
    assert np.all(np.isnan(d[~m]))


def test_write_max_tiles(tmp_path):
    terr, cell_id, sl, grid, cen, polys = _sloping_setup()
    d = F.sloping_max_depth_dem(sl, np.full(len(cen), 0.5), terr, cell_id)
    x0, y0 = terr.x0, terr.y0
    rv = {"cut": [np.array([[x0 + 62, y0 - 2], [x0 + 69, y0 - 2]]), np.array([[x0 + 62, y0 - 58], [x0 + 69, y0 - 58]])],
          "max_ws": np.array([1.2, 1.2]), "bed": np.array([0.0, 0.0]),
          "areas2d": [np.array([[x0, y0], [x0 + 60, y0], [x0 + 60, y0 - 50], [x0, y0 - 50]])]}
    t = F.write_max_tiles(tmp_path, d, terr, rv, polys, zmin=15, zmax=16)
    assert t["tiles"] > 0 and t["render_mode"] == "sloping" and t["area_2d_km2"] > 0
    assert (tmp_path / "tiles" / "tiles.json").exists()
