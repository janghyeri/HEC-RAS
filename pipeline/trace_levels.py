"""하천 흔적수위 비교 — 현장조사 흔적수위 vs 모형 1D 최고수위 (작업 진행 가이드 Step 8, 가이드라인 §4.5.1).

자료: 한국수자원조사기술원(2022.9.13), 「포항 냉천 범람지역 현장조사 결과」의 참고3 '냉천 범람구간 홍수흔적 조사 결과'
      — 측점 21개(하구에서 0.48–5.30 km), 좌·우안 흔적수위 22개(EL. m). 원문 표를 옮긴 것: pipeline/data/trace_levels_20220913.csv
      (출처를 적고 인용 — 2026-11-19 사용자 확인)

비교 방법
  - 모형 단면 번호(RS, km) = 하구에서 잰 누가거리 ÷ 1000. 조사표의 교량·낙차공 위치(항만교·냉천교·인덕교·원용교·원리1낙차공)가
    모형의 교량·구조물 단면 쌍과 20 m 안에서 맞는 것으로 확인했다.
  - 모형 값 = 결과의 river.json 단면별 최고수위(max_ws_m)를 누가거리로 선형 보간 (단면 사이는 직선).
  - 차이 = 모형 − 흔적 (음수면 모형이 낮음). 지표: n, RMSE, 편의(평균 차이), MAE, 최대 |차이|, 모형이 낮은 개수.
  - 흔적수위는 둑에 남은 가장 높은 자국이고 모형은 단면마다 수위 하나다 — 이 차이는 화면·보고서에 적는다.
  - 판정(받아들일 수 있는지, 원인)은 사용자가 한다. 여기서는 숫자만 낸다.

사용
  python -m pipeline.trace_levels --publish          # web/public/data/<버전>/validation/trace_levels.json (조사 자료 + 게시 결과별 지표)
  python -m pipeline.trace_levels --river <river.json>   # 결과 하나의 지표
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "pipeline" / "data"
WEB_DATA = REPO / "web" / "public" / "data"
SURVEY_CSV = DATA / "trace_levels_20220913.csv"

SOURCE = {
    "name": "포항 냉천 범람지역 현장조사 결과 — 참고3 냉천 범람구간 홍수흔적 조사 결과",
    "provider": "한국수자원조사기술원",
    "date": "2022-09-13",
    "citation": "한국수자원조사기술원. (2022). 포항 냉천 범람지역 현장조사 결과 (2022.9.13).",
    "note": "원문 표의 측점·누가거리·계획홍수위·흔적수위(좌·우안)·제방고를 옮겨 적음. 자료에 '향후 피해신고, 흔적수위 등을 고려하여 변경 예정'이라고 적혀 있음",
}
RS_BASIS = ("모형 단면 번호(km) = 하구에서 누가거리 ÷ 1000 — 항만교·냉천교·인덕교·원용교·원리1낙차공 위치가 "
            "모형의 교량·구조물 단면 쌍과 20 m 안에서 맞음")


def _num(s: str) -> float | None:
    s = (s or "").strip()
    return float(s) if s else None


def load_survey(path: Path = SURVEY_CSV) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        out.append({"station": r["station"], "dist_m": float(r["dist_m"]), "plan_fwl_m": _num(r["plan_fwl"]),
                    "trace_left_m": _num(r["trace_left"]), "trace_right_m": _num(r["trace_right"]),
                    "levee_old_left_m": _num(r["levee_old_left"]), "levee_old_right_m": _num(r["levee_old_right"]),
                    "levee_survey_left_m": _num(r["levee_survey_left"]),
                    "levee_survey_right_m": _num(r["levee_survey_right"]), "note": r["note"] or None})
    return out


def model_profile(river: dict) -> tuple[list[float], list[float]]:
    """river.json → (RS km 오름차순, 최고수위). 같은 RS가 두 번 있으면(교량 위·아래) 둘 다 둔다"""
    pts = sorted((float(x["rs"]), x["max_ws_m"]) for x in river["xs"] if x.get("max_ws_m") is not None)
    return [p[0] for p in pts], [p[1] for p in pts]


def interp(x: float, xs: list[float], ys: list[float]) -> float | None:
    if not xs or x < xs[0] or x > xs[-1]:
        return None
    for i in range(1, len(xs)):
        if x <= xs[i]:
            x0, x1 = xs[i - 1], xs[i]
            if x1 == x0:
                return ys[i]
            w = (x - x0) / (x1 - x0)
            return ys[i - 1] * (1 - w) + ys[i] * w
    return ys[-1]


def compare(survey: list[dict], river: dict) -> dict:
    xs, ys = model_profile(river)
    points = []
    for s in survey:
        m = interp(s["dist_m"] / 1000.0, xs, ys)
        for side in ("left", "right"):
            t = s[f"trace_{side}_m"]
            if t is None or m is None:
                continue
            points.append({"station": s["station"], "dist_m": s["dist_m"], "side": side, "trace_m": t,
                           "model_m": round(m, 3), "diff_m": round(m - t, 3), "_d": m - t})
    d = [p.pop("_d") for p in points]     # 지표는 반올림 전 값으로 (화면 ValidationApp과 같게)
    n = len(d)
    metrics = {
        "n": n,
        "rmse_m": round(math.sqrt(sum(v * v for v in d) / n), 6) if n else None,
        "bias_m": round(sum(d) / n, 6) if n else None,
        "mae_m": round(sum(abs(v) for v in d) / n, 6) if n else None,
        "max_abs_m": round(max(abs(v) for v in d), 6) if n else None,
        "n_model_lower": sum(1 for v in d if v < 0),
    }
    return {"metrics": metrics, "points": points}


def publish(version: str = "v1") -> dict:
    survey = load_survey()
    root = WEB_DATA / version
    results = {}
    for rj in sorted(root.glob("*/river.json")):
        river = json.loads(rj.read_text(encoding="utf-8"))
        results[rj.parent.name] = compare(survey, river)["metrics"]
    out = {"model_version": version, "source": SOURCE, "rs_basis": RS_BASIS,
           "method": "모형 = river.json 단면별 최고수위를 누가거리로 선형 보간, 차이 = 모형 − 흔적 (음수면 모형이 낮음)",
           "caveat": "흔적수위는 둑에 남은 가장 높은 자국(물결·부유물 자국이 섞일 수 있음), 모형은 1D 단면마다 수위 하나",
           "survey": survey, "published_results": results,
           "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "computed_by": "pipeline/trace_levels.py"}
    dst = root / "validation" / "trace_levels.json"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--publish", action="store_true")
    ap.add_argument("--version", default="v1")
    ap.add_argument("--river", help="결과 하나의 river.json")
    a = ap.parse_args()
    if a.publish:
        out = publish(a.version)
        for k, v in out["published_results"].items():
            print(f"{k:10s} n={v['n']} RMSE {v['rmse_m']:.2f} m  편의 {v['bias_m']:+.2f} m  MAE {v['mae_m']:.2f}  "
                  f"최대 {v['max_abs_m']:.2f}  모형이 낮음 {v['n_model_lower']}/{v['n']}")
    elif a.river:
        r = compare(load_survey(), json.loads(Path(a.river).read_text(encoding="utf-8")))
        print(json.dumps(r["metrics"], ensure_ascii=False))
        for p in r["points"]:
            print(f"  {p['station']:6s} {p['side']:5s} 흔적 {p['trace_m']:6.2f}  모형 {p['model_m']:6.2f}  차이 {p['diff_m']:+.2f}")
    else:
        ap.error("--publish 또는 --river")


if __name__ == "__main__":
    main()
