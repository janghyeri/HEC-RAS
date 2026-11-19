"""흔적수위 비교 검증: 보간, 지표 계산, 게시 파일과 같은 값.
`python -m pytest pipeline/tests/test_trace_levels.py`"""
import json
import math

import pytest

from pipeline import trace_levels as T


def river(points):
    return {"xs": [{"rs": f"{rs:.3f}", "max_ws_m": ws} for rs, ws in points]}


def test_interp_and_duplicate_rs():
    xs, ys = T.model_profile(river([(2.0, 8.0), (1.0, 6.0), (1.5, 7.5), (1.5, 7.0)]))
    assert xs == [1.0, 1.5, 1.5, 2.0]
    assert T.interp(1.25, xs, ys) == pytest.approx(6.5)        # 1.0–1.5(아래쪽 값 7.0) 사이
    assert T.interp(1.75, xs, ys) == pytest.approx(7.75)       # 1.5(위쪽 값 7.5)–2.0 사이
    assert T.interp(0.5, xs, ys) is None and T.interp(2.5, xs, ys) is None


def test_metrics():
    survey = [{"station": "a", "dist_m": 1000, "trace_left_m": 6.5, "trace_right_m": None},
              {"station": "b", "dist_m": 2000, "trace_left_m": 9.0, "trace_right_m": 8.0}]
    r = T.compare(survey, river([(1.0, 6.0), (2.0, 8.0)]))
    d = [-0.5, -1.0, 0.0]
    m = r["metrics"]
    assert m["n"] == 3 and m["n_model_lower"] == 2
    assert m["bias_m"] == pytest.approx(sum(d) / 3, abs=1e-3)
    assert m["rmse_m"] == pytest.approx(math.sqrt(sum(v * v for v in d) / 3), abs=1e-3)
    assert m["max_abs_m"] == 1.0


def test_survey_table():
    s = T.load_survey()
    assert len(s) == 21
    n = sum((x["trace_left_m"] is not None) + (x["trace_right_m"] is not None) for x in s)
    assert n == 22
    assert [x["dist_m"] for x in s] == sorted(x["dist_m"] for x in s)


@pytest.mark.skipif(not (T.WEB_DATA / "v1" / "validation" / "trace_levels.json").exists(), reason="게시 파일 없음")
def test_published_matches():
    pub = json.loads((T.WEB_DATA / "v1" / "validation" / "trace_levels.json").read_text(encoding="utf-8"))
    for sid, m in pub["published_results"].items():
        rv = json.loads((T.WEB_DATA / "v1" / sid / "river.json").read_text(encoding="utf-8"))
        assert T.compare(T.load_survey(), rv)["metrics"] == m
