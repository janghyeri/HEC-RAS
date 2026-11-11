"""행정구역(시군구·읍면동) 경계선과 이름 자리 — 2D 지도·3D 화면에서 '어느 동네인지' 구별해 보이기용.

원자료: 통계청 통계지리정보서비스(SGIS) 행정동 경계를 vuski/admdongkor가 가공한 GeoJSON
  (https://github.com/vuski/admdongkor, ver20220701/HangJeongDong_ver20220701.geojson — 힌남노(2022-09-06) 당시 행정동)
  공공누리 제1유형(출처표시) + CC BY 4.0 → 화면과 문서에 출처를 표시한다. 원자료(전국 34 MB)는 저장소에 넣지 않는다.

출력: web/public/data/admin/boundaries.geojson
  LineString  kind=boundary, level=sgg(시군구 경계) | emd(같은 시군구 안 읍면동 경계)   — 바닷가 선은 뺀다
  Point       kind=label,    level=sgg | emd, name, sgg   — 이름을 놓을 자리 (다각형 안쪽, 가장자리에서 먼 곳)

계산: 이웃 행정동이 꼭짓점을 공유하므로(2022-07 자료에서 확인, 바닷가 말고는 모두 두 동이 공유) 변을 두 동 쌍으로 묶어
한 번씩만 선으로 낸다 → 두 동 경계가 겹쳐 두 줄로 보이지 않는다.

사용: python -m pipeline.admin_web --src HangJeongDong_ver20220701.geojson --out web/public/data/admin/boundaries.geojson
"""
from __future__ import annotations

import argparse
import json
import math
import re
from collections import defaultdict
from pathlib import Path

BBOX = (129.22, 35.83, 129.62, 36.14)       # 서, 남, 동, 북 — 냉천 모형 범위보다 넉넉히 (포항 남·북구, 경주 일부)
SOURCE = ("통계청 통계지리정보서비스(SGIS) 행정동 경계(2022-07-01 기준, 공공누리 제1유형)를 vuski/admdongkor가 가공한 자료 "
          "(CC BY 4.0, https://github.com/vuski/admdongkor)")


def polygons(geom) -> list:
    return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def sgg_label(s: str) -> str:
    """'포항시남구' → '포항시 남구'"""
    m = re.match(r"^(.+시)(.+구)$", s)
    return f"{m.group(1)} {m.group(2)}" if m else s


def ring_area(r) -> float:
    return 0.5 * sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(r[:-1], r[1:]))


def inside(pt, poly) -> bool:
    x, y = pt
    ins = False
    for r in poly:
        for (x0, y0), (x1, y1) in zip(r[:-1], r[1:]):
            if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
                ins = not ins
    return ins


def _seg_dist(p, a, b, kx) -> float:
    ax, ay, bx, by, px, py = a[0] * kx, a[1], b[0] * kx, b[1], p[0] * kx, p[1]
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def label_point(poly, n: int = 24) -> tuple[float, float]:
    """다각형 안쪽에서 가장자리와 가장 먼 점 (격자 두 번 탐색 — 이름 자리용이라 대략이면 충분)."""
    kx = math.cos(math.radians(poly[0][0][1]))
    xs = [p[0] for p in poly[0]]
    ys = [p[1] for p in poly[0]]
    box = (min(xs), min(ys), max(xs), max(ys))
    best, bd = None, -1.0
    for _ in range(2):
        w, s, e, nn = box
        for i in range(n):
            for j in range(n):
                p = (w + (i + 0.5) * (e - w) / n, s + (j + 0.5) * (nn - s) / n)
                if not inside(p, poly):
                    continue
                d = min(_seg_dist(p, a, b, kx) for r in poly for a, b in zip(r[:-1], r[1:]))
                if d > bd:
                    best, bd = p, d
        if best is None:
            break
        hw, hh = (box[2] - box[0]) / n * 2, (box[3] - box[1]) / n * 2
        box = (best[0] - hw, best[1] - hh, best[0] + hw, best[1] + hh)
    if best is None:                       # 아주 가는 모양 — 첫 꼭짓점들 평균
        best = (sum(xs) / len(xs), sum(ys) / len(ys))
    return best


def chains(segs: list[tuple]) -> list[list]:
    """선분 목록 → 이어진 꺾은선들."""
    adj = defaultdict(list)
    for k, (a, b) in enumerate(segs):
        adj[a].append(k)
        adj[b].append(k)
    used = [False] * len(segs)
    out = []
    starts = [v for v, ks in adj.items() if len(ks) != 2] + list(adj.keys())   # 끝점부터, 남은 것은 고리
    for v0 in starts:
        for k0 in adj[v0]:
            if used[k0]:
                continue
            line, v, k = [v0], v0, k0
            while k is not None:
                used[k] = True
                a, b = segs[k]
                v = b if a == v else a
                line.append(v)
                nxt = [kk for kk in adj[v] if not used[kk]]
                k = nxt[0] if len(adj[v]) == 2 and nxt else None
            out.append(line)
    return out


def build(src: Path, bbox=BBOX) -> dict:
    g = json.loads(src.read_text(encoding="utf-8"))
    feats = []
    for f in g["features"]:
        polys = polygons(f["geometry"])
        if any(bbox[0] < x < bbox[2] and bbox[1] < y < bbox[3] for poly in polys for r in poly for x, y in r):
            feats.append(f)
    owners = defaultdict(set)
    for k, f in enumerate(feats):
        for poly in polygons(f["geometry"]):
            for r in poly:
                pts = [(round(x, 7), round(y, 7)) for x, y in r]
                for a, b in zip(pts[:-1], pts[1:]):
                    if a != b:
                        owners[(a, b) if a < b else (b, a)].add(k)
    groups = defaultdict(list)
    for seg, own in owners.items():
        if len(own) == 2:
            groups[tuple(sorted(own))].append(seg)
    out, n_shared = [], 0
    sgg_of = [f["properties"]["sggnm"] for f in feats]
    for (i, j), segs in groups.items():
        level = "sgg" if sgg_of[i] != sgg_of[j] else "emd"
        n_shared += len(segs)
        for line in chains(segs):
            out.append({"type": "Feature", "properties": {"kind": "boundary", "level": level},
                        "geometry": {"type": "LineString", "coordinates": [[round(x, 6), round(y, 6)] for x, y in line]}})
    # 이름 자리: 읍면동 = 가장 큰 조각 안, 시군구 = 그 시군구에서 가장 넓은 동의 자리 대신 면적 가중 중심에 가장 가까운 동 이름 자리
    by_sgg = defaultdict(list)
    for f in feats:
        p = f["properties"]
        poly = max(polygons(f["geometry"]), key=lambda pp: abs(ring_area(pp[0])))
        lp = label_point(poly)
        area = sum(abs(ring_area(pp[0])) for pp in polygons(f["geometry"]))
        name = p["adm_nm"].split()[-1]
        out.append({"type": "Feature", "properties": {"kind": "label", "level": "emd", "name": name,
                                                      "sgg": sgg_label(p["sggnm"]), "code": p.get("adm_cd2")},
                    "geometry": {"type": "Point", "coordinates": [round(lp[0], 6), round(lp[1], 6)]}})
        by_sgg[p["sggnm"]].append((area, lp, poly))
    for s, items in by_sgg.items():
        tot = sum(a for a, _, _ in items)
        cx = sum(a * lp[0] for a, lp, _ in items) / tot
        cy = sum(a * lp[1] for a, lp, _ in items) / tot
        _, lp, _ = min(items, key=lambda it: (it[1][0] - cx) ** 2 + (it[1][1] - cy) ** 2)
        # 동 이름과 겹치지 않게 조금 위(북쪽)로
        out.append({"type": "Feature", "properties": {"kind": "label", "level": "sgg", "name": sgg_label(s)},
                    "geometry": {"type": "Point", "coordinates": [round(lp[0], 6), round(lp[1] + 0.004, 6)]}})
    single = sum(1 for own in owners.values() if len(own) == 1)
    return {"type": "FeatureCollection",
            "source": SOURCE,
            "bbox_select": list(bbox),
            "check": {"features": len(feats), "edges_shared_by_two": n_shared, "edges_single": single,
                      "note": "한 동만 쓰는 변 = 바닷가·선택 범위 바깥쪽 (선으로 내지 않음)"},
            "features": out}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    fc = build(Path(a.src))
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    kinds = defaultdict(int)
    for f in fc["features"]:
        kinds[f"{f['properties']['kind']}:{f['properties']['level']}"] += 1
    print(json.dumps({"bytes": out.stat().st_size, **fc["check"], "kinds": kinds}, ensure_ascii=False))


if __name__ == "__main__":
    main()
