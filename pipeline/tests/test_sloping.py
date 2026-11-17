"""sloping 검증 (가짜 사각 격자): 선형 수면 재현, 셀 경계 연속, 둑(높은 면)에서 단차 유지, 마른 셀 제외.
`python -m pytest pipeline/tests/test_sloping.py`"""
import numpy as np

from pipeline.sloping import SlopingMesh

H = 10.0       # 셀 크기 m


def grid_mesh(nx=6, ny=5, face_z=None, zmin=None):
    fx, fy = np.meshgrid(np.arange(nx + 1) * H, np.arange(ny + 1) * H)
    fp = np.stack([fx.ravel(), fy.ravel()], axis=1)

    def fid(i, j):
        return j * (nx + 1) + i

    cells, cen = [], []
    for j in range(ny):
        for i in range(nx):
            cells.append([fid(i, j), fid(i + 1, j), fid(i + 1, j + 1), fid(i, j + 1)])   # 반시계
            cen.append([(i + 0.5) * H, (j + 0.5) * H])
    idx = np.full((len(cells), 6), -1)                 # -1 채움 확인용으로 6칸
    idx[:, :4] = np.array(cells)
    faces = set()
    for c in cells:
        for k in range(4):
            a, b = c[k], c[(k + 1) % 4]
            faces.add((min(a, b), max(a, b)))
    faces = np.array(sorted(faces))
    fz = np.zeros(len(faces)) if face_z is None else face_z(fp[faces[:, 0]], fp[faces[:, 1]])
    z = np.zeros(len(cells)) if zmin is None else zmin
    area = {"center": np.array(cen), "facepoints": fp, "cell_fp_index": idx, "zmin": z,
            "faces_fp": faces, "faces_zmin": fz}
    return SlopingMesh([area]), np.array(cen), nx, ny


def cell_of(x, y, nx):
    return (np.floor(y / H) * nx + np.floor(x / H)).astype(np.int64)


def test_linear_surface_reproduced_inside():
    m, cen, nx, ny = grid_mesh()
    ws = 5.0 + 0.01 * cen[:, 0] + 0.02 * cen[:, 1]
    # 가장자리 셀은 꼭짓점 이웃이 모자라 평균이 달라진다 — 안쪽 셀만
    rng = np.random.default_rng(0)
    px = rng.uniform(H * 1, H * (nx - 1), 2000)
    py = rng.uniform(H * 1, H * (ny - 1), 2000)
    st = m.stencil(px, py, cell_of(px, py, nx))
    s = m.surface(ws, st)
    assert np.allclose(s, 5.0 + 0.01 * px + 0.02 * py, atol=1e-6)
    assert np.allclose(st["w"].sum(axis=1), 1.0)


def test_constant_stays_constant_and_continuous():
    m, cen, nx, ny = grid_mesh()
    s = m.surface(np.full(len(cen), 3.0), m.stencil(np.array([12.0, 33.0]), np.array([7.0, 41.0]),
                                                     cell_of(np.array([12.0, 33.0]), np.array([7.0, 41.0]), nx)))
    assert np.allclose(s, 3.0)
    # 아무 수면이나: 셀 경계 위 점을 양쪽 셀에서 계산하면 같은 값 (꼭짓점 넷이 만나는 사각 격자에서도)
    rng = np.random.default_rng(1)
    ws = 2.0 + rng.uniform(0, 0.3, len(cen))
    y = rng.uniform(0, ny * H, 300)
    x = np.full(300, 3 * H)                            # 세로 경계 x = 30
    left = m.surface(ws, m.stencil(x, y, cell_of(x - 0.01, y, nx)))
    right = m.surface(ws, m.stencil(x, y, cell_of(x + 0.01, y, nx)))
    assert np.allclose(left, right, atol=1e-9)


def test_high_face_keeps_step():
    # x = 30 m 세로선의 면 최저 표고 100 m (둑) → 양쪽 수면을 잇지 않음
    def fz(a, b):
        return np.where((a[:, 0] == 3 * H) & (b[:, 0] == 3 * H), 100.0, 0.0)

    m, cen, nx, ny = grid_mesh(face_z=fz)
    ws = np.where(cen[:, 0] < 3 * H, 10.0, 11.0)
    x = np.array([29.9, 30.1, 25.0, 35.0])
    y = np.array([25.0, 25.0, 25.0, 25.0])
    s = m.surface(ws, m.stencil(x, y, cell_of(x, y, nx)))
    assert np.allclose(s, [10.0, 11.0, 10.0, 11.0])
    # 둑이 없으면 경계에서 이어진다 (경계 위는 두 수위 평균)
    m2, *_ = grid_mesh()
    s2 = m2.surface(ws, m2.stencil(np.array([30.0]), np.array([25.0]), cell_of(np.array([29.9]), np.array([25.0]), nx)))
    assert np.isclose(s2[0], 10.5)


def test_dry_cell_excluded():
    nx, ny = 6, 5
    zmin = np.zeros(nx * ny)
    zmin[2 * nx + 3] = 4.0                             # 셀 (3, 2) 마름 — 수위 = 최저 표고
    m, cen, nx, ny = grid_mesh(zmin=zmin)
    ws = np.full(nx * ny, 1.0)
    ws[2 * nx + 3] = 4.0
    x = np.array([25.0, 29.99, 35.0])
    y = np.array([25.0, 29.99, 25.0])
    s = m.surface(ws, m.stencil(x, y, cell_of(x, y, nx)))
    assert np.allclose(s[:2], 1.0)                     # 마른 셀 수위(4 m)를 끌어오지 않음
    assert np.isnan(s[2])                              # 마른 셀 화소는 물 없음
