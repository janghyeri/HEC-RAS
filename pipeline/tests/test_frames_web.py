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
