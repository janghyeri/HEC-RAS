"""2D 계산 영역 표시 이미지 — 3D '물 높이' 보기에서 하천(1D) 물을 세우지 않게 가리는 데 쓴다.

왜: 3D 물 높이는 '브이월드 지면 + 2 m 지형 기준 수심'으로 세운다. 하천 수로는 브이월드 지형과 HEC-RAS 지형(측량 하상)의
차이가 커서 하천 수심(최대 5 m 넘음)만큼 세우면 물이 둑 위로 떠 보인다 → 하천 물은 지면 색으로만 그리고, 2D 셀 안 물만 세운다.

출력: <out>.png (8비트, 255 = 2D 셀 안, 0 = 밖) + <out>.json (범위·크기 — depth2m/frames.json과 같은 격자여야 함)
입력: 웹 공개 폴더의 mesh.json·mesh_vertices.i32·mesh_offsets.u32, 격자는 depth2m/frames.json의 bounds·width·height
사용: python -m pipeline.area_mask_web --mesh-dir web/public/data/v1 --grid web/public/data/v1/S0-C/depth2m/frames.json \
        --out web/public/data/v1/area2d_2m
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def build(mesh_dir: Path, grid: dict) -> tuple[np.ndarray, dict]:
    meta = json.loads((mesh_dir / "mesh.json").read_text(encoding="utf-8"))
    scale = float(meta["coordinate_scale"])
    v = np.fromfile(mesh_dir / "mesh_vertices.i32", dtype=np.int32).reshape(-1, 2) / scale
    off = np.fromfile(mesh_dir / "mesh_offsets.u32", dtype=np.uint32).astype(np.int64)
    w, s, e, n = grid["bounds"]
    W, H = int(grid["width"]), int(grid["height"])
    px = (v[:, 0] - w) / (e - w) * W
    py = (n - v[:, 1]) / (n - s) * H
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    for i in range(len(off) - 1):
        a, b = off[i], off[i + 1]
        if b - a >= 3:
            d.polygon(list(zip(px[a:b].tolist(), py[a:b].tolist())), fill=255, outline=255)
    info = {"bounds": grid["bounds"], "width": W, "height": H, "model_version": meta["model_version"],
            "geometry_hash": meta["geometry_hash"], "n_cells": meta["n_cells"],
            "note": "255 = 2D 셀 안 (화소 중심 기준, 셀 경계선 포함). 3D 물 높이 보기에서 하천(1D) 물을 세우지 않는 데 씀"}
    return np.asarray(img), info


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mesh-dir", required=True)
    ap.add_argument("--grid", required=True, help="depth2m/frames.json (격자)")
    ap.add_argument("--out", required=True, help="출력 경로 (확장자 없이)")
    a = ap.parse_args()
    grid = json.loads(Path(a.grid).read_text(encoding="utf-8"))
    m, info = build(Path(a.mesh_dir), grid)
    out = Path(a.out)
    Image.fromarray(m, "L").save(out.with_suffix(".png"), optimize=True)
    info["inside_fraction"] = round(float((m > 0).mean()), 4)
    out.with_suffix(".json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({**info, "bytes": out.with_suffix(".png").stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    main()
