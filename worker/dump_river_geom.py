"""하천(1D) 지도 그리기에 필요한 자료를 HEC-RAS 결과 HDF에서 꺼내 npz로 저장 (워커 PC에서 실행).

지금 웹 지도는 2D 셀 결과만 그려서 냉천 하천(1D 단면) 구간이 비어 보인다. 하천 수면을 지도에 그리려면
단면 위치(절단선)·단면 지형·제방(측방 구조물) 위치와 단면 수위가 필요하다. 이 스크립트는 그 자료를
가공 없이 그대로 꺼낸다 (가공은 pipeline/river_map.py).

꺼내는 것 (그룹 바로 아래 데이터셋만, 2D 셀 자료는 빼고)
  /Geometry/Cross Sections/*            단면 이름·절단선·지형(Station-Elevation)·제방 위치 등
  /Geometry/River Centerlines/*         하천 중심선
  /Geometry/Structures/*                측방 구조물 위치·높이
  /Geometry/2D Flow Areas/*             2D 영역 경계(다각형)·이름 — 영역별 셀 자료는 제외
  /Results/Unsteady/Geometry Info/Cross Section Attributes
  .../Summary Output/Cross Sections/*   단면 최대 수위·유량
  .../Unsteady Time Series/Cross Sections/Water Surface, Flow
  .../Unsteady Time Series/Time Date Stamp
  (--terrain) 2 m 지형 전체 + 좌표 (float32, 압축)

사용 예 (code 폴더에서)
  python -m worker.dump_river_geom --out C:\\Hec-Ras\\HECRASMCP\\dump --terrain <Terrain.all.tif> S0-C=<p03.hdf> S0-E=<p03.hdf>
  출력: <out>/river_<이름>.npz, <out>/river_<이름>.json (데이터셋 목록·속성), <out>/terrain.npz
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

OUT = "/Results/Unsteady/Output/Output Blocks/Base Output"
GROUPS = ["/Geometry/Cross Sections", "/Geometry/River Centerlines", "/Geometry/Structures",
          "/Geometry/2D Flow Areas", f"{OUT}/Summary Output/Cross Sections"]
DATASETS = ["/Results/Unsteady/Geometry Info/Cross Section Attributes",
            f"{OUT}/Unsteady Time Series/Cross Sections/Water Surface",
            f"{OUT}/Unsteady Time Series/Cross Sections/Flow",
            f"{OUT}/Unsteady Time Series/Time Date Stamp"]


def _jsonable(v):
    if isinstance(v, bytes):
        return v.decode("latin-1", "replace")
    if isinstance(v, np.ndarray):
        return [_jsonable(x) for x in v.tolist()] if v.dtype.kind in "SOU" else v.tolist()
    if isinstance(v, (np.generic,)):
        return v.item()
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    return v


def dump_hdf(name: str, hdf: Path, out: Path) -> dict:
    import h5py

    arrays, listing = {}, {"hdf": str(hdf), "datasets": {}, "skipped": []}

    def take(path: str, ds) -> None:
        arr = ds[()]
        if isinstance(arr, np.ndarray) and arr.dtype.hasobject:      # 가변 길이 문자열 → JSON으로
            listing["datasets"][path] = {"shape": list(arr.shape), "dtype": str(arr.dtype),
                                         "attrs": {k: _jsonable(v) for k, v in ds.attrs.items()},
                                         "values": _jsonable(arr)}
            return
        arrays[path.replace("/", "|")] = np.asarray(arr)
        listing["datasets"][path] = {"shape": list(np.shape(arr)), "dtype": str(np.asarray(arr).dtype),
                                     "attrs": {k: _jsonable(v) for k, v in ds.attrs.items()}}

    with h5py.File(hdf, "r") as h:
        for g in GROUPS:
            if g not in h:
                listing["skipped"].append(g)
                continue
            listing.setdefault("group_attrs", {})[g] = {k: _jsonable(v) for k, v in h[g].attrs.items()}
            for k, obj in h[g].items():
                if isinstance(obj, h5py.Dataset):
                    take(f"{g}/{k}", obj)
        for p in DATASETS:
            if p in h:
                take(p, h[p])
            else:
                listing["skipped"].append(p)
        listing["root_attrs"] = {k: _jsonable(v) for k, v in h["/"].attrs.items()}

    np.savez_compressed(out / f"river_{name}.npz", **arrays)
    (out / f"river_{name}.json").write_text(json.dumps(listing, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"name": name, "arrays": len(arrays), "skipped": listing["skipped"]}


def dump_terrain(path: Path, out: Path) -> dict:
    from pipeline.raster_depth import read_terrain

    t = read_terrain(str(path))
    np.savez_compressed(out / "terrain.npz", z=t.z.astype(np.float32),
                        transform=np.array([t.x0, t.y0, t.dx, t.dy], dtype=np.float64))
    return {"shape": list(t.z.shape), "x0": t.x0, "y0": t.y0, "dx": t.dx, "dy": t.dy}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--terrain", default=None, help="Terrain.all.tif (주면 terrain.npz도 만든다)")
    ap.add_argument("items", nargs="+", help="이름=결과 HDF 경로 (예: S0-C=C:\\...\\NC090902.p03.hdf)")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    report = {}
    if a.terrain:
        report["terrain"] = dump_terrain(Path(a.terrain), out)
        print("지형:", report["terrain"], flush=True)
    for it in a.items:
        name, _, path = it.partition("=")
        p = Path(path)
        if not p.exists():
            print(f"건너뜀 (파일 없음): {name} {p}", flush=True)
            report[name] = {"error": "파일 없음", "path": str(p)}
            continue
        try:
            report[name] = dump_hdf(name, p, out)
        except Exception as e:  # 하나가 실패해도 나머지는 계속
            report[name] = {"error": f"{type(e).__name__}: {e}", "path": str(p)}
        print(name, report[name], flush=True)
    (out / "dump_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
