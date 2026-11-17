// 3D 재현 (/3d) — 브이월드 WebGL 3D 지도 API 3.0 (Cesium 기반) 위에 침수심을 지면에 덮어 보여 준다 (docs/GUIDE.md §4.4.5 L2).
//
// 이 화면만 React 페이지가 아니라 HTML을 직접 돌려준다: 브이월드 초기화 스크립트(webglMapInit.js.do)가 document.write로
// 다른 스크립트를 넣기 때문에, 문서를 읽는 중에(<head>) 불러야만 동작한다 (2026-11-05 확인). 화면 동작은 public/view3d/.
// 키는 Vercel 환경 변수(NEXT_PUBLIC_VWORLD_KEY, 배포 주소에 등록된 키)에서 넣는다 — 저장소에는 없다.
import { DEPTH_CLASSES } from "@/lib/depth";

export const dynamic = "force-static";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

export function GET() {
  const key = process.env.NEXT_PUBLIC_VWORLD_KEY ?? "";
  const build = (process.env.VERCEL_GIT_COMMIT_SHA ?? "dev").slice(0, 8);
  const cfg = {
    dataRoot: "/data",
    supabaseUrl: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, ""),
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    hasKey: key.length > 0,
    vworldKey: key, // 지붕 항공사진(WMTS Satellite)용 — 같은 키가 위 스크립트 주소에도 이미 공개되어 있음
    classes: DEPTH_CLASSES.map((c) => ({ ...c, hi: Number.isFinite(c.hi) ? c.hi : null })),
  };
  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#063a74" />
<title>3D 재현 — 힌남노 침수 다시보기</title>
<meta name="description" content="2022 태풍 힌남노 포항 냉천 침수 모의 결과를 브이월드 3D 지도 위에 시간대별로 재현합니다." />
<link rel="icon" href="/icons/icon-192.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/view3d/view3d.css?v=${build}" />
<script>window.__VIEW3D__ = ${JSON.stringify(cfg).replace(/</g, "\\u003c")};</script>
${key ? `<script src="https://map.vworld.kr/js/webglMapInit.js.do?version=3.0&apiKey=${esc(key)}"></script>` : ""}
<script src="/view3d/buildings.js?v=${build}" defer></script>
<script src="/view3d/view3d.js?v=${build}" defer></script>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="brand-sub">2022년 9월 6일 태풍 힌남노<span class="wide-only"> · 경상북도 포항시 냉천</span></span>
    <span class="brand-title">힌남노 침수 다시보기</span>
  </div>
  <nav class="topnav" aria-label="주 메뉴">
    <a href="/">침수 지도</a>
    <a href="/3d" aria-current="page">3D 재현</a>
    <a href="/analysis">분석·비교</a>
    <a href="/run" class="wide-only">조건 설정·실행</a>
  </nav>
</header>
<main class="stage3d">
  <div id="vmap" aria-label="3D 지도"></div>
  <div id="status" class="v3-status" role="status">3D 지도를 불러오는 중…</div>
  <aside id="panel" class="v3-panel" aria-label="3D 재현 설정">
    <button type="button" id="fold" class="v3-fold" aria-expanded="true">설정 접기</button>
    <div class="v3-body">
      <label class="v3-field"><span>해석 조건</span><select id="scn" aria-label="해석 조건"></select></label>
      <div class="seg" role="radiogroup" aria-label="보기">
        <button type="button" role="radio" data-mode="max" aria-checked="true">최대 침수심</button>
        <button type="button" role="radio" data-mode="time" aria-checked="false">시간대별</button>
      </div>
      <div id="timebox" class="v3-time" hidden>
        <button type="button" id="play" class="play-btn" aria-label="재생"></button>
        <input type="range" id="slider" min="0" max="69" step="1" value="0" aria-label="시각" />
        <output id="tlabel" class="v3-tlabel"></output>
      </div>
      <p id="nowline" class="v3-now"></p>
      <div class="v3-flowrow">
        <button type="button" id="flowbtn" class="v3-toggle" aria-pressed="false"><svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 4h11M9 1l3 3-3 3"/><path d="M5 11h11M13 8l3 3-3 3"/></svg>흐름 보기</button>
        <span id="flowinfo" class="v3-flowinfo"></span>
      </div>
      <p id="flownote" class="v3-note" hidden>흰 줄은 물이 흐르는 방향과 빠르기(길수록 빠름)를 실제보다 100배 빠르게 흘린 것입니다. 하천은 단면 평균 유속(유량 ÷ 흐름 단면적), 범람 구역은 HEC-RAS 셀 경계면 유속으로 다시 계산한 셀 유속(20 m 격자)으로 그렸고, 방향·빠르기 비교용 표현입니다.</p>
      <ul id="legend" class="v3-legend" aria-label="침수심 범례"></ul>
      <div class="v3-views">
        <button type="button" data-view="tilt">비스듬히 보기</button>
        <button type="button" data-view="top">위에서 보기</button>
      </div>
      <fieldset class="v3-layers">
        <legend>지도에 함께 보기</legend>
        <label><input type="checkbox" id="w3d" checked /> 물 높이 3D (수면을 수심만큼 세우고 건물 잠김 표시)</label>
        <label><input type="checkbox" id="bld" checked /> 건물 (건물통합정보 높이·층수·용도)</label>
        <div class="seg seg-sm" role="radiogroup" aria-label="건물 표현">
          <button type="button" role="radio" data-bstyle="real" aria-checked="true">실사화</button>
          <button type="button" role="radio" data-bstyle="white" aria-checked="false">흰색 모형</button>
        </div>
        <p id="bldnote" class="v3-note" aria-live="polite"></p>
        <label><input type="checkbox" id="adm" checked /> 행정구역 경계·이름 (시군구·읍면동)</label>
        <label><input type="checkbox" id="names" /> 건물·상호 이름</label>
      </fieldset>
      <div id="pick" class="v3-pick" aria-live="polite"><span class="muted">지도를 누르면 그 자리의 침수심 등급을 보여 줍니다.</span></div>
      <p class="v3-note">물은 2 m 지형으로 계산한 수심을 브이월드 지면 위에 덮어 그렸습니다 (수위를 높이로 띄우지 않음). 셀 안 수면은 셀 꼭짓점 수위를 이어 보간한 경사 수면(HEC-RAS RAS Mapper의 Sloping 표현과 같은 원리)이고, 수심을 이어진 색으로 칠해 얕을수록 투명하게, 0.5·1·2 m에 가는 등수심선을 그었습니다(이 자료가 아직 없는 결과는 4등급 색). 시간대별 물 표면의 물결은 그 시각 유속 방향으로 움직이는 표현입니다. '물 높이 3D'는 수면을 브이월드 지면에서 수심만큼 올려 세운 것으로(수위 절대 높이가 아님), 건물 벽은 둘레 수심(외곽선에서 3 m 바깥 중 가장 깊은 곳)까지 잠긴 색과 물 높이 선으로 그렸습니다. 하천 수로의 물은 브이월드 지형과 측량 하상이 달라 세우지 않고 지면 색으로만 보입니다. 숫자는 2 m 지형 기준이고, 항공사진·건물은 촬영 시점이라 2022년 9월과 다를 수 있습니다. 건물은 국토교통부 GIS건물통합정보(브이월드)의 외곽선·높이·지상층수·주용도로 직접 세웠습니다. 지붕은 브이월드 항공사진(높은 건물은 사진이 비스듬히 찍혀 지붕 무늬가 조금 밀릴 수 있음), 벽은 용도별(아파트·주택·상가·공장·공공) 표현에 실제 층수만큼 창을 그린 것으로 실제 외벽 사진이 아닙니다(흰색 모형은 무늬 없이 명암만). 그림자는 남서쪽 빛을 가정한 표현입니다. 2022년 9월 6일 이후 사용승인된 건물은 뺐고, 건물을 누르면 층수·용도·사용승인일을 보여 줍니다. 건물은 지도를 가까이(높이 약 4 km 아래) 볼 때 보는 곳 둘레부터 불러옵니다. 행정구역은 통계청 통계지리정보서비스 행정동 경계(2022년 7월 기준, 공공누리 제1유형)를 vuski/admdongkor가 가공한 자료(CC BY 4.0)입니다. HEC-RAS 1D–2D 모의 결과로 실제 침수와 다를 수 있습니다.</p>
    </div>
  </aside>
</main>
${key ? "" : `<p class="v3-nokey">브이월드 키(NEXT_PUBLIC_VWORLD_KEY)가 없어 3D 지도를 열 수 없습니다.</p>`}
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
