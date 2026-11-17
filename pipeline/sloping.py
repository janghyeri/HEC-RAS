"""경사 수면(RAS Mapper 'Sloping' 표현과 같은 원리) — 셀 하나에 수위 하나가 아니라, 셀 꼭짓점(면점) 수위를
이웃 셀 수위로 정하고 셀 안을 삼각형으로 보간해 화소별 수위를 만든다.

왜: 셀마다 수위를 그대로 깔면(RAS Mapper 'Horizontal') 수심 경계가 셀 모양대로 계단처럼 끊긴다. 사용자 RAS Mapper
설정(NC090902.rasmap RenderMode=sloping)과 같은 방식으로 웹 수심 이미지를 그리기 위해 (2026-11-17 사용자 결정).

계산 (화면 표현용 — KPI(셀 기준)에는 쓰지 않는다)
  1. 젖은 셀: 셀 수위 − 셀 최저 표고 > 0.001 m (RAS Mapper와 같은 기준). 마른 셀 화소는 물 없음.
  2. 셀 c의 꼭짓점 p 수위 = p를 둘러싼 셀 가운데 c와 '물이 이어진' 셀들의 수위 평균.
     이웃 두 셀이 공유하는 면(face)의 최저 표고가 두 셀 수위보다 모두 낮으면(면이 양쪽에서 잠김) 이어졌다고 본다.
     면이 한쪽 수위보다 높으면(둑·턱을 넘어 떨어지는 물) 잇지 않아 그 자리 수면 단차를 그대로 둔다.
     같은 꼭짓점 둘레에서 이어진 셀끼리는 같은 값을 쓰므로 셀 경계에서 수면이 끊기지 않는다.
  3. 화소 수위 = 셀 중심(셀 수위)·꼭짓점 두 개로 만든 삼각형 안 무게중심 좌표 보간. 수심 = 화소 수위 − 2 m 지형.

RAS Mapper와 같은 값은 아니다 — RAS Mapper는 면 수위의 연결 상태를 더 자세히 나누고 면점 값을 평면 회귀로 구한다
(rivia 문서: RasMapperLib 'Sloping (Cell Corners)'). 여기서는 같은 원리를 단순하게 따른다.
"""
from __future__ import annotations

import numpy as np

WET_EPS = 0.001          # 젖은 셀 기준 (m)


class SlopingMesh:
    """여러 2D 영역을 이어 붙인 전역 셀 번호(=build_mesh·ws_frames 순서) 기준."""

    def __init__(self, areas: list[dict]):
        """areas: 영역마다 dict(center (n,2), facepoints (m,2), cell_fp_index (n,k) -1 채움, zmin (n,),
        faces_fp (nf,2) 또는 None, faces_zmin (nf,) 또는 None)"""
        centers, zmins, fps = [], [], []
        node_cell, node_fp, cstart = [], [], [0]
        pair_c1, pair_c2, pair_n1a, pair_n2a, pair_n1b, pair_n2b, pair_zf = ([] for _ in range(7))
        cell_off = fp_off = 0
        for a in areas:
            cen = np.asarray(a["center"], dtype=np.float64)
            fpt = np.asarray(a["facepoints"], dtype=np.float64)
            idx = np.asarray(a["cell_fp_index"], dtype=np.int64)
            zmin = np.asarray(a["zmin"], dtype=np.float64)
            n = cen.shape[0]
            counts = (idx >= 0).sum(axis=1)
            # 꼭짓점 노드: 셀마다 면점 순서대로
            rows = np.repeat(np.arange(n), counts)
            if np.any((idx[:, 1:] >= 0) & (idx[:, :-1] < 0)):
                raise ValueError("면점 번호 배열에서 -1이 행 중간에 있음 (형식이 예상과 다름)")
            fp_local = idx[idx >= 0]                       # 행 순서대로 펼침
            starts_local = np.concatenate([[0], np.cumsum(counts)[:-1]])
            base = cstart[-1]
            node_cell.append(rows + cell_off)
            node_fp.append(fp_local + fp_off)
            cstart.extend((base + np.cumsum(counts)).tolist())

            # 셀 변(연속한 두 꼭짓점) → 이웃 셀 찾기
            k_in = np.arange(fp_local.size) - np.repeat(starts_local, counts)      # 셀 안 순번
            nxt = np.where(k_in + 1 < np.repeat(counts, counts), np.arange(fp_local.size) + 1,
                           np.repeat(starts_local, counts))                        # 다음 꼭짓점(마지막은 처음으로)
            fa, fb = fp_local, fp_local[nxt]
            lo, hi = np.minimum(fa, fb), np.maximum(fa, fb)
            m = fpt.shape[0]
            key = lo * m + hi
            order = np.argsort(key, kind="stable")
            ks = key[order]
            same = np.flatnonzero(ks[1:] == ks[:-1])
            e1, e2 = order[same], order[same + 1]              # 같은 변을 가진 두 셀의 (꼭짓점 위치)
            c1, c2 = rows[e1], rows[e2]
            # 셀 c1의 변: 꼭짓점 e1(면점 fa[e1]) → nxt[e1](면점 fb[e1]). 셀 c2에서 같은 면점 찾기
            n1a, n1b = e1, nxt[e1]
            p_a = fa[e1]
            n2a = np.where(fa[e2] == p_a, e2, nxt[e2])
            n2b = np.where(fa[e2] == p_a, nxt[e2], e2)
            # 면 최저 표고
            zf = None
            if a.get("faces_fp") is not None and a.get("faces_zmin") is not None:
                ffp = np.asarray(a["faces_fp"], dtype=np.int64)
                fz = np.asarray(a["faces_zmin"], dtype=np.float64)
                fk = np.minimum(ffp[:, 0], ffp[:, 1]) * m + np.maximum(ffp[:, 0], ffp[:, 1])
                fo = np.argsort(fk)
                pos = np.searchsorted(fk[fo], ks[same])
                pos = np.clip(pos, 0, fk.size - 1)
                hit = fk[fo][pos] == ks[same]
                zf = np.where(hit, fz[fo][pos], np.nan)
            if zf is None:
                zf = np.full(c1.size, np.nan)
            zf = np.where(np.isfinite(zf), zf, np.maximum(zmin[c1], zmin[c2]))  # 면 자료가 없으면 두 셀 최저 표고 중 높은 쪽
            pair_c1.append(c1 + cell_off)
            pair_c2.append(c2 + cell_off)
            pair_n1a.append(n1a + base)
            pair_n2a.append(n2a + base)
            pair_n1b.append(n1b + base)
            pair_n2b.append(n2b + base)
            pair_zf.append(zf)
            centers.append(cen)
            zmins.append(zmin)
            fps.append(fpt)
            cell_off += n
            fp_off += m
        self.center = np.concatenate(centers)
        self.zmin = np.concatenate(zmins)
        self.fp_xy = np.concatenate(fps)
        self.node_cell = np.concatenate(node_cell)
        self.node_fp = np.concatenate(node_fp)
        self.cstart = np.asarray(cstart, dtype=np.int64)          # (n_cells+1,)
        self.n_cells = self.center.shape[0]
        self.n_nodes = self.node_cell.size
        c1 = np.concatenate(pair_c1)
        c2 = np.concatenate(pair_c2)
        self.face_c1, self.face_c2, self.face_zf = c1, c2, np.concatenate(pair_zf)
        # 이음 후보: 면 하나에 꼭짓점 두 쌍 (양 끝 면점)
        self.edge_u = np.concatenate([np.concatenate(pair_n1a), np.concatenate(pair_n1b)])
        self.edge_v = np.concatenate([np.concatenate(pair_n2a), np.concatenate(pair_n2b)])
        self.n_faces_internal = c1.size

    # ------------------------------------------------------------ 꼭짓점 수위
    def wet(self, cell_ws: np.ndarray) -> np.ndarray:
        ws = np.asarray(cell_ws, dtype=np.float64)
        return np.isfinite(ws) & (ws - self.zmin > WET_EPS)

    def corner_ws(self, cell_ws: np.ndarray) -> np.ndarray:
        """꼭짓점 노드별 수위 (마른 셀의 노드는 NaN)."""
        ws = np.asarray(cell_ws, dtype=np.float64)
        wet = self.wet(ws)
        c1, c2 = self.face_c1, self.face_c2
        conn = wet[c1] & wet[c2] & (self.face_zf < np.minimum(ws[c1], ws[c2]))
        conn2 = np.concatenate([conn, conn])
        u, v = self.edge_u[conn2], self.edge_v[conn2]
        lab = np.arange(self.n_nodes)
        for _ in range(64):                    # 꼭짓점 둘레 셀 몇 개끼리라 몇 번이면 수렴
            m = np.minimum(lab[u], lab[v])
            new = lab.copy()
            np.minimum.at(new, u, m)
            np.minimum.at(new, v, m)
            new = new[new]
            if np.array_equal(new, lab):
                break
            lab = new
        ok = wet[self.node_cell]
        wsn = ws[self.node_cell]
        s = np.bincount(lab[ok], weights=wsn[ok], minlength=self.n_nodes)
        c = np.bincount(lab[ok], minlength=self.n_nodes)
        out = np.full(self.n_nodes, np.nan)
        out[ok] = s[lab[ok]] / c[lab[ok]]
        return out

    # ------------------------------------------------------------ 화소 보간 계수 (한 번만)
    def stencil(self, px: np.ndarray, py: np.ndarray, pcell: np.ndarray, chunk: int = 1_000_000) -> dict:
        """화소(EPSG:5187 좌표, 셀 번호)마다 삼각형(셀 중심, 꼭짓점 a, b)과 무게 (w0 중심, w1 a, w2 b)."""
        n = pcell.size
        w = np.zeros((n, 3), dtype=np.float32)
        na = np.zeros(n, dtype=np.int32)
        nb = np.zeros(n, dtype=np.int32)
        kmax = int(np.max(np.diff(self.cstart))) if self.n_cells else 0
        for s0 in range(0, n, chunk):
            sl = slice(s0, min(n, s0 + chunk))
            c = pcell[sl]
            cx, cy = self.center[c, 0], self.center[c, 1]
            dx, dy = px[sl] - cx, py[sl] - cy
            st = self.cstart[c]
            K = self.cstart[c + 1] - st
            best = np.full(c.size, -np.inf)
            bw = np.zeros((c.size, 3))
            ba = np.zeros(c.size, dtype=np.int64)
            bb = np.zeros(c.size, dtype=np.int64)
            for k in range(kmax):
                valid = k < K
                a = st + np.minimum(k, K - 1)
                b = np.where(k + 1 < K, st + k + 1, st)
                A = self.fp_xy[self.node_fp[a]]
                B = self.fp_xy[self.node_fp[b]]
                v0x, v0y = A[:, 0] - cx, A[:, 1] - cy
                v1x, v1y = B[:, 0] - cx, B[:, 1] - cy
                den = v0x * v1y - v1x * v0y
                good = valid & (np.abs(den) > 1e-9)
                with np.errstate(divide="ignore", invalid="ignore"):
                    la = (dx * v1y - v1x * dy) / den
                    lb = (v0x * dy - dx * v0y) / den
                lc = 1.0 - la - lb
                score = np.where(good, np.minimum(np.minimum(la, lb), lc), -np.inf)
                upd = score > best
                best = np.where(upd, score, best)
                bw[upd] = np.stack([lc[upd], la[upd], lb[upd]], axis=1)
                ba[upd] = a[upd]
                bb[upd] = b[upd]
            # 래스터화 때문에 셀 다각형 살짝 밖인 화소 — 음수를 0으로 두고 다시 나눔
            bw = np.clip(bw, 0.0, None)
            ssum = bw.sum(axis=1, keepdims=True)
            bw = np.where(ssum > 0, bw / np.where(ssum > 0, ssum, 1), np.array([1.0, 0.0, 0.0]))
            w[sl] = bw
            na[sl] = ba
            nb[sl] = bb
        return {"cell": pcell, "w": w, "a": na, "b": nb}

    def surface(self, cell_ws: np.ndarray, st: dict, corner: np.ndarray | None = None) -> np.ndarray:
        """화소 수위 (마른 셀 화소 NaN)."""
        ws = np.asarray(cell_ws, dtype=np.float64)
        if corner is None:
            corner = self.corner_ws(ws)
        w = st["w"]
        out = w[:, 0] * ws[st["cell"]] + w[:, 1] * corner[st["a"]] + w[:, 2] * corner[st["b"]]
        out[~self.wet(ws)[st["cell"]]] = np.nan
        return out


def mesh_from_plan(plan, faces: list[dict] | None = None) -> SlopingMesh:
    """hecras_hdf.PlanResult → SlopingMesh. faces: 영역마다 dict(faces_fp, faces_zmin) (없으면 Area2D 속성 사용)."""
    areas = []
    for i, a in enumerate(plan.areas):
        f = (faces[i] if faces else None) or {}
        areas.append({"center": a.center, "facepoints": a.facepoints, "cell_fp_index": a.cell_fp_index, "zmin": a.zmin,
                      "faces_fp": f.get("faces_fp", getattr(a, "faces_fp", None)),
                      "faces_zmin": f.get("faces_zmin", getattr(a, "faces_zmin", None))})
    return SlopingMesh(areas)
