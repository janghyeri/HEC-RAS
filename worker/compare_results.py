"""두 HEC-RAS 결과(p##.hdf)가 같은지 확인 — 기준 파일 재현성 검사 (작업 진행 가이드 Step 1-3, Step 5).

비교 항목
  - 침수면적 (셀 표고-체적 표 기반, 최대 수위가 지형보다 0.1 / 0.5 / 1.0 m 이상 높은 면적)
  - 2D 셀 최대 수위 차이 분포 (99·99.9 분위, 0.05 m 넘는 셀 수, 최대)
  - 하천 단면 최대 수위·최대 유량 차이
  - 측방 구조물 첨두 월류량·순 월류 체적 (방향이 바뀌면 '불안정 의심')
  - 전체·2D 영역별 체적오차, 계산 성공 여부·계산 시간

판정 (기본값, 인자로 변경 가능)
  - 침수면적 차이가 모든 기준에서 ±1 % 이내
  - 셀 최대 수위 차이의 99 분위가 0.02 m 이내
  → 둘 다 만족하면 "같음". 셀 하나의 최대 차이는 참고로만 보여준다
    (2026-10-28 확인: 같은 입력으로 다시 돌려도 측방 구조물 RS 7.65 주변 소수 셀은 수십 cm까지 달라짐).

사용 예
  python compare_results.py --a C:\\Hec-Ras\\KNUWATER\\Pohang\\NC090902\\NC090902.p03.hdf ^
                            --b C:\\Hec-Ras\\HECRASMCP\\Pohang_web\\NC090902\\NC090902.p03.hdf
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import h5py
import numpy as np

_trapz = getattr(np, "trapezoid", None) or np.trapz  # numpy 1.x(Anaconda 구버전)에서도 동작

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pipeline.subgrid import SubgridTable  # noqa: E402  셀 표고-체적 계산은 파이프라인과 같은 구현을 쓴다

BASE = "/Results/Unsteady/Output/Output Blocks/Base Output"
SUMMARY = "/Results/Unsteady/Summary"
GEOM = "/Geometry/2D Flow Areas"
DEPTHS = (0.1, 0.5, 1.0)


def _attrs(h, path):
    return {k: (v.decode() if isinstance(v, bytes) else v) for k, v in h[path].attrs.items()}


def load(path: str) -> dict:
    out = {"cells": {}, "geom": {}, "lat": {}}
    with h5py.File(path, "r") as h:
        s = _attrs(h, SUMMARY)
        out["solution"] = s.get("Solution")
        out["runtime"] = s.get("Computation Time Total")
        out["vol_err_pct"] = _attrs(h, SUMMARY + "/Volume Accounting").get("Error Percent")
        out["vol2d"] = {}
        va2d = SUMMARY + "/Volume Accounting/Volume Accounting 2D"
        if va2d in h:
            for area in h[va2d].keys():
                out["vol2d"][area] = _attrs(h, f"{va2d}/{area}").get("Error Percent")
        g2d = BASE + "/Summary Output/2D Flow Areas"
        for area in h[g2d].keys():
            key = f"{g2d}/{area}/Maximum Water Surface"
            if key not in h:
                continue
            out["cells"][area] = h[key][()][0].astype(float)
            g = f"{GEOM}/{area}"
            out["geom"][area] = {
                "area": h[g + "/Cells Surface Area"][()].astype(float),
                "zmin": h[g + "/Cells Minimum Elevation"][()].astype(float),
                "info": h[g + "/Cells Volume Elevation Info"][()],
                "vals": h[g + "/Cells Volume Elevation Values"][()].astype(float),
            }
        xs = BASE + "/Summary Output/Cross Sections"
        out["xs_ws"] = h[xs + "/Maximum Water Surface"][()][0].astype(float)
        out["xs_q"] = h[xs + "/Maximum Flow"][()][0].astype(float)
        ls = BASE + "/Unsteady Time Series/Lateral Structures"
        if ls in h:
            dt = 600.0  # 10분 출력 (모형 기본)
            for name in h[ls].keys():
                q = h[f"{ls}/{name}/Structure Variables"][()][:, 0].astype(float)
                out["lat"][name] = {"peak": float(np.nanmax(q)), "net_m3": float(_trapz(q, dx=dt))}
    return out


def inundation(r: dict) -> dict:
    tot = {d: 0.0 for d in DEPTHS}
    for area, ws in r["cells"].items():
        g = r["geom"][area]
        real = np.isfinite(g["zmin"]) & (g["area"] > 0)
        sg = SubgridTable(g["info"][real], g["vals"], g["area"][real])
        for d in DEPTHS:
            tot[d] += sg.area_deeper_than(ws[real], d).sum()
    return tot


def compare(a: dict, b: dict, tol_area_pct: float = 1.0, tol_p99: float = 0.02) -> bool:
    ok = True
    print(f"계산 결과   A: {a['solution']} ({a['runtime']})   B: {b['solution']} ({b['runtime']})")
    print(f"전체 체적오차 %  A: {a['vol_err_pct']:.3f}   B: {b['vol_err_pct']:.3f}")
    for area in sorted(set(a["vol2d"]) | set(b["vol2d"])):
        print(f"  2D {area:6s} 체적오차 %  A: {a['vol2d'].get(area, float('nan')):.3f}   B: {b['vol2d'].get(area, float('nan')):.3f}")

    ia, ib = inundation(a), inundation(b)
    for d in DEPTHS:
        pct = (ib[d] - ia[d]) / ia[d] * 100 if ia[d] else 0.0
        ok &= abs(pct) <= tol_area_pct
        print(f"침수면적 (수심 ≥ {d} m)  A {ia[d] / 1e6:.4f} km2 · B {ib[d] / 1e6:.4f} km2 · 차이 {pct:+.2f} %")

    for area in sorted(a["cells"]):
        g = a["geom"][area]
        real = np.isfinite(g["zmin"]) & (g["area"] > 0)
        d = np.abs(a["cells"][area] - b["cells"][area])[real]
        p99, p999 = np.percentile(d, 99), np.percentile(d, 99.9)
        ok &= p99 <= tol_p99
        print(f"2D {area:6s} 셀 최대수위 차이  99분위 {p99:.4f} m · 99.9분위 {p999:.4f} m · "
              f"0.05 m 초과 {int(np.sum(d > 0.05))}셀 / {int(real.sum())} · 최대 {d.max():.3f} m")

    dws = np.nanmax(np.abs(a["xs_ws"] - b["xs_ws"]))
    dq = np.nanmax(np.abs(a["xs_q"] - b["xs_q"]))
    print(f"하천 단면 최대수위 차이 최대 {dws:.4f} m · 최대유량 차이 최대 {dq:.2f} m3/s")

    for name in sorted(a["lat"]):
        la, lb = a["lat"][name], b["lat"].get(name, {"peak": np.nan, "net_m3": np.nan})
        flip = np.sign(la["net_m3"]) != np.sign(lb["net_m3"])
        note = "  ← 순 월류 방향이 바뀜: 불안정 의심" if flip else ""
        print(f"측방 구조물 {name}: 첨두 A {la['peak']:.1f} · B {lb['peak']:.1f} m3/s · "
              f"순 월류 체적 A {la['net_m3'] / 1e3:.1f} · B {lb['net_m3'] / 1e3:.1f} 천 m3{note}")

    print("판정:", f"같음 (침수면적 ±{tol_area_pct}% · 99분위 {tol_p99} m 이내)" if ok else "다름 — 원인 확인 필요")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--a", required=True, help="기준 결과 (원본) p##.hdf")
    ap.add_argument("--b", required=True, help="비교 결과 (새로 계산) p##.hdf")
    ap.add_argument("--tol-area", type=float, default=1.0, help="침수면적 허용 차이 %% (기본 1.0)")
    ap.add_argument("--tol-p99", type=float, default=0.02, help="셀 최대수위 차이 99분위 허용값 m (기본 0.02)")
    args = ap.parse_args()
    raise SystemExit(0 if compare(load(args.a), load(args.b), args.tol_area, args.tol_p99) else 1)


if __name__ == "__main__":
    main()
