"""HEC-RAS 6.x 계획 결과 HDF(p##.hdf)에서 웹 변환에 필요한 값만 읽는다.

모형 값(셀 수, 시각, 경계 이름)은 모두 HDF에서 읽는다 — 코드에 박아 넣지 않는다 (모형 v1 → v2 교체 대비).
경로 근거: docs/GUIDE.md §4.3.2
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime

import h5py
import numpy as np

BASE = "/Results/Unsteady/Output/Output Blocks/Base Output"
TS = BASE + "/Unsteady Time Series"
SUM = BASE + "/Summary Output"
GEOM2D = "/Geometry/2D Flow Areas"
EC_FLOW = "/Event Conditions/Unsteady/Boundary Conditions/Flow Hydrographs"


def _s(v):
    return v.decode("latin-1").strip() if isinstance(v, (bytes, np.bytes_)) else v


def _attrs(h, path):
    return {k: _s(v) for k, v in h[path].attrs.items()}


def parse_ras_time(s: str) -> datetime:
    return datetime.strptime(_s(s), "%d%b%Y %H:%M:%S")


@dataclass
class Area2D:
    name: str
    n_cells: int                 # 실제 셀 수 (뒤쪽 가상 셀 제외)
    cell_area: np.ndarray        # (n,) m2
    zmin: np.ndarray             # (n,) 셀 최저 표고
    center: np.ndarray           # (n, 2) EPSG:5187
    facepoints: np.ndarray       # (m, 2) EPSG:5187
    cell_fp_index: np.ndarray    # (n, k) 면점 번호, -1 채움
    ve_info: np.ndarray          # (n, 2) 표고-체적 표 시작·개수
    ve_values: np.ndarray        # (*, 2) [표고, 체적]
    max_ws: np.ndarray           # (n,) 최대 수위
    ws_frames: np.ndarray        # (t, n) 출력 시각별 수위
    faces_fp: np.ndarray | None = None     # (nf, 2) 면 양 끝 면점 번호 (경사 수면 표현용, 없으면 None)
    faces_zmin: np.ndarray | None = None   # (nf,) 면 최저 표고


@dataclass
class PlanResult:
    path: str
    projection: str
    plan_title: str
    time_window: str
    times: list[datetime]
    areas: list[Area2D]
    summary: dict
    volume_error_pct: dict
    compute_tasks: dict
    xs_stations: list[str]
    xs_flow: np.ndarray          # (t, nxs)
    xs_ws: np.ndarray            # (t, nxs)
    xs_max_flow: np.ndarray = None   # (3, nxs) [최대 유량, 그때 수위, 시각(일)] — 계산 간격 기준 최댓값
    xs_max_ws: np.ndarray = None     # (3, nxs) [최고 수위, 그때 유량, 시각(일)]
    lateral: dict = field(default_factory=dict)       # 이름 → {'flow': (t,), 'area2d': str}
    bc_flows: dict = field(default_factory=dict)      # Event Conditions 유량 이름 → (시간[일], 유량)
    bc_lines: dict = field(default_factory=dict)      # (영역, 이름) → (x, y, 종류 External/Internal)


def _compute_tasks(h) -> dict:
    out = {}
    try:
        msg = _s(h["/Results/Summary/Compute Messages (text)"][()][0])
    except KeyError:
        return out
    for line in msg.splitlines():
        m = re.match(r"\s*(Completing Geometry, Flow and Plan|Preprocessing Geometry|Unsteady Flow Computations|"
                     r"Post-Processing|Generating Time Series Post Process|Complete Process)\s+([\d:]+)\s*$", line)
        if m:
            parts = [int(p) for p in m.group(2).split(":")]
            sec = 0
            for p in parts:
                sec = sec * 60 + p
            out[m.group(1)] = sec
    return out


def _face_zmin(h, g):
    """면 최저 표고: Faces Minimum Elevation, 없으면 면 표고-면적 표의 첫 표고."""
    if g + "/Faces Minimum Elevation" in h:
        return h[g + "/Faces Minimum Elevation"][()].astype(float)
    if g + "/Faces Area Elevation Info" in h and g + "/Faces Area Elevation Values" in h:
        info = h[g + "/Faces Area Elevation Info"][()]
        vals = h[g + "/Faces Area Elevation Values"][()]
        return vals[info[:, 0].astype(np.int64), 0].astype(float)
    return None


def read_plan(path: str) -> PlanResult:
    with h5py.File(path, "r") as h:
        root = _attrs(h, "/")
        info = _attrs(h, "/Plan Data/Plan Information")
        times = [parse_ras_time(t) for t in h[TS + "/Time Date Stamp"][()]]

        areas = []
        for name in [_s(n) for n in h[GEOM2D + "/Attributes"][()]["Name"]]:
            g = f"{GEOM2D}/{name}"
            zmin = h[g + "/Cells Minimum Elevation"][()].astype(float)
            n_real = int(np.sum(np.isfinite(zmin)))
            # 실제 셀이 앞쪽에 모여 있는지 확인 (HEC-RAS 규칙)
            assert np.all(np.isfinite(zmin[:n_real])), f"{name}: 실제 셀 순서가 예상과 다름"
            sl = slice(0, n_real)
            areas.append(Area2D(
                name=name,
                n_cells=n_real,
                cell_area=h[g + "/Cells Surface Area"][()][sl].astype(float),
                zmin=zmin[sl],
                center=h[g + "/Cells Center Coordinate"][()][sl],
                facepoints=h[g + "/FacePoints Coordinate"][()],
                cell_fp_index=h[g + "/Cells FacePoint Indexes"][()][sl],
                ve_info=h[g + "/Cells Volume Elevation Info"][()][sl],
                ve_values=h[g + "/Cells Volume Elevation Values"][()].astype(float),
                max_ws=h[f"{SUM}/2D Flow Areas/{name}/Maximum Water Surface"][()][0][sl].astype(float),
                ws_frames=h[f"{TS}/2D Flow Areas/{name}/Water Surface"][()][:, sl].astype(float),
                faces_fp=h[g + "/Faces FacePoint Indexes"][()] if g + "/Faces FacePoint Indexes" in h else None,
                faces_zmin=_face_zmin(h, g),
            ))

        summary = _attrs(h, "/Results/Unsteady/Summary")
        va = "/Results/Unsteady/Summary/Volume Accounting"
        vol = {"total": _attrs(h, va).get("Error Percent")}
        if va + "/Volume Accounting 2D" in h:
            for a in h[va + "/Volume Accounting 2D"].keys():
                vol[a] = _attrs(h, f"{va}/Volume Accounting 2D/{a}").get("Error Percent")

        xs_attr = h["/Results/Unsteady/Geometry Info/Cross Section Attributes"][()]
        stations = [_s(r["Station"]) for r in xs_attr]

        lateral = {}
        ls = TS + "/Lateral Structures"
        st_area = {}
        if "/Geometry/Structures/Attributes" in h:
            for r in h["/Geometry/Structures/Attributes"][()]:
                if _s(r["Type"]) == "Lateral":
                    st_area[f"{_s(r['River'])} {_s(r['Reach'])} {_s(r['RS'])}"] = _s(r["DS SA/2D"])
        if ls in h:
            for name in h[ls].keys():
                q = h[f"{ls}/{name}/Structure Variables"][()][:, 0].astype(float)
                lateral[name] = {"flow": q, "area2d": st_area.get(name, "")}

        bc_flows = {}
        if EC_FLOW in h:
            for name in h[EC_FLOW].keys():
                d = h[f"{EC_FLOW}/{name}"][()]
                bc_flows[name] = (d[:, 0].astype(float), d[:, 1].astype(float))

        bc_lines = {}
        bl = "/Geometry/Boundary Condition Lines"
        if bl + "/Attributes" in h:
            attrs = h[bl + "/Attributes"][()]
            pinfo = h[bl + "/Polyline Info"][()]
            pts = h[bl + "/Polyline Points"][()]
            for r, (start, count, *_rest) in zip(attrs, pinfo):
                seg = pts[start:start + count]
                x, y = seg.mean(axis=0)
                bc_lines[(_s(r["SA-2D"]), _s(r["Name"]))] = (float(x), float(y), _s(r["Type"]))

        return PlanResult(
            path=path,
            projection=_s(root.get("Projection", "")),
            plan_title=info.get("Plan Title", ""),
            time_window=info.get("Time Window", ""),
            times=times,
            areas=areas,
            summary=summary,
            volume_error_pct=vol,
            compute_tasks=_compute_tasks(h),
            xs_stations=stations,
            xs_flow=h[TS + "/Cross Sections/Flow"][()].astype(float),
            xs_ws=h[TS + "/Cross Sections/Water Surface"][()].astype(float),
            xs_max_flow=h[SUM + "/Cross Sections/Maximum Flow"][()].astype(float),
            xs_max_ws=h[SUM + "/Cross Sections/Maximum Water Surface"][()].astype(float),
            lateral=lateral,
            bc_flows=bc_flows,
            bc_lines=bc_lines,
        )
