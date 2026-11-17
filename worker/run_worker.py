"""웹 실행 워커 — Supabase 대기열에서 작업을 가져와 HEC-RAS로 계산하고 결과를 올린다 (Step 5).

    웹(로그인 사용자) ──runs에 'queued'──▶ Supabase ◀──claim_next_run── 이 워커(HEC-RAS PC)
                                                     ──결과 파일──▶ Storage 'results/<버전>/run-<id>/'

- 한 번에 1건만 계산한다. 계산 중에도 30초마다 worker_heartbeat를 갱신한다 → 웹에 '계산 서버 켜짐' 표시.
- 설정: worker/.env (worker/.env.example 참고). service_role 키는 이 파일에만 둔다.
- 실행 (Anaconda Prompt, 저장소 루트):  python -m worker.run_worker
  한 건만 처리하고 끝내려면 --once. 워커 PC에서는 start_worker.bat(worker/start_worker.bat 사본)을 더블클릭한다.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from worker import hecras_job as J  # noqa: E402
from worker.supabase_rest import Supabase, SupabaseError, _ctype, load_env  # noqa: E402

BUCKET = "results"
UPLOAD_FILES = ("kpi.json", "meta.json", "cells_max.u8", "frames_depth.u8", "manholes.geojson", "timeseries.json",
                "river.json", "river_flow.json", "flow2d.json", "flow2d.bin")
LOG_KEEP = 8000           # DB에 남기는 로그 글자 수 (끝부분)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Worker:
    def __init__(self, env: dict):
        self.sb = Supabase(env.get("SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_ROLE_KEY", ""))
        self.worker_id = env.get("WORKER_ID") or platform.node()
        self.jobs = Path(env.get("JOBS_DIR", r"C:\Hec-Ras\HECRASMCP\jobs"))
        self.versions = [v.strip() for v in env.get("MODEL_VERSIONS", "v1").split(",") if v.strip()]
        self.ras = env.get("RAS_EXE") or None
        self.keep_hdf = env.get("KEEP_HDF", "1") == "1"
        self.current: dict | None = None
        self._stop = threading.Event()

    # ------------------------------------------------------------ 계산 서버 상태
    def heartbeat(self):
        info = {"host": platform.node(), "cores": os.cpu_count(), "model_versions": self.versions,
                "ras_exe": self.ras or os.environ.get("RAS_EXE", J.DEFAULT_RAS),
                "current_run": self.current["id"] if self.current else None}
        try:
            self.sb.upsert("worker_heartbeat", {"worker_id": self.worker_id, "last_seen": now_iso(), "info": info},
                           on_conflict="worker_id")
        except SupabaseError as e:
            print(f"[heartbeat] {e}", flush=True)

    def _heartbeat_loop(self):
        while not self._stop.wait(30):
            self.heartbeat()

    # ------------------------------------------------------------ 작업 1건
    def process(self, run: dict):
        rid = run["id"]
        ver, base = run["model_version"], run["base"]
        job_dir = self.jobs / f"run-{rid}"
        prefix = f"{ver}/run-{rid}"
        lines: list[str] = []
        last_push = [0.0]

        def log(s: str, progress: str | None = None, force: bool = False):
            line = f"[{datetime.now():%H:%M:%S}] {s}"
            print(f"run-{rid} {line}", flush=True)
            lines.append(line)
            if force or progress or time.time() - last_push[0] > 15:
                fields = {"log": "\n".join(lines)[-LOG_KEEP:]}
                if progress:
                    fields["progress"] = progress
                try:
                    self.sb.update("runs", {"id": rid}, fields)
                except SupabaseError as e:
                    print(f"[log] {e}", flush=True)
                last_push[0] = time.time()

        t0 = time.time()
        self.current = run
        self.heartbeat()
        try:
            log(f"작업 받음: {base} {json.dumps(run.get('params') or {}, ensure_ascii=False)}", progress="작업 폴더 준비")
            if ver not in self.versions:
                raise ValueError(f"이 워커가 계산하지 않는 모형 버전: {ver}")
            if job_dir.exists():
                shutil.rmtree(job_dir)

            def ras_log(s: str):
                prog = "HEC-RAS 계산 중" if "HEC-RAS 시작" in s else ("후처리 마무리 기다림" if "Ras.exe 종료" in s else None)
                log(s, progress=prog)

            pp = run.get("postprocess")      # 값이 없으면 정석대로 1D 후처리 켬 (2026-11-02 결정)
            res = J.run_job(ver, base, run.get("params") or {}, job_dir, postprocess=True if pp is None else bool(pp),
                            ras_exe=self.ras, log=ras_log)
            log("웹 파일 만들기", progress="결과 변환")
            from pipeline.export_web import export
            from pipeline.publish_web import publish

            sid = f"run-{rid}"
            label = run.get("label") or f"{J.load_model(ver)['run']['bases'][base]['label']} (계산 {rid})"
            cfg = J.load_model(ver)["run"]
            changed = {p["id"]: res.applied["params"][p["id"]] for p in cfg["params"]
                       if p["id"] in res.applied["params"] and res.applied["params"][p["id"]] != p["default"]}
            kpi = export(str(res.hdf), str(res.terrain), str(job_dir / "web_out"), ver, sid, label,
                         base=base, params=changed or None)
            publish(job_dir / "web_out", job_dir / "web_pub", ver, 10, 16)
            try:                                        # 냉천 하천(1D) 수면을 지도에 더함
                from pipeline.river_publish import add_river_to_job

                add_river_to_job(job_dir, res.hdf, res.terrain, ver, sid)
            except Exception as e:
                log(f"하천 수면 실패 (2D 결과는 올림): {type(e).__name__}: {e}")
            out = job_dir / "web_pub" / ver / sid
            try:                                        # 10분 침수심 이미지 (지도 시간 재생·3D)
                from pipeline.frames_web import make_frames

                # 경사 수면(RAS Mapper sloping과 같은 원리): 4 m 등급 이미지 + 3D용 2 m 연속 수심 + 2D 최대 수심 타일 (2026-11-17)
                fr = make_frames(res.hdf, res.terrain, out, sid, ver, flow2d=True, depth2m=True, tiles=True)
                log(f"10분 침수심 이미지 {fr['count']}장 ({fr['bytes_total'] / 1e6:.1f} MB), "
                    f"3D 연속 수심 {(fr.get('depth2m') or {}).get('MB')} MB, 경사 수면 타일 {(fr.get('tiles') or {}).get('tiles')}장")
                f2 = fr.get("flow2d") or {}
                log(f"범람 구역 흐름 자료 {f2.get('MB')} MB" if f2.get("ok") else f"범람 구역 흐름 실패 (이미지는 올림): {f2.get('error')}")
            except Exception as e:
                log(f"침수심 이미지 실패 (최대 수심 지도는 올림): {type(e).__name__}: {e}")
            log("결과 파일 올리기", progress="결과 올리는 중")
            n = 0
            for f in UPLOAD_FILES:
                p = out / f
                if p.exists():
                    self.sb.upload(BUCKET, f"{prefix}/{f}", p.read_bytes(), _ctype(p))
                    n += 1
            n += self.sb.upload_dir(BUCKET, f"{prefix}/tiles", out / "tiles", log=log)
            for sub in ("frames", "depth2m"):             # 10분 침수심 이미지 (4 m 등급, 3D 물 표면용 2 m 연속 수심)
                if (out / sub / "frames.json").exists():
                    n += self.sb.upload_dir(BUCKET, f"{prefix}/{sub}", out / sub, log=log)
            tasks = _tasks(res.run.get("compute_messages"))
            self.sb.update("runs", {"id": rid}, {
                "status": "done", "finished_at": now_iso(), "progress": "완료", "kpi": kpi,
                "files_prefix": prefix, "wall_seconds": round(time.time() - t0, 1), "ras_seconds": tasks,
                "error": None, "log": ("\n".join(lines) + f"\n파일 {n}개 올림")[-LOG_KEEP:]})
            print(f"run-{rid} 완료 {time.time() - t0:.0f}초, 침수면적 {kpi['inundation_area_km2']['ge_0.1m']} km²", flush=True)
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            lines.append(traceback.format_exc())
            try:
                self.sb.update("runs", {"id": rid}, {"status": "failed", "finished_at": now_iso(), "error": err,
                                                      "progress": "실패", "wall_seconds": round(time.time() - t0, 1),
                                                      "log": "\n".join(lines)[-LOG_KEEP:]})
            except SupabaseError as e2:
                print(f"[실패 기록 못 함] {e2}", flush=True)
            print(f"run-{rid} 실패: {err}", flush=True)
        finally:
            self.current = None
            _cleanup(job_dir, self.keep_hdf)
            self.heartbeat()

    # ------------------------------------------------------------ 반복
    def loop(self, once: bool = False, idle_s: float = 10.0):
        print(f"워커 {self.worker_id} 시작 — 모형 {', '.join(self.versions)}, 작업 폴더 {self.jobs}", flush=True)
        self.jobs.mkdir(parents=True, exist_ok=True)
        # 창을 닫는 등으로 끝나지 못한 이 워커의 'running' 작업 정리 — 남아 있으면 같은 조건을 다시 요청할 수 없다
        try:
            self.sb.update("runs", {"worker_id": self.worker_id, "status": "running"},
                           {"status": "failed", "finished_at": now_iso(), "progress": "실패",
                            "error": "워커가 다시 시작됨 — 이전 계산이 끝나지 않았습니다. 다시 요청해 주세요."})
        except SupabaseError as e:
            print(f"[정리] {e}", flush=True)
        self.heartbeat()
        threading.Thread(target=self._heartbeat_loop, daemon=True).start()
        try:
            while True:
                try:
                    got = self.sb.rpc("claim_next_run", {"p_worker": self.worker_id, "p_model_versions": self.versions})
                except SupabaseError as e:
                    print(f"[대기열] {e}", flush=True)
                    time.sleep(30)
                    continue
                if got:
                    self.process(got[0])
                    if once:
                        return
                else:
                    if once:
                        print("대기 중인 작업 없음", flush=True)
                        return
                    time.sleep(idle_s)
        except KeyboardInterrupt:
            print("워커 중단", flush=True)
            if self.current:
                try:
                    self.sb.update("runs", {"id": self.current["id"]},
                                   {"status": "failed", "error": "워커가 중단됨", "finished_at": now_iso()})
                except SupabaseError:
                    pass
        finally:
            self._stop.set()


def _tasks(msg: str | None) -> dict:
    from worker.run_local import compute_tasks

    return compute_tasks(msg)


def _cleanup(job_dir: Path, keep_hdf: bool):
    """작업 폴더 정리 — 큰 1D 출력(O03 약 300 MB)과 복사한 입력은 지우고, 결과 HDF·로그는 남긴다(검증용)."""
    if not job_dir.exists():
        return
    for p in list(job_dir.rglob("*")):
        try:
            if p.is_file() and (p.suffix.upper().startswith(".O0") or (not keep_hdf and p.name.endswith(".hdf"))):
                p.unlink()
        except OSError:
            pass
    shutil.rmtree(job_dir / "web_out", ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env", default=str(Path(__file__).with_name(".env")))
    ap.add_argument("--once", action="store_true", help="대기 작업 하나만 처리하고 끝냄")
    a = ap.parse_args()
    env = {**load_env(Path(a.env)), **{k: v for k, v in os.environ.items() if k.startswith(("SUPABASE_", "WORKER_", "RAS_", "JOBS_", "MODEL_", "KEEP_"))}}
    if env.get("RAS_EXE"):
        os.environ["RAS_EXE"] = env["RAS_EXE"]
    Worker(env).loop(once=a.once)


if __name__ == "__main__":
    main()
