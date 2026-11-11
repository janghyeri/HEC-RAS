/* 실사풍 건물 (/3d) — 국토교통부 GIS건물통합정보(브이월드 2D 데이터 API, LT_C_BLDGINFO)로 건물을 직접 세운다.
 *  - 외곽선 그대로, 높이 = 건물 높이(없으면 지상층수 × 층고), 바닥 = 브이월드 지형(sampleTerrain 15단계)
 *  - 지붕: 브이월드 항공사진(WMTS Satellite z18, 화소 약 0.5 m)을 잘라 입힘
 *  - 벽: 주용도(아파트·주택·상가·공장·공공)별 표현 + 실제 지상층수에 맞춘 층·창 — 실제 외벽 사진이 아님
 *  - 2022-09-06 이후 사용승인된 건물은 뺀다 (힌남노 당시 없던 건물)
 * 카메라가 보는 곳 둘레의 웹 메르카토르 z16 타일(약 500 m) 단위로 불러오고, 멀어지면 지운다.
 * 자료 요청은 JSONP(브이월드 데이터 API는 CORS 머리글이 없음), 키는 이 사이트 주소에 등록된 브이월드 키.
 * 쓰는 쪽: view3d.js — HnBuildings.create(viewer, { key, onState })
 */
(function () {
  "use strict";
  var TILE_Z = 16; // 건물 묶음 타일
  var ROOF_Z = 18; // 지붕 항공사진
  var FLOOD_DAY = "20220906";
  var SINK = 1.5; // 경사지에서 떠 보이지 않게 벽을 땅속으로 조금 내림 (m)

  // 주용도코드(건축물대장) → 표현 묶음
  var CAT = { HOUSE: 0, APT: 1, SHOP: 2, FACTORY: 3, PUBLIC: 4 };
  var USE = {
    "01000": CAT.HOUSE, // 단독주택
    "02000": CAT.APT, // 공동주택 (낮으면 아래에서 주택으로)
    "03000": CAT.SHOP, // 제1종 근린생활
    "04000": CAT.SHOP, // 제2종 근린생활
    "07000": CAT.SHOP, // 판매
    "14000": CAT.SHOP, // 업무
    "15000": CAT.SHOP, // 숙박
    "16000": CAT.SHOP, // 위락
    "17000": CAT.FACTORY, // 공장
    "18000": CAT.FACTORY, // 창고
    "19000": CAT.FACTORY, // 위험물 저장·처리
    "20000": CAT.FACTORY, // 자동차 관련
    "21000": CAT.FACTORY, // 동물·식물 관련
    "22000": CAT.FACTORY, // 자원순환 관련
  };
  var USE_NAME = {
    "01000": "단독주택", "02000": "공동주택", "03000": "제1종 근린생활시설", "04000": "제2종 근린생활시설",
    "05000": "문화·집회시설", "06000": "종교시설", "07000": "판매시설", "08000": "운수시설", "09000": "의료시설",
    "10000": "교육연구시설", "11000": "노유자시설", "12000": "수련시설", "13000": "운동시설", "14000": "업무시설",
    "15000": "숙박시설", "16000": "위락시설", "17000": "공장", "18000": "창고시설", "19000": "위험물 저장·처리시설",
    "20000": "자동차 관련 시설", "21000": "동물·식물 관련 시설", "22000": "자원순환 관련 시설",
  };

  // ---------------------------------------------------------------- 셰이더 (재질 안에 모두 둔다 — 재질 uniform 이름이 바뀌어도 쓰도록)
  var MAT_SRC = [
    // fwidth(무늬 흐리기·경계 부드럽게)용. Cesium이 #extension 줄을 셰이더 맨 앞으로 옮긴다
    "#extension GL_OES_standard_derivatives : enable",
    "varying vec3 v_positionEC;",
    "varying vec3 v_normalEC;",
    "varying vec4 v_facade;", // 벽 안 위치 s(m, 면 시작부터), 바닥에서 높이 t(m), 층고(m), 표현 코드(묶음×64 + 씨앗)
    "varying vec4 v_extra;", // 면 길이(m), 건물 높이(m), 지상층수, 지붕이면 1
    "varying vec4 v_roof;", // 지붕 사진 좌표 s,t + 건물 중심의 사진 좌표
    "uniform sampler2D roofImg;",
    "uniform float roofOn;",
    "float hb(float n) { return fract(sin(n * 12.9898) * 43758.5453); }",
    "float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
    "float vn(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);",
    "  return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), u.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), u.x), u.y); }",
    // 부드러운 사각 띠: a~b 안이면 1 (경계 너비 w)
    "float band(float x, float a, float b, float w) { return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x)); }",
    // 일정 간격으로 되풀이되는 창: 간격 p, 창 폭 wd(가운데 기준), x는 m
    "float rep(float x, float p, float wd, float w) { float u = (fract(x / p) - 0.5) * p; return band(u, -wd * 0.5, wd * 0.5, w); }",
    "vec3 pick4(float r, vec3 a, vec3 b, vec3 c, vec3 d) { return r < 0.25 ? a : (r < 0.5 ? b : (r < 0.75 ? c : d)); }",
    "vec3 glassCol(float ty, float fh, float k) {",
    "  vec3 dark = vec3(0.16, 0.20, 0.24) + 0.05 * k;",
    "  vec3 skyc = vec3(0.56, 0.64, 0.72);",
    "  return mix(dark, skyc, 0.18 + 0.32 * clamp(ty / fh, 0.0, 1.0) * k);",
    "}",
    "czm_material czm_getMaterial(czm_materialInput materialInput) {",
    "  czm_material m = czm_getDefaultMaterial(materialInput);",
    "  vec3 n = normalize(v_normalEC);",
    "  if (dot(n, -v_positionEC) < 0.0) n = -n;",
    "  vec3 upW = normalize((czm_inverseView * vec4(v_positionEC, 1.0)).xyz);",
    "  vec3 eastW = normalize(cross(vec3(0.0, 0.0, 1.0), upW));",
    "  vec3 northW = cross(upW, eastW);",
    "  vec3 upE = normalize(czm_viewRotation * upW);",
    "  vec3 L = normalize(czm_viewRotation * normalize(upW * 0.75 - eastW * 0.45 - northW * 0.55));",
    "  float diff = max(dot(n, L), 0.0);",
    "  float sky = 0.5 + 0.5 * dot(n, upE);",
    "  float cat = floor(v_facade.w / 64.0 + 0.001);",
    "  float seed = v_facade.w - cat * 64.0;",
    "  float r1 = hb(seed + 1.0), r2 = hb(seed + 7.0), r3 = hb(seed + 13.0);",
    "  float H = v_extra.y;",
    // ---- 지붕: 낮은 건물은 항공사진(가장자리 번짐을 줄이려고 건물 중심 쪽으로 12 % 당겨 읽음), 높은 건물은 사진이 비스듬해 콘크리트 옥상
    "  if (v_extra.w > 0.5) {",
    "    vec3 base = mix(vec3(0.56, 0.57, 0.55), vec3(0.70, 0.70, 0.67), r1);",
    "    vec3 rc = base * (0.9 + 0.2 * vn(v_roof.xy * 900.0));",
    "    if (roofOn > 0.5 && H < 16.0) {",
    "      vec3 a = texture2D(roofImg, clamp(mix(v_roof.xy, v_roof.zw, 0.12), 0.0, 1.0)).rgb;",
    "      rc = mix(a, base, 0.12);",
    "    }",
    "    m.diffuse = rc * (0.78 + 0.22 * diff);",
    "    return m;",
    "  }",
    // ---- 벽
    "  float s = v_facade.x, t = v_facade.y, fh = max(v_facade.z, 2.4);",
    "  float segL = max(v_extra.x, 0.5), floors = max(v_extra.z, 1.0);",
    "  float ws = max(fwidth(s), 0.002), wt = max(fwidth(t), 0.002), aa = max(ws, wt);",
    "  float fade = clamp(1.8 - aa * 2.2, 0.0, 1.0);", // 화소당 0.8 m보다 성기면 무늬를 흐린다
    "  float fi = floor(t / fh), ty = fract(t / fh) * fh;",
    "  float x = s - segL * 0.5;", // 면 가운데 기준
    "  float stuc = vn(vec2(s, t) * 1.6) * 0.6 + vn(vec2(s, t) * 0.31) * 0.4;",
    "  vec3 wall; vec3 col; float win = 0.0; vec3 glass = glassCol(ty, fh, 0.6 + 0.4 * hb(floor(s / 2.0) + fi * 7.0 + seed));",
    "  float frame = 0.0;",
    "  if (cat < 0.5) {", // ---- 주택: 면마다 창 1~3개(테두리), 몇 면은 1층 문, 벽돌 무늬
    "    wall = pick4(r1, vec3(0.62, 0.40, 0.32), vec3(0.84, 0.77, 0.65), vec3(0.73, 0.72, 0.69), vec3(0.88, 0.85, 0.77));",
    "    float nw = max(1.0, floor(segL / 3.6));",
    "    float p = segL / nw;",
    "    float u = (fract(s / p) - 0.5) * p;",
    "    float wd = min(1.4, p * 0.55);",
    "    win = band(u, -wd * 0.5, wd * 0.5, ws) * band(ty, 0.9, min(2.2, fh - 0.35), wt) * step(2.0, segL);",
    "    frame = band(u, -wd * 0.5 - 0.08, wd * 0.5 + 0.08, ws) * band(ty, 0.82, min(2.2, fh - 0.35) + 0.08, wt) - win;",
    "    float door = step(0.55, hb(seed + floor(segL * 10.0))) * band(x, segL * 0.22 - 0.5, segL * 0.22 + 0.5, ws) * band(t, 0.0, 2.1, wt) * step(fi, 0.5) * step(3.0, segL);",
    "    if (r1 < 0.25) {", // 벽돌
    "      float row = floor(t / 0.075);",
    "      float mort = max(1.0 - band(fract(t / 0.075), 0.12, 1.0, wt / 0.075), 1.0 - band(fract((s + mod(row, 2.0) * 0.1) / 0.2), 0.06, 1.0, ws / 0.2));",
    "      wall = mix(wall * (0.9 + 0.18 * h2(vec2(floor((s + mod(row, 2.0) * 0.1) / 0.2), row))), vec3(0.72, 0.70, 0.66), mort * 0.7 * fade);",
    "    } else wall *= 0.94 + 0.1 * stuc;",
    "    col = mix(wall, vec3(0.93, 0.92, 0.88), frame * fade);",
    "    col = mix(col, glass, win * fade);",
    "    col = mix(col, vec3(0.30, 0.24, 0.20), door * fade);",
    "  } else if (cat < 1.5) {", // ---- 아파트: 긴 면은 층마다 발코니 난간 + 통창(세로 창살), 세대 사이 벽, 짧은 면은 막힌 벽 + 작은 창 + 색 띠
    "    wall = pick4(r1, vec3(0.91, 0.90, 0.86), vec3(0.88, 0.86, 0.81), vec3(0.93, 0.92, 0.89), vec3(0.86, 0.85, 0.82));",
    "    wall *= 0.96 + 0.06 * stuc;",
    "    if (segL >= 14.0) {",
    "      float unitW = 7.0 + 2.0 * r2;",
    "      float sep = 1.0 - band((fract(s / unitW) - 0.5) * unitW, -unitW * 0.5 + 0.35, unitW * 0.5 - 0.35, ws);",
    "      float gl = band(ty, 1.0, fh - 0.28, wt) * (1.0 - sep);",
    "      float mull = 1.0 - band(fract(s / 1.45), 0.04, 0.96, ws / 1.45);",
    "      win = gl * step(0.5, fi + 0.6 * step(0.5, r3));", // 1층은 반쯤 필로티처럼 비움
    "      col = mix(wall, glass, win * fade);",
    "      col = mix(col, vec3(0.80, 0.80, 0.78), win * mull * fade * 0.8);",
    "      col *= 1.0 - 0.18 * band(ty, 0.0, 0.18, wt) * fade;", // 층 슬래브 그림자 줄
    "      col *= 1.0 - 0.12 * band(ty, 0.95, 1.05, wt) * fade;", // 난간 윗선
    "    } else {",
    "      win = band(x, -0.5, 0.5, ws) * band(ty, 1.0, 2.1, wt);",
    "      vec3 accent = pick4(r2, vec3(0.30, 0.42, 0.40), vec3(0.50, 0.36, 0.30), vec3(0.32, 0.36, 0.46), vec3(0.55, 0.52, 0.46));",
    "      float stripe = band(x, segL * 0.18, segL * 0.18 + 1.4, ws) * band(t, H * 0.55, H - 1.2, wt);",
    "      col = mix(wall, accent, stripe * 0.85);",
    "      col = mix(col, glass, win * fade);",
    "    }",
    "    col *= 1.0 - 0.15 * band(t, H - 0.7, H + 1.0, wt);", // 옥상 난간 줄
    "  } else if (cat < 2.5) {", // ---- 상가·업무: 1층 유리 진열창 + 간판 띠, 위층은 띠창 또는 창
    "    wall = pick4(r1, vec3(0.80, 0.80, 0.78), vec3(0.78, 0.72, 0.64), vec3(0.62, 0.46, 0.38), vec3(0.88, 0.87, 0.84));",
    "    wall *= 0.95 + 0.08 * stuc;",
    "    if (fi < 0.5) {",
    "      float shop = band(ty, 0.08, fh - 0.95, wt);",
    "      float mull = 1.0 - band(fract(s / 2.6), 0.03, 0.97, ws / 2.6);",
    "      vec3 sign = pick4(r2, vec3(0.20, 0.27, 0.40), vec3(0.45, 0.18, 0.16), vec3(0.16, 0.36, 0.30), vec3(0.34, 0.34, 0.34));",
    "      float sb = band(ty, fh - 0.9, fh - 0.15, wt);",
    "      col = mix(wall, glassCol(ty, fh, 0.5), shop * fade);",
    "      col = mix(col, vec3(0.35, 0.36, 0.37), shop * mull * fade);",
    "      col = mix(col, sign * (0.9 + 0.2 * hb(floor(s / 6.0) + seed)), sb);",
    "    } else {",
    "      if (r3 < 0.5) win = band(ty, 0.9, fh - 0.45, wt) * (1.0 - (1.0 - band(fract(s / 1.6), 0.05, 0.95, ws / 1.6)));",
    "      else win = rep(s, 2.8, 1.5, ws) * band(ty, 0.9, fh - 0.5, wt);",
    "      col = mix(wall, glass, win * fade);",
    "    }",
    "    col *= 1.0 - 0.12 * band(t, H - 0.5, H + 1.0, wt);",
    "  } else if (cat < 3.5) {", // ---- 공장·창고: 판넬 골·이음, 아래 콘크리트 띠, 위쪽 띠창, 긴 면에 셔터 문
    "    wall = pick4(r1, vec3(0.80, 0.81, 0.80), vec3(0.86, 0.84, 0.77), vec3(0.66, 0.72, 0.67), vec3(0.72, 0.74, 0.76));",
    "    float rib = band(fract(s / 0.3), 0.0, 0.5, ws / 0.3);",
    "    wall *= 1.0 - 0.06 * rib * fade;",
    "    wall *= 1.0 - 0.08 * (1.0 - band(fract(t / 1.0), 0.03, 0.97, wt)) * fade;",
    "    col = mix(wall, vec3(0.58, 0.58, 0.56) * (0.9 + 0.15 * stuc), band(t, -2.0, 1.1, wt));",
    "    win = rep(s, 4.0, 3.0, ws) * band(t, H - 2.1, H - 1.2, wt) * step(4.0, H);",
    "    col = mix(col, glassCol(0.5, 1.0, 0.7), win * fade);",
    "    float sh = step(12.0, segL) * step(0.45, r3) * band(x, -2.2, 2.2, ws) * band(t, 0.0, min(4.2, H - 1.0), wt);",
    "    col = mix(col, vec3(0.55, 0.57, 0.58) * (1.0 - 0.15 * (1.0 - band(fract(t / 0.12), 0.1, 1.0, wt / 0.12))), sh * fade + sh * (1.0 - fade) * 0.6);",
    "  } else {", // ---- 공공·교육 등: 큰 창 줄, 처마 띠
    "    wall = pick4(r1, vec3(0.86, 0.84, 0.80), vec3(0.80, 0.78, 0.74), vec3(0.78, 0.66, 0.56), vec3(0.88, 0.88, 0.86));",
    "    wall *= 0.95 + 0.08 * stuc;",
    "    win = rep(s, 3.6, 2.2, ws) * band(ty, 0.85, fh - 0.55, wt);",
    "    col = mix(wall, glass, win * fade);",
    "    col *= 1.0 - 0.15 * band(t, H - 0.6, H + 1.0, wt);",
    "  }",
    "  col = mix(col, col * 0.86, (1.0 - fade) * 0.3);", // 멀리서는 무늬 대신 조금 어둡게
    "  col *= mix(0.70, 1.0, smoothstep(-0.2, 1.4, t));", // 바닥에 닿는 곳 어둡게 (접지감)
    "  m.diffuse = col * (0.50 + 0.40 * diff + 0.14 * sky);",
    "  return m;",
    "}",
  ].join("\n");

  var VS = [
    "attribute vec3 position3DHigh;",
    "attribute vec3 position3DLow;",
    "attribute vec3 normal;",
    "attribute vec4 facade;",
    "attribute vec4 extra;",
    "attribute vec4 roof;",
    "attribute float batchId;",
    "varying vec3 v_positionEC;",
    "varying vec3 v_normalEC;",
    "varying vec4 v_facade;",
    "varying vec4 v_extra;",
    "varying vec4 v_roof;",
    "void main() {",
    "  vec4 p = czm_computePosition();",
    "  v_positionEC = (czm_modelViewRelativeToEye * p).xyz;",
    "  v_normalEC = czm_normal * normal;",
    "  v_facade = facade;",
    "  v_extra = extra;",
    "  v_roof = roof;",
    "  gl_Position = czm_modelViewProjectionRelativeToEye * p;",
    "}",
  ].join("\n");

  var FS = [
    "void main() {",
    "  czm_materialInput materialInput;",
    "  czm_material material = czm_getMaterial(materialInput);",
    "  gl_FragColor = vec4(material.diffuse, 1.0);",
    "}",
  ].join("\n");

  // ---------------------------------------------------------------- 도움 함수
  function lon2x(lon, z) {
    return ((lon + 180) / 360) * Math.pow(2, z);
  }
  function lat2y(lat, z) {
    var r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
  }
  function x2lon(x, z) {
    return (x / Math.pow(2, z)) * 360 - 180;
  }
  function y2lat(y, z) {
    var n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
  function merc(lat) {
    var r = (lat * Math.PI) / 180;
    return Math.log(Math.tan(Math.PI / 4 + r / 2));
  }

  var jsonpN = 0;
  function jsonp(params, key) {
    return new Promise(function (resolve, reject) {
      var cb = "__hnBld" + ++jsonpN + "_" + Date.now();
      var q = new URLSearchParams(params);
      q.set("key", key);
      q.set("domain", location.origin);
      q.set("format", "json");
      q.set("callback", cb);
      var s = document.createElement("script");
      var timer = setTimeout(function () {
        cleanup();
        reject(new Error("시간 초과"));
      }, 25000);
      function cleanup() {
        clearTimeout(timer);
        try {
          delete window[cb];
        } catch (e) {
          window[cb] = undefined;
        }
        s.remove();
      }
      window[cb] = function (d) {
        cleanup();
        resolve(d);
      };
      s.onerror = function () {
        cleanup();
        reject(new Error("요청 실패"));
      };
      s.src = "https://api.vworld.kr/req/data?" + q.toString();
      document.head.appendChild(s);
    });
  }

  function fetchBuildings(tile, key) {
    var w = x2lon(tile.x, TILE_Z),
      e = x2lon(tile.x + 1, TILE_Z),
      n = y2lat(tile.y, TILE_Z),
      s = y2lat(tile.y + 1, TILE_Z);
    var all = [];
    function page(p) {
      return jsonp(
        {
          service: "data",
          request: "GetFeature",
          data: "LT_C_BLDGINFO",
          geomFilter: "BOX(" + w + "," + s + "," + e + "," + n + ")",
          size: "1000",
          page: String(p),
          geometry: "true",
          attribute: "true",
          crs: "EPSG:4326",
        },
        key
      ).then(function (d) {
        var r = d && d.response;
        if (!r) throw new Error("응답 없음");
        if (r.status === "NOT_FOUND") return all;
        if (r.status !== "OK") throw new Error((r.error && r.error.text) || r.status);
        all = all.concat(r.result.featureCollection.features);
        var pages = Number((r.page && r.page.total) || 1);
        return p < pages && p < 8 ? page(p + 1) : all;
      });
    }
    return page(1).then(function (feats) {
      return { feats: feats, bounds: [w, s, e, n] };
    });
  }

  function loadRoof(bounds, key) {
    // 건물 범위(타일보다 조금 넓음)를 덮는 z18 위성 타일을 이어 붙인다 (최대 6×6)
    var x0 = Math.floor(lon2x(bounds[0], ROOF_Z)),
      x1 = Math.floor(lon2x(bounds[2], ROOF_Z)),
      y0 = Math.floor(lat2y(bounds[3], ROOF_Z)),
      y1 = Math.floor(lat2y(bounds[1], ROOF_Z));
    var cx = (x0 + x1) >> 1,
      cy = (y0 + y1) >> 1;
    x0 = Math.max(x0, cx - 2);
    x1 = Math.min(x1, cx + 3);
    y0 = Math.max(y0, cy - 2);
    y1 = Math.min(y1, cy + 3);
    var nx = x1 - x0 + 1,
      ny = y1 - y0 + 1;
    var cv = document.createElement("canvas");
    cv.width = nx * 256;
    cv.height = ny * 256;
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "rgb(150,150,146)";
    ctx.fillRect(0, 0, cv.width, cv.height);
    var jobs = [];
    for (var j = 0; j < ny; j++)
      for (var i = 0; i < nx; i++)
        (function (i, j) {
          var url = "https://api.vworld.kr/req/wmts/1.0.0/" + encodeURIComponent(key) + "/Satellite/" + ROOF_Z + "/" + (y0 + j) + "/" + (x0 + i) + ".jpeg";
          jobs.push(
            fetch(url, { mode: "cors" })
              .then(function (r) {
                if (!r.ok) throw new Error(r.status);
                return r.blob();
              })
              .then(createImageBitmap)
              .then(function (img) {
                ctx.drawImage(img, i * 256, j * 256);
              })
              .catch(function () {})
          );
        })(i, j);
    return Promise.all(jobs).then(function () {
      return {
        canvas: cv,
        west: x2lon(x0, ROOF_Z),
        east: x2lon(x1 + 1, ROOF_Z),
        mN: merc(y2lat(y0, ROOF_Z)),
        mS: merc(y2lat(y1 + 1, ROOF_Z)),
      };
    });
  }

  // 지상층수·높이·용도 → 높이, 층고, 표현 묶음
  function shapeOf(p) {
    var floors = parseInt(p.grnd_flr, 10);
    var h = parseFloat(p.height);
    var cat = USE[p.usability];
    if (!(floors > 0)) floors = h > 0 ? Math.max(1, Math.round(h / 3.1)) : 1;
    if (cat === undefined) cat = floors >= 5 ? CAT.APT : p.usability ? CAT.PUBLIC : CAT.HOUSE;
    if (cat === CAT.APT && floors < 5) cat = CAT.HOUSE; // 연립·다세대
    var per = cat === CAT.FACTORY ? 5.5 : cat === CAT.SHOP ? 3.4 : cat === CAT.PUBLIC ? 3.6 : 2.9;
    if (!(h > 0)) h = floors * per + (cat === CAT.APT ? 1.2 : 0.4);
    h = Math.max(2.5, Math.min(h, 250));
    var fh = Math.max(2.4, Math.min(cat === CAT.FACTORY ? 12 : 6, h / floors));
    return { h: h, fh: fh, cat: cat, floors: floors };
  }

  function ringsOf(geom) {
    var polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    return polys;
  }

  // ---------------------------------------------------------------- 기하 만들기
  function buildGeometry(list, roof) {
    var pos = [],
      nor = [],
      fac = [],
      ext = [],
      rof = [],
      idx = [];
    var vcount = 0;
    var C = Cesium;
    var tmpA = new C.Cartesian3(),
      tmpB = new C.Cartesian3(),
      up = new C.Cartesian3(),
      nrm = new C.Cartesian3();
    var wE = roof ? roof.east - roof.west : 1,
      wM = roof ? roof.mN - roof.mS : 1;
    function rst(lon, lat) {
      return roof ? [(lon - roof.west) / wE, (merc(lat) - roof.mS) / wM] : [0, 0];
    }
    function push(c, n, f0, f1, f2, f3, e0, e1, e2, e3, r0, r1, r2, r3) {
      pos.push(c.x, c.y, c.z);
      nor.push(n.x, n.y, n.z);
      fac.push(f0, f1, f2, f3);
      ext.push(e0, e1, e2, e3);
      rof.push(r0, r1, r2, r3);
      return vcount++;
    }
    function clean(ring) {
      var pts = ring.slice();
      if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
      return pts;
    }
    list.forEach(function (b) {
      var base = b.base - SINK,
        top = b.base + b.shape.h,
        H = b.shape.h,
        fh = b.shape.fh,
        fl = b.shape.floors;
      var code = b.shape.cat * 64 + b.seed;
      b.polys.forEach(function (poly) {
        // 벽: 모든 고리 (구멍 포함). 면마다 s = 면 시작부터 거리
        poly.forEach(function (ring) {
          var pts = clean(ring);
          if (pts.length < 3) return;
          for (var i = 0; i < pts.length; i++) {
            var p = pts[i],
              q = pts[(i + 1) % pts.length];
            var pb = C.Cartesian3.fromDegrees(p[0], p[1], base),
              qb = C.Cartesian3.fromDegrees(q[0], q[1], base),
              pt = C.Cartesian3.fromDegrees(p[0], p[1], top),
              qt = C.Cartesian3.fromDegrees(q[0], q[1], top);
            var len = C.Cartesian3.distance(pb, qb);
            if (len < 0.05) continue;
            C.Cartesian3.subtract(qb, pb, tmpA);
            C.Cartesian3.normalize(pb, up);
            C.Cartesian3.cross(tmpA, up, nrm);
            if (C.Cartesian3.magnitude(nrm) < 1e-9) continue;
            C.Cartesian3.normalize(nrm, nrm);
            var a = push(pb, nrm, 0, -SINK, fh, code, len, H, fl, 0, -1, -1, -1, -1),
              bq = push(qb, nrm, len, -SINK, fh, code, len, H, fl, 0, -1, -1, -1, -1),
              c = push(qt, nrm, len, H, fh, code, len, H, fl, 0, -1, -1, -1, -1),
              d = push(pt, nrm, 0, H, fh, code, len, H, fl, 0, -1, -1, -1, -1);
            idx.push(a, bq, c, a, c, d);
          }
        });
        // 지붕: 바깥 고리 + 구멍을 삼각형으로
        var flat = [],
          holes = [],
          ll = [];
        poly.forEach(function (ring, ri) {
          var pts = clean(ring);
          if (ri > 0) holes.push(flat.length);
          pts.forEach(function (p) {
            flat.push(new C.Cartesian2(p[0] * b.kx, p[1] * 110540));
            ll.push(p);
          });
        });
        if (flat.length < 3) return;
        var tri;
        try {
          tri = C.PolygonPipeline.triangulate(flat, holes);
        } catch (e) {
          return;
        }
        var upN = C.Cartesian3.normalize(C.Cartesian3.fromDegrees(ll[0][0], ll[0][1], top, C.Ellipsoid.WGS84, tmpB), new C.Cartesian3());
        var cst = rst(C.Math.toDegrees(b.c.longitude), C.Math.toDegrees(b.c.latitude));
        var start = vcount;
        ll.forEach(function (p) {
          var r = rst(p[0], p[1]);
          push(C.Cartesian3.fromDegrees(p[0], p[1], top), upN, 0, H, fh, code, 0, H, fl, 1, r[0], r[1], cst[0], cst[1]);
        });
        for (var k = 0; k < tri.length; k++) idx.push(start + tri[k]);
      });
    });
    if (!idx.length) return null;
    var positions = new Float64Array(pos);
    function f(vals, n) {
      return new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: n, values: new Float32Array(vals) });
    }
    return new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
        normal: f(nor, 3),
        facade: f(fac, 4),
        extra: f(ext, 4),
        roof: f(rof, 4),
      },
      indices: Cesium.IndexDatatype.createTypedArray(vcount, idx),
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
    });
  }

  // ---------------------------------------------------------------- 관리자
  function create(viewer, opts) {
    var key = opts.key;
    var tiles = {}; // "x/y" → {state, prim, count}
    var active = false;
    var queue = [];
    var running = 0;
    var stats = { buildings: 0, skippedNew: 0, tiles: 0, failed: 0 };
    var failures = 0;

    function state(msg) {
      if (opts.onState) opts.onState(msg, stats);
    }

    function makeAppearance(roof) {
      var mat = new Cesium.Material({
        translucent: false,
        fabric: {
          type: "HnBuilding" + Math.random().toString(36).slice(2, 8),
          uniforms: { roofImg: roof ? roof.canvas : Cesium.Material.DefaultImageId, roofOn: roof ? 1 : 0 },
          source: MAT_SRC,
        },
      });
      return new Cesium.Appearance({
        material: mat,
        translucent: false,
        closed: false,
        vertexShaderSource: VS,
        fragmentShaderSource: FS,
        renderState: { depthTest: { enabled: true }, depthMask: true, cull: { enabled: false } },
      });
    }

    function loadTile(t) {
      var id = t.x + "/" + t.y;
      return fetchBuildings(t, key)
        .then(function (res) {
          if (!active || !tiles[id]) return;
          var list = [];
          var bb = [Infinity, Infinity, -Infinity, -Infinity];
          res.feats.forEach(function (f) {
            var p = f.properties || {};
            if (p.useapr_day && p.useapr_day > FLOOD_DAY) {
              stats.skippedNew++;
              return;
            }
            var polys = ringsOf(f.geometry);
            if (!polys.length || !polys[0][0] || polys[0][0].length < 3) return;
            // 타일 경계에 걸친 건물은 첫 꼭짓점이 든 타일에서만
            var v0 = polys[0][0][0];
            if (Math.floor(lon2x(v0[0], TILE_Z)) !== t.x || Math.floor(lat2y(v0[1], TILE_Z)) !== t.y) return;
            var cx = 0,
              cy = 0,
              n = 0;
            polys.forEach(function (poly) {
              poly[0].forEach(function (c) {
                cx += c[0];
                cy += c[1];
                n++;
                if (c[0] < bb[0]) bb[0] = c[0];
                if (c[1] < bb[1]) bb[1] = c[1];
                if (c[0] > bb[2]) bb[2] = c[0];
                if (c[1] > bb[3]) bb[3] = c[1];
              });
            });
            list.push({
              polys: polys,
              c: Cesium.Cartographic.fromDegrees(cx / n, cy / n),
              shape: shapeOf(p),
              seed: (Math.abs(parseInt(String(p.useapr_day || "0").slice(-4), 10) || 0) + list.length * 7) % 64,
              kx: 111320 * Math.cos(((cy / n) * Math.PI) / 180),
              props: p,
            });
          });
          if (!list.length) return { list: list };
          return Promise.all([
            Cesium.sampleTerrain(viewer.terrainProvider, 15, list.map(function (b) {
              return b.c;
            })).catch(function () {
              return null;
            }),
            loadRoof(bb, key).catch(function () {
              return null;
            }),
          ]).then(function (r) {
            list.forEach(function (b) {
              var h = b.c.height;
              if (!(isFinite(h))) {
                var g = viewer.scene.globe.getHeight(b.c);
                h = g === undefined ? 0 : g;
              }
              b.base = h;
            });
            return { list: list, roof: r[1] };
          });
        })
        .then(function (res) {
          var T = tiles[id];
          if (!active || !T || !res) return;
          T.count = res.list.length;
          if (!res.list.length) {
            T.state = "empty";
            return;
          }
          var geom = buildGeometry(res.list, res.roof);
          if (!geom) {
            T.state = "empty";
            return;
          }
          var prim = new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({ geometry: geom }),
            appearance: makeAppearance(res.roof),
            asynchronous: false,
            compressVertices: false,
            releaseGeometryInstances: true,
            allowPicking: false,
            shadows: Cesium.ShadowMode.ENABLED,
            show: active,
          });
          viewer.scene.primitives.add(prim);
          T.prim = prim;
          T.list = res.list.map(function (b) {
            return { c: b.c, p: b.props, shape: b.shape, ring: b.polys[0][0] };
          });
          T.state = "ready";
          stats.buildings += res.list.length;
          stats.tiles++;
          failures = 0;
          viewer.scene.requestRender();
        })
        .catch(function (e) {
          if (tiles[id]) tiles[id].state = "failed";
          stats.failed++;
          failures++;
          console.warn("[3D] 건물 타일 " + id + " 실패", e);
        });
    }

    function pump() {
      while (running < 2 && queue.length) {
        var t = queue.shift();
        if (!tiles[t.x + "/" + t.y] || tiles[t.x + "/" + t.y].state !== "queued") continue;
        tiles[t.x + "/" + t.y].state = "loading";
        running++;
        state("건물 불러오는 중…");
        loadTile(t).then(function () {
          running--;
          if (!running && !queue.length) state("");
          if (failures >= 3) {
            state("건물 자료를 불러오지 못했습니다");
            if (opts.onFail) opts.onFail();
            return;
          }
          pump();
        });
      }
    }

    function update() {
      if (!active) return;
      var cam = viewer.camera;
      var h = cam.positionCartographic.height;
      if (h > 4000) return;
      var cv = viewer.scene.canvas;
      var hit = cam.pickEllipsoid(new Cesium.Cartesian2(cv.clientWidth / 2, cv.clientHeight * 0.6));
      if (!hit) return;
      var c = Cesium.Cartographic.fromCartesian(hit);
      var lon = Cesium.Math.toDegrees(c.longitude),
        lat = Cesium.Math.toDegrees(c.latitude);
      var tx = Math.floor(lon2x(lon, TILE_Z)),
        ty = Math.floor(lat2y(lat, TILE_Z));
      var mobile = window.matchMedia("(max-width: 767px)").matches;
      var R = h < 1200 && !mobile ? 2 : 1; // 둘레 5×5(가까울 때) 또는 3×3 타일
      var want = [];
      for (var dy = -R; dy <= R; dy++) for (var dx = -R; dx <= R; dx++) want.push({ x: tx + dx, y: ty + dy, d: Math.abs(dx) + Math.abs(dy) });
      want.sort(function (a, b) {
        return a.d - b.d;
      });
      want.forEach(function (t) {
        var id = t.x + "/" + t.y;
        if (!tiles[id]) {
          tiles[id] = { state: "queued" };
          queue.push(t);
        }
      });
      // 멀어진 타일은 지운다
      Object.keys(tiles).forEach(function (id) {
        var a = id.split("/");
        if (Math.abs(+a[0] - tx) > R + 3 || Math.abs(+a[1] - ty) > R + 3) {
          var T = tiles[id];
          if (T.prim) {
            viewer.scene.primitives.remove(T.prim);
            stats.buildings -= T.count || 0;
            stats.tiles--;
          }
          delete tiles[id];
        }
      });
      queue = queue.filter(function (t) {
        return tiles[t.x + "/" + t.y];
      });
      pump();
    }

    function setActive(on) {
      active = on;
      Object.keys(tiles).forEach(function (id) {
        if (tiles[id].prim) tiles[id].prim.show = on;
      });
      if (on) update();
      viewer.scene.requestRender();
    }

    function inside(ring, x, y) {
      var c = false;
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var a = ring[i],
          b = ring[j];
        if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
      }
      return c;
    }
    // 누른 자리의 건물: 외곽선 안이면 그 건물, 아니면 중심점 25 m 안의 가장 가까운 건물
    function nearest(lon, lat) {
      var best = null,
        bd = 25;
      var kx = 111320 * Math.cos((lat * Math.PI) / 180);
      Object.keys(tiles).forEach(function (id) {
        (tiles[id].list || []).forEach(function (b) {
          if (best && bd < 0) return;
          var d = Math.hypot((Cesium.Math.toDegrees(b.c.longitude) - lon) * kx, (Cesium.Math.toDegrees(b.c.latitude) - lat) * 110540);
          if (d < 200 && b.ring && inside(b.ring, lon, lat)) {
            best = b;
            bd = -1;
          } else if (d < bd) {
            bd = d;
            best = b;
          }
        });
      });
      if (!best) return null;
      var p = best.p;
      return {
        name: p.bld_nm || "",
        use: USE_NAME[p.usability] || (p.usability ? "용도 코드 " + p.usability : "용도 정보 없음"),
        floors: parseInt(p.grnd_flr, 10) || null,
        underground: parseInt(p.ugrnd_flr, 10) || 0,
        height: parseFloat(p.height) > 0 ? parseFloat(p.height) : null,
        heightUsed: best.shape.h,
        approved: p.useapr_day || "",
      };
    }

    viewer.camera.moveEnd.addEventListener(function () {
      try {
        update();
      } catch (e) {}
    });

    return { setActive: setActive, update: update, nearest: nearest, stats: stats, tiles: tiles };
  }

  window.HnBuildings = { create: create, _shape: shapeOf };
})();
