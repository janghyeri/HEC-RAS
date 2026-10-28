"""EPSG:5187 (Korea 2000 / East Belt 2010, GRS80 횡메르카토르) ↔ WGS84 경위도.

pyproj 없이 쓰려고 Krüger 급수(n^4 차수)로 직접 구현했다. 수 km 범위에서 오차는 1 mm 미만.
(GRS80과 WGS84 타원체 차이는 무시할 수준이며 KGD2002는 ITRF 기반이라 WGS84와 같다고 본다.)

투영 정수 (HEC-RAS 결과 HDF의 Projection 속성과 같음)
  위도 원점 38°N, 중앙 자오선 129°E, 축척 1.0, 가산 X(동) 200,000 m, 가산 Y(북) 600,000 m
"""
from __future__ import annotations

import numpy as np

A_AXIS = 6378137.0
F = 1 / 298.257222101
LAT0, LON0 = np.radians(38.0), np.radians(129.0)
K0, FE, FN = 1.0, 200000.0, 600000.0

_n = F / (2 - F)
_A = A_AXIS / (1 + _n) * (1 + _n**2 / 4 + _n**4 / 64)
_ALPHA = (
    _n / 2 - 2 * _n**2 / 3 + 5 * _n**3 / 16 + 41 * _n**4 / 180,
    13 * _n**2 / 48 - 3 * _n**3 / 5 + 557 * _n**4 / 1440,
    61 * _n**3 / 240 - 103 * _n**4 / 140,
    49561 * _n**4 / 161280,
)
_BETA = (
    _n / 2 - 2 * _n**2 / 3 + 37 * _n**3 / 96 - _n**4 / 360,
    _n**2 / 48 + _n**3 / 15 - 437 * _n**4 / 1440,
    17 * _n**3 / 480 - 37 * _n**4 / 840,
    4397 * _n**4 / 161280,
)
_DELTA = (
    2 * _n - 2 * _n**2 / 3 - 2 * _n**3 + 116 * _n**4 / 45,
    7 * _n**2 / 3 - 8 * _n**3 / 5 - 227 * _n**4 / 45,
    56 * _n**3 / 15 - 136 * _n**4 / 35,
    4279 * _n**4 / 630,
)
_C = 2 * np.sqrt(_n) / (1 + _n)


def _xi_eta(lat, dlon):
    t = np.sinh(np.arctanh(np.sin(lat)) - _C * np.arctanh(_C * np.sin(lat)))
    xi_p = np.arctan2(t, np.cos(dlon))
    eta_p = np.arctanh(np.sin(dlon) / np.sqrt(1 + t * t))
    xi, eta = xi_p.copy(), eta_p.copy()
    for j, a in enumerate(_ALPHA, start=1):
        xi = xi + a * np.sin(2 * j * xi_p) * np.cosh(2 * j * eta_p)
        eta = eta + a * np.cos(2 * j * xi_p) * np.sinh(2 * j * eta_p)
    return xi, eta


_XI0, _ = _xi_eta(np.array(LAT0), np.array(0.0))


def to_lonlat(x, y):
    """EPSG:5187 (x 동향, y 북향, m) → (경도, 위도) 도."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    xi = (y - FN) / (K0 * _A) + _XI0
    eta = (x - FE) / (K0 * _A)
    xi_p, eta_p = xi.copy(), eta.copy()
    for j, b in enumerate(_BETA, start=1):
        xi_p = xi_p - b * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
        eta_p = eta_p - b * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
    chi = np.arcsin(np.sin(xi_p) / np.cosh(eta_p))
    lat = chi.copy()
    for j, d in enumerate(_DELTA, start=1):
        lat = lat + d * np.sin(2 * j * chi)
    lon = LON0 + np.arctan2(np.sinh(eta_p), np.cos(xi_p))
    return np.degrees(lon), np.degrees(lat)


def from_lonlat(lon, lat):
    """(경도, 위도) 도 → EPSG:5187 (x, y) m."""
    lat = np.radians(np.asarray(lat, dtype=float))
    dlon = np.radians(np.asarray(lon, dtype=float)) - LON0
    xi, eta = _xi_eta(lat, dlon)
    return FE + K0 * _A * eta, FN + K0 * _A * (xi - _XI0)
