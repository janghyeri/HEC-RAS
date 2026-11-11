"""냉천 흐름 표시용 자료 (river_flow.json) — 지도·3D에서 시각을 멈춰도 하천이 흐르는 모습을 그린다.

입력: worker/dump_river_geom.py 출력 npz (하천 중심선, 단면 절단선·측량 단면, 단면별 10분 유량·수위)
출력: river_flow.json
  centerline     하천 중심선 경위도 (상류 → 하류)
  xs.chainage_m  단면이 중심선과 만나는 곳의 상류 끝부터 거리 (m)
  velocity_ms    [시각][단면] 단면 평균 유속 = 유량 ÷ 흐름 단면적 (측량 단면에서 그 시각 수위 아래 면적)
  top_width_m    [시각][단면] 수면 폭 (절단선 길이를 넘지 않게)

단면 평균 유속은 화면의 흐름 표시(빠르기·방향 비교)에만 쓴다. HEC-RAS의 주수로·고수부지 구분, 비유효 흐름 구역은 따지지 않은
단순 값이라 수리 계산·KPI에는 쓰지 않는다.

사용: python -m pipeline.river_flow --npz dump/river_S0-C.npz --out web/public/data/v1/S0-C/river_flow.json --scenario S0-C
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from . import tm_korea
from .river_publish import load_river

TS = "|Results|Unsteady|Output|Output Blocks|Base Output|Unsteady Time Series|Cross Sections|"


def area_width(profile: np.ndarray, ws: float) -> tuple[float, float]:
    """측량 단면(측점, 표고)에서 수위 ws 아래 흐름 단면적(m²)과 수면 폭(m). 젖은 경계는 선형 보간."""
    s = profile[:, 0].astype(float)
    z = profile[:, 1].astype(float)
    ds = np.diff(s)
    d1, d2 = ws - z[:-1], ws - z[1:]
    ok = ds > 0
    both = ok & (d1 > 0) & (d2 > 0)
    part = ok & ((d1 > 0) ^ (d2 > 0))
    a = np.sum(ds[both] * (d1[both] + d2[both]) / 2)
    t = np.sum(ds[both])
    if part.any():
        dm = np.maximum(d1[part], d2[part])
        f = dm / (np.abs(d1[part]) + np.abs(d2[part]))
        a += np.sum(ds[part] * f * dm / 2)
        t += np.sum(ds[part] * f)
    return float(a), float(t)


def _intersect(p, q, a, b):
    """선분 pq와 ab의 교점 매개변수 (t: pq 위, u: ab 위), 없으면 None."""
    r, s = q - p, b - a
    den = r[0] * s[1] - r[1] * s[0]
    if abs(den) < 1e-12:
        return None
    w = a - p
    t = (w[0] * s[1] - w[1] * s[0]) / den
    u = (w[0] * r[1] - w[1] * r[0]) / den
    return (t, u) if (0 <= t <= 1 and 0 <= u <= 1) else None


def chainage(centerline: np.ndarray, cutlines: list[np.ndarray]) -> np.ndarray:
    """단면 절단선이 중심선과 만나는 곳까지 중심선 거리. 안 만나면 절단선 가운데에서 가장 가까운 중심선 점."""
    seg = np.diff(centerline, axis=0)
    seglen = np.hypot(seg[:, 0], seg[:, 1])
    cum = np.concatenate([[0], np.cumsum(seglen)])
    out = []
    for cut in cutlines:
        hit = None
        for j in range(len(centerline) - 1):
            for k in range(len(cut) - 1):
                r = _intersect(centerline[j], centerline[j + 1], cut[k], cut[k + 1])
                if r is not None:
                    hit = cum[j] + r[0] * seglen[j]
                    break
            if hit is not None:
                break
        if hit is None:
            mid = cut.mean(axis=0)
            j = int(np.argmin(np.hypot(centerline[:, 0] - mid[0], centerline[:, 1] - mid[1])))
            hit = cum[j]
        out.append(hit)
    return np.maximum.accumulate(np.array(out))   # 상류 → 하류로 늘어나게


def build(npz: Path, scenario: str) -> dict:
    rv = load_river(npz)
    with np.load(npz) as z:
        cl = np.array(z["|Geometry|River Centerlines|Polyline Points"], dtype=float)
        sei = np.array(z["|Geometry|Cross Sections|Station Elevation Info"])
        sev = np.array(z["|Geometry|Cross Sections|Station Elevation Values"])
        q = np.array(z[TS + "Flow"], dtype=float)
        ws = np.array(z[TS + "Water Surface"], dtype=float)
        stamps = [s.decode().strip() if isinstance(s, bytes) else str(s) for s in z[TS.replace("Cross Sections|", "") + "Time Date Stamp"]]
    # 중심선 방향을 상류(첫 단면) → 하류로
    first = rv["cut"][0].mean(axis=0)
    if np.hypot(*(cl[-1] - first)) < np.hypot(*(cl[0] - first)):
        cl = cl[::-1]
    ch = chainage(cl, rv["cut"])
    profiles = [sev[s:s + n] for s, n in sei]
    cut_len = np.array([float(np.sum(np.hypot(*np.diff(c, axis=0).T))) for c in rv["cut"]])
    T, N = q.shape
    vel = np.zeros((T, N))
    wid = np.zeros((T, N))
    for t in range(T):
        for i, p in enumerate(profiles):
            a, w = area_width(p, ws[t, i])
            vel[t, i] = q[t, i] / a if a > 1e-6 else 0.0
            wid[t, i] = min(w, cut_len[i] * 0.95)
    vel = np.clip(vel, -10, 10)
    lon, lat = tm_korea.to_lonlat(cl[:, 0], cl[:, 1])
    return {
        "scenario_id": scenario,
        "note": "흐름 표시용. velocity = 유량 ÷ 흐름 단면적(측량 단면, 그 시각 수위 아래) — 주수로·고수부지·비유효 흐름 구분 없는 단순 "
                "단면 평균 유속이라 수리 계산에는 쓰지 않는다",
        "times_raw": stamps,
        "centerline": [[round(float(a), 6), round(float(b), 6)] for a, b in zip(lon, lat)],
        "length_m": round(float(np.sum(np.hypot(*np.diff(cl, axis=0).T))), 1),
        "xs": {"rs": rv["rs"], "chainage_m": [round(float(c), 1) for c in ch]},
        "velocity_ms": [[round(float(v), 2) for v in row] for row in vel],
        "top_width_m": [[round(float(v), 0) for v in row] for row in wid],
    }


def write(npz: Path, out: Path, scenario: str) -> dict:
    info = build(npz, scenario)
    out.write_text(json.dumps(info, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    v = np.array(info["velocity_ms"])
    return {"scenario": scenario, "bytes": out.stat().st_size, "xs": len(info["xs"]["rs"]),
            "velocity_p50_max": [round(float(np.median(v)), 2), round(float(v.max()), 2)],
            "length_m": info["length_m"]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--npz", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--scenario", required=True)
    a = ap.parse_args()
    print(json.dumps(write(Path(a.npz), Path(a.out), a.scenario), ensure_ascii=False))


if __name__ == "__main__":
    main()
