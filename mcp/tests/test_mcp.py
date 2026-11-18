"""MCP 서버 시험 — 실제 서비스에 닿지 않게 가짜 사이트(web/public/data)와 가짜 Supabase를 띄워 stdio로 대화한다.

python -m pytest mcp/tests   (또는 python mcp/tests/test_mcp.py)
"""
import json
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "web" / "public" / "data"
SERVER = ROOT / "mcp" / "hinnamno_mcp.py"
TOKEN = "test-access-token"

RUN1 = {"id": 1, "model_version": "v1", "base": "S0-C",
        "params": {"tide_offset_m": 0.5, "lateral_flow_factor": 1.0, "internal_flow_factor": 1.5, "upstream_flow_factor": 1.0},
        "params_hash": "9ceeace833435682", "label": None, "status": "done", "created_at": "2026-11-03T01:04:24+00:00",
        "started_at": "2026-11-03T01:04:34+00:00", "finished_at": "2026-11-03T01:13:16+00:00", "worker_id": "knuwater-24core",
        "progress": "완료", "error": None, "wall_seconds": 522.2, "files_prefix": "v1/run-1"}


class State:
    posted = []
    signups = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path.startswith("/data/"):  # 가짜 배포 사이트
            f = DATA / u.path[len("/data/"):]
            if f.is_file():
                return self.send_json(json.loads(f.read_text(encoding="utf-8")))
            return self.send_json({"error": "not found"}, 404)
        if u.path.startswith("/storage/v1/object/public/results/v1/run-1/"):  # run-1 결과 = 게시된 맨홀 ×1.5 파일로 대신
            f = DATA / "v1" / "S2-mh150" / u.path.rsplit("/", 1)[1]
            return self.send_json(json.loads(f.read_text(encoding="utf-8"))) if f.is_file() else self.send_json({}, 404)
        if self.headers.get("apikey") != "anon-key":
            return self.send_json({"message": "no apikey"}, 401)
        if u.path == "/rest/v1/runs":
            if "id" in q:
                rid = int(q["id"][0].split(".")[1])
                return self.send_json([{**RUN1, "kpi": {"inundation_area_km2": {"ge_0.1m": 2.9368}, "onset_time": "2022-09-06T02:20:00+09:00"}}] if rid == 1 else [])
            if "params_hash" in q:
                h = q["params_hash"][0].split(".", 1)[1]
                return self.send_json([RUN1] if h == RUN1["params_hash"] else [])
            if q.get("status", [""])[0].startswith("in.(queued"):
                return self.send_json([])
            return self.send_json([RUN1])
        if u.path == "/rest/v1/worker_heartbeat":
            return self.send_json([{"worker_id": "knuwater-24core", "last_seen": "2026-11-17T11:05:30+00:00", "info": {"cores": 24}}])
        return self.send_json({"message": "unknown"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if u.path == "/auth/v1/signup":
            State.signups += 1
            return self.send_json({"access_token": TOKEN, "refresh_token": "r", "expires_in": 3600, "user": {"id": "anon-user"}})
        if u.path == "/rest/v1/runs":
            assert self.headers.get("Authorization") == f"Bearer {TOKEN}", "토큰 없이 요청"
            assert self.headers.get("Prefer") == "return=representation"
            State.posted.append(body)
            return self.send_json([{**RUN1, "id": 2, "status": "queued", "params": body["params"], "params_hash": body["params_hash"]}], 201)
        return self.send_json({"message": "unknown"}, 404)


class McpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        cls.sess = ROOT / "mcp" / "tests" / ".session_test.json"
        if cls.sess.exists():
            cls.sess.unlink()
        env = {**os.environ, "HINNAMNO_SITE": base, "HINNAMNO_SUPABASE_URL": base, "HINNAMNO_SUPABASE_ANON_KEY": "anon-key",
               "HINNAMNO_SESSION_FILE": str(cls.sess), "PYTHONIOENCODING": "utf-8"}
        cls.p = subprocess.Popen([sys.executable, str(SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=env, text=True, encoding="utf-8")
        cls.n = 0

    @classmethod
    def tearDownClass(cls):
        cls.p.stdin.close()
        cls.p.wait(timeout=5)
        cls.httpd.shutdown()
        if cls.sess.exists():
            cls.sess.unlink()

    def rpc(self, method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method, **({"params": params} if params is not None else {})}
        if not notify:
            type(self).n += 1
            msg["id"] = self.n
        self.p.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.p.stdin.flush()
        if notify:
            return None
        return json.loads(self.p.stdout.readline())

    def tool(self, name, args=None):
        r = self.rpc("tools/call", {"name": name, "arguments": args or {}})["result"]
        text = r["content"][0]["text"]
        return r.get("isError", False), (text if r.get("isError") else json.loads(text))

    def test_1_handshake(self):
        r = self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
        self.assertEqual(r["result"]["protocolVersion"], "2025-06-18")
        self.assertIn("tools", r["result"]["capabilities"])
        self.assertIsNone(self.rpc("notifications/initialized", notify=True))
        tools = self.rpc("tools/list")["result"]["tools"]
        self.assertEqual({t["name"] for t in tools}, {"describe_model", "list_results", "get_kpi", "compare_results",
                                                     "get_timeseries_summary", "request_run", "get_run_status", "worker_status"})
        self.assertIn("error", self.rpc("no/such"))

    def test_2_read_tools(self):
        err, m = self.tool("describe_model")
        self.assertFalse(err)
        self.assertEqual(len(m["바꿀_수_있는_조건"]), 4)
        err, lst = self.tool("list_results")
        self.assertEqual([r["id"] for r in lst["게시된_결과"]][:2], ["S0-E", "S0-C"])
        self.assertEqual(lst["웹_계산"][0]["id"], "run-1")
        err, k = self.tool("get_kpi", {"result": "S0-C"})
        self.assertFalse(err)
        self.assertAlmostEqual(k["KPI"]["침수면적_km2"]["0.1m 이상"], 2.7184)
        self.assertEqual(k["KPI"]["침수_건물_동"]["0.5m 이상"], 1411)
        self.assertEqual(k["이름"], "하천 범람 + 도시 침수")
        err, k1 = self.tool("get_kpi", {"result": "run-1"})
        self.assertFalse(err)
        err, c = self.tool("compare_results", {"a": "S0-E", "b": "S0-C"})
        row = c["표"][0]
        self.assertAlmostEqual(row["차이"], 2.7184 - 1.1771, places=4)
        self.assertEqual(c["시각"]["침수_시작"], {"S0-E": "06:10", "S0-C": "02:30"})
        err, ts = self.tool("get_timeseries_summary", {"result": "S0-C", "rs": "2.613"})
        self.assertFalse(err, ts)
        self.assertAlmostEqual(ts["하천_최대유량_m3s"]["값"], 1264.3, delta=2)  # 10분 출력 최댓값 (KPI는 계산 간격 기준)
        self.assertGreater(ts["맨홀_유입량_m3"], 5_000_000)
        err, ts2 = self.tool("get_timeseries_summary", {"result": "S0-C", "start": "06:00", "end": "09:00"})
        self.assertEqual(ts2["기간"], "06:00–09:00")
        err, msg = self.tool("get_kpi", {"result": "S9"})
        self.assertTrue(err)

    def test_3_request_run(self):
        err, same = self.tool("request_run", {"base": "S0-C", "internal_flow_factor": 1.5, "tide_offset_m": 0.5})
        self.assertFalse(err)
        self.assertEqual(same["조건_해시"], "9ceeace833435682")  # 웹이 계산 1에 저장한 해시와 같음
        self.assertEqual(same["같은_조건_기존_계산"]["id"], "run-1")
        err, bad = self.tool("request_run", {"base": "S0-E", "internal_flow_factor": 1.2})
        self.assertTrue(err)
        err, bad = self.tool("request_run", {"upstream_flow_factor": 2.0})
        self.assertTrue(err)
        err, plan = self.tool("request_run", {"upstream_flow_factor": 1.2, "tide_offset_m": 0.3})
        self.assertNotIn("요청됨", plan)
        self.assertEqual(State.posted, [])
        err, done = self.tool("request_run", {"upstream_flow_factor": 1.2, "tide_offset_m": 0.3, "confirm": True})
        self.assertFalse(err, done)
        self.assertEqual(done["요청됨"]["id"], "run-2")
        self.assertEqual(State.posted[0]["params"]["upstream_flow_factor"], 1.2)
        self.assertEqual(set(State.posted[0]), {"model_version", "base", "params", "params_hash"})
        # 두 번째 요청은 저장한 세션을 다시 쓴다 (익명 사용자를 새로 만들지 않음)
        self.tool("request_run", {"upstream_flow_factor": 1.25, "confirm": True})
        self.assertEqual(State.signups, 1)

    def test_4_status(self):
        err, st = self.tool("get_run_status", {"run": "run-1"})
        self.assertFalse(err)
        self.assertEqual(st["상태"], "done")
        self.assertIn("analysis?a=S0-C&b=run-1", st["화면"]["비교"])
        err, w = self.tool("worker_status")
        self.assertFalse(err)
        self.assertFalse(w["계산_서버"][0]["켜짐"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
