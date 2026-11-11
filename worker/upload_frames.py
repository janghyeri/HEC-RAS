"""이미 계산된 웹 실행 결과(run-<id>)에 10분 침수심 이미지(frames/)를 Supabase Storage로 올린다.

새 웹 실행은 워커(run_worker.py)가 계산 직후 frames/까지 만들어 올리므로 이 스크립트는 그 전에 계산한 결과용이다.
meta.json(Storage)의 파일 목록에도 frames/를 더한다.

사용 (code 폴더): python -m worker.upload_frames --dir <...\\run-1\\frames> --prefix v1/run-1 [--name frames2m]
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
    ap.add_argument("--dir", required=True, help="frames 폴더 (frames.json과 PNG)")
    ap.add_argument("--prefix", required=True, help="Storage 결과 경로, 예: v1/run-1")
    ap.add_argument("--name", default="frames", help="Storage 안 폴더 이름 (기본 frames, 2 m 판은 frames2m)")
    a = ap.parse_args()
    env = load_env(Path(__file__).with_name(".env"))
    sb = Supabase(env.get("SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_ROLE_KEY", ""))
    d = Path(a.dir)
    if not (d / "frames.json").exists():
        print(f"frames.json 없음: {d}")
        return 1
    n = sb.upload_dir(BUCKET, f"{a.prefix}/{a.name}", d, log=print)
    info = json.loads((d / "frames.json").read_text(encoding="utf-8"))
    try:
        with urllib.request.urlopen(sb.public_url(BUCKET, f"{a.prefix}/meta.json"), timeout=30) as r:
            meta = json.loads(r.read())
        meta.setdefault("files", {})[a.name + "/"] = (f"10분 침수심 이미지 {info['count']}장 (경위도 격자, 화소 {info['pixel_m']:g} m) — "
                                                  "시간 재생·3D 지면 덮기, 설명은 frames/frames.json")
        sb.upload(BUCKET, f"{a.prefix}/meta.json", json.dumps(meta, ensure_ascii=False, indent=1).encode("utf-8"),
                  "application/json")
        print("meta.json 파일 목록에 frames/ 추가")
    except Exception as e:  # meta.json 갱신이 안 돼도 이미지는 쓸 수 있다 (화면은 frames.json을 직접 읽음)
        print(f"meta.json 갱신 못 함: {e}")
    print(f"결과: {n}개 올림 → {a.prefix}/{a.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
