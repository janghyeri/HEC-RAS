"""tm_korea 검증: 원점, 왕복 변환, 독립 공식(Snyder 급수)과의 일치. `python -m pipeline.tests.test_tm_korea`"""
import numpy as np

from pipeline import tm_korea as tm


def snyder_forward(lon, lat):
    """USGS Snyder (1987) 횡메르카토르 급수 — Krüger와 독립된 검산용."""
    a, f = tm.A_AXIS, tm.F
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    phi, lam = np.radians(lat), np.radians(lon)
    phi0, lam0 = tm.LAT0, tm.LON0

    def M(p):
        return a * ((1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * p
                    - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * np.sin(2 * p)
                    + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * np.sin(4 * p)
                    - (35 * e2**3 / 3072) * np.sin(6 * p))

    N = a / np.sqrt(1 - e2 * np.sin(phi) ** 2)
    T = np.tan(phi) ** 2
    C = ep2 * np.cos(phi) ** 2
    A = (lam - lam0) * np.cos(phi)
    x = tm.K0 * N * (A + (1 - T + C) * A**3 / 6 + (5 - 18 * T + T**2 + 72 * C - 58 * ep2) * A**5 / 120)
    y = tm.K0 * (M(phi) - M(phi0) + N * np.tan(phi) * (A**2 / 2 + (5 - T + 9 * C + 4 * C**2) * A**4 / 24
                                                      + (61 - 58 * T + T**2 + 600 * C - 330 * ep2) * A**6 / 720))
    return tm.FE + x, tm.FN + y


def main():
    lon, lat = tm.to_lonlat(200000.0, 600000.0)
    assert abs(lon - 129.0) < 1e-9 and abs(lat - 38.0) < 1e-9, (lon, lat)  # 1e-9 도 ≈ 0.1 mm

    # 냉천 모형 범위 (지형 래스터 경계 근처) 격자점
    xs, ys = np.meshgrid(np.linspace(233900, 239100, 27), np.linspace(366200, 382500, 41))
    lon, lat = tm.to_lonlat(xs, ys)
    x2, y2 = tm.from_lonlat(lon, lat)
    rt = max(np.abs(x2 - xs).max(), np.abs(y2 - ys).max())
    xs3, ys3 = snyder_forward(lon, lat)
    ind = max(np.abs(xs3 - xs).max(), np.abs(ys3 - ys).max())
    print(f"원점 OK · 왕복 오차 최대 {rt * 1000:.4f} mm · Snyder 급수와 차이 최대 {ind * 1000:.3f} mm")
    print(f"범위: 경도 {lon.min():.5f}~{lon.max():.5f}, 위도 {lat.min():.5f}~{lat.max():.5f}")
    assert rt < 1e-4 and ind < 5e-3
    print("통과")


if __name__ == "__main__":
    main()
