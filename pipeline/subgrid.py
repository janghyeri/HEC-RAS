"""HEC-RAS 셀 표고-체적 표(subgrid)로 셀별 젖은 면적·체적·수심을 계산한다 (벡터화).

셀 하나의 표는 [(표고 e_k, 체적 V_k)]. 표고 z에서
  체적 V(z): 구간 선형 보간 (마지막 점 위로는 셀 면적 × 높이 차를 더함)
  젖은 면적 A(z) = dV/dz: z가 속한 구간의 기울기 = 지형이 z보다 낮은 면적
  평균 수심(젖은 부분) = V / A
  '수심 ≥ h' 면적 = A(z − h)  — 지형이 z − h 보다 낮은 면적
셀 최저표고 기준 수심(z − zmin)은 셀 안 가장 낮은 점 기준이라 과대값이므로 쓰지 않는다 (CLAUDE.md 규칙).
"""
from __future__ import annotations

import numpy as np


class SubgridTable:
    def __init__(self, ve_info: np.ndarray, ve_values: np.ndarray, cell_area: np.ndarray):
        n = len(ve_info)
        kmax = int(ve_info[:, 1].max())
        self.cell_area = cell_area.astype(float)
        self.count = ve_info[:, 1].astype(int)
        E = np.full((n, kmax), np.inf)
        V = np.zeros((n, kmax))
        for i, (s, c) in enumerate(ve_info):
            E[i, :c] = ve_values[s:s + c, 0]
            V[i, :c] = ve_values[s:s + c, 1]
            if c < kmax:
                V[i, c:] = ve_values[s + c - 1, 1] if c else 0.0
        self.E, self.V = E, V
        self.e_last = E[np.arange(n), np.maximum(self.count - 1, 0)]
        self.v_last = V[np.arange(n), np.maximum(self.count - 1, 0)]

    def evaluate(self, z: np.ndarray):
        """표고 z (n,) → (젖은 면적, 체적). z가 NaN이면 0."""
        z = np.asarray(z, dtype=float)
        n = len(z)
        rows = np.arange(n)
        zz = np.where(np.isfinite(z), z, -np.inf)
        k = np.sum(self.E <= zz[:, None], axis=1)          # z 이하 표고 점 개수
        area = np.zeros(n)
        vol = np.zeros(n)

        top = (k >= self.count) & (self.count > 0)
        area[top] = self.cell_area[top]
        vol[top] = self.v_last[top] + (zz[top] - self.e_last[top]) * self.cell_area[top]

        mid = (k > 0) & ~top
        km = k[mid]
        r = rows[mid]
        e0, e1 = self.E[r, km - 1], self.E[r, km]
        v0, v1 = self.V[r, km - 1], self.V[r, km]
        slope = np.where(e1 > e0, (v1 - v0) / np.where(e1 > e0, e1 - e0, 1.0), 0.0)
        area[mid] = slope
        vol[mid] = v0 + slope * (zz[mid] - e0)

        area = np.clip(area, 0.0, self.cell_area)
        return area, np.maximum(vol, 0.0)

    def depth_metrics(self, ws: np.ndarray):
        """수위 → (젖은 부분 평균 수심 m, 젖은 면적 비율 0~1)."""
        a, v = self.evaluate(ws)
        mean_depth = np.where(a > 0, v / np.where(a > 0, a, 1.0), 0.0)
        return mean_depth, a / self.cell_area

    def area_deeper_than(self, ws: np.ndarray, h: float) -> np.ndarray:
        """셀별로 수심이 h 이상인 면적 (m2)."""
        a, _ = self.evaluate(np.asarray(ws, dtype=float) - h)
        return a
