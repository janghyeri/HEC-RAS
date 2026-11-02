"""워커 PC에서 작업 1건을 직접 돌려 보는 시험 (Supabase 없이) — 작업 진행 가이드 Step 5.

하는 일
  1. 기준 복사본(Pohang_web)을 작업 폴더로 복사하고 u01에 입력 조건을 적용
  2. (--no-postprocess) 계획 파일의 1D 후처리를 끄고 HEC-RAS 명령줄 계산, 'Complete Process'까지 대기
  3. (--compare) 기준 결과와 비교 — worker/compare_results.py와 같은 기준(침수면적 ±1 %, 99분위 0.02 m)
     + 기준 결과에 있는데 새 결과에 없는 HDF 자료 목록 (후처리를 끄면 무엇이 빠지는지)
  4. (--export) 웹 파일 만들기 — pipeline.export_web + 최대 수심 타일 (publish_web)
  5. 작업 폴더에 report.json · report.txt · run.log

사용 예 (저장소 루트에서, Anaconda Prompt)
  python -m worker.run_local --base S0-C --name T1_x1_post0 --no-postprocess --compare --export
  python -m worker.run_local --base S0-C --name T2_manhole150 --set internal_flow_factor=1.5 --no-postprocess --compare --export
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import re
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from worker import hecras_job as J  # noqa: E402

TASK_RE = re.compile(r"\s*(Completing Geometry, Flow and Plan|Preprocessing Geometry|Unsteady Flow Computations|"
                     r"Post-Processing|Generating Time Series Post Process|Complete Process)\s+([\d:]+)\s*$")


def compute_tasks(msg: str | None) -> dict:
    out = {}
    for line in (msg or "").splitlines():
        m = TASK_RE.match(line)
        if m:
            sec = 0
            for p in m.group(2).split(":"):
                sec = sec * 60 + int(p)
            out[m.group(1)] = sec
    return out


def datasets(hdf: Path) -> dict:
    import h5py

    out = {}
    with h5py.File(hdf, "r") as h:
        h.visititems(lambda name, obj: out.__setitem__(name, obj.shape) if isinstance(obj, h5py.Dataset) else None)
    return out


def missing_datasets(base_hdf: Path, new_hdf: Path) -> list[str]:
    a, b = datasets(base_hdf), datasets(new_hdf)
    return sorted(k for k in a if k not in b)


def _group(paths: list[str], depth: int = 5) -> dict:
    g = {}
    for p in paths:
        key = "/".join(p.split("/")[:depth])
        g[key] = g.get(key, 0) + 1
    return g


def parse_set(items: list[str]) -> dict:
    out = {}
    for it in items or []:
        k, _, v = it.partition("=")
        if not v:
            raise SystemExit(f"--set 형식은 이름=값: {it}")
        out[k.strip()] = float(v)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model-version", default="v1")
    ap.add_argument("--base", required=True, help="기준 시나리오 (S0-E 또는 S0-C)")
    ap.add_argument("--name", required=True, help="작업 이름 = 작업 폴더 이름 (영문·숫자·_ 권장)")
    ap.add_argument("--set", action="append", default=[], help="입력 조건 이름=값, 예: internal_flow_factor=1.5")
    ap.add_argument("--jobs", default=r"C:\Hec-Ras\HECRASMCP\jobs", help="작업 폴더들을 둘 곳 (영어 경로)")
    ap.add_argument("--base-path", default=None, help="기준 복사본 (기본: 모형 설정의 base_path)")
    ap.add_argument("--no-postprocess", action="store_true", help="1D 후처리 끄기")
    ap.add_argument("--compare", action="store_true", help="기준 결과와 비교")
    ap.add_argument("--export", action="store_true", help="웹 파일·타일 만들기")
    ap.add_argument("--ras", default=None, help="Ras.exe 경로 (기본: 환경변수 RAS_EXE 또는 HEC-RAS 6.6 기본 위치)")
    a = ap.parse_args()

    info = J.load_model(a.model_version)
    cfg = info["run"]
    base_path = Path(a.base_path or info["base_path"])
    if (Path(a.jobs) / a.name).exists():          # 같은 이름으로 다시 돌리면 앞 결과를 지우지 않고 새 폴더
        a.name = f"{a.name}_{datetime.now():%m%d_%H%M%S}"
    job_dir = Path(a.jobs) / a.name
    job_dir.parent.mkdir(parents=True, exist_ok=True)
    log_lines: list[str] = []

    def log(s: str):
        line = f"[{datetime.now():%H:%M:%S}] {s}"
        print(line, flush=True)
        log_lines.append(line)

    report = {"name": a.name, "model_version": a.model_version, "base": a.base, "postprocess": not a.no_postprocess,
              "started_at": datetime.now().isoformat(timespec="seconds")}
    t0 = time.time()
    try:
        params = parse_set(a.set)
        report["params_hash"] = J.params_hash(a.model_version, a.base, J.validate_params(cfg, a.base, params))
        res = J.run_job(a.model_version, a.base, params, job_dir, base_path=base_path,
                        postprocess=not a.no_postprocess, ras_exe=a.ras, log=log)
        report["applied"] = res.applied
        report["wall_seconds_ras"] = res.run["wall_seconds"]
        report["solution"] = res.run["solution"]
        report["compute_seconds"] = compute_tasks(res.run.get("compute_messages"))

        b = cfg["bases"][a.base]
        base_hdf = (base_path / b["prj"]).with_suffix("." + b["plan"] + ".hdf")
        if a.compare:
            log(f"기준 결과와 비교: {base_hdf}")
            from worker import compare_results as C

            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                same = C.compare(C.load(str(base_hdf)), C.load(str(res.hdf)))
            text = buf.getvalue()
            print(text, flush=True)
            report["compare"] = {"same": bool(same), "text": text.splitlines()}
            miss = missing_datasets(base_hdf, res.hdf)
            report["missing_datasets_count"] = len(miss)
            report["missing_datasets_groups"] = _group(miss)
            (job_dir / "missing_datasets.txt").write_text("\n".join(miss), encoding="utf-8")
            log(f"기준 결과에 있고 새 결과에 없는 HDF 자료: {len(miss)}개 (missing_datasets.txt)")

        if a.export:
            log("웹 파일 만들기")
            try:
                from pipeline.export_web import export
                from pipeline.publish_web import publish

                label = f"{b['label']} ({a.name})"
                kpi = export(str(res.hdf), str(res.terrain), str(job_dir / "web_out"), a.model_version, a.name, label)
                pub = publish(job_dir / "web_out", job_dir / "web_pub", a.model_version, 10, 16)
                report["export"] = {"ok": True, "publish": pub,
                                    "kpi": {k: kpi.get(k) for k in ("inundation_area_km2", "onset_time",
                                                                    "peak_instant_area", "max_depth_m", "river",
                                                                    "volume_error_pct", "internal_inflow")}}
                log(f"웹 파일 완료: 침수면적(≥0.1 m) {kpi['inundation_area_km2']['ge_0.1m']} km²")
            except Exception as e:  # 후처리를 끄면 일부 자료가 없을 수 있다 → 무엇이 빠졌는지 기록
                report["export"] = {"ok": False, "error": f"{type(e).__name__}: {e}",
                                    "trace": traceback.format_exc().splitlines()[-6:]}
                log(f"웹 파일 실패: {type(e).__name__}: {e}")
        report["ok"] = True
    except Exception as e:
        report["ok"] = False
        report["error"] = f"{type(e).__name__}: {e}"
        report["trace"] = traceback.format_exc().splitlines()[-8:]
        if getattr(e, "windows", None):            # HEC-RAS가 멈췄을 때 떠 있던 창 (대화상자 글자)
            report["ras_windows"] = e.windows
        log(f"실패: {report['error']}")
    report["wall_seconds_total"] = round(time.time() - t0, 1)
    report["finished_at"] = datetime.now().isoformat(timespec="seconds")

    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    (job_dir / "run.log").write_text("\n".join(log_lines) + "\n", encoding="utf-8")
    summary = [f"작업 {a.name}: {'성공' if report['ok'] else '실패'}",
               f"  전체 {report['wall_seconds_total']:.0f}초, HEC-RAS {report.get('wall_seconds_ras', 0):.0f}초, "
               f"후처리 {'켬' if report['postprocess'] else '끔'}",
               f"  계산 단계(초): {report.get('compute_seconds')}"]
    if not report["ok"]:
        summary.append(f"  오류: {report.get('error')}")
    if "compare" in report:
        summary.append(f"  기준 결과와 {'같음' if report['compare']['same'] else '다름'}, "
                       f"빠진 HDF 자료 {report.get('missing_datasets_count')}개")
    if "export" in report:
        summary.append(f"  웹 파일 {'완료' if report['export']['ok'] else '실패: ' + report['export'].get('error', '')}")
    (job_dir / "report.txt").write_text("\n".join(summary) + "\n", encoding="utf-8")
    print("\n".join(summary), flush=True)
    raise SystemExit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
