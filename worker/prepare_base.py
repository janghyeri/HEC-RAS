"""웹 실행용 HEC-RAS 기준 파일(u01) 만들기 — 작업 진행 가이드 Step 1-3.

하는 일
  1. 지오메트리(g##)에 없는 위치를 가리키는 경계조건 블록을 u01에서 제거
     (예: 없는 2D BC Line, 없는 2D 영역/저류지). 실행 결과에는 영향이 없어야 한다.
  2. (--dss-to-table) DSS에 연결된 유량 경계조건을 u01 표(Use DSS=False)로 전환.
     값은 기존 결과 p##.hdf의 /Event Conditions 에서 읽는다 = 실제로 계산에 쓰인 값.
     표는 모의 시작 시각부터 시작(Use Fixed Start Time=False).

원본 u01은 <이름>.u01.orig 로 한 번만 백업한다. 결과를 HEC-RAS로 다시 돌려
기존 결과와 최대 수위·체적오차가 같은지 반드시 확인한다 (worker/compare_results.py).

사용 예 (Windows, Pohang_web 안에서)
  python prepare_base.py --project C:\\Hec-Ras\\HECRASMCP\\Pohang_web\\NC090901\\NC0909.prj
  python prepare_base.py --project C:\\Hec-Ras\\HECRASMCP\\Pohang_web\\NC090902\\NC090902.prj --dss-to-table
"""
from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path

import numpy as np

EC_FLOW = "/Event Conditions/Unsteady/Boundary Conditions/Flow Hydrographs"
END_OF_BC = ("Met Point Raster Parameters=", "Precipitation Mode=")


# ---------------------------------------------------------------- project files
def read_prj(prj: Path) -> dict:
    txt = prj.read_text(encoding="latin-1")
    cur = re.search(r"^Current Plan=(\w+)", txt, re.M).group(1)
    plan = prj.with_suffix("." + cur)
    ptxt = plan.read_text(encoding="latin-1")
    geom = re.search(r"^Geom File=(\w+)", ptxt, re.M).group(1)
    flow = re.search(r"^Flow File=(\w+)", ptxt, re.M).group(1)
    return {
        "plan": plan,
        "plan_hdf": Path(str(plan) + ".hdf"),
        "geom": prj.with_suffix("." + geom),
        "flow": prj.with_suffix("." + flow),
    }


def geometry_objects(geom: Path) -> dict:
    """g## 텍스트에서 2D 영역(저류지 포함)과 BC Line(이름 → 영역)을 읽는다."""
    areas, bclines = set(), set()
    name = None
    for line in geom.read_text(encoding="latin-1").splitlines():
        if line.startswith("Storage Area="):
            areas.add(line.split("=", 1)[1].split(",")[0].strip())
        elif line.startswith("BC Line Name="):
            name = line.split("=", 1)[1].strip()
        elif line.startswith("BC Line Storage Area=") and name is not None:
            bclines.add((line.split("=", 1)[1].strip(), name))
            name = None
    return {"areas": areas, "bclines": bclines}


# ---------------------------------------------------------------- u01 parsing
def split_u01(lines: list[str]):
    """u01을 [머리말, 경계조건 블록들, 꼬리말]로 나눈다."""
    first = next(i for i, l in enumerate(lines) if l.startswith("Boundary Location="))
    last = next(i for i, l in enumerate(lines) if i > first and l.startswith(END_OF_BC))
    head, body, tail = lines[:first], lines[first:last], lines[last:]
    blocks, cur = [], []
    for l in body:
        if l.startswith("Boundary Location=") and cur:
            blocks.append(cur)
            cur = []
        cur.append(l)
    if cur:
        blocks.append(cur)
    return head, blocks, tail


def block_location(block: list[str]) -> dict:
    f = [x.strip() for x in block[0].split("=", 1)[1].split(",")]
    f += [""] * (9 - len(f))
    return {"river": f[0], "reach": f[1], "rs": f[2], "sa": f[4], "area2d": f[5], "bcline": f[7]}


def is_orphan(loc: dict, geo: dict) -> bool:
    if loc["river"]:
        return False                      # 1D 경계조건은 그대로 둔다
    if loc["area2d"]:
        if loc["area2d"] not in geo["areas"]:
            return True
        return bool(loc["bcline"]) and (loc["area2d"], loc["bcline"]) not in geo["bclines"]
    if loc["sa"]:
        return loc["sa"] not in geo["areas"]
    return False


# ---------------------------------------------------------------- table writing
def fmt(v: float) -> str:
    """HEC-RAS 8칸 고정폭 값 (7자리 이내 + 앞 공백)."""
    if abs(v) < 5e-7:
        return "0".rjust(8)
    for d in range(6, -1, -1):
        s = f"{v:.{d}f}"
        if len(s) <= 7:
            s = s.rstrip("0").rstrip(".") if "." in s else s
            return s.rjust(8)
    return f"{v:.0f}".rjust(8)


def table_block(location_line: str, values: np.ndarray, interval: str) -> list[str]:
    out = [location_line, f"Interval={interval}", f"Flow Hydrograph= {len(values)} "]
    for i in range(0, len(values), 10):
        out.append("".join(fmt(v) for v in values[i:i + 10]))
    out += [
        "Stage Hydrograph TW Check=0",
        "Flow Hydrograph Slope= 0.005 ",
        "DSS Path=",
        "Use DSS=False",
        "Use Fixed Start Time=False",
        "Fixed Start Date/Time=,",
        "Is Critical Boundary=False",
        "Critical Boundary Flow=",
    ]
    return out


def interval_label(dt_days: float) -> str:
    minutes = round(dt_days * 1440)
    table = {1: "1MIN", 2: "2MIN", 5: "5MIN", 10: "10MIN", 15: "15MIN", 30: "30MIN", 60: "1HOUR"}
    if minutes not in table:
        raise ValueError(f"지원하지 않는 시간 간격: {minutes}분")
    return table[minutes]


def event_flows(plan_hdf: Path) -> dict:
    """p##.hdf Event Conditions의 2D BC Line 유량: {(영역, BC Line): (시간[일], 유량)}."""
    import h5py
    out = {}
    with h5py.File(plan_hdf, "r") as h:
        grp = h[EC_FLOW]
        for name in grp.keys():
            m = re.match(r"2D: (.+?) BCLine: (.+)$", name)
            if m:
                d = grp[name][()]
                out[(m.group(1).strip(), m.group(2).strip())] = (d[:, 0].astype(float), d[:, 1].astype(float))
    return out


# ---------------------------------------------------------------- main
def prepare(prj: Path, dss_to_table: bool, dry_run: bool = False) -> dict:
    files = read_prj(prj)
    geo = geometry_objects(files["geom"])
    raw = files["flow"].read_bytes().decode("latin-1")
    newline = "\r\n" if "\r\n" in raw else "\n"
    lines = raw.split(newline)
    head, blocks, tail = split_u01(lines)

    report = {"blocks_before": len(blocks), "removed": [], "converted": 0,
              "volume_hdf_m3": 0.0, "volume_table_m3": 0.0}

    # 머리말의 없는 저류지 초기수위 줄 제거
    kept_head = []
    for l in head:
        if l.startswith("Initial Storage Elev="):
            sa = l.split("=", 1)[1].split(",")[0].strip()
            if sa not in geo["areas"]:
                report["removed"].append(f"Initial Storage Elev ({sa})")
                continue
        kept_head.append(l)

    flows = event_flows(files["plan_hdf"]) if dss_to_table else {}
    new_blocks = []
    for b in blocks:
        loc = block_location(b)
        if is_orphan(loc, geo):
            report["removed"].append(f"{loc['area2d'] or loc['sa']}/{loc['bcline']}")
            continue
        uses_dss = any(l.strip() == "Use DSS=True" for l in b)
        if dss_to_table and uses_dss:
            key = (loc["area2d"], loc["bcline"])
            if key not in flows:
                raise KeyError(f"Event Conditions에 {key} 유량이 없습니다")
            t, q = flows[key]
            label = interval_label(float(np.median(np.diff(t))))
            new = table_block(b[0], q, label)
            q_tab = np.array([float(x) for row in new[3:3 + (len(q) + 9) // 10]
                              for x in row.split()])
            report["volume_hdf_m3"] += float(np.trapezoid(q, t * 86400))
            report["volume_table_m3"] += float(np.trapezoid(q_tab, t * 86400))
            report["converted"] += 1
            new_blocks.append(new)
        else:
            new_blocks.append(b)

    report["blocks_after"] = len(new_blocks)
    out_lines = kept_head + [l for b in new_blocks for l in b] + tail
    text = newline.join(out_lines)
    if not dry_run:
        backup = Path(str(files["flow"]) + ".orig")
        if not backup.exists():
            shutil.copy2(files["flow"], backup)
        files["flow"].write_bytes(text.encode("latin-1"))
    report["output"] = text
    return report


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True, type=Path, help="HEC-RAS .prj 경로")
    ap.add_argument("--dss-to-table", action="store_true", help="DSS 연결 유량을 u01 표로 전환")
    ap.add_argument("--dry-run", action="store_true", help="파일을 쓰지 않고 결과만 출력")
    a = ap.parse_args()
    r = prepare(a.project, a.dss_to_table, a.dry_run)
    print(f"경계조건 블록: {r['blocks_before']} → {r['blocks_after']}")
    print(f"제거: {len(r['removed'])}개")
    if a.dss_to_table:
        print(f"DSS → 표 전환: {r['converted']}개")
        print(f"총 유입 체적: HDF {r['volume_hdf_m3']:,.0f} m3 / 표 {r['volume_table_m3']:,.0f} m3")


if __name__ == "__main__":
    main()
