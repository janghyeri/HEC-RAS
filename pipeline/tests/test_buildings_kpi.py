"""침수 건물 수 검증 (가짜 격자·건물): 외곽선 안 화소, 작은 건물은 중심 화소, 계산 범위 밖 제외, 기준 수심 경계값,
둘레 점(3 m 바깥), 용도 묶음, 게시 결과 대조(자료가 있을 때).
`python -m pytest pipeline/tests/test_buildings_kpi.py`"""
import gzip
import json

import numpy as np
import pytest

from pipeline import buildings_kpi as K

# 10 × 8 화소 격자, 화소 1e-4도
INFO = {"bounds": [129.0, 36.0, 129.001, 36.0008], "width": 10, "height": 8}


def sq(x0, y0, x1, y1):
    return [[np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=float)]]


def make(blds, mask=None):
    g = K.Grid(INFO)
    m = np.full((g.H, g.W), 255, np.uint8) if mask is None else mask
    return K.prepare({"list": blds}, g, m), g


def px(g, i, j):
    """화소 (i, j) 중심 경위도"""
    return g.w + (i + 0.5) * g.dx, g.n - (j + 0.5) * g.dy


def test_interior_pixels_by_center():
    g = K.Grid(INFO)
    # 화소 2..4 (열), 1..2 (행) 중심을 덮는 사각형
    x0, _ = px(g, 2, 0)
    x1, _ = px(g, 4, 0)
    _, y1 = px(g, 0, 1)
    _, y0 = px(g, 0, 2)
    p = K.interior_pixels(g, sq(x0 - 1e-6, y0 - 1e-6, x1 + 1e-6, y1 + 1e-6))
    got = sorted((int(k % g.W), int(k // g.W)) for k in p)
    assert got == sorted((i, j) for i in (2, 3, 4) for j in (1, 2))


def test_small_building_uses_centroid_pixel_and_thresholds():
    g = K.Grid(INFO)
    cx, cy = px(g, 5, 4)
    tiny = sq(cx - 2e-6, cy - 2e-6, cx + 2e-6, cy + 2e-6)     # 화소 중심을 안 덮을 만큼 작게 — 그래도 중심 화소 하나
    tiny[0][0] += np.array([3e-6, 0])                           # 화소 중심에서 조금 비켜서 '외곽선 안 중심 없음'
    prep, _ = make([{"code": "01000", "polys": tiny}])
    assert len(prep["list"]) == 1 and prep["list"][0]["px"].tolist() == [4 * g.W + 5]
    d = np.zeros((g.H, g.W), np.uint8)
    d[4, 5] = 4                                                 # 0.08 m — 침수 아님
    assert K.compute(prep, d)["flooded"]["ge_0.1m"] == 0
    d[4, 5] = 5                                                 # 0.10 m — 침수
    r = K.compute(prep, d)
    assert r["flooded"] == {"ge_0.1m": 1, "ge_0.5m": 0, "ge_1.0m": 0}
    assert r["by_use"][0] == {"use": "주택", "total": 1, "flooded_ge_0.1m": 1, "flooded_ge_0.5m": 0}


def test_outside_domain_dropped_and_max_inside():
    g = K.Grid(INFO)
    a = sq(*px(g, 0, 7), *px(g, 2, 5))                          # 왼쪽 아래 3×3
    b = sq(*px(g, 7, 2), *px(g, 9, 0))                          # 오른쪽 위 3×3
    a[0][0] += np.array([[-1e-6, -1e-6], [1e-6, -1e-6], [1e-6, 1e-6], [-1e-6, 1e-6]])
    b[0][0] += np.array([[-1e-6, -1e-6], [1e-6, -1e-6], [1e-6, 1e-6], [-1e-6, 1e-6]])
    mask = np.zeros((g.H, g.W), np.uint8)
    mask[5:8, 0:2] = 255                                        # a만 계산 범위에 걸침
    prep, _ = make([{"code": "17000", "polys": a}, {"code": "03000", "polys": b}], mask)
    assert len(prep["list"]) == 1 and prep["list"][0]["group"] == "공장·창고"
    d = np.zeros((g.H, g.W), np.uint8)
    d[5, 2] = 60                                                # 외곽선 안 가장 깊은 화소 1.2 m (범위 밖 화소여도 건물 안이면 셈)
    r = K.compute(prep, d)
    assert r["buildings_in_domain"] == 1 and r["flooded"] == {"ge_0.1m": 1, "ge_0.5m": 1, "ge_1.0m": 1}


def test_ring_samples_are_outside_by_3m():
    poly = sq(129.0004, 36.0004, 129.0005, 36.0005)
    c = K.centroid(poly)
    pts = K.ring_samples(poly, c)
    kx = K.M_PER_DEG_LON_EQ * np.cos(np.radians(c[1]))
    r = poly[0][0]
    for (x, y), (vx, vy) in zip(pts, np.vstack([r, r[:1]])):
        dist = np.hypot((x - vx) * kx, (y - vy) * K.M_PER_DEG_LAT)
        assert abs(dist - 3.0) < 1e-6


def test_gray_threshold():
    assert [K.gray_threshold(m) for m in K.THRESHOLDS] == [5, 25, 50]


def test_load_buildings_roundtrip(tmp_path):
    d = {"origin_e6": [129000000, 36000000], "codes": ["", "01000"],
         "buildings": [[1, [[[400, 400, 100, 0, 0, 100, -100, 0]]]]]}
    p = tmp_path / "b.json.gz"
    with gzip.open(p, "wt", encoding="utf-8") as f:
        json.dump(d, f)
    b = K.load_buildings(p)["list"][0]
    assert b["code"] == "01000"
    assert np.allclose(b["polys"][0][0], [[129.0004, 36.0004], [129.0005, 36.0004], [129.0005, 36.0005], [129.0004, 36.0005]])


@pytest.mark.skipif(not (K.DATA / "buildings_v1.json.gz").exists() or not (K.WEB_DATA / "v1").exists(),
                    reason="건물 자료·게시 결과 없음")
def test_published_results_reproduce():
    assert K.check("v1")
