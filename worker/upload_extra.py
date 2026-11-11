"""이미 계산된 웹 실행 결과(run-<id>)에 나중에 생긴 파일(예: flow2d.json·flow2d.bin·river_flow.json)을 Storage로 올린다.

새 웹 실행은 워커(run_worker.py)가 계산 직후 다 올리므로 이 스크립트는 그 전에 계산한 결과용이다.
Storage의 meta.json 파일 목록에도 이름을 더한다. 없는 파일은 건너뛴다.

사용 (code 폴더): python -m worker.upload_extra --dir <...\\v1\\run-1> --prefix v1/run-1 flow2d.json flow2d.bin river_flow.json
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

from worker.supabase_rest import Supabase, _ctype, load_env  # noqa: E402

BUCKET = "results"
DESC = {
    "flow2d.json": "범람 구역 흐름 방향 설명 — 3D '흐름 보기'",
    "flow2d.bin": "범람 구역 셀 유속(동·북) Int8 — 형식은 flow2d.json",
    "river_flow.json": "냉천 흐름 표시용 단면 평균 유속·수면 폭 (화면 표현용)",
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", required=True, help="파일이 있는 폴더")
    ap.add_argument("--prefix", required=True, help="Storage 결과 경로, 예: v1/run-1")
    ap.add_argument("names", nargs="+", help="올릴 파일 이름")
    a = ap.parse_args()
    env = load_env(Path(__file__).with_name(".env"))
    sb = Supabase(env.get("SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_ROLE_KEY", ""))
    d = Path(a.dir)
    done = []
    for name in a.names:
        p = d / name
        if not p.is_file():
            print(f"없음, 건너뜀: {p}")
            continue
        sb.upload(BUCKET, f"{a.prefix}/{name}", p.read_bytes(), _ctype(p))
        print(f"올림: {a.prefix}/{name} ({p.stat().st_size / 1e6:.2f} MB)")
        done.append(name)
    if not done:
        print("올린 파일이 없습니다.")
        return 1
    try:
        with urllib.request.urlopen(sb.public_url(BUCKET, f"{a.prefix}/meta.json"), timeout=30) as r:
            meta = json.loads(r.read())
        files = meta.setdefault("files", {})
        for name in done:
            files[name] = DESC.get(name, name)
        sb.upload(BUCKET, f"{a.prefix}/meta.json", json.dumps(meta, ensure_ascii=False, indent=1).encode("utf-8"),
                  "application/json")
        print("meta.json 파일 목록 갱신")
    except Exception as e:  # meta.json 갱신이 안 돼도 화면은 파일을 직접 읽는다
        print(f"meta.json 갱신 못 함: {e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
