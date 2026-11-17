"""이미 계산된 웹 실행 결과(run-<id>)에 나중에 다시 만든 이미지 폴더를 Supabase Storage로 올린다.
frames/(10분 침수심 등급), depth2m/(3D 연속 수심), tiles/(최대 수심 타일) — 폴더 안 frames.json 또는 tiles.json으로 알아본다.

새 웹 실행은 워커(run_worker.py)가 계산 직후 다 만들어 올리므로 이 스크립트는 그 전에 계산한 결과용이다.
meta.json(Storage)의 파일 목록에도 폴더를 더한다.

사용 (code 폴더): python -m worker.upload_frames --dir <...\\run-1\\frames> --prefix v1/run-1 [--name depth2m|tiles]
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from worker.supabase_rest import Supabase, load_env  # noqa: E402

BUCKET = "results"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", required=True, help="올릴 폴더 (frames.json 또는 tiles.json이 있는 곳)")
    ap.add_argument("--prefix", required=True, help="Storage 결과 경로, 예: v1/run-1")
    ap.add_argument("--name", default="frames", help="Storage 안 폴더 이름 (frames, depth2m, tiles)")
    a = ap.parse_args()
    env = load_env(Path(__file__).with_name(".env"))
    sb = Supabase(env.get("SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_ROLE_KEY", ""))
    d = Path(a.dir)
    desc_p = d / "frames.json" if (d / "frames.json").exists() else d / "tiles.json"
    if not desc_p.exists():
        print(f"frames.json·tiles.json 없음: {d}")
        return 1
    n = sb.upload_dir(BUCKET, f"{a.prefix}/{a.name}", d, log=print)
    info = json.loads(desc_p.read_text(encoding="utf-8"))
    mode = info.get("render_mode", "horizontal")
    if desc_p.name == "tiles.json":
        desc = f"최대 수심 등급 PNG 타일 z{info.get('minzoom')}–{info.get('maxzoom')} (XYZ) — 2D 수심({mode}) + 하천 수면, 설명은 {a.name}/tiles.json"
    elif "encoding" in info:
        desc = (f"3D 물 표면용 연속 수심 {info['count']}장 + max.png (화소 {info['pixel_m']:g} m, {mode}) — "
                f"설명은 {a.name}/frames.json")
    else:
        desc = (f"10분 침수심 이미지 {info['count']}장 (경위도 격자, 화소 {info['pixel_m']:g} m, {mode}) — "
                f"시간 재생·3D 지면 덮기, 설명은 {a.name}/frames.json")
    try:
        with urllib.request.urlopen(sb.public_url(BUCKET, f"{a.prefix}/meta.json"), timeout=30) as r:
            meta = json.loads(r.read())
        meta.setdefault("files", {})[a.name + "/"] = desc
        sb.upload(BUCKET, f"{a.prefix}/meta.json", json.dumps(meta, ensure_ascii=False, indent=1).encode("utf-8"),
                  "application/json")
        print(f"meta.json 파일 목록에 {a.name}/ 추가")
    except Exception as e:  # meta.json 갱신이 안 돼도 이미지는 쓸 수 있다 (화면은 frames.json을 직접 읽음)
        print(f"meta.json 갱신 못 함: {e}")
    print(f"결과: {n}개 올림 → {a.prefix}/{a.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
