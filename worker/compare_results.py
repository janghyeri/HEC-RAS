"""두 HEC-RAS 결과(p##.hdf)가 같은지 확인 — 기준 파일 재현성 검사 (작업 진행 가이드 Step 1-3, Step 5).

비교 항목
  - 2D 영역별 셀 최대 수위 차이 (최대·평균 절대값)
  - 하천 단면 최대 수위·최대 유량 차이
  - 측방 구조물 최대 월류량
  - 전체·2D 영역별 체적오차, 계산 성공 여부·계산 시간

사용 예
  python compare_results.py --a C:\\Hec-Ras\\KNUWATER\\Pohang\\NC090902\\NC090902.p03.hdf ^
                            --b C:\\Hec-Ras\\HECRASMCP\\Pohang_web\\NC090902\\NC090902.p03.hdf
"""
from __future__ import annotations

import argparse

import h5py
import numpy as np

BASE = "/Results/Unsteady/Output/Output Blocks/Base Output"
SUMMARY = "/Results/Unsteady/Summary"


def _attrs(h, path):
    return {k: (v.decode() if isinstance(v, bytes) else v) for k, v in h[path].attrs.items()}


def load(path: str) -> dict:
    out = {"cells": {}, "lat": {}}
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
            if key in h:
                out["cells"][area] = h[key][()][0].astype(float)
        xs = BASE + "/Summary Output/Cross Sections"
        out["xs_ws"] = h[xs + "/Maximum Water Surface"][()][0].astype(float)
        out["xs_q"] = h[xs + "/Maximum Flow"][()][0].astype(float)
        ls = BASE + "/Unsteady Time Series/Lateral Structures"
        if ls in h:
            for name in h[ls].keys():
                out["lat"][name] = float(np.nanmax(h[f"{ls}/{name}/Structure Variables"][()][:, 0]))
    return out


def compare(a: dict, b: dict, tol_ws: float = 0.01) -> bool:
    ok = True
    print(f"계산 결과   A: {a['solution']} ({a['runtime']})   B: {b['solution']} ({b['runtime']})")
    print(f"전체 체적오차 %  A: {a['vol_err_pct']:.3f}   B: {b['vol_err_pct']:.3f}")
    for area in sorted(set(a["vol2d"]) | set(b["vol2d"])):
        print(f"  2D {area:6s} 체적오차 %  A: {a['vol2d'].get(area, float('nan')):.3f}   B: {b['vol2d'].get(area, float('nan')):.3f}")
    for area in sorted(a["cells"]):
        d = np.abs(a["cells"][area] - b["cells"][area])
        d = d[np.isfinite(d)]
        flag = "OK" if d.max() <= tol_ws else "차이 있음"
        ok &= d.max() <= tol_ws
        print(f"2D {area:6s} 셀 최대수위 차이  최대 {d.max():.4f} m · 평균 {d.mean():.5f} m · {flag}")
    dws = np.nanmax(np.abs(a["xs_ws"] - b["xs_ws"]))
    dq = np.nanmax(np.abs(a["xs_q"] - b["xs_q"]))
    ok &= dws <= tol_ws
    print(f"하천 단면 최대수위 차이 최대 {dws:.4f} m · 최대유량 차이 최대 {dq:.2f} m3/s")
    for name in sorted(a["lat"]):
        print(f"측방 구조물 {name}: 최대 월류 A {a['lat'][name]:.2f} · B {b['lat'].get(name, float('nan')):.2f} m3/s")
    print("판정:", "같음 (허용오차 %.3f m 이내)" % tol_ws if ok else "다름 — 원인 확인 필요")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--a", required=True, help="기준 결과 (원본) p##.hdf")
    ap.add_argument("--b", required=True, help="비교 결과 (새로 계산) p##.hdf")
    ap.add_argument("--tol", type=float, default=0.01, help="수위 허용오차 m (기본 0.01)")
    args = ap.parse_args()
    raise SystemExit(0 if compare(load(args.a), load(args.b), args.tol) else 1)


if __name__ == "__main__":
    main()
