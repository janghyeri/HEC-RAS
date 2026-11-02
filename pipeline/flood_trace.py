"""행정안전부 침수흔적도 → 웹 표시용 GeoJSON, 모의 결과와 비교 (작업 진행 가이드 Step 8, 가이드라인 §4.5.1).

자료: 행정안전부_침수흔적도, 재난안전데이터공유플랫폼 오픈API DSSP-IF-00117
      (https://www.safetydata.go.kr/disaster-data/view?dataSn=108)
이용 조건: 공공누리 제3유형 — 출처표시, 변경금지.
  → 폴리곤 모양과 속성 값은 바꾸지 않는다. 좌표계 변환(표시용 경위도)만 한다. 화면·보고서에 출처를 적는다.
  → 모의 결과와의 비교 지표(CSI 등)는 이 자료를 바꾸지 않고 따로 계산한 값이다.

응답 항목 (플랫폼 문서 기준): SN 일련번호, FLDN_DOWA 침수수심, FLDN_GRD 침수등급, FLDN_AREA 침수면적,
  FLDN_YR 침수연도, FLDN_DST_NM 침수재해명, FLDN_CS_DTL_NM 침수원인상세명, FLDN_BGNG_YMD/FLDN_END_YMD 침수
  시작·종료일자, FLDN_BGNG_TM/FLDN_END_TM 시각, STDG_CTPV_CD 법정동 시도코드, STDG_SGG_CD 시군구코드, GEOM

비교 (모형 2D 범위 안에서만, 2 m 격자)
  관측 = 침수흔적 폴리곤 안, 모의 = 최대 수심 ≥ h
  CSI = 적중 / (적중 + 놓침 + 헛침수), 적중률(POD) = 적중 / (적중 + 놓침), 헛침수율(FAR) = 헛침수 / (적중 + 헛침수)
  h = 0.1 m(침수면적 정의)와 0.3 m(재해지도 작성 지침의 침수 기준) 둘 다 계산 — 어느 쪽을 쓸지는 사용자 판단
"""
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from . import tm_korea

SOURCE = {
    "name": "행정안전부 침수흔적도",
    "provider": "행정안전부 (재난안전데이터공유플랫폼)",
    "api": "DSSP-IF-00117",
    "url": "https://www.safetydata.go.kr/disaster-data/view?dataSn=108",
    "license": "공공누리 제3유형 (출처표시, 변경금지)",
    "note": "폴리곤과 속성은 원자료 그대로이며 좌표계만 경위도(EPSG:4326)로 바꿈",
}

# ---------------------------------------------------------------- 좌표계 (한국 TM 계열, GRS80)
TM = {  # EPSG: (중앙 자오선, 위도 원점, 축척, 가산 동, 가산 북)
    "EPSG:5185": (125.0, 38.0, 1.0, 200000.0, 600000.0),
    "EPSG:5186": (127.0, 38.0, 1.0, 200000.0, 600000.0),
    "EPSG:5187": (129.0, 38.0, 1.0, 200000.0, 600000.0),
    "EPSG:5179": (127.5, 38.0, 0.9996, 1000000.0, 2000000.0),
}


def tm_to_lonlat(x, y, epsg: str):
    """GRS80 횡메르카토르 역변환 — tm_korea(EPSG:5187)와 같은 식을 정수만 바꿔 쓴다."""
    if epsg == "EPSG:5187":
        return tm_korea.to_lonlat(x, y)
    lon0, lat0, k0, fe, fn = TM[epsg]
    # tm_korea 의 식: 중앙 자오선이 다르면 경도만 평행이동, 축척·가산값을 맞춰 5187 좌표로 바꿔 넣는다
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    # 위도 원점(38°)과 타원체(GRS80)가 같으면 중앙 자오선 기준 상대 좌표의 식은 같다
    x5187 = tm_korea.FE + (x - fe) / k0
    y5187 = tm_korea.FN + (y - fn) / k0
    lon, lat = tm_korea.to_lonlat(x5187, y5187)
    return lon - 129.0 + lon0, lat


def lonlat_to_5187(lon, lat):
    return tm_korea.from_lonlat(lon, lat)


def detect_crs(xy: np.ndarray, expect_lon=(129.2, 129.6), expect_lat=(35.8, 36.2)) -> str:
    """좌표 범위로 좌표계를 추정한다 (포항 남구 일대라는 것을 알고 있으므로 그 위치에 맞는 것을 고른다)."""
    x, y = float(np.median(xy[:, 0])), float(np.median(xy[:, 1]))
    if 120 < x < 135 and 30 < y < 40:
        return "EPSG:4326"
    for epsg in ("EPSG:5187", "EPSG:5186", "EPSG:5185", "EPSG:5179"):
        lon, lat = tm_to_lonlat(np.array([x]), np.array([y]), epsg)
        if expect_lon[0] < lon[0] < expect_lon[1] and expect_lat[0] < lat[0] < expect_lat[1]:
            return epsg
    raise ValueError(f"좌표계를 알 수 없음 (중앙값 {x:.1f}, {y:.1f})")


# ---------------------------------------------------------------- 지오메트리
Polygon = list  # [외곽 링, 구멍 링...], 링 = (n, 2) 배열


def _ring(txt: str) -> np.ndarray:
    pts = [p.split() for p in txt.strip().strip("()").split(",")]
    return np.array([[float(a), float(b)] for a, b, *_ in pts])


def parse_geom(g) -> list[Polygon]:
    """WKT(POLYGON/MULTIPOLYGON, SRID= 접두 허용) 또는 GeoJSON → 폴리곤 목록."""
    if isinstance(g, dict) or (isinstance(g, str) and g.lstrip().startswith("{")):
        gj = json.loads(g) if isinstance(g, str) else g
        polys = [gj["coordinates"]] if gj["type"] == "Polygon" else gj["coordinates"]
        return [[np.asarray(r, dtype=float)[:, :2] for r in p] for p in polys]
    s = re.sub(r"^SRID=\d+;", "", str(g).strip())
    typ = s.split("(", 1)[0].strip().upper()
    body = s[len(s.split("(", 1)[0]):].strip()
    if typ.startswith("POLYGON"):
        polys_txt = [body[1:-1]]
    elif typ.startswith("MULTIPOLYGON"):
        polys_txt = re.findall(r"\(\s*(\(.*?\)(?:\s*,\s*\(.*?\))*)\s*\)", body[1:-1])
    else:
        raise ValueError(f"지원하지 않는 지오메트리: {typ}")
    out = []
    for pt in polys_txt:
        rings = re.findall(r"\(([^()]*)\)", pt)
        out.append([_ring(r) for r in rings])
    return out


def wkt_srid(g) -> str | None:
    m = re.match(r"^\s*SRID=(\d+);", str(g))
    return f"EPSG:{m.group(1)}" if m else None


# ---------------------------------------------------------------- 자료 고르기
@dataclass
class Trace:
    props: dict
    polys: list[Polygon]       # 원 좌표계
    crs: str


def select(records: list[dict], sgg_prefix=("4711",), year: str | None = None, event: str | None = None) -> list[dict]:
    """시군구 코드(포항시 남구 47111, 북구 47113), 연도, 재해명으로 고른다."""
    out = []
    for r in records:
        sgg = str(r.get("STDG_SGG_CD") or "")
        if sgg_prefix and not any(sgg.startswith(p) for p in sgg_prefix):
            continue
        if year and str(r.get("FLDN_YR") or "")[:4] != year:
            continue
        if event and event not in str(r.get("FLDN_DST_NM") or "") + str(r.get("FLDN_CS_DTL_NM") or ""):
            continue
        out.append(r)
    return out


def to_traces(records: list[dict]) -> list[Trace]:
    out = []
    for r in records:
        g = r.get("GEOM")
        if not g:
            continue
        polys = parse_geom(g)
        crs = wkt_srid(g) or detect_crs(np.vstack([p[0] for p in polys]))
        out.append(Trace({k: v for k, v in r.items() if k != "GEOM"}, polys, crs))
    return out


def to_lonlat_polys(t: Trace) -> list[Polygon]:
    if t.crs == "EPSG:4326":
        return t.polys
    return [[np.column_stack(tm_to_lonlat(r[:, 0], r[:, 1], t.crs)) for r in p] for p in t.polys]


def to_5187_polys(t: Trace) -> list[Polygon]:
    if t.crs == "EPSG:5187":
        return t.polys
    out = []
    for p in to_lonlat_polys(t):
        out.append([np.column_stack(lonlat_to_5187(r[:, 0], r[:, 1])) for r in p])
    return out


def geojson(traces: list[Trace], digits: int = 6) -> dict:
    feats = []
    for t in traces:
        coords = [[np.round(r, digits).tolist() for r in p] for p in to_lonlat_polys(t)]
        feats.append({"type": "Feature", "properties": t.props,
                      "geometry": {"type": "MultiPolygon", "coordinates": coords}})
    return {"type": "FeatureCollection", "source": SOURCE, "features": feats}


# ---------------------------------------------------------------- 격자 비교
@dataclass
class Grid:
    x0: float
    y0: float
    dx: float
    dy: float
    cols: int
    rows: int


def rasterize(polys_5187: list[Polygon], g: Grid) -> np.ndarray:
    img = Image.new("L", (g.cols, g.rows), 0)
    d = ImageDraw.Draw(img)
    for p in polys_5187:
        for k, ring in enumerate(p):
            c = (ring[:, 0] - g.x0) / g.dx - 0.5
            r = (g.y0 - ring[:, 1]) / g.dy - 0.5
            if len(ring) >= 3:
                d.polygon(list(zip(c.tolist(), r.tolist())), fill=1 if k == 0 else 0)
    return np.asarray(img, dtype=bool)


def domain_mask(mesh_dir: Path, g: Grid) -> np.ndarray:
    """웹 격자 파일(mesh_vertices.i32, mesh_offsets.u32, 경위도 정수)로 2D 계산 범위를 그린다."""
    info = json.loads((mesh_dir / "mesh.json").read_text(encoding="utf-8"))
    v = np.fromfile(mesh_dir / "mesh_vertices.i32", dtype="<i4").reshape(-1, 2) / info["coordinate_scale"]
    o = np.fromfile(mesh_dir / "mesh_offsets.u32", dtype="<u4")
    x, y = lonlat_to_5187(v[:, 0], v[:, 1])
    img = Image.new("L", (g.cols, g.rows), 0)
    d = ImageDraw.Draw(img)
    c = (x - g.x0) / g.dx - 0.5
    r = (g.y0 - y) / g.dy - 0.5
    for i in range(len(o) - 1):
        a, b = int(o[i]), int(o[i + 1])
        if b - a >= 3:
            d.polygon(list(zip(c[a:b].tolist(), r[a:b].tolist())), fill=1)
    return np.asarray(img, dtype=bool)


def scores(obs: np.ndarray, sim: np.ndarray, domain: np.ndarray, pixel_area: float) -> dict:
    o, s = obs & domain, sim & domain
    hit = int((o & s).sum())
    miss = int((o & ~s).sum())
    fa = int((~o & s).sum())
    km2 = lambda n: round(n * pixel_area / 1e6, 4)  # noqa: E731
    return {"hit_km2": km2(hit), "miss_km2": km2(miss), "false_alarm_km2": km2(fa),
            "csi": round(hit / (hit + miss + fa), 3) if hit + miss + fa else None,
            "pod": round(hit / (hit + miss), 3) if hit + miss else None,
            "far": round(fa / (hit + fa), 3) if hit + fa else None}


def compare(traces: list[Trace], depth_m: np.ndarray, g: Grid, domain: np.ndarray,
            thresholds=(0.1, 0.3)) -> dict:
    polys = [to_5187_polys(t) for t in traces]
    obs = np.zeros(depth_m.shape, dtype=bool)
    per = []
    for t, p in zip(traces, polys):
        m = rasterize(p, g)
        obs |= m
        inside = m & domain
        d = depth_m[inside]
        per.append({"SN": t.props.get("SN"), "FLDN_DOWA": t.props.get("FLDN_DOWA"), "FLDN_GRD": t.props.get("FLDN_GRD"),
                    "area_km2": round(float(m.sum()) * g.dx * g.dy / 1e6, 4),
                    "in_domain_frac": round(float(inside.sum()) / max(1, int(m.sum())), 3),
                    "model_wet_frac_0.1": round(float((d >= 0.1).mean()), 3) if d.size else None,
                    "model_depth_median_m": round(float(np.median(d)), 2) if d.size else None,
                    "model_depth_p90_m": round(float(np.percentile(d, 90)), 2) if d.size else None})
    pix = g.dx * g.dy
    res = {"obs_area_km2": round(float(obs.sum()) * pix / 1e6, 4),
           "obs_area_in_domain_km2": round(float((obs & domain).sum()) * pix / 1e6, 4),
           "domain_area_km2": round(float(domain.sum()) * pix / 1e6, 4),
           "by_threshold": {f"{h}": scores(obs, depth_m >= h, domain, pix) for h in thresholds},
           "polygons": per}
    return res


def load_depth(depth_cm_png: Path) -> np.ndarray:
    return np.asarray(Image.open(depth_cm_png), dtype=np.float32) / 100.0


def load_records(paths: list[Path]) -> list[dict]:
    """API 응답(JSON 페이지 여러 개 또는 레코드 목록 JSON)을 읽는다."""
    recs = []
    for p in paths:
        d = json.loads(Path(p).read_text(encoding="utf-8"))
        if isinstance(d, list):
            recs += d
        elif isinstance(d, dict):
            body = d.get("body", d)
            items = body if isinstance(body, list) else (body.get("items") or body.get("item") or body.get("data") or [])
            if isinstance(items, dict):
                items = items.get("item", [])
            recs += items
    return recs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--records", nargs="+", required=True, help="API 응답 JSON (페이지들) 또는 레코드 목록 JSON")
    ap.add_argument("--sgg", nargs="*", default=["4711"], help="시군구 코드 앞자리 (포항 남구 47111, 북구 47113)")
    ap.add_argument("--year", default="2022")
    ap.add_argument("--event", default=None, help="재해명·원인에 들어 있어야 할 글자 (예: 힌남노)")
    ap.add_argument("--scenarios", nargs="*", default=["S0-C", "S0-E"])
    ap.add_argument("--out-root", default="data/out", help="export_web 출력 (모형 버전 폴더 위)")
    ap.add_argument("--model-version", default="v1")
    ap.add_argument("--geojson-out", default=None, help="웹 표시용 GeoJSON 저장 위치")
    ap.add_argument("--report", default=None, help="비교 결과 JSON 저장 위치")
    a = ap.parse_args()

    recs = load_records([Path(p) for p in a.records])
    sel = select(recs, tuple(a.sgg), a.year, a.event)
    traces = to_traces(sel)
    print(f"레코드 {len(recs)}개 중 선택 {len(sel)}개, 지오메트리 {len(traces)}개, 좌표계 {sorted({t.crs for t in traces})}")
    if a.geojson_out:
        Path(a.geojson_out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.geojson_out).write_text(json.dumps(geojson(traces), ensure_ascii=False, separators=(",", ":")),
                                       encoding="utf-8")
    ver = Path(a.out_root) / a.model_version
    report = {"source": SOURCE, "selection": {"sgg": a.sgg, "year": a.year, "event": a.event, "n": len(traces)},
              "scenarios": {}}
    domain = None
    for sid in a.scenarios:
        meta = json.loads((ver / sid / "meta.json").read_text(encoding="utf-8"))["raster"]
        g = Grid(meta["origin_xy"][0], meta["origin_xy"][1], meta["pixel_xy"][0], meta["pixel_xy"][1],
                 meta["width"], meta["height"])
        if domain is None:
            domain = domain_mask(ver, g)
        depth = load_depth(ver / sid / "max_depth_cm.png")
        report["scenarios"][sid] = compare(traces, depth, g, domain)
        bt = report["scenarios"][sid]["by_threshold"]
        print(sid, {h: (v["csi"], v["pod"], v["far"]) for h, v in bt.items()})
    if a.report:
        Path(a.report).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
