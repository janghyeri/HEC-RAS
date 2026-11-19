"""침수 건물 수 KPI (buildings.json) — 건물 외곽선 × 최대 수심.

정의 (docs/GUIDE.md §4.4.1 침수 기준 수심과 같게):
  침수 건물 = 건물 외곽선 안 화소(2 m 경위도 격자, 화소 중심이 외곽선 안)의 최대 수심 ≥ 0.1 m (0.5·1.0 m도 함께)
  - 수심: depth2m/max.png (8비트 회색조 × 0.02 m, 경사 수면, 2 m 지형 기준) — 결과마다 frames_web.py가 만든다
  - 계산 범위: 외곽선 안 화소가 2D 계산 범위(area2d_2m.png, 255 = 2D 셀 안)에 하나라도 걸친 건물만
  - 외곽선 안에 화소 중심이 하나도 없는 작은 건물은 건물 중심(바깥 고리 꼭짓점 평균)이 든 화소 하나로 본다
  - ring_check(참고): 3D '물 높이' 보기와 같은 방식 — 첫 외곽선 꼭짓점(최대 16개)을 건물 중심에서 3 m 바깥으로 민 점의 최대 수심
  - 건물: 국토교통부 GIS건물통합정보(브이월드 데이터 API LT_C_BLDGINFO). 2022-09-06 이후 사용승인 건물은 받을 때 뺐다.
    받은 자료는 pipeline/data/buildings_<버전>.json.gz (형식은 load_buildings 설명). 브라우저에서 3D 화면(buildings.js)과
    같은 타일·같은 규칙으로 받았다 — 2026-11-17 브라우저 계산값과는 자료 갱신·경계 화소 차이로 ±2동 다를 수 있어
    게시 결과 4개도 이 스크립트로 다시 계산했다 (2026-11-19)

사용:
  python -m pipeline.buildings_kpi --result-dir <결과 폴더> [--scenario run-1]
  (결과 폴더 = depth2m/frames.json·max.png가 있는 곳. 모형 버전 기본 v1,
   계산 범위 이미지 기본 pipeline/data/area2d_2m_<버전>.png → 없으면 web/public/data/<버전>/area2d_2m.png)
  python -m pipeline.buildings_kpi --check     # 게시된 결과 4개의 buildings.json과 같은지 대조
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "pipeline" / "data"
WEB_DATA = REPO / "web" / "public" / "data"

STEP_M = 0.02                      # depth2m 회색조 1단계 (frames_web.py와 같음)
THRESHOLDS = (0.1, 0.5, 1.0)       # m
RING_OUT_M = 3.0                   # buildings.js FLOOD_OUT
RING_MAX = 16                      # buildings.js floodSamples: 꼭짓점 최대 16개
M_PER_DEG_LAT = 110540.0           # buildings.js와 같은 값
M_PER_DEG_LON_EQ = 111320.0

# 주용도코드 → 묶음 (분석 화면 표의 '용도별'). 03000·04000 등 근린생활은 상가·업무로
USE_GROUPS = [
    ("주택", {"01000"}),
    ("공동주택", {"02000"}),
    ("상가·업무", {"03000", "04000", "07000", "14000", "15000", "16000"}),
    ("공장·창고", {"17000", "18000", "19000", "20000", "21000", "22000"}),
]
OTHER = "그 밖"
USE_GROUPS_NOTE = ("주택 01000 · 공동주택 02000 · 상가·업무 03000/04000/07000/14000/15000/16000 · "
                   "공장·창고 17000–22000 · 그 밖(공공·교육·부속 건물·용도 없음 등)")


def gray_threshold(m: float) -> int:
    """수심 m 이상 = 회색조 값 이상 (0.1 m → 5)"""
    return int(math.ceil(round(m / STEP_M, 6)))


def use_group(code: str) -> str:
    for name, codes in USE_GROUPS:
        if code in codes:
            return name
    return OTHER


# ---------------------------------------------------------------- 건물 자료
def load_buildings(path: Path) -> dict:
    """buildings_<버전>.json.gz:
    {"origin_e6": [x0, y0], "codes": [주용도코드...], "buildings": [[코드 번호, 다각형들], ...], ...}
    다각형 = 고리들, 고리 = [x, y, dx, dy, dx, dy, ...] (1e-6도 정수, 첫 점은 origin 기준, 이후는 앞 점과의 차이,
    닫는 점(첫 점 반복)은 뺌). 반환: buildings 목록 [{"code", "polys": [[ring ndarray(N,2) 경위도]]}]"""
    with gzip.open(path, "rt", encoding="utf-8") as f:
        d = json.load(f)
    x0, y0 = d["origin_e6"]
    out = []
    for ci, polys in d["buildings"]:
        pp = []
        for poly in polys:
            rings = []
            for flat in poly:
                a = np.asarray(flat, dtype=np.int64).reshape(-1, 2)
                a = np.cumsum(a, axis=0)
                a[:, 0] += x0
                a[:, 1] += y0
                rings.append(a / 1e6)
            pp.append(rings)
        out.append({"code": d["codes"][ci], "polys": pp})
    d["list"] = out
    return d


# ---------------------------------------------------------------- 격자
class Grid:
    def __init__(self, info: dict):
        self.w, self.s, self.e, self.n = (float(v) for v in info["bounds"])
        self.W, self.H = int(info["width"]), int(info["height"])
        self.dx = (self.e - self.w) / self.W
        self.dy = (self.n - self.s) / self.H

    def same(self, other: "Grid") -> bool:
        return (self.W, self.H) == (other.W, other.H) and np.allclose(
            [self.w, self.s, self.e, self.n], [other.w, other.s, other.e, other.n], atol=1e-9)

    def pixel_of(self, lon: float, lat: float) -> tuple[int, int] | None:
        i = math.floor((lon - self.w) / self.dx)
        j = math.floor((self.n - lat) / self.dy)
        if 0 <= i < self.W and 0 <= j < self.H:
            return i, j
        return None


def _inside_even_odd(px: np.ndarray, py: np.ndarray, rings: list[np.ndarray]) -> np.ndarray:
    """점들(px, py)이 고리들(바깥+구멍) 안인지 — 짝홀 규칙"""
    inside = np.zeros(px.shape, dtype=bool)
    for r in rings:
        xs, ys = r[:, 0], r[:, 1]
        x1, y1 = xs, ys
        x2, y2 = np.roll(xs, -1), np.roll(ys, -1)
        for k in range(len(xs)):
            ya, yb = y1[k], y2[k]
            if ya == yb:
                continue
            cond = (ya > py) != (yb > py)
            if not cond.any():
                continue
            xint = x1[k] + (py - ya) * (x2[k] - x1[k]) / (yb - ya)
            inside ^= cond & (px < xint)
    return inside


def interior_pixels(g: Grid, polys: list[list[np.ndarray]]) -> np.ndarray:
    """외곽선 안 화소 (화소 중심 기준) → 1차원 번호 j*W+i. 다각형 여러 개는 합집합"""
    found = []
    for rings in polys:
        outer = rings[0]
        lon0, lat0 = outer[:, 0].min(), outer[:, 1].min()
        lon1, lat1 = outer[:, 0].max(), outer[:, 1].max()
        i0 = max(0, math.floor((lon0 - g.w) / g.dx - 0.5))
        i1 = min(g.W - 1, math.ceil((lon1 - g.w) / g.dx - 0.5))
        j0 = max(0, math.floor((g.n - lat1) / g.dy - 0.5))
        j1 = min(g.H - 1, math.ceil((g.n - lat0) / g.dy - 0.5))
        if i1 < i0 or j1 < j0:
            continue
        ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
        cx = g.w + (ii + 0.5) * g.dx
        cy = g.n - (jj + 0.5) * g.dy
        m = _inside_even_odd(cx, cy, rings)
        if m.any():
            found.append((jj[m] * g.W + ii[m]).ravel())
    if not found:
        return np.zeros(0, dtype=np.int64)
    return np.unique(np.concatenate(found))


def centroid(polys: list[list[np.ndarray]]) -> tuple[float, float]:
    """buildings.js와 같게: 모든 다각형 바깥 고리 꼭짓점 평균 (닫는 점 포함 — GeoJSON 고리는 첫 점이 끝에 한 번 더 있음)"""
    sx = sy = 0.0
    n = 0
    for rings in polys:
        r = rings[0]
        sx += float(r[:, 0].sum()) + float(r[0, 0])
        sy += float(r[:, 1].sum()) + float(r[0, 1])
        n += len(r) + 1
    return sx / n, sy / n


def ring_samples(polys: list[list[np.ndarray]], c: tuple[float, float]) -> list[tuple[float, float]]:
    """buildings.js floodSamples와 같은 점: 첫 다각형 바깥 고리(닫는 점 포함) 꼭짓점을 중심에서 3 m 바깥으로"""
    r = polys[0][0]
    ring = np.vstack([r, r[:1]])
    n = len(ring)
    cx, cy = c
    kx = M_PER_DEG_LON_EQ * math.cos(math.radians(cy))
    step = max(1, math.ceil(n / RING_MAX))
    out = []
    for i in range(0, n, step):
        dx = (ring[i, 0] - cx) * kx
        dy = (ring[i, 1] - cy) * M_PER_DEG_LAT
        L = math.hypot(dx, dy) or 1.0
        out.append((ring[i, 0] + (dx / L) * RING_OUT_M / kx, ring[i, 1] + (dy / L) * RING_OUT_M / M_PER_DEG_LAT))
    return out


# ---------------------------------------------------------------- 건물별 화소 (결과와 무관 — 한 번 만들어 둔다)
def prepare(bld: dict, g: Grid, mask: np.ndarray) -> dict:
    """계산 범위 안 건물마다 외곽선 안 화소·둘레 점 화소. 결과(수심)와 무관하므로 결과 여러 개에 다시 쓴다"""
    flat_mask = mask.ravel() > 0
    keep = []
    for b in bld["list"]:
        px = interior_pixels(g, b["polys"])
        c = centroid(b["polys"])
        if px.size == 0:
            p = g.pixel_of(*c)
            if p is None:
                continue
            px = np.array([p[1] * g.W + p[0]], dtype=np.int64)
        if not flat_mask[px].any():
            continue
        rs = []
        for lon, lat in ring_samples(b["polys"], c):
            p = g.pixel_of(lon, lat)
            if p is not None:
                rs.append(p[1] * g.W + p[0])
        keep.append({"group": use_group(b["code"]), "px": px, "ring": np.array(rs, dtype=np.int64)})
    return {"grid": g, "list": keep}


def compute(prep: dict, depth: np.ndarray) -> dict:
    """depth: depth2m/max.png 회색조 배열 (H, W)"""
    g: Grid = prep["grid"]
    if depth.shape != (g.H, g.W):
        raise ValueError(f"수심 이미지 크기 {depth.shape[::-1]}가 격자 {g.W}×{g.H}와 다름")
    flat = depth.ravel()
    th = {f"ge_{m}m": gray_threshold(m) for m in THRESHOLDS}
    flooded = {k: 0 for k in th}
    ring = {k: 0 for k in th}
    groups = {name: {"use": name, "total": 0, "flooded_ge_0.1m": 0, "flooded_ge_0.5m": 0}
              for name in [n for n, _ in USE_GROUPS] + [OTHER]}
    for b in prep["list"]:
        dmax = int(flat[b["px"]].max())
        rmax = int(flat[b["ring"]].max()) if b["ring"].size else 0
        gr = groups[b["group"]]
        gr["total"] += 1
        for k, t in th.items():
            if dmax >= t:
                flooded[k] += 1
                if k in ("ge_0.1m", "ge_0.5m"):
                    gr[f"flooded_{k}"] += 1
            if rmax >= t:
                ring[k] += 1
    return {"buildings_in_domain": len(prep["list"]), "flooded": flooded, "ring_check": ring,
            "by_use": list(groups.values())}


def building_json(res: dict, bld: dict, version: str, scenario: str, depth_generated_at: str | None) -> dict:
    return {
        "model_version": version,
        "scenario_id": scenario,
        "definition": "침수 건물 = 건물 외곽선 안 최대 수심 ≥ 기준 (docs/GUIDE.md §4.4.1). 수심은 depth2m/max.png "
                      "(2 m 경위도 격자, 경사 수면, 2 m 지형 기준, 0.02 m 단위)",
        "domain": "건물 외곽선 안 화소가 2D 계산 범위(area2d_2m.png)에 걸친 건물만",
        "source": "국토교통부 GIS건물통합정보 (브이월드 데이터 API LT_C_BLDGINFO, 2026-11-19 받음), "
                  f"2022-09-06 이후 사용승인 건물 {bld.get('excluded_after_flood_day', '?')}동 제외",
        "buildings_in_domain": res["buildings_in_domain"],
        "flooded": res["flooded"],
        "ring_check": {"note": "외곽선 꼭짓점에서 3 m 바깥 최대 수심 기준 (3D 물 높이 보기와 같은 방식) — 참고",
                       **res["ring_check"]},
        "by_use": res["by_use"],
        "use_groups": USE_GROUPS_NOTE,
        "threshold_note": "기준 수심(0.1 m)은 침수면적 정의와 같게 둠 — 0.5 m(무릎)·1.0 m(허리)도 함께. 어느 쪽을 주 값으로 쓸지는 사용자 판단",
        "depth_generated_at": depth_generated_at,
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "computed_by": "pipeline/buildings_kpi.py",
    }


# ---------------------------------------------------------------- 진입점
def load_mask(version: str, mask_path: Path | None = None) -> tuple[Grid, np.ndarray]:
    """계산 범위 이미지. 계산 PC 코드 폴더에는 web/이 없어서 pipeline/data의 사본(area2d_2m_<버전>.png)을 먼저 본다"""
    if mask_path:
        mp = Path(mask_path)
    else:
        mp = DATA / f"area2d_2m_{version}.png"
        if not mp.exists():
            mp = WEB_DATA / version / "area2d_2m.png"
    info = json.loads(mp.with_suffix(".json").read_text(encoding="utf-8"))
    return Grid(info), np.asarray(Image.open(mp).convert("L"))


_PREP_CACHE: dict = {}


def prepared(version: str, mask_path: Path | None = None, bld_path: Path | None = None) -> tuple[dict, dict]:
    key = (version, str(mask_path), str(bld_path))
    if key not in _PREP_CACHE:
        g, mask = load_mask(version, mask_path)
        bld = load_buildings(Path(bld_path) if bld_path else DATA / f"buildings_{version}.json.gz")
        _PREP_CACHE[key] = (prepare(bld, g, mask), bld)
    return _PREP_CACHE[key]


def make_buildings(result_dir: Path, version: str, scenario: str, mask_path: Path | None = None,
                   bld_path: Path | None = None) -> dict:
    """결과 폴더(<...>/<버전>/<시나리오>)의 depth2m/max.png로 buildings.json을 만들고 내용을 돌려준다"""
    result_dir = Path(result_dir)
    fj = json.loads((result_dir / "depth2m" / "frames.json").read_text(encoding="utf-8"))
    prep, bld = prepared(version, mask_path, bld_path)
    if not prep["grid"].same(Grid(fj)):
        raise ValueError("depth2m 격자가 계산 범위 이미지(area2d_2m) 격자와 다름 — area_mask_web.py로 다시 만들 것")
    depth = np.asarray(Image.open(result_dir / fj["max"]["file"]).convert("L"))
    out = building_json(compute(prep, depth), bld, version, scenario, fj.get("generated_at"))
    (result_dir / "buildings.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def check(version: str = "v1") -> bool:
    """게시된 결과(web/public/data/<버전>/*/buildings.json)와 같은 숫자가 나오는지"""
    ok = True
    for bj in sorted((WEB_DATA / version).glob("*/buildings.json")):
        ref = json.loads(bj.read_text(encoding="utf-8"))
        rd = bj.parent
        fj = json.loads((rd / "depth2m" / "frames.json").read_text(encoding="utf-8"))
        prep, _ = prepared(version)
        depth = np.asarray(Image.open(rd / fj["max"]["file"]).convert("L"))
        res = compute(prep, depth)
        same = (res["buildings_in_domain"] == ref["buildings_in_domain"] and res["flooded"] == ref["flooded"]
                and all(res["ring_check"][k] == ref["ring_check"][k] for k in res["ring_check"])
                and res["by_use"] == ref["by_use"])
        ok &= same
        print(f"{rd.name:10s} {'같음' if same else '다름'}  범위 안 {res['buildings_in_domain']} (게시 {ref['buildings_in_domain']})  "
              f"침수 {res['flooded']} (게시 {ref['flooded']})  둘레 {res['ring_check']}")
        if not same:
            for a, b in zip(res["by_use"], ref["by_use"]):
                if a != b:
                    print("   용도", a, "게시", b)
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--result-dir", help="결과 폴더 (depth2m/frames.json·max.png가 있는 곳) — buildings.json을 여기에 씀")
    ap.add_argument("--scenario", help="시나리오 이름 (기본: 결과 폴더 이름)")
    ap.add_argument("--version", default="v1")
    ap.add_argument("--mask", help="계산 범위 이미지 (기본 web/public/data/<버전>/area2d_2m.png)")
    ap.add_argument("--buildings", help="건물 자료 (기본 pipeline/data/buildings_<버전>.json.gz)")
    ap.add_argument("--check", action="store_true", help="게시된 결과 buildings.json과 대조")
    a = ap.parse_args()
    if a.check:
        raise SystemExit(0 if check(a.version) else 1)
    if not a.result_dir:
        ap.error("--result-dir 또는 --check")
    rd = Path(a.result_dir)
    out = make_buildings(rd, a.version, a.scenario or rd.name, a.mask, a.buildings)
    print(json.dumps({k: out[k] for k in ("scenario_id", "buildings_in_domain", "flooded", "ring_check")},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
