"""워커 PC ↔ Supabase 연결 점검 (HEC-RAS는 돌리지 않음).

worker/.env 의 SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY 로
  1. 키 종류 확인 (service_role 이어야 함 — 키 값은 화면에 쓰지 않는다)
  2. runs 표 읽기
  3. worker_heartbeat 에 '살아 있음' 한 줄 쓰기 → 웹에 '계산 서버 켜짐'이 뜨는지 확인용
  4. results 버킷에 작은 시험 파일 올리기 → 결과 파일 올리기 권한 확인

사용 (code 폴더에서): python -m worker.check_supabase
"""
from __future__ import annotations

import base64
import json
import os
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from worker.supabase_rest import Supabase, SupabaseError, load_env  # noqa: E402


def key_role(key: str) -> str:
    try:
        payload = key.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get("role", "?")
    except Exception:
        return "알 수 없음 (새 형식 키일 수 있음)"


def main() -> int:
    env_path = Path(__file__).with_name(".env")
    env = load_env(env_path)
    url, key = env.get("SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    print(f".env 위치: {env_path} ({'있음' if env_path.exists() else '없음'})")
    print(f"SUPABASE_URL: {url or '(비어 있음)'}")
    if not key:
        print("실패: SUPABASE_SERVICE_ROLE_KEY 가 비어 있음 — .env 에 service_role 키를 넣어 주세요")
        return 1
    role = key_role(key)
    print(f"키 종류: {role} (길이 {len(key)}자)")
    if role not in ("service_role", "알 수 없음 (새 형식 키일 수 있음)"):
        print("실패: service_role 키가 아님 — Supabase → Project Settings → API 의 service_role(secret) 키를 넣어 주세요")
        return 1
    sb = Supabase(url, key)
    ok = True
    worker_id = env.get("WORKER_ID", "worker")
    steps = [
        ("runs 표 읽기", lambda: f"{len(sb.select('runs', 'select=id,status&limit=5'))}건"),
        ("계산 서버 상태 쓰기", lambda: sb.upsert("worker_heartbeat", {
            "worker_id": worker_id, "last_seen": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "info": {"host": platform.node(), "cores": os.cpu_count(), "check": True}}, on_conflict="worker_id") or "완료"),
        ("결과 버킷에 시험 파일 올리기", lambda: sb.upload("results", f"_check/{worker_id}.json",
                                                    json.dumps({"checked_at": datetime.now(timezone.utc).isoformat()}).encode(),
                                                    "application/json") or "완료"),
    ]
    for name, fn in steps:
        try:
            print(f"  {name}: {fn()}")
        except SupabaseError as e:
            ok = False
            print(f"  {name}: 실패 — {e}")
    print("결과:", "연결 정상" if ok else "실패한 항목을 확인하세요")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
