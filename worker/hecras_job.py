"""웹 실행 작업 1건 — 기준 모형 복사 → u01에 조건 적용 → HEC-RAS 계산 → 완료 확인.

작업 진행 가이드 Step 5. Supabase 연결(run_worker.py)과 로컬 시험(run_local.py)이 같이 쓴다.

- 설정은 pipeline/models/<버전>.json 의 "run" 항목에서 읽는다 (기준 계획, 지형, 입력 항목·범위).
  모형 값(경계 이름, RS 번호 등)을 코드에 적지 않는다 — 경계 종류는 u01 구조로 판별한다.
    river_flow    : 하천 경계(Boundary Location에 하천 이름이 있음)의 "Flow Hydrograph="
    lateral_flow  : "Lateral Inflow Hydrograph=" (하천 측방 유입)
    internal_flow : 2D 영역 경계(하천 이름 없음, 2D 영역 이름 있음)의 "Flow Hydrograph=" (맨홀 월류)
    stage         : "Stage Hydrograph=" (하류 조위)
- 원본(C:\\Hec-Ras\\KNUWATER\\Pohang)과 기준 복사본(Pohang_web)은 건드리지 않는다. 작업 폴더에서만 고친다.
- Ras.exe -c 는 후처리가 끝나기 전에 돌아올 수 있다 → 결과 HDF 계산 메시지에 "Complete Process"가
  생기고 파일 크기가 멈출 때까지 기다린다.
- Ras.exe에는 프로젝트·계획 파일 이름을 따옴표로 감싸서 넘긴다 (ras_command). 따옴표가 없으면 Ras.exe가
  '명령줄 매개변수 오류' 창을 띄우고 멈춘다 (2026-11-02 T1·T2가 1시간씩 멈춘 원인, 화면에서 확인).
- HEC-RAS 입력 파일은 줄 끝이 CRLF다. 고칠 때 줄 끝을 그대로 두고, 고친 뒤 줄 수·줄 끝 개수가 같은지 확인한다.
  (처음에는 CR 하나가 빠진 것을 멈춤 원인으로 의심했으나, 같은 계획 파일을 배치 파일로 돌리면 정상 계산됨
  → 원인은 아니었다. 원본과 같은 형식을 지키려고 고쳐 둔다.)
- 계산 중 대화상자가 뜨거나 파일 쓰기가 오래 멈추면 바로 끝내고 창 글자를 오류에 남긴다 (ras_windows.py).
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from . import ras_windows as RW

REPO = Path(__file__).resolve().parents[1]
DEFAULT_RAS = r"C:\Program Files (x86)\HEC\HEC-RAS\6.6\Ras.exe"

TABLE_KEYS = ("Flow Hydrograph", "Lateral Inflow Hydrograph", "Stage Hydrograph")
TABLE_RE = re.compile(r"^(Flow Hydrograph|Lateral Inflow Hydrograph|Stage Hydrograph)=\s*(\d+)\s*$")
FIELD = 8          # u01 표는 8칸 고정 폭, 한 줄 10개
PER_LINE = 10


# ---------------------------------------------------------------- 설정
def load_model(model_version: str) -> dict:
    path = REPO / "pipeline" / "models" / f"{model_version}.json"
    info = json.loads(path.read_text(encoding="utf-8"))
    if "run" not in info:
        raise ValueError(f"{path.name}에 run 설정이 없습니다")
    return info


def validate_params(run_cfg: dict, base: str, params: dict) -> dict:
    """입력값을 범위 안인지 확인하고, 빠진 항목은 기본값으로 채운다. 범위 밖이면 ValueError."""
    if base not in run_cfg["bases"]:
        raise ValueError(f"기준 시나리오 {base!r} 없음 (가능: {', '.join(run_cfg['bases'])})")
    known = {p["id"]: p for p in run_cfg["params"]}
    unknown = set(params) - set(known)
    if unknown:
        raise ValueError(f"알 수 없는 입력 항목: {', '.join(sorted(unknown))}")
    out = {}
    for pid, p in known.items():
        if base not in p.get("bases", run_cfg["bases"]):
            if pid in params and float(params[pid]) != p["default"]:
                raise ValueError(f"{p['label']}은(는) {base}에 쓸 수 없습니다")
            continue
        v = float(params.get(pid, p["default"]))
        if not math.isfinite(v) or v < p["min"] - 1e-9 or v > p["max"] + 1e-9:
            raise ValueError(f"{p['label']} {v} 가 범위 {p['min']}–{p['max']} 밖입니다")
        out[pid] = round(v, 6)
    return out


def params_hash(model_version: str, base: str, params: dict) -> str:
    """같은 조건이면 같은 값 — 이미 계산된 결과를 다시 쓰는 데 쓴다 (가이드라인 §4.2.3)."""
    s = json.dumps({"v": model_version, "base": base, "p": params}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------- u01 표 읽기·쓰기
def parse_fields(line: str) -> list[float]:
    vals = []
    for i in range(0, len(line.rstrip("\r\n")), FIELD):
        s = line[i:i + FIELD].strip()
        if s:
            vals.append(float(s))
    return vals


def fmt8(v: float) -> str:
    """8칸 안에 들어가는 가장 정밀한 숫자 문자열 (오른쪽 정렬)."""
    if v == 0 or abs(v) < 5e-6:
        return "0".rjust(FIELD)
    for d in range(5, -1, -1):
        s = f"{v:.{d}f}"
        if "." in s:
            s = s.rstrip("0").rstrip(".")
        if len(s) <= FIELD:
            return s.rjust(FIELD)
    raise ValueError(f"u01 표 칸(8자)에 들어가지 않는 값: {v}")


def format_table(vals: list[float]) -> list[str]:
    return ["".join(fmt8(v) for v in vals[i:i + PER_LINE]) for i in range(0, len(vals), PER_LINE)]


@dataclass
class Table:
    key: str            # Flow Hydrograph / Lateral Inflow Hydrograph / Stage Hydrograph
    target: str         # river_flow / lateral_flow / internal_flow / stage
    location: str       # 사람이 읽는 위치 (하천 RS 또는 2D 영역/BC Line)
    header: int         # 머리줄 번호 (0부터)
    n: int
    values: list[float]


def _location(bl_line: str) -> tuple[str, str]:
    """Boundary Location 줄 → (종류, 위치). 종류: river / area2d / other"""
    f = [x.strip() for x in bl_line.split("=", 1)[1].split(",")]
    f += [""] * (9 - len(f))
    river, reach, rs, area, bcline = f[0], f[1], f[2], f[5], f[7]
    if river:
        return "river", f"{river} {reach} RS {rs}"
    if area:
        return "area2d", f"{area}/{bcline}"
    return "other", ",".join(x for x in f if x)


def find_tables(lines: list[str]) -> list[Table]:
    tables, kind, loc = [], "other", ""
    i = 0
    while i < len(lines):
        ln = lines[i].rstrip("\r\n")
        if ln.startswith("Boundary Location="):
            kind, loc = _location(ln)
        m = TABLE_RE.match(ln)
        if m:
            key, n = m.group(1), int(m.group(2))
            nlines = math.ceil(n / PER_LINE)
            vals = []
            for j in range(i + 1, i + 1 + nlines):
                vals += parse_fields(lines[j])
            if len(vals) != n:
                raise ValueError(f"{i + 1}번째 줄 {key}: 값 {len(vals)}개, 머리줄은 {n}개")
            if key == "Flow Hydrograph":
                target = "river_flow" if kind == "river" else "internal_flow" if kind == "area2d" else "other_flow"
            elif key == "Lateral Inflow Hydrograph":
                target = "lateral_flow"
            else:
                target = "stage"
            tables.append(Table(key, target, loc, i, n, vals))
            i += 1 + nlines
            continue
        i += 1
    return tables


def apply_params(u01: Path, run_cfg: dict, params: dict) -> dict:
    """u01 표에 배율·보정값을 적용해 같은 파일에 쓴다. 바꾼 표 수와 바꾸기 전후 합계를 돌려준다.
    모든 값이 기본값이면 파일을 건드리지 않는다 (기준 결과와 같은 입력을 보장)."""
    txt = u01.read_bytes().decode("latin-1")
    lines, nl, tail = _split_lines(txt)
    tables = find_tables(lines)
    by_target = {p["target"]: p for p in run_cfg["params"]}
    summary = {}
    changed = False
    for t in tables:
        p = by_target.get(t.target)
        s = summary.setdefault(t.target, {"tables": 0, "sum_before": 0.0, "sum_after": 0.0})
        s["tables"] += 1
        s["sum_before"] += sum(t.values)
        if p is None or p["id"] not in params or params[p["id"]] == p["default"]:
            s["sum_after"] += sum(t.values)
            continue
        v = params[p["id"]]
        new = [x * v for x in t.values] if p["op"] == "mul" else [x + v for x in t.values]
        new_lines = format_table(new)
        nlines = math.ceil(t.n / PER_LINE)
        assert len(new_lines) == nlines
        lines[t.header + 1:t.header + 1 + nlines] = new_lines
        # 쓴 글자를 다시 읽어 합계를 낸다 → 8칸 반올림 영향까지 확인
        s["sum_after"] += sum(x for ln in new_lines for x in parse_fields(ln))
        changed = True
    if changed:
        new_txt = nl.join(lines) + tail
        _check_same_layout(txt, new_txt, u01.name)
        u01.write_bytes(new_txt.encode("latin-1"))
    for s in summary.values():
        s["sum_before"] = round(s["sum_before"], 4)
        s["sum_after"] = round(s["sum_after"], 4)
    return {"changed": changed, "targets": summary}


def _split_lines(txt: str) -> tuple[list[str], str, str]:
    """줄 목록, 줄 끝 문자(CRLF/LF), 파일 끝 줄바꿈. str.splitlines()는 \\x85·\\x0c 등에서도 잘라서 쓰지 않는다."""
    nl = "\r\n" if "\r\n" in txt else "\n"
    tail = nl if txt.endswith(nl) else ""
    body = txt[: len(txt) - len(tail)]
    return body.split(nl), nl, tail


def _check_same_layout(old: str, new: str, name: str) -> None:
    """고친 파일의 줄 수·CRLF 수·LF 수가 원래와 같은지 — 다르면 쓰지 않고 멈춘다."""
    for what, a, b in (("CRLF", old.count("\r\n"), new.count("\r\n")),
                       ("LF", old.count("\n"), new.count("\n")),
                       ("CR", old.count("\r"), new.count("\r"))):
        if a != b:
            raise ValueError(f"{name}: 고친 뒤 {what} 개수가 달라짐 ({a} → {b}) — 파일을 쓰지 않음")


def set_postprocess(plan: Path, on: bool) -> None:
    """계획 파일의 1D 후처리 실행 여부. 끄면 계산 시간이 약 4분 줄어든다 (Step 1 측정).
    값 칸만 바꾸고 줄 끝(CR)은 그대로 둔다. HEC-RAS 표기: 켬 'Run PostProcess=-1 ', 끔 'Run PostProcess= 0 '."""
    txt = plan.read_bytes().decode("latin-1")
    new, n = re.subn(r"^Run PostProcess=[ \t]*-?\d+[ \t]*(?=\r?$)",
                     "Run PostProcess=" + ("-1 " if on else " 0 "), txt, flags=re.M)
    if n != 1:
        raise ValueError(f"{plan.name}에서 'Run PostProcess=' 줄을 찾지 못함 ({n}개)")
    _check_same_layout(txt, new, plan.name)
    if new != txt:
        plan.write_bytes(new.encode("latin-1"))


# ---------------------------------------------------------------- 작업 폴더
def make_job_dir(base_path: Path, job_dir: Path, ignore: list[str]) -> Path:
    """기준 복사본을 폴더 구조째 복사 (상대 경로 ..\\NC090901\\Terrain 때문에). 지난 결과 파일은 뺀다."""
    if job_dir.exists():
        raise FileExistsError(f"작업 폴더가 이미 있음: {job_dir}")

    def _ign(_d, names):
        return {n for n in names if any(fnmatch.fnmatch(n, pat) for pat in ignore)}

    shutil.copytree(base_path, job_dir, ignore=_ign)
    return job_dir


# ---------------------------------------------------------------- 실행·완료 대기
def compute_messages(hdf: Path) -> str | None:
    import h5py  # 워커 PC(Anaconda)에 있음

    try:
        with h5py.File(hdf, "r") as h:
            v = h["/Results/Summary/Compute Messages (text)"][()]
            v = v[0] if hasattr(v, "__len__") and not isinstance(v, (bytes, str)) else v
            return v.decode("latin-1", "replace") if isinstance(v, bytes) else str(v)
    except (OSError, KeyError):
        return None   # 쓰는 중이거나 아직 없음


def solution_status(hdf: Path) -> str | None:
    import h5py

    try:
        with h5py.File(hdf, "r") as h:
            s = h["/Results/Unsteady/Summary"].attrs.get("Solution")
            return s.decode() if isinstance(s, bytes) else s
    except (OSError, KeyError):
        return None


def ras_path(ras_exe: str | None = None) -> str:
    ras = ras_exe or os.environ.get("RAS_EXE", DEFAULT_RAS)
    if not Path(ras).exists():
        raise FileNotFoundError(f"Ras.exe 없음: {ras} (환경변수 RAS_EXE로 지정)")
    return ras


def ras_command(ras: str, prj: Path, plan: Path):
    """Ras.exe 명령줄. HEC-RAS는 프로젝트·계획 파일 이름에 따옴표가 있어야 인식한다 ("must have quotes").
    subprocess에 목록으로 넘기면 공백 없는 경로에는 따옴표가 붙지 않아, Ras.exe가 '명령줄 매개변수 오류'
    창을 띄우고 멈춘다 (2026-11-02 T1·T2가 1시간씩 멈춘 원인). → Windows에서는 문자열을 직접 만든다."""
    if os.name == "nt":
        return f'"{ras}" -c "{prj}" "{plan}"'
    return [ras, "-c", str(prj), str(plan)]          # Linux 시험용


def _folder_signature(folder: Path) -> tuple:
    """작업 폴더 안 파일들의 (개수, 크기 합, 가장 늦은 수정 시각) — 후처리가 아직 쓰고 있는지 보는 데 쓴다."""
    n = size = 0
    latest = 0.0
    for p in folder.rglob("*"):
        try:
            st = p.stat()
        except OSError:
            continue
        if p.is_file():
            n += 1
            size += st.st_size
            latest = max(latest, st.st_mtime)
    return n, size, latest


class RasStuck(RuntimeError):
    """HEC-RAS가 대화상자 때문에, 또는 이유를 모르게 멈춤. windows = 그때 떠 있던 HEC-RAS 창."""

    def __init__(self, message: str, windows: list[dict] | None = None):
        super().__init__(message)
        self.windows = windows or []


def run_ras(prj: Path, plan: Path, ras_exe: str | None = None, log=print,
            timeout_s: int = 3600, poll_s: float = 10.0, idle_polls: int = 3,
            stall_s: float = 600.0, dialog_polls: int = 6, progress_s: float = 60.0) -> dict:
    """HEC-RAS 명령줄 계산 후 결과가 다 쓰일 때까지 기다린다.

    2026-10-28 기준 실행 기록: Ras.exe -c 가 돌아온 뒤에도 1D 후처리가 1~2분 더 O03·p03.hdf를 쓴다.
    → Ras.exe 종료 후, 작업 폴더 파일이 poll_s × idle_polls 동안 그대로이고 계산 메시지에
      'Complete Process'가 있으면 완료. HEC-RAS가 쓰는 중인 HDF는 열지 않는다 (폴더가 조용할 때만 연다).

    멈춤 감지 (2026-11-02 추가, 전에는 1시간 시간 제한까지 기다렸다)
    - HEC-RAS 프로세스에 표준 대화상자가 poll_s × dialog_polls(1분) 동안 떠 있고 그동안 파일 변화도 없으면
      → RasStuck (창 글자 포함)
    - 계산 중인데 작업 폴더 파일이 stall_s 동안 하나도 바뀌지 않으면 → RasStuck
      (정상 계산에서는 p03.tmp.hdf·O03이 계속 커진다. 전체 6~8분)
    - 어느 경우든 Ras.exe와 자식 계산 프로그램을 같이 끝낸다.
    """
    os.environ.setdefault("HDF5_USE_FILE_LOCKING", "FALSE")   # 읽기 쪽이 잠금을 잡지 않게
    ras = ras_path(ras_exe)
    hdf = Path(str(plan) + ".hdf")
    tmp = Path(str(plan) + ".tmp.hdf")
    for f in (hdf, tmp):
        if f.exists():
            f.unlink()
    folder = prj.parent
    t0 = time.time()
    log(f"HEC-RAS 시작: {prj.name} {plan.name}")
    proc = subprocess.Popen(ras_command(ras, prj, plan), cwd=str(folder))
    exit_code, t_exit, last_sig, idle, msg, note = None, None, None, 0, None, ""
    last_change = last_progress = t0
    dialog_seen, seen_windows = 0, []
    tree: dict[int, str] = {}
    try:
        while True:
            time.sleep(poll_s)
            now = time.time()
            if exit_code is None:
                exit_code = proc.poll()
                if exit_code is not None:
                    t_exit = now
                    log(f"Ras.exe 종료 (코드 {exit_code}, {t_exit - t0:.0f}초) — 후처리·결과 쓰기 끝나기를 기다림")
            sig = _folder_signature(folder)
            if sig != last_sig:
                last_change = now
                idle = 0
            else:
                idle += 1
            last_sig = sig

            # 대화상자·멈춤 감지 (자식 계산 프로그램이 남아 있으면 Ras.exe가 끝난 뒤에도 본다)
            tree = RW.process_tree(proc.pid, exit_code is None, tree)
            alive = exit_code is None or bool(tree)
            if alive:
                wins = RW.windows(tree)
                dlg = RW.dialogs(wins)
                if dlg:
                    dialog_seen += 1
                    if dialog_seen == 1:
                        log(f"HEC-RAS 대화상자 보임: {RW.describe(dlg)}")
                    # 대화상자가 떠 있고 그동안 파일도 그대로일 때만 멈춤으로 본다 (진행 창 오인 방지)
                    if dialog_seen >= dialog_polls and idle >= dialog_polls:
                        raise RasStuck("HEC-RAS 대화상자가 떠서 계산이 멈춤: " + RW.describe(dlg), dlg)
                else:
                    dialog_seen = 0
                if wins and not seen_windows:
                    log("HEC-RAS 창: " + ", ".join(f"'{w['title']}' ({w['class']})" for w in wins))
                if wins:
                    seen_windows = wins
                if exit_code is None and now - last_change > stall_s:
                    raise RasStuck(f"HEC-RAS가 {stall_s:.0f}초 동안 작업 폴더에 아무것도 쓰지 않음 "
                                   f"(떠 있는 창: {RW.describe(wins) or '찾지 못함'})", wins)

            if now - last_progress >= progress_s:
                last_progress = now
                size = tmp.stat().st_size if tmp.exists() else (hdf.stat().st_size if hdf.exists() else 0)
                log(f"  진행 {now - t0:.0f}초: 결과 HDF {size / 1e6:.0f} MB, "
                    f"마지막 파일 변화 {now - last_change:.0f}초 전")

            if exit_code is not None and hdf.exists() and not tmp.exists() and idle >= idle_polls:
                msg = compute_messages(hdf)
                if msg and "Complete Process" in msg:
                    break
                sol = solution_status(hdf)
                if idle >= idle_polls * 3 and sol:
                    note = "계산 메시지에 'Complete Process'가 없지만 폴더가 멈추고 계산 결과가 있음"
                    log(note)
                    break
            if now - t0 > timeout_s:
                raise RasStuck(f"{timeout_s}초 안에 끝나지 않음 (떠 있는 창: {RW.describe(seen_windows) or '찾지 못함'})",
                               seen_windows)
            if exit_code is not None and not hdf.exists() and not tmp.exists() and now - t_exit > 120:
                raise RuntimeError(f"Ras.exe가 결과 HDF 없이 끝남 (코드 {exit_code}) — 작업 폴더의 .bco·계산 로그 확인")
    except BaseException as e:              # 오류·Ctrl+C 어느 쪽이든 HEC-RAS를 남겨 두지 않는다
        tree = RW.process_tree(proc.pid, proc.poll() is None, tree)
        if proc.poll() is None or tree:
            log(f"HEC-RAS 종료시킴 ({type(e).__name__})")
            RW.kill(tree, proc)
        raise
    wall = time.time() - t0
    sol = solution_status(hdf)
    log(f"완료: {wall:.0f}초 (Ras.exe 종료 후 {time.time() - t_exit:.0f}초 더 기다림), {sol}")
    if sol and "success" not in sol.lower():
        raise RuntimeError(f"계산 실패: {sol}")
    return {"hdf": str(hdf), "wall_seconds": round(wall, 1), "ras_exit_seconds": round(t_exit - t0, 1),
            "solution": sol, "exit_code": exit_code, "compute_messages": msg, "note": note}


@dataclass
class JobResult:
    job_dir: Path
    hdf: Path
    terrain: Path
    applied: dict
    run: dict


def run_job(model_version: str, base: str, params: dict, job_dir: Path, base_path: Path | None = None,
            postprocess: bool = True, ras_exe: str | None = None, log=print) -> JobResult:
    """작업 1건 전체: 입력 검사 → 폴더 복사 → u01 적용 → (후처리 설정) → 계산 → 완료 확인."""
    info = load_model(model_version)
    cfg = info["run"]
    p = validate_params(cfg, base, params)
    ras_exe = ras_path(ras_exe)          # 복사 전에 확인
    base_path = Path(base_path or info["base_path"])
    b = cfg["bases"][base]
    log(f"작업 폴더 복사: {base_path} → {job_dir}")
    make_job_dir(base_path, job_dir, cfg.get("copy_ignore", []))
    prj = job_dir / Path(b["prj"])
    plan = prj.with_suffix("." + b["plan"])
    u01 = _flow_file(prj, plan)
    applied = apply_params(u01, cfg, p)
    log(f"입력 적용: {json.dumps(p, ensure_ascii=False)} → u01 {'변경' if applied['changed'] else '그대로'}")
    if not postprocess:
        set_postprocess(plan, False)
        log("1D 후처리 끔")
    run = run_ras(prj, plan, ras_exe=ras_exe, log=log)
    return JobResult(job_dir, Path(run["hdf"]), job_dir / cfg["terrain"], {"params": p, **applied}, run)


def _flow_file(prj: Path, plan: Path) -> Path:
    txt = plan.read_bytes().decode("latin-1")
    m = re.search(r"^Flow File=(\w+)", txt, re.M)
    if not m:
        raise ValueError(f"{plan.name}에 Flow File 없음")
    return prj.with_suffix("." + m.group(1))
