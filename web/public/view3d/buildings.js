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
    // fwidth(창 무늬 흐리기)용. Cesium이 #extension 줄을 셰이더 맨 앞으로 옮긴다 (Primitive는 CustomShader와 달리 직접 켜야 함)
    "#extension GL_OES_standard_derivatives : enable",
    "varying vec3 v_positionEC;",
    "varying vec3 v_normalEC;",
    "varying vec4 v_facade;", // s(벽 둘레 m), t(바닥에서 높이 m), 층고(m), 표현 코드(묶음×64 + 씨앗)
    "varying vec3 v_roof;", // 지붕 사진 좌표 s,t / 지붕이면 z = 1
    "uniform sampler2D roofImg;",
    "uniform float roofOn;",
    "float hb(float n) { return fract(sin(n * 12.9898) * 43758.5453); }",
    "float box(float x, float a, float b) { return step(a, x) * step(x, b); }",
    "vec3 pick4(float r, vec3 a, vec3 b, vec3 c, vec3 d) { return r < 0.25 ? a : (r < 0.5 ? b : (r < 0.75 ? c : d)); }",
    "czm_material czm_getMaterial(czm_materialInput materialInput) {",
    "  czm_material m = czm_getDefaultMaterial(materialInput);",
    "  vec3 n = normalize(v_normalEC);",
    "  if (dot(n, -v_positionEC) < 0.0) n = -n;",
    "  vec3 upW = normalize((czm_inverseView * vec4(v_positionEC, 1.0)).xyz);",
    "  vec3 eastW = normalize(cross(vec3(0.0, 0.0, 1.0), upW));",
    "  vec3 northW = cross(upW, eastW);",
    "  vec3 L = normalize(czm_viewRotation * normalize(upW * 0.75 - eastW * 0.45 - northW * 0.55));",
    "  float diff = max(dot(n, L), 0.0);",
    "  float cat = floor(v_facade.w / 64.0 + 0.001);",
    "  float seed = v_facade.w - cat * 64.0;",
    "  float r1 = hb(seed + 1.0), r2 = hb(seed + 7.0);",
    "  if (v_roof.z > 0.5) {",
    "    vec3 rc = vec3(0.62, 0.62, 0.60) * (0.9 + 0.2 * r1);",
    "    if (roofOn > 0.5) rc = texture2D(roofImg, clamp(v_roof.xy, 0.0, 1.0)).rgb;",
    "    m.diffuse = rc * (0.92 + 0.12 * diff);",
    "    return m;",
    "  }",
    "  float s = v_facade.x, t = v_facade.y, fh = max(v_facade.z, 2.4);",
    "  float fi = floor(t / fh), ft = fract(t / fh);",
    // 묶음별 벽 색·창 간격
    "  vec3 wall; float colW; float winA; float winB; float hA; float hB;",
    "  if (cat < 0.5) {", // 주택
    "    wall = pick4(r1, vec3(0.83, 0.76, 0.64), vec3(0.72, 0.55, 0.45), vec3(0.74, 0.73, 0.70), vec3(0.88, 0.85, 0.77));",
    "    colW = 4.2; winA = 0.32; winB = 0.68; hA = 0.36; hB = 0.78;",
    "  } else if (cat < 1.5) {", // 아파트
    "    wall = pick4(r1, vec3(0.90, 0.88, 0.84), vec3(0.87, 0.85, 0.80), vec3(0.92, 0.90, 0.86), vec3(0.85, 0.83, 0.78));",
    "    colW = 3.0; winA = 0.12; winB = 0.88; hA = 0.30; hB = 0.86;",
    "  } else if (cat < 2.5) {", // 상가·업무
    "    wall = pick4(r1, vec3(0.80, 0.80, 0.78), vec3(0.82, 0.76, 0.68), vec3(0.68, 0.50, 0.42), vec3(0.88, 0.87, 0.84));",
    "    colW = 3.4; winA = 0.10; winB = 0.90; hA = 0.30; hB = 0.80;",
    "  } else if (cat < 3.5) {", // 공장·창고
    "    wall = pick4(r1, vec3(0.80, 0.81, 0.80), vec3(0.86, 0.84, 0.77), vec3(0.68, 0.74, 0.69), vec3(0.74, 0.75, 0.76));",
    "    colW = 6.0; winA = 0.25; winB = 0.75; hA = 0.0; hB = 0.0;",
    "  } else {", // 공공·교육 등
    "    wall = pick4(r1, vec3(0.86, 0.84, 0.80), vec3(0.80, 0.78, 0.74), vec3(0.84, 0.80, 0.72), vec3(0.88, 0.88, 0.86));",
    "    colW = 3.6; winA = 0.15; winB = 0.85; hA = 0.30; hB = 0.82;",
    "  }",
    "  float fc = fract((s + r2 * colW) / colW);",
    "  float fade = clamp(1.6 - max(fwidth(s / colW), fwidth(t / fh)) * 5.0, 0.0, 1.0);",
    "  vec3 glass = mix(vec3(0.25, 0.30, 0.35), vec3(0.52, 0.58, 0.64), ft * 0.6 + 0.2 * r2);",
    "  float win = 0.0;",
    "  if (cat > 2.5 && cat < 3.5) {", // 공장: 세로 판넬 골 + 꼭대기 근처 띠창
    "    wall *= 0.96 + 0.04 * step(0.5, fract(s / 0.9));",
    "    win = box(fc, winA, winB) * box(t, 2.6, 3.4) * step(4.5, fh);",
    "  } else if (cat > 1.5 && cat < 2.5 && fi < 0.5) {", // 상가 1층: 유리 진열창
    "    win = box(fract(s / 4.0), 0.05, 0.95) * box(ft, 0.08, 0.86);",
    "    glass = mix(vec3(0.20, 0.24, 0.27), vec3(0.45, 0.50, 0.54), ft);",
    "  } else {",
    "    win = box(fc, winA, winB) * box(ft, hA, hB);",
    "  }",
    "  win *= step(0.0, t);",
    "  vec3 col = mix(wall, glass, win * fade);",
    "  col = mix(col, wall * 0.9, (1.0 - fade) * 0.35);", // 멀리서는 창이 흐려지되 조금 어둡게
    "  if (cat > 0.5 && cat < 1.5) col *= 1.0 - 0.10 * (1.0 - smoothstep(0.0, 0.05, ft)) * fade;", // 아파트 층 슬래브 줄
    "  col *= mix(0.78, 1.0, smoothstep(0.0, 0.5, t));", // 바닥 근처 조금 어둡게
    "  m.diffuse = col * (0.56 + 0.44 * diff);",
    "  return m;",
    "}",
  ].join("\n");

  var VS = [
    "attribute vec3 position3DHigh;",
    "attribute vec3 position3DLow;",
    "attribute vec3 normal;",
    "attribute vec4 facade;",
    "attribute vec3 roof;",
    "attribute float batchId;",
    "varying vec3 v_positionEC;",
    "varying vec3 v_normalEC;",
    "varying vec4 v_facade;",
    "varying vec3 v_roof;",
    "void main() {",
    "  vec4 p = czm_computePosition();",
    "  v_positionEC = (czm_modelViewRelativeToEye * p).xyz;",
    "  v_normalEC = czm_normal * normal;",
    "  v_facade = facade;",
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
    function push(c, n, s, t, fh, code, rs, rt, isRoof) {
      pos.push(c.x, c.y, c.z);
      nor.push(n.x, n.y, n.z);
      fac.push(s, t, fh, code);
      rof.push(rs, rt, isRoof);
      return vcount++;
    }
    list.forEach(function (b) {
      var base = b.base - SINK,
        top = b.base + b.shape.h;
      var code = b.shape.cat * 64 + b.seed;
      b.polys.forEach(function (poly) {
        // 벽: 모든 고리 (구멍 포함)
        poly.forEach(function (ring) {
          var pts = ring.slice();
          if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
          if (pts.length < 3) return;
          var cum = 0;
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
            var a = push(pb, nrm, cum, -SINK, b.shape.fh, code, -1, -1, 0),
              bq = push(qb, nrm, cum + len, -SINK, b.shape.fh, code, -1, -1, 0),
              c = push(qt, nrm, cum + len, b.shape.h, b.shape.fh, code, -1, -1, 0),
              d = push(pt, nrm, cum, b.shape.h, b.shape.fh, code, -1, -1, 0);
            idx.push(a, bq, c, a, c, d);
            cum += len;
          }
        });
        // 지붕: 바깥 고리 + 구멍을 삼각형으로
        var flat = [],
          holes = [],
          ll = [];
        poly.forEach(function (ring, ri) {
          var pts = ring.slice();
          if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
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
        var start = vcount;
        ll.forEach(function (p) {
          var rs = roof ? (p[0] - roof.west) / wE : 0,
            rt = roof ? (merc(p[1]) - roof.mS) / wM : 0;
          push(C.Cartesian3.fromDegrees(p[0], p[1], top), upN, 0, b.shape.h, b.shape.fh, code, rs, rt, 1);
        });
        for (var k = 0; k < tri.length; k++) idx.push(start + tri[k]);
      });
    });
    if (!idx.length) return null;
    var positions = new Float64Array(pos);
    return new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
        normal: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array(nor) }),
        facade: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 4, values: new Float32Array(fac) }),
        roof: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array(rof) }),
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
            show: active,
          });
          viewer.scene.primitives.add(prim);
          T.prim = prim;
          T.list = res.list.map(function (b) {
            return { c: b.c, p: b.props, shape: b.shape };
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

    // 누른 자리에서 가장 가까운 건물(중심점 기준 40 m 안)의 속성
    function nearest(lon, lat) {
      var best = null,
        bd = 40;
      var kx = 111320 * Math.cos((lat * Math.PI) / 180);
      Object.keys(tiles).forEach(function (id) {
        (tiles[id].list || []).forEach(function (b) {
          var d = Math.hypot((Cesium.Math.toDegrees(b.c.longitude) - lon) * kx, (Cesium.Math.toDegrees(b.c.latitude) - lat) * 110540);
          if (d < bd) {
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
