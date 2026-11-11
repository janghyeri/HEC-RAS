"""flow2d_web 계산 시험 (HDF 없이 합성 격자로). 실행: python -m pytest pipeline/tests/test_flow2d_web.py"""
import math

import numpy as np

from pipeline import tm_korea
from pipeline.flow2d_web import (DRY, SCALE_MS, cell_velocity, downhill_share, face_wet_area, grid_north_bearing, pack,
                                 to_east_north, unpack)


def quad_mesh(nx=6, ny=5, d=10.0):
    """정사각 셀 nx×ny. 면 = 이웃 셀 쌍 (0번 → 1번 방향 법선) + 바깥 면(1번 = 가상 셀 번호)."""
    n = nx * ny
    cid = lambda i, j: j * nx + i
    fc, nl = [], []
    ghost = n
    for j in range(ny):
        for i in range(nx):
            c = cid(i, j)
            if i + 1 < nx:
                fc.append((c, cid(i + 1, j)))
                nl.append((1.0, 0.0, d))
            if j + 1 < ny:
                fc.append((c, cid(i, j + 1)))
                nl.append((0.0, 1.0, d))
            if i == 0:
                fc.append((c, ghost)); nl.append((-1.0, 0.0, d)); ghost += 1
            if j == 0:
                fc.append((c, ghost)); nl.append((0.0, -1.0, d)); ghost += 1
    return n, np.array(fc), np.array(nl)


def test_uniform_flow_recovered():
    n, fc, nl = quad_mesh()
    U = np.array([0.8, -0.3])
    vn = nl[:, :2] @ U
    uv = cell_velocity(n, fc, nl[:, :2], vn, nl[:, 2])
    assert np.allclose(uv, U, rtol=5e-3, atol=1e-6)   # 정규화(1e-3 × 대각합) 때문에 0.3 %쯤 작다 (화면용이라 무시)


def test_dry_faces_ignored_and_one_direction_cell():
    n, fc, nl = quad_mesh(nx=3, ny=1)
    U = np.array([1.2, 0.0])
    vn = nl[:, :2] @ U
    w = np.where(np.abs(nl[:, 0]) > 0, nl[:, 2], 0.0)   # 남북 면은 마름 → 동서 방향만 남음
    uv = cell_velocity(n, fc, nl[:, :2], vn, w)
    assert np.allclose(uv[:, 0], 1.2, atol=3e-3) and np.allclose(uv[:, 1], 0.0)
    uv0 = cell_velocity(n, fc, nl[:, :2], vn, np.zeros(len(fc)))
    assert np.all(uv0 == 0)


def test_face_wet_area_matches_interp():
    rng = np.random.default_rng(1)
    F = 40
    counts = rng.integers(2, 6, F)
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
    vals = []
    for c in counts:
        e = np.sort(rng.uniform(0, 5, c)) + np.arange(c) * 1e-3
        a = np.concatenate([[0], np.cumsum(rng.uniform(0.5, 3, c - 1))])
        vals.append(np.stack([e, a, np.zeros(c), np.zeros(c)], axis=1))
    values = np.concatenate(vals)
    info = np.stack([starts, counts], axis=1)
    length = rng.uniform(5, 20, F)
    ws = rng.uniform(-1, 7, F)
    ws[3] = np.nan
    got = face_wet_area(info, values, ws, length)
    for f in range(F):
        e = values[starts[f]:starts[f] + counts[f], 0]
        a = values[starts[f]:starts[f] + counts[f], 1]
        if not np.isfinite(ws[f]) or ws[f] < e[0]:
            want = 0.0
        elif ws[f] >= e[-1]:
            want = a[-1] + length[f] * (ws[f] - e[-1])
        else:
            want = np.interp(ws[f], e, a)
        assert math.isclose(got[f], want, abs_tol=1e-9), (f, got[f], want)
    # 표 순서가 섞여 있어도 같은 값
    perm = rng.permutation(F)
    blocks = [values[starts[f]:starts[f] + counts[f]] for f in perm]
    v2 = np.concatenate(blocks)
    s2 = np.empty(F, dtype=np.int64)
    pos = 0
    for f, b in zip(perm, blocks):
        s2[f] = pos
        pos += len(b)
    got2 = face_wet_area(np.stack([s2, counts], axis=1), v2, ws, length)
    assert np.allclose(got, got2)
    assert face_wet_area(None, None, ws, length) is None


def test_downhill_share():
    fc = np.array([[0, 1], [1, 2], [2, 3]])
    ws = np.array([3.0, 2.0, 1.0, 5.0])
    vn = np.array([0.5, 0.4, 0.3])        # 0→1, 1→2는 내리막, 2→3은 오르막
    assert downhill_share(fc, vn, ws, 4) == (2, 3)


def test_rotation_and_bearing():
    x, y = tm_korea.from_lonlat(np.array([129.38]), np.array([35.99]))     # 포항 냉천 부근
    b = grid_north_bearing(float(x[0]), float(y[0]))
    assert 0.15 < math.degrees(b) < 0.3                # 자오선 수렴각 ≈ (129.38 − 129)° × sin 36° ≈ 0.22°
    e, n = to_east_north(np.array([0.0]), np.array([1.0]), b)
    assert math.isclose(e[0], math.sin(b)) and math.isclose(n[0], math.cos(b))


def test_pack_roundtrip():
    u0 = np.array([[np.nan, 0.5], [1.0, np.nan]])
    v0 = np.array([[np.nan, -0.25], [0.0, np.nan]])
    u1 = np.array([[0.1, np.nan], [9.0, np.nan]])
    v1 = np.array([[0.2, np.nan], [-0.1, np.nan]])
    idx, blob = pack([(u0, v0), (u1, v1)])
    assert idx.tolist() == [0, 1, 2]                 # 젖은 적 있는 격자만 (3번은 늘 마름)
    i2, q = unpack(blob, len(idx), 2)
    assert i2.tolist() == [0, 1, 2]
    assert q[0, 0].tolist() == [DRY, 10, 20] and q[0, 1].tolist() == [DRY, -5, 0]
    assert q[1, 0].tolist() == [2, DRY, 127]         # 9 m/s는 6.35 m/s로 잘림
    assert len(blob) == 4 * 3 + 2 * 2 * 3
    assert SCALE_MS == 0.05


def test_write_flow2d_end_to_end(tmp_path):
    """가짜 지형·셀 두 개: 셀 0만 젖고 동쪽으로 1 m/s → 젖은 격자점은 모두 동쪽 ≈ 1 m/s, 마른 시각은 -128."""
    import json

    from pipeline import frames_web as F
    from pipeline.flow2d_web import write_flow2d

    x0, y0 = 234000.0, 382400.0
    rows = cols = 200
    xs = x0 + (np.arange(cols) + 0.5) * 2
    z = np.tile(((xs - x0) / 100.0).astype(np.float32), (rows, 1))     # 동쪽으로 갈수록 높아짐 (0~4 m)
    cell_id = np.full((rows, cols), -1, dtype=np.int64)
    cell_id[:, :100] = 0
    cell_id[:, 100:150] = 1
    lon, lat = tm_korea.to_lonlat(np.array([x0, x0 + 400]), np.array([y0 - 400, y0]))
    grid = F.lonlat_grid([lon[0], lat[0], lon[1], lat[1]], 20.0)
    smp = F.FrameSampler(z, x0, y0, 2.0, 2.0, cell_id, grid)
    ws = np.array([[0.0, 0.0], [1.5, 0.2]])                 # 시각 0: 모두 마름, 시각 1: 셀 0의 서쪽 부분만 0.1 m 이상
    uv = np.zeros((2, 2, 2))
    uv[1, 0] = [1.0, 0.0]
    info = write_flow2d(smp, uv, ws, ["t0", "t1"], tmp_path, 0.0, {"downhill_share": 1.0}, {"scenario_id": "X"})
    meta = json.loads((tmp_path / "flow2d.json").read_text(encoding="utf-8"))
    assert meta["n"] == info["n"] > 0 and meta["grid"]["width"] == grid["width"]
    idx, q = unpack((tmp_path / "flow2d.bin").read_bytes(), meta["n"], 2)
    assert np.all(q[0] == DRY)                               # 시각 0은 마름
    assert np.all(q[1, 0] == 20) and np.all(q[1, 1] == 0)    # 1 m/s 동쪽 = 20칸
    cols_ = idx % grid["width"]
    lon_c = grid["west"] + (cols_ + 0.5) * grid["dlon"]
    xc, _ = tm_korea.from_lonlat(lon_c, np.full(lon_c.shape, (lat[0] + lat[1]) / 2))
    assert xc.max() < x0 + 150                               # 수심 0.1 m 이상인 곳(지형 < 1.4 m)만
    assert meta["speed_max_ms"] == [0.0, 1.0]
