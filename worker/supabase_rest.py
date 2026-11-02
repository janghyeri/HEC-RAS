"""Supabase REST 최소 클라이언트 — 표준 라이브러리(urllib)만 쓴다 (워커 PC에 패키지 추가 설치 없이).

워커는 service_role 키로 접속한다. 이 키는 워커 PC의 worker/.env 에만 두고 저장소·웹에 넣지 않는다.
"""
from __future__ import annotations

import json
import mimetypes
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class SupabaseError(RuntimeError):
    pass


class Supabase:
    def __init__(self, url: str, key: str, timeout: float = 60.0):
        if not url or not key:
            raise SupabaseError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 비어 있습니다 (worker/.env)")
        self.url = url.rstrip("/")
        self.key = key
        self.timeout = timeout

    # ------------------------------------------------------------ 공통
    def _request(self, method: str, path: str, body=None, headers: dict | None = None,
                 data: bytes | None = None, retries: int = 3):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        last = None
        for i in range(retries):
            req = urllib.request.Request(self.url + path, data=data, method=method, headers=h)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    raw = r.read()
                    if not raw:
                        return None
                    ctype = r.headers.get("Content-Type", "")
                    return json.loads(raw) if "json" in ctype else raw
            except urllib.error.HTTPError as e:
                msg = e.read().decode("utf-8", "replace")
                if e.code < 500:            # 요청이 틀린 것 → 다시 해도 같음
                    raise SupabaseError(f"{method} {path} → {e.code}: {msg}") from None
                last = f"{e.code}: {msg}"
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                last = str(e)
            time.sleep(2 * (i + 1))
        raise SupabaseError(f"{method} {path} 실패 (재시도 {retries}번): {last}")

    # ------------------------------------------------------------ DB (PostgREST)
    def rpc(self, fn: str, args: dict):
        return self._request("POST", f"/rest/v1/rpc/{fn}", body=args)

    def select(self, table: str, query: str):
        return self._request("GET", f"/rest/v1/{table}?{query}")

    def update(self, table: str, match: dict, fields: dict):
        q = "&".join(f"{k}=eq.{urllib.parse.quote(str(v))}" for k, v in match.items())
        return self._request("PATCH", f"/rest/v1/{table}?{q}", body=fields,
                             headers={"Prefer": "return=minimal"})

    def upsert(self, table: str, row: dict, on_conflict: str):
        return self._request("POST", f"/rest/v1/{table}?on_conflict={on_conflict}", body=row,
                             headers={"Prefer": "resolution=merge-duplicates,return=minimal"})

    def insert(self, table: str, row: dict):
        return self._request("POST", f"/rest/v1/{table}", body=row, headers={"Prefer": "return=representation"})

    # ------------------------------------------------------------ Storage
    def upload(self, bucket: str, key: str, data: bytes, content_type: str | None = None):
        ctype = content_type or mimetypes.guess_type(key)[0] or "application/octet-stream"
        path = f"/storage/v1/object/{bucket}/{urllib.parse.quote(key)}"
        return self._request("POST", path, data=data,
                             headers={"Content-Type": ctype, "x-upsert": "true", "Cache-Control": "3600"})

    def upload_dir(self, bucket: str, prefix: str, folder: Path, log=None) -> int:
        files = [p for p in sorted(folder.rglob("*")) if p.is_file()]
        for i, p in enumerate(files, 1):
            rel = p.relative_to(folder).as_posix()
            self.upload(bucket, f"{prefix}/{rel}", p.read_bytes(), _ctype(p))
            if log and (i % 50 == 0 or i == len(files)):
                log(f"올림 {i}/{len(files)}")
        return len(files)

    def public_url(self, bucket: str, key: str) -> str:
        return f"{self.url}/storage/v1/object/public/{bucket}/{key}"


def _ctype(p: Path) -> str:
    if p.suffix == ".u8":
        return "application/octet-stream"
    if p.suffix == ".geojson":
        return "application/geo+json"
    return mimetypes.guess_type(p.name)[0] or "application/octet-stream"


def load_env(path: Path) -> dict:
    """KEY=VALUE 형식 .env 읽기 (따옴표 없이). 없으면 빈 dict."""
    env = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():   # 메모장 BOM 허용
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env
