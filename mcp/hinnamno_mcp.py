"""힌남노 침수 다시보기 — MCP 서버 (선택 과제, docs/GUIDE.md §4.3.3).

AI(Claude Desktop 등)가 자연어로 다음을 할 수 있게 한다.
  · 모형·입력 범위 보기, 계산된 결과 목록, KPI 조회, 두 결과 비교, 하천 단면·측방 구조물 시계열 요약
  · 새 조건으로 HEC-RAS 계산 요청(웹 '조건 설정·실행'과 같은 대기열), 진행 상태·계산 서버 상태 확인

원칙
  · 웹과 같은 길만 쓴다: 공개 자료(배포 사이트 /data/…, Storage 공개 결과)와 Supabase 공개(anon) 키 + 익명 로그인.
    service_role 키는 쓰지 않으며 권한은 DB(RLS)가 정한다 — 대기는 전체 5건·1인 2건, 같은 조건은 기존 결과 재사용.
  · 계산 요청은 두 단계: confirm=false로 조건·해시·재사용 여부를 먼저 보여 주고, confirm=true일 때만 대기열에 넣는다.
  · 범위 검사와 조건 해시는 worker/hecras_job.py validate_params · params_hash 와 같은 규칙 (같은 조건 = 같은 해시).
  · 수치는 결과 파일(kpi.json·timeseries.json)에서 읽은 값을 그대로 돌려준다. 해석·판단은 사용자가 한다.

외부 패키지 없이 Python 3.9+ 표준 라이브러리만 쓴다 (MCP stdio = 줄 단위 JSON-RPC 2.0).

환경 변수
  HINNAMNO_SITE            배포 사이트 주소 (예: https://<배포 주소>) — 필수
  HINNAMNO_SUPABASE_URL    Supabase 주소 — 결과 목록·계산 요청에 필요
  HINNAMNO_SUPABASE_ANON_KEY  Supabase 공개(anon) 키 (웹 web/.env.local 의 NEXT_PUBLIC_SUPABASE_ANON_KEY 와 같은 값)
  HINNAMNO_MODEL_VERSION   기본 v1
  HINNAMNO_SESSION_FILE    익명 로그인 세션 저장 위치 (기본: 사용자 폴더 .hinnamno_mcp_session.json)
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SERVER_NAME = "hinnamno-flood"
SERVER_VERSION = "0.1.0"
PROTOCOL_DEFAULT = "2025-06-18"
TIMEOUT = 20


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


SITE = env("HINNAMNO_SITE").rstrip("/")
SB_URL = env("HINNAMNO_SUPABASE_URL").rstrip("/")
SB_KEY = env("HINNAMNO_SUPABASE_ANON_KEY")
VERSION = env("HINNAMNO_MODEL_VERSION", "v1")
SESSION_FILE = Path(env("HINNAMNO_SESSION_FILE") or (Path.home() / ".hinnamno_mcp_session.json"))
WORKER_ONLINE_SEC = 90  # web/lib/supabase.ts 와 같음


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class ToolError(Exception):
    pass


# ------------------------------------------------------------------ HTTP
def http(method: str, url: str, body=None, headers: dict | None = None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    h = {"Accept": "application/json", **(headers or {})}
    if data is not None:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            text = r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            j = json.loads(text)
            msg = j.get("message") or j.get("msg") or j.get("error_description") or j.get("error") or text
        except Exception:
            msg = text[:300]
        raise ToolError(f"{method} {url.split('?')[0]} 응답 {e.code}: {msg}")
    except urllib.error.URLError as e:
        raise ToolError(f"{url.split('?')[0]} 에 접속하지 못했습니다: {e.reason}")
    return json.loads(text) if text else None


def site_json(path: str):
    if not SITE:
        raise ToolError("HINNAMNO_SITE(배포 사이트 주소)가 설정되지 않았습니다.")
    return http("GET", f"{SITE}/data/{path}")


def need_supabase():
    if not (SB_URL and SB_KEY):
        raise ToolError("HINNAMNO_SUPABASE_URL·HINNAMNO_SUPABASE_ANON_KEY 가 설정되지 않아 웹 계산 결과·계산 요청을 쓸 수 없습니다.")


def sb(method: str, path: str, body=None, token: str | None = None, prefer: str | None = None):
    need_supabase()
    h = {"apikey": SB_KEY, "Authorization": f"Bearer {token or SB_KEY}"}
    if prefer:
        h["Prefer"] = prefer
    return http(method, SB_URL + path, body, h)


def storage_url(prefix: str, file: str) -> str:
    return f"{SB_URL}/storage/v1/object/public/results/{prefix}/{file}"


# ------------------------------------------------------------------ 익명 로그인 (웹과 같은 방식, 세션은 파일에 두고 다시 씀)
def _save_session(a: dict) -> dict:
    s = {
        "access_token": a["access_token"],
        "refresh_token": a["refresh_token"],
        "expires_at": a.get("expires_at") or int(time.time()) + int(a.get("expires_in", 3600)),
        "user_id": a["user"]["id"],
    }
    try:
        SESSION_FILE.write_text(json.dumps(s), encoding="utf-8")
    except OSError as e:
        log("세션 저장 실패:", e)
    return s


def session() -> dict:
    s = None
    try:
        s = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        s = None
    if s and s.get("expires_at", 0) - 60 > time.time():
        return s
    if s and s.get("refresh_token"):
        try:
            return _save_session(sb("POST", "/auth/v1/token?grant_type=refresh_token", {"refresh_token": s["refresh_token"]}))
        except ToolError as e:
            log("세션 갱신 실패, 새로 로그인:", e)
    return _save_session(sb("POST", "/auth/v1/signup", {"data": {}}))


# ------------------------------------------------------------------ 모형 설정 · 조건 검사 (worker/hecras_job.py 와 같은 규칙)
_model_cache: dict | None = None


def model_info() -> dict:
    global _model_cache
    if _model_cache is None:
        _model_cache = site_json(f"{VERSION}/model.json")
    return _model_cache


def validate_params(run_cfg: dict, base: str, params: dict) -> dict:
    if base not in run_cfg["bases"]:
        raise ToolError(f"기준 계산 {base!r} 없음 (가능: {', '.join(run_cfg['bases'])})")
    known = {p["id"]: p for p in run_cfg["params"]}
    unknown = set(params) - set(known)
    if unknown:
        raise ToolError(f"알 수 없는 입력 항목: {', '.join(sorted(unknown))}")
    out = {}
    for pid, p in known.items():
        if base not in p.get("bases", run_cfg["bases"]):
            if pid in params and float(params[pid]) != p["default"]:
                raise ToolError(f"{p['label']}은(는) {base}에 쓸 수 없습니다")
            continue
        v = float(params.get(pid, p["default"]))
        if not math.isfinite(v) or v < p["min"] - 1e-9 or v > p["max"] + 1e-9:
            raise ToolError(f"{p['label']} {v} 가 범위 {p['min']}–{p['max']} 밖입니다")
        out[pid] = round(v, 6)
    return out


def params_hash(model_version: str, base: str, params: dict) -> str:
    s = json.dumps({"v": model_version, "base": base, "p": params}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


# ------------------------------------------------------------------ 결과 찾기
def short_label(label: str) -> str:
    s = re.sub(r"^힌남노\s*", "", label or "")
    s = re.sub(r"\s*\(맨홀 월류량\s*(×[\d.]+)\)", r" \1", s)
    s = re.sub(r"외수\s*\+\s*내수", "하천 범람 + 도시 침수", s)
    return s.replace("외수", "하천 범람").replace("내수", "도시 침수")


RUN_COLS = "id,model_version,base,params,params_hash,label,status,created_at,started_at,finished_at,worker_id,progress,error,wall_seconds,files_prefix"


def published() -> list[dict]:
    idx = site_json("index.json")
    return [s for s in idx.get("scenarios", []) if s.get("model_version") == VERSION]


def web_runs(limit: int = 30) -> list[dict]:
    return sb("GET", f"/rest/v1/runs?select={RUN_COLS}&model_version=eq.{VERSION}&order=created_at.desc&limit={limit}")


def get_run(run_id: int) -> dict:
    rows = sb("GET", f"/rest/v1/runs?select={RUN_COLS},kpi&id=eq.{int(run_id)}")
    if not rows:
        raise ToolError(f"계산 {run_id}번이 없습니다.")
    return rows[0]


def resolve(result: str) -> dict:
    """'S0-C' 같은 게시 결과 이름, 또는 'run-3'·'3'·'계산 3' 같은 웹 계산 번호 → {id, label, file(name) -> url}"""
    r = str(result).strip()
    m = re.fullmatch(r"(?:run-?|계산\s*)?(\d+)(?:번)?", r, flags=re.I)
    if m:
        row = get_run(int(m.group(1)))
        if row["status"] != "done" or not row.get("files_prefix"):
            raise ToolError(f"계산 {row['id']}번은 아직 끝나지 않았습니다 (상태: {row['status']}).")
        prefix = row["files_prefix"]
        return {"id": f"run-{row['id']}", "label": short_label(row.get("label") or f"{row['base']} (계산 {row['id']})"),
                "url": lambda f, p=prefix: storage_url(p, f), "run": row}
    for s in published():
        if s["scenario_id"].lower() == r.lower():
            return {"id": s["scenario_id"], "label": short_label(s["label"]), "url": lambda f, p=s["path"]: f"{SITE}/data/{p}/{f}"}
    names = ", ".join(s["scenario_id"] for s in published())
    raise ToolError(f"결과 {result!r}를 찾지 못했습니다. 게시된 결과: {names} · 웹 계산은 'run-번호'")


def fetch(res: dict, file: str, optional: bool = False):
    try:
        return http("GET", res["url"](file))
    except ToolError:
        if optional:
            return None
        raise


def hhmm(t: str | None) -> str | None:
    return t[11:16] if t and len(t) >= 16 else t


def kpi_digest(k: dict, bld: dict | None) -> dict:
    a = k.get("inundation_area_km2", {})
    river = k.get("river", {})
    q = river.get("q_max_anywhere", {})
    out = {
        "침수면적_km2": {"0.1m 이상": a.get("ge_0.1m"), "0.5m 이상": a.get("ge_0.5m"), "1.0m 이상": a.get("ge_1.0m"), "2.0m 이상": a.get("ge_2.0m")},
        "침수_시작": hhmm(k.get("onset_time")),
        "순간_최대_침수면적": {"km2": k.get("peak_instant_area", {}).get("km2"), "시각": hhmm(k.get("peak_instant_area", {}).get("time"))},
        "0.3m_이상_1시간_넘게_침수_km2": (k.get("duration_ge_0.3m") or {}).get("area_km2_ge_1h"),
        "최대_침수심_99분위_m": (k.get("max_depth_m") or {}).get("p99_of_flooded"),
        "하천_최대유량": {"m3s": q.get("q_max_m3s"), "RS": q.get("rs"), "시각": hhmm(q.get("q_max_time"))},
        "하구_최고수위_EL_m": (river.get("outlet") or {}).get("ws_max_m"),
        "맨홀_유입_총량_m3": (k.get("internal_inflow") or {}).get("total_volume_m3"),
        "측방_구조물": [
            {"이름": l.get("name"), "2D": l.get("to_2d_area"), "첨두_m3s": l.get("peak_m3s"), "시가지로_m3": l.get("volume_to_2d_m3"), "순_m3": l.get("net_volume_m3")}
            for l in k.get("lateral_structures") or []
        ],
        "체적오차_%": k.get("volume_error_pct"),
        "계산시간_s": (k.get("compute_seconds") or {}).get("Complete Process"),
        "모형버전": k.get("model_version"),
    }
    if bld:
        out["침수_건물_동"] = {"0.1m 이상": bld["flooded"].get("ge_0.1m"), "0.5m 이상": bld["flooded"].get("ge_0.5m"),
                          "1.0m 이상": bld["flooded"].get("ge_1.0m"), "기준_건물수": bld.get("buildings_in_domain")}
    return out


# ------------------------------------------------------------------ 도구
def t_describe_model(_: dict) -> dict:
    m = model_info()
    run = m.get("run", {})
    return {
        "모형": m.get("description"),
        "모형버전": m.get("model_version"),
        "기준_계산": {k: {"이름": short_label(v.get("label", k)), "프로젝트": m.get("projects", {}).get(k)} for k, v in run.get("bases", {}).items()},
        "바꿀_수_있는_조건": [
            {"id": p["id"], "이름": p["label"], "범위": [p["min"], p["max"]], "간격": p["step"], "기본값": p["default"],
             "적용_기준": p.get("bases", list(run.get("bases", {})))}
            for p in run.get("params", [])
        ],
        "원본에서_바꾼_점": m.get("changes_from_original"),
        "주의": m.get("notes"),
        "계산시간": "24코어 PC 1회 약 9분 (부정류 1.5~3분 + 1D 후처리 약 4분 + 변환·업로드)",
    }


def t_list_results(_: dict) -> dict:
    out = {"게시된_결과": [{"id": s["scenario_id"], "이름": short_label(s["label"]), "바꾼_조건": s.get("params")} for s in published()]}
    if SB_URL and SB_KEY:
        rows = web_runs()
        out["웹_계산"] = [
            {"id": f"run-{r['id']}", "상태": r["status"], "기준": r["base"], "조건": r["params"],
             "요청": r["created_at"], "끝": r.get("finished_at"), "전체_초": r.get("wall_seconds")}
            for r in rows
        ]
    else:
        out["웹_계산"] = "Supabase 설정이 없어 조회하지 않음"
    return out


def t_get_kpi(a: dict) -> dict:
    res = resolve(a["result"])
    k = fetch(res, "kpi.json")
    bld = fetch(res, "buildings.json", optional=True)
    return {"결과": res["id"], "이름": res["label"], "KPI": kpi_digest(k, bld), "정의": k.get("definitions")}


def _num(x):
    return x if isinstance(x, (int, float)) else None


def t_compare_results(a: dict) -> dict:
    ra, rb = resolve(a["a"]), resolve(a["b"])
    ka, kb = kpi_digest(fetch(ra, "kpi.json"), fetch(ra, "buildings.json", True)), kpi_digest(fetch(rb, "kpi.json"), fetch(rb, "buildings.json", True))

    def row(name, va, vb):
        va, vb = _num(va), _num(vb)
        d = None if va is None or vb is None else round(vb - va, 4)
        pct = None if d is None or not va else round(100 * d / va, 1)
        return {"항목": name, ra["id"]: va, rb["id"]: vb, "차이": d, "증감_%": pct}

    rows = [
        row("침수면적 0.1m 이상 (km²)", ka["침수면적_km2"]["0.1m 이상"], kb["침수면적_km2"]["0.1m 이상"]),
        row("침수면적 0.5m 이상 (km²)", ka["침수면적_km2"]["0.5m 이상"], kb["침수면적_km2"]["0.5m 이상"]),
        row("침수면적 1.0m 이상 (km²)", ka["침수면적_km2"]["1.0m 이상"], kb["침수면적_km2"]["1.0m 이상"]),
        row("순간 최대 침수면적 (km²)", ka["순간_최대_침수면적"]["km2"], kb["순간_최대_침수면적"]["km2"]),
        row("최대 침수심 99분위 (m)", ka["최대_침수심_99분위_m"], kb["최대_침수심_99분위_m"]),
        row("하천 최대유량 (m³/s)", ka["하천_최대유량"]["m3s"], kb["하천_최대유량"]["m3s"]),
        row("하구 최고수위 (EL. m)", ka["하구_최고수위_EL_m"], kb["하구_최고수위_EL_m"]),
        row("맨홀 유입 총량 (m³)", ka["맨홀_유입_총량_m3"], kb["맨홀_유입_총량_m3"]),
    ]
    if "침수_건물_동" in ka and "침수_건물_동" in kb:
        rows.append(row("침수 건물 0.5m 이상 (동)", ka["침수_건물_동"]["0.5m 이상"], kb["침수_건물_동"]["0.5m 이상"]))
    return {
        "기준": f"{ra['id']} {ra['label']}", "비교": f"{rb['id']} {rb['label']}", "표": rows,
        "시각": {"침수_시작": {ra["id"]: ka["침수_시작"], rb["id"]: kb["침수_시작"]},
               "순간_최대_시각": {ra["id"]: ka["순간_최대_침수면적"]["시각"], rb["id"]: kb["순간_최대_침수면적"]["시각"]}},
        "주의": "비교는 같은 모형 버전끼리만. 측방 구조물 RS 7.65 값·좌안 2D 수심은 신뢰도가 낮음(모형 설명 참고)",
    }


def _peak(vals, times, i0=0, i1=None):
    i1 = len(vals) - 1 if i1 is None else i1
    best = None
    for i in range(i0, min(i1, len(vals) - 1) + 1):
        v = vals[i]
        if v is not None and (best is None or v > best[0]):
            best = (v, i)
    return None if best is None else {"값": round(best[0], 3), "시각": hhmm(times[best[1]])}


def _window(times, start: str | None, end: str | None):
    def idx(hm, default):
        if not hm:
            return default
        for i, t in enumerate(times):
            if hhmm(t) >= hm:
                return i
        return len(times) - 1
    i0, i1 = idx(start, 0), idx(end, len(times) - 1)
    if i1 <= i0:
        raise ToolError("기간 끝이 시작보다 빨라요 (HH:MM, 예: 06:00–09:00).")
    return i0, i1


def t_get_timeseries_summary(a: dict) -> dict:
    res = resolve(a["result"])
    ts = fetch(res, "timeseries.json")
    times = ts["times"]
    i0, i1 = _window(times, a.get("start"), a.get("end"))
    st = ts["river_stations"]
    rs = str(a.get("rs") or "").strip()
    if rs and rs not in st:
        raise ToolError(f"하천 단면 RS {rs} 없음 — {st[0]}(상류)…{st[-1]}(하구) 중에서")
    j = st.index(rs) if rs else len(st) - 1
    q = [row[j] for row in ts["river_flow_m3s"]]
    ws = [row[j] for row in ts["river_ws_m"]]
    area = ts.get("inundation_area_ge_0.1m_km2") or []
    mh = ts.get("internal_inflow_total_m3s") or []
    vol = 0.0
    for i in range(i0, min(i1, len(mh) - 1)):
        dt = (_iso(times[i + 1]) - _iso(times[i]))
        vol += (mh[i] + mh[i + 1]) / 2 * dt
    lat = {}
    for name, vals in (ts.get("lateral_flow_m3s") or {}).items():
        to2d = back = 0.0
        for i in range(i0, min(i1, len(vals) - 1)):
            dt = (_iso(times[i + 1]) - _iso(times[i]))
            v = (vals[i] + vals[i + 1]) / 2 * dt
            to2d += max(v, 0); back += max(-v, 0)
        lat[name] = {"첨두_하천→시가지": _peak(vals, times, i0, i1), "시가지로_m3": round(to2d), "하천으로_m3": round(back),
                     "주의": "10분 값 기준 참고값 (RS 7.65는 실행마다 방향이 바뀌는 불안정 구간)"}
    return {
        "결과": res["id"], "이름": res["label"], "기간": f"{hhmm(times[i0])}–{hhmm(times[i1])}", "하천_단면": f"RS {st[j]}",
        "하천_최대유량_m3s": _peak(q, times, i0, i1), "하천_최고수위_EL_m": _peak(ws, times, i0, i1),
        "최대_침수면적_km2": _peak(area, times, i0, i1) if area else None,
        "맨홀_유입량_m3": round(vol) if mh and any(mh) else 0,
        "측방_구조물": lat,
        "출력_간격": "10분 (KPI의 최댓값은 계산 간격 기준이라 조금 다를 수 있음)",
    }


def _iso(t: str) -> float:
    from datetime import datetime
    return datetime.fromisoformat(t).timestamp()


def t_request_run(a: dict) -> dict:
    m = model_info()
    cfg = m["run"]
    base = a.get("base", "S0-C")
    given = {k: a[k] for k in ("upstream_flow_factor", "lateral_flow_factor", "internal_flow_factor", "tide_offset_m") if a.get(k) is not None}
    params = validate_params(cfg, base, given)
    h = params_hash(VERSION, base, params)
    changed = {p["id"]: params[p["id"]] for p in cfg["params"] if p["id"] in params and params[p["id"]] != p["default"]}
    need_supabase()
    same = sb("GET", f"/rest/v1/runs?select={RUN_COLS}&model_version=eq.{VERSION}&params_hash=eq.{h}"
                     f"&status=in.(queued,running,done)&order=created_at.desc&limit=1")
    plan = {"기준": base, "조건": params, "바꾼_조건": changed or "없음 (힌남노 조건 그대로)", "조건_해시": h}
    if not changed:
        plan["안내"] = "바꾼 조건이 없어 게시된 기준 결과(" + base + ")와 같습니다. get_kpi로 보면 됩니다."
        return plan
    if same:
        r = same[0]
        plan["같은_조건_기존_계산"] = {"id": f"run-{r['id']}", "상태": r["status"]}
        plan["안내"] = "같은 조건의 계산이 이미 있어 새로 계산하지 않습니다. get_run_status로 확인하세요."
        return plan
    if not a.get("confirm"):
        plan["안내"] = "아직 요청하지 않았습니다. 이대로 HEC-RAS 계산(약 9분)을 대기열에 넣으려면 confirm=true로 다시 부르세요."
        return plan
    s = session()
    rows = sb("POST", f"/rest/v1/runs?select={RUN_COLS}", {"model_version": VERSION, "base": base, "params": params, "params_hash": h},
              token=s["access_token"], prefer="return=representation")
    r = rows[0]
    plan["요청됨"] = {"id": f"run-{r['id']}", "상태": r["status"], "요청_시각": r["created_at"]}
    plan["안내"] = "대기열에 넣었습니다. 계산 서버가 켜져 있으면 약 9분 뒤 끝납니다. get_run_status로 확인하세요."
    if SITE:
        plan["화면"] = {"지도": f"{SITE}/?run={r['id']}", "조건 설정·실행": f"{SITE}/run"}
    return plan


def t_get_run_status(a: dict) -> dict:
    rid = int(re.sub(r"\D", "", str(a["run"])) or 0)
    r = get_run(rid)
    out = {"id": f"run-{r['id']}", "상태": r["status"], "기준": r["base"], "조건": r["params"], "진행": r.get("progress"),
           "요청": r["created_at"], "시작": r.get("started_at"), "끝": r.get("finished_at"), "계산_서버": r.get("worker_id")}
    if r["status"] == "running" and r.get("started_at"):
        out["경과_초"] = round(time.time() - _iso(r["started_at"].replace("Z", "+00:00")))
    if r["status"] == "done":
        k = r.get("kpi") or {}
        out["전체_초"] = r.get("wall_seconds")
        out["침수면적_km2"] = k.get("inundation_area_km2")
        out["침수_시작"] = hhmm(k.get("onset_time"))
        if SITE:
            out["화면"] = {"지도": f"{SITE}/?run={r['id']}", "비교": f"{SITE}/analysis?a={r['base']}&b=run-{r['id']}"}
    if r["status"] == "failed":
        out["오류"] = r.get("error")
    return out


def t_worker_status(_: dict) -> dict:
    rows = sb("GET", "/rest/v1/worker_heartbeat?select=worker_id,last_seen,info&order=last_seen.desc")
    out = []
    for w in rows:
        age = time.time() - _iso(w["last_seen"].replace("Z", "+00:00"))
        info = w.get("info") or {}
        out.append({"계산_서버": w["worker_id"], "켜짐": age < WORKER_ONLINE_SEC, "마지막_소식_초_전": round(age),
                    "코어": info.get("cores"), "지금_계산": info.get("current_run"), "모형버전": info.get("model_versions")})
    queued = sb("GET", f"/rest/v1/runs?select=id,status&model_version=eq.{VERSION}&status=in.(queued,running)&order=created_at")
    return {"계산_서버": out, "대기·계산_중": [f"run-{q['id']} ({q['status']})" for q in queued]}


RESULT = {"type": "string", "description": "게시 결과 이름(S0-E 하천 범람만, S0-C 하천 범람+도시 침수, S2-mh050, S2-mh150) 또는 웹 계산 'run-번호'"}
TOOLS = [
    ("describe_model", "냉천 HEC-RAS 6.6 1D–2D 모형 요약과 웹에서 바꿀 수 있는 조건·범위를 보여 준다.", {}, [], t_describe_model),
    ("list_results", "계산된 결과 목록: 미리 게시된 결과와 웹에서 요청한 계산(상태 포함).", {}, [], t_list_results),
    ("get_kpi", "결과 하나의 주요 지표(침수면적·침수 시작·하천 첨두유량·하구 수위·침수 건물·체적오차 등).", {"result": RESULT}, ["result"], t_get_kpi),
    ("compare_results", "두 결과의 주요 지표 차이와 증감률(기준 a → 비교 b).",
     {"a": {**RESULT, "description": "기준 결과 " + RESULT["description"]}, "b": {**RESULT, "description": "비교 결과 " + RESULT["description"]}}, ["a", "b"], t_compare_results),
    ("get_timeseries_summary", "기간·하천 단면을 골라 하천 최대유량·최고수위, 최대 침수면적, 맨홀 유입량, 측방 구조물 월류량을 요약한다.",
     {"result": RESULT, "rs": {"type": "string", "description": "하천 단면 RS (예 7.600, 2.613, 0.000). 없으면 하구"},
      "start": {"type": "string", "description": "기간 시작 HH:MM (예 06:00). 없으면 처음"},
      "end": {"type": "string", "description": "기간 끝 HH:MM. 없으면 끝"}}, ["result"], t_get_timeseries_summary),
    ("request_run", "새 조건으로 HEC-RAS 계산을 웹 대기열에 요청한다. confirm=false(기본)이면 조건·해시·기존 결과 재사용 여부만 보여 주고, confirm=true일 때만 실제로 요청한다.",
     {"base": {"type": "string", "enum": ["S0-E", "S0-C"], "description": "기준 계산: S0-E 하천 범람만, S0-C 하천 범람+도시 침수 (기본 S0-C)"},
      "upstream_flow_factor": {"type": "number", "description": "상류 유입 배율 0.5–1.5"},
      "lateral_flow_factor": {"type": "number", "description": "측방 유입 배율 0.5–1.5"},
      "internal_flow_factor": {"type": "number", "description": "맨홀 월류량 배율 0.5–1.5 (S0-C만)"},
      "tide_offset_m": {"type": "number", "description": "하류 조위 보정 0–1.0 m"},
      "confirm": {"type": "boolean", "description": "true면 실제로 대기열에 넣음 (약 9분 계산)"}}, [], t_request_run),
    ("get_run_status", "웹 계산 하나의 상태·진행 단계·경과 시간, 끝났으면 침수면적과 화면 주소.",
     {"run": {"type": "string", "description": "계산 번호 (예 run-3 또는 3)"}}, ["run"], t_get_run_status),
    ("worker_status", "계산 서버(HEC-RAS 워커 PC)가 켜져 있는지와 대기 중인 계산.", {}, [], t_worker_status),
]
TOOL_MAP = {t[0]: t for t in TOOLS}


def tool_list():
    return [{"name": n, "description": d, "inputSchema": {"type": "object", "properties": props, "required": req}}
            for n, d, props, req, _ in TOOLS]


def call_tool(name: str, args: dict) -> dict:
    if name not in TOOL_MAP:
        return {"content": [{"type": "text", "text": f"알 수 없는 도구: {name}"}], "isError": True}
    try:
        out = TOOL_MAP[name][4](args or {})
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False, indent=1)}]}
    except ToolError as e:
        return {"content": [{"type": "text", "text": str(e)}], "isError": True}
    except Exception as e:  # 예상 못 한 오류도 대화를 끊지 않고 알려 준다
        log("도구 오류:", repr(e))
        return {"content": [{"type": "text", "text": f"{name} 실행 중 오류: {e!r}"}], "isError": True}


# ------------------------------------------------------------------ JSON-RPC (stdio)
def handle(msg: dict):
    mid, method = msg.get("id"), msg.get("method")
    if method is None:  # 응답 메시지(서버가 요청한 적 없음) — 무시
        return None
    if mid is None:  # 알림 (notifications/initialized 등)
        return None
    if method == "initialize":
        pv = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL_DEFAULT
        result = {"protocolVersion": pv, "capabilities": {"tools": {"listChanged": False}},
                  "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                  "instructions": "냉천 힌남노 HEC-RAS 침수 결과 조회·비교와 계산 요청. 계산 요청은 사용자가 조건을 확인한 뒤 confirm=true로만."}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": tool_list()}
    elif method == "tools/call":
        p = msg.get("params") or {}
        result = call_tool(p.get("name", ""), p.get("arguments") or {})
    elif method in ("resources/list", "prompts/list"):
        result = {method.split("/")[0]: []}
    else:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"지원하지 않는 메서드: {method}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def self_check():
    """python hinnamno_mcp.py --check — 설정과 접속을 확인한다 (읽기 도구만 부르고 계산은 요청하지 않음)."""
    print(f"site={SITE or '(없음)'}  supabase={'설정됨' if SB_URL and SB_KEY else '(없음)'}  model={VERSION}")
    for name, args in (("describe_model", {}), ("list_results", {}), ("get_kpi", {"result": "S0-C"}),
                       ("compare_results", {"a": "S0-E", "b": "S0-C"}), ("worker_status", {})):
        r = call_tool(name, args)
        text = r["content"][0]["text"]
        print(f"\n[{'실패' if r.get('isError') else '정상'}] {name}")
        print(text if len(text) < 1500 else text[:1500] + " …")


def main():
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    if "--check" in sys.argv:
        self_check()
        return
    log(f"{SERVER_NAME} {SERVER_VERSION} 시작 · site={SITE or '(없음)'} · supabase={'설정됨' if SB_URL and SB_KEY else '(없음)'}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "JSON 해석 실패"}}
        else:
            out = [handle(m) for m in msg] if isinstance(msg, list) else handle(msg)
            if isinstance(out, list):
                out = [o for o in out if o] or None
        if out:
            sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
