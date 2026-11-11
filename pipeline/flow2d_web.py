"""범람 구역(2D) 흐름 방향 자료 — 3D 화면 '흐름 보기'에서 물이 시가지로 어디로 퍼지는지 흰 줄로 그린다.

출력 (<out> = 시나리오 웹 폴더, 예: web/public/data/v1/S0-C)
  flow2d.json   격자·시각·배율·확인값
  flow2d.bin    Uint32 격자 번호[n] (젖은 적이 있는 격자점만, 북→남·서→동 순서)
                + 시각마다 Int8 동쪽 유속[n], Int8 북쪽 유속[n]   (m/s = 값 × scale_ms, −128 = 그 시각 마름)

계산
  1. 셀 유속 벡터: HEC-RAS가 저장하는 셀 경계면 법선 유속(Face Velocity)으로 셀마다 가중 최소제곱을 푼다.
     Σ w (n·u − Vn)² 최소 → 2×2 식. w = 그 시각 경계면 흐름 단면적(경계면 표고-면적 표, 양옆 셀 수위 평균),
     표가 없으면 경계면 길이(젖은 면만). 법선은 Faces Cell Indexes 0번 → 1번 셀 방향, Vn은 그 방향이 +.
     한 방향 면만 젖은 셀은 작은 정규화(대각 + 1e-3 × 대각합)로 그 방향 성분만 남긴다.
  2. 부호 확인: 양쪽 셀이 다 젖은 면에서 '물이 수위 높은 셀 → 낮은 셀로 흐르는 비율'을 남긴다 (0.5보다 작으면 부호를 뒤집고 기록)
  3. 방향 보정: EPSG:5187 격자 북쪽과 진북의 차이(자오선 수렴각, 약 0.24°)만큼 돌려 동·북 성분으로
  4. 격자: 경위도 격자(화소 약 20 m)마다 그 자리 셀 유속, 그 시각 수심(셀 수위 − 2 m 지형) 0.1 m 이상인 곳만
     — 침수심 이미지(frames_web)와 같은 기준이라 물이 그려진 곳에만 흐름이 보인다

화면 표현용 자료다 (방향·빠르기 비교). KPI·수리 판단에는 쓰지 않는다. 하천(1D) 흐름은 river_flow.json.

사용 (워커 PC, code 폴더에서)
  python -m pipeline.flow2d_web --hdf <p03.hdf> --terrain <Terrain.all.tif> --out <시나리오 웹 폴더> --scenario S0-C
  python -m pipeline.flow2d_web --job S0-C=<hdf> --job S0-E=<hdf> --terrain <tif> --out-root <폴더> --zip
"""
from __future__ import annotations

import argparse
import json
import math
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import tm_korea

STEP_M = 20.0
MIN_DEPTH = 0.1          # frames_web.MIN_DEPTH와 같게
SCALE_MS = 0.05          # Int8 한 칸 = 0.05 m/s → ±6.35 m/s
DRY = -128
GEOM2D = "/Geometry/2D Flow Areas"
TS2D = "/Results/Unsteady/Output/Output Blocks/Base Output/Unsteady Time Series/2D Flow Areas"


# ---------------------------------------------------------------- 셀 유속
def face_wet_area(info: np.ndarray | None, values: np.ndarray | None, ws_face: np.ndarray,
                  length: np.ndarray) -> np.ndarray | None:
    """경계면 흐름 단면적 (면마다 표고-면적 표를 선형 보간, 표 위로는 면 길이 × 초과 수심, 표 아래는 0).

    info: (F, 2) 표 시작·개수, values: (*, ≥2) [표고, 면적, …]. 표가 없으면 None을 돌려준다.
    """
    if info is None or values is None:
        return None
    F = len(info)
    start = info[:, 0].astype(np.int64)
    count = info[:, 1].astype(np.int64)
    elev = values[:, 0].astype(np.float64)
    area = values[:, 1].astype(np.float64)
    out = np.zeros(F, dtype=np.float64)
    ok = (count > 0) & np.isfinite(ws_face)
    contiguous = np.array_equal(start, np.concatenate([[0], np.cumsum(count)[:-1]])) and count.sum() <= elev.size
    if not contiguous:                    # 표가 면 순서대로 붙어 있지 않으면 (드묾) 하나씩
        for f in np.flatnonzero(ok):
            out[f] = _interp_one(ws_face[f], elev[start[f]:start[f] + count[f]], area[start[f]:start[f] + count[f]], length[f])
        return out
    total = int(count.sum())
    e, a = elev[:total], area[:total]
    # 면마다 표고가 오름차순 → 면 번호 × span을 더하면 전체가 오름차순이 되어 한 번에 searchsorted
    wsf = np.where(ok, ws_face, 0.0)
    span = float(np.ptp(e)) + float(np.abs(wsf).max(initial=0.0)) + float(np.abs(e).max(initial=0.0)) + 1e4
    owner = np.repeat(np.arange(F), count)
    idx = np.searchsorted(owner * span + e, np.arange(F) * span + wsf, side="right") - 1   # ws 이하인 마지막 행
    lo, hi = start, start + count - 1
    above = ok & (idx >= hi)
    mid = ok & (idx >= lo) & (idx < hi)
    i0 = np.clip(idx, 0, total - 1)
    i1 = np.clip(idx + 1, 0, total - 1)
    de = e[i1] - e[i0]
    frac = np.where(de > 0, (wsf - e[i0]) / np.where(de > 0, de, 1.0), 0.0)
    out[mid] = (a[i0] + (a[i1] - a[i0]) * frac)[mid]
    top = np.clip(hi, 0, total - 1)
    out[above] = (a[top] + length * np.maximum(0.0, wsf - e[top]))[above]
    return np.maximum(out, 0.0)


def _interp_one(ws, e, a, length):
    if not np.isfinite(ws) or ws <= e[0]:
        return 0.0
    if ws >= e[-1]:
        return float(a[-1] + length * (ws - e[-1]))
    return float(np.interp(ws, e, a))


def cell_velocity(n_cells: int, face_cells: np.ndarray, normal: np.ndarray, vn: np.ndarray,
                  weight: np.ndarray) -> np.ndarray:
    """면 법선 유속 → 셀 유속 벡터 (가중 최소제곱). face_cells (F,2), normal (F,2) 단위, vn (F,), weight (F,).

    n_cells 이상 번호(가상 셀)는 건너뛴다. 돌려주는 값 (n_cells, 2) — 젖은 면이 없는 셀은 0.
    """
    w = np.where(np.isfinite(vn) & (weight > 0), weight, 0.0)
    v = np.where(w > 0, vn, 0.0)
    nx, ny = normal[:, 0], normal[:, 1]
    terms = np.stack([w * nx * nx, w * ny * ny, w * nx * ny, w * v * nx, w * v * ny], axis=1)
    acc = np.zeros((5, n_cells), dtype=np.float64)
    for col in (0, 1):
        c = face_cells[:, col]
        m = (c >= 0) & (c < n_cells)
        for k in range(5):
            acc[k] += np.bincount(c[m], weights=terms[m, k], minlength=n_cells)[:n_cells]
    a11, a22, a12, b1, b2 = acc
    tr = a11 + a22
    eps = 1e-3 * tr
    a11e, a22e = a11 + eps, a22 + eps
    det = a11e * a22e - a12 * a12
    out = np.zeros((n_cells, 2), dtype=np.float64)
    ok = (tr > 0) & (det > 0)
    out[ok, 0] = (a22e[ok] * b1[ok] - a12[ok] * b2[ok]) / det[ok]
    out[ok, 1] = (a11e[ok] * b2[ok] - a12[ok] * b1[ok]) / det[ok]
    return out


def downhill_share(face_cells: np.ndarray, vn: np.ndarray, ws: np.ndarray, n_cells: int,
                   min_v: float = 0.05, min_dws: float = 0.005) -> tuple[int, int]:
    """양쪽이 실제 셀인 면에서 Vn>0(0번→1번)이 '0번 수위 > 1번 수위'와 맞는 면 수, 따진 면 수."""
    c0, c1 = face_cells[:, 0], face_cells[:, 1]
    real = (c0 >= 0) & (c0 < n_cells) & (c1 >= 0) & (c1 < n_cells)
    c0, c1, v = c0[real], c1[real], vn[real]
    dws = ws[c0] - ws[c1]
    use = (np.abs(v) > min_v) & (np.abs(dws) > min_dws) & np.isfinite(dws)
    return int(np.sum((v[use] * dws[use]) > 0)), int(use.sum())


def grid_north_bearing(x: float, y: float) -> float:
    """EPSG:5187 격자 북쪽이 진북에서 동쪽으로 돌아간 각 (라디안)."""
    lon, lat = tm_korea.to_lonlat(np.array([x, x]), np.array([y, y + 100.0]))
    p = math.radians(float(lat[0]))
    m_lat = 111132.954 - 559.822 * math.cos(2 * p)
    m_lon = 111412.84 * math.cos(p)
    return math.atan2((lon[1] - lon[0]) * m_lon, (lat[1] - lat[0]) * m_lat)


def to_east_north(u: np.ndarray, v: np.ndarray, beta: float) -> tuple[np.ndarray, np.ndarray]:
    """격자 성분(u: 격자 동, v: 격자 북) → 진동·진북 성분."""
    c, s = math.cos(beta), math.sin(beta)
    return u * c + v * s, -u * s + v * c


# ---------------------------------------------------------------- 격자 자료
def pack(frames_uv: list[tuple[np.ndarray, np.ndarray]]) -> tuple[np.ndarray, bytes]:
    """시각별 (동, 북) 격자 배열(마름 = NaN) → (젖은 적 있는 격자 번호, flow2d.bin 내용)."""
    wet_any = np.zeros(frames_uv[0][0].size, dtype=bool)
    for u, _ in frames_uv:
        wet_any |= np.isfinite(u.ravel())
    idx = np.flatnonzero(wet_any).astype("<u4")
    parts = [idx.tobytes()]
    for u, v in frames_uv:
        for comp in (u.ravel()[idx], v.ravel()[idx]):
            q = np.full(idx.size, DRY, dtype=np.int8)
            m = np.isfinite(comp)
            q[m] = np.clip(np.round(comp[m] / SCALE_MS), -127, 127).astype(np.int8)
            parts.append(q.tobytes())
    return idx, b"".join(parts)


def unpack(buf: bytes, n: int, count: int) -> tuple[np.ndarray, np.ndarray]:
    """pack의 반대 (시험용). (격자 번호, (시각, 2, n) Int8)"""
    idx = np.frombuffer(buf, dtype="<u4", count=n)
    q = np.frombuffer(buf, dtype=np.int8, offset=4 * n).reshape(count, 2, n)
    return idx, q


def write_flow2d(sampler, cell_uv_frames: np.ndarray, ws_frames: np.ndarray, times: list[str], out: Path,
                 beta: float, check: dict, meta: dict | None = None) -> dict:
    """cell_uv_frames (시각, 셀, 2) 격자 성분 셀 유속 → out/flow2d.bin·json."""
    g = sampler.grid
    H, W = g["height"], g["width"]
    frames_uv, p95, vmax = [], [], []
    for t in range(ws_frames.shape[0]):
        d, is2d = sampler.depth(ws_frames[t])
        wet = (np.isfinite(d) & is2d & (d >= MIN_DEPTH)).ravel()
        u = np.full(H * W, np.nan, dtype=np.float32)
        v = np.full(H * W, np.nan, dtype=np.float32)
        m = sampler.cell >= 0
        pix = sampler.pix[m]
        cell = sampler.cell[m]
        keep = wet[pix]
        e, n = to_east_north(cell_uv_frames[t, cell[keep], 0], cell_uv_frames[t, cell[keep], 1], beta)
        u[pix[keep]] = e
        v[pix[keep]] = n
        frames_uv.append((u, v))
        sp = np.hypot(e, n)
        p95.append(round(float(np.percentile(sp, 95)), 2) if sp.size else 0.0)
        vmax.append(round(float(sp.max()), 2) if sp.size else 0.0)
    idx, blob = pack(frames_uv)
    (out / "flow2d.bin").write_bytes(blob)
    info = {
        **(meta or {}),
        "count": int(ws_frames.shape[0]),
        "times": times,
        "file": "flow2d.bin",
        "layout": "Uint32(LE) 격자 번호[n] + 시각마다 Int8 동쪽[n], Int8 북쪽[n]. m/s = 값 × scale_ms, -128 = 그 시각 마름",
        "grid": {"west": round(g["west"], 8), "north": round(g["north"], 8), "dlon": g["dlon"], "dlat": g["dlat"],
                 "width": W, "height": H, "step_m": STEP_M, "order": "북→남 행, 서→동 열 (번호 = 행 × width + 열)"},
        "n": int(idx.size),
        "scale_ms": SCALE_MS,
        "dry": DRY,
        "min_depth_m": MIN_DEPTH,
        "speed_p95_ms": p95,
        "speed_max_ms": vmax,
        "check": check,
        "bytes": len(blob),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": "셀 유속 = HEC-RAS 셀 경계면 법선 유속(Face Velocity)의 가중 최소제곱 재구성 (가중 = 경계면 흐름 단면적). "
                "화면 표현용, 수리 계산·KPI에는 쓰지 않음. 하천(1D) 흐름은 river_flow.json",
    }
    (out / "flow2d.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    return info


# ---------------------------------------------------------------- HEC-RAS 결과에서 (워커 PC)
def read_face_velocity(hdf: Path, plan) -> tuple[np.ndarray, dict]:
    """영역별 면 자료로 셀 유속 (시각, 전체 셀, 2)을 만든다. plan = hecras_hdf.read_plan 결과 (셀 순서 = build_mesh)."""
    import h5py

    per_area, agree, judged, weight_kind = [], 0, 0, set()
    with h5py.File(str(hdf), "r") as h:
        for a in plan.areas:
            g = f"{GEOM2D}/{a.name}"
            r = f"{TS2D}/{a.name}"
            need = [g + "/Faces Cell Indexes", g + "/Faces NormalUnitVector and Length", r + "/Face Velocity"]
            miss = [p for p in need if p not in h]
            if miss:
                have = sorted(h[r].keys()) if r in h else []
                raise KeyError(f"{a.name}: HDF에 없음 {miss} (결과에 있는 것: {have})")
            fci = h[g + "/Faces Cell Indexes"][()].astype(np.int64)
            nl = h[g + "/Faces NormalUnitVector and Length"][()].astype(np.float64)
            fv = h[r + "/Face Velocity"][()].astype(np.float64)          # (시각, 면)
            info = h[g + "/Faces Area Elevation Info"][()] if g + "/Faces Area Elevation Info" in h else None
            vals = h[g + "/Faces Area Elevation Values"][()] if g + "/Faces Area Elevation Values" in h else None
            ws = a.ws_frames                                              # (시각, 실제 셀)
            if fv.shape[0] != ws.shape[0]:
                raise ValueError(f"{a.name}: 면 유속 시각 수 {fv.shape[0]} ≠ 수위 시각 수 {ws.shape[0]}")
            n = a.n_cells
            c0, c1 = fci[:, 0], fci[:, 1]
            r0 = (c0 >= 0) & (c0 < n)
            r1 = (c1 >= 0) & (c1 < n)
            uv = np.zeros((ws.shape[0], n, 2))
            for t in range(ws.shape[0]):
                w0 = np.where(r0, ws[t, np.clip(c0, 0, n - 1)], np.nan)
                w1 = np.where(r1, ws[t, np.clip(c1, 0, n - 1)], np.nan)
                ws_face = np.where(np.isfinite(w0) & np.isfinite(w1), (w0 + w1) / 2, np.where(np.isfinite(w0), w0, w1))
                wa = face_wet_area(info, vals, ws_face, nl[:, 2])
                if wa is None:
                    wa = np.where(fv[t] != 0, nl[:, 2], 0.0)
                    weight_kind.add("경계면 길이 (젖은 면)")
                else:
                    weight_kind.add("경계면 흐름 단면적")
                uv[t] = cell_velocity(n, fci, nl[:, :2], fv[t], wa)
                k, m = downhill_share(fci, fv[t], ws[t], n)
                agree += k
                judged += m
            per_area.append(uv)
    share = agree / judged if judged else None
    flipped = share is not None and share < 0.5
    out = np.concatenate(per_area, axis=1)
    if flipped:
        out = -out
    check = {"downhill_share": None if share is None else round(share, 4), "faces_judged": judged, "flipped": flipped,
             "weight": " / ".join(sorted(weight_kind)),
             "note": "양쪽 셀이 젖은 면(|Vn|>0.05 m/s, 수위차>5 mm)에서 물이 수위 높은 셀→낮은 셀로 흐른 비율. "
                     "1에 가까울수록 면 유속 부호 해석이 맞음 (0.5 미만이면 부호를 뒤집음)"}
    return out, check


def make_flow2d(hdf: Path, terrain_tif: Path, out: Path, scenario: str, model_version: str, ctx: dict | None = None) -> dict:
    """결과 HDF·지형으로 out/flow2d.bin·json을 만든다. ctx: frames_web.make_frames가 이미 읽은 {plan, terrain, mesh, cell_id}."""
    from .frames_web import FrameSampler, _iso_times, bbox_of, lonlat_grid

    if ctx is None:
        from .export_web import build_mesh
        from .hecras_hdf import read_plan
        from .raster_depth import rasterize_cells, read_terrain

        plan = read_plan(str(hdf))
        terrain = read_terrain(str(terrain_tif))
        mesh = build_mesh(plan)
        cell_id = rasterize_cells(mesh["polygons"], terrain)
    else:
        plan, terrain, mesh, cell_id = ctx["plan"], ctx["terrain"], ctx["mesh"], ctx["cell_id"]
    cell_uv, check = read_face_velocity(hdf, plan)
    ws_frames = np.concatenate([a.ws_frames for a in plan.areas], axis=1)
    grid = lonlat_grid(bbox_of(mesh["polygons"]), STEP_M)
    sampler = FrameSampler(terrain.z, terrain.x0, terrain.y0, terrain.dx, terrain.dy, cell_id, grid)
    cx, cy = np.concatenate(mesh["polygons"]).mean(axis=0)
    beta = grid_north_bearing(float(cx), float(cy))
    check["grid_north_bearing_deg"] = round(math.degrees(beta), 3)
    info = write_flow2d(sampler, cell_uv, ws_frames, _iso_times(plan.times), out, beta, check,
                        {"model_version": model_version, "scenario_id": scenario})
    meta_p = out / "meta.json"
    if meta_p.exists():
        meta = json.loads(meta_p.read_text(encoding="utf-8"))
        files = meta.setdefault("files", {})
        files["flow2d.json"] = f"범람 구역 흐름 방향 설명 (격자 {STEP_M:g} m, {info['count']}시각) — 3D '흐름 보기'"
        files["flow2d.bin"] = "범람 구역 셀 유속(동·북) Int8 — 형식은 flow2d.json"
        meta_p.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return info


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--terrain", required=True)
    ap.add_argument("--model-version", default="v1")
    ap.add_argument("--hdf")
    ap.add_argument("--scenario")
    ap.add_argument("--out", help="시나리오 웹 폴더 (flow2d.*를 여기에 만든다)")
    ap.add_argument("--job", action="append", default=[], help="시나리오=HDF (여러 번), --out-root와 함께")
    ap.add_argument("--out-root", help="--job 출력 위치: <out-root>/<버전>/<시나리오>/")
    ap.add_argument("--zip", action="store_true", help="<out-root>/flow2d.zip에 모든 결과를 묶는다")
    a = ap.parse_args()
    jobs = []
    if a.hdf:
        jobs.append((a.scenario, Path(a.hdf), Path(a.out)))
    for j in a.job:
        sid, _, h = j.partition("=")
        jobs.append((sid, Path(h), Path(a.out_root) / a.model_version / sid))
    report = []
    for sid, h, out in jobs:
        print(f"[{datetime.now():%H:%M:%S}] {sid}: {h}", flush=True)
        try:
            out.mkdir(parents=True, exist_ok=True)
            info = make_flow2d(h, Path(a.terrain), out, sid, a.model_version)
            line = {"scenario": sid, "ok": True, "n": info["n"], "MB": round(info["bytes"] / 1e6, 2),
                    "speed_p95_max": max(info["speed_p95_ms"]), "speed_max": max(info["speed_max_ms"]),
                    "check": info["check"]}
        except Exception as e:  # 한 시나리오가 실패해도 나머지는 계속
            line = {"scenario": sid, "ok": False, "error": f"{type(e).__name__}: {e}"}
        print(json.dumps(line, ensure_ascii=False), flush=True)
        report.append(line)
    if a.out_root:
        root = Path(a.out_root)
        root.mkdir(parents=True, exist_ok=True)
        (root / "flow2d_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
        if a.zip:
            with zipfile.ZipFile(root / "flow2d.zip", "w", zipfile.ZIP_DEFLATED) as z:
                for p in sorted(root.rglob("flow2d.*")):
                    if p.suffix in (".json", ".bin"):
                        z.write(p, p.relative_to(root).as_posix())
                z.write(root / "flow2d_report.json", "flow2d_report.json")


if __name__ == "__main__":
    main()
