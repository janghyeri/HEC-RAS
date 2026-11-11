/* 3D 재현 (/3d) — 브이월드 WebGL 3D 지도 API 3.0 위에 침수심 이미지를 지면에 덮는다.
 *  - 최대 침수심: 2D 지도와 같은 타일 (tiles/{z}/{x}/{y}.png, 2 m 지형 기준 수심 + 하천 수면)
 *  - 시간대별: 10분 침수심 이미지 (frames/NNN.png, 경위도 격자 — pipeline/frames_web.py)
 *  - 지도를 누르면 그 자리 이미지 색으로 침수심 등급을 알려 주고, 2D 지도로 이어 준다
 * 설정(window.__VIEW3D__)과 브이월드 스크립트는 app/3d/route.ts가 넣는다. 모형 값은 자료 파일에서 읽는다.
 */
(function () {
  "use strict";
  var C = window.__VIEW3D__ || {};
  var $ = function (id) {
    return document.getElementById(id);
  };
  var S = {
    items: [],
    cur: null,
    tiles: null,
    kpi: null,
    frames: null,
    mode: "max",
    frame: 0,
    playing: false,
    timer: null,
    map: null,
    viewer: null,
    maxLayer: null,
    frameLayer: null,
    swap: 0,
    images: {},
    flow: null, // 하천 흐름 표시 {model, ps, lines}
    f2: null, // 범람 구역 흐름 (flow2d.json·bin)
    flood: null, // 범람 구역 흰 줄 {ps, lines}
    flowOn: false, // '흐름 보기' 버튼
    peak: 0, // 최대 침수심 보기에서 흐름을 보여 줄 시각 (침수면적이 가장 넓은 때)
    water: null, // 시간대별 물 표면 (GroundPrimitive + 물결 재질), 만들 수 없으면 false
    admin: null, // 행정구역 경계·이름 (CustomDataSource)
    bldStyle: null,
    t0: performance.now(),
    bstyle: (function () {
      try {
        return localStorage.getItem("hinnamno.bldStyle") === "white" ? "white" : "real";
      } catch (e) {
        return "real";
      }
    })(),
    ready: false,
  };

  function status(msg, kind) {
    var el = $("status");
    if (!msg) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = msg;
    el.className = "v3-status" + (kind ? " " + kind : "");
  }
  function hhmm(iso) {
    return iso ? String(iso).slice(11, 16) : "—";
  }
  function shortLabel(l) {
    return String(l)
      .replace(/^힌남노\s*/, "")
      .replace(/\s*\(맨홀 월류량\s*(×[\d.]+)\)/g, " $1")
      .replace(/외수\s*\+\s*내수/g, "하천 범람 + 도시 침수")
      .replace(/외수/g, "하천 범람")
      .replace(/내수/g, "도시 침수");
  }
  function getJSON(url, opt) {
    return fetch(url, opt).then(function (r) {
      if (!r.ok) throw new Error(url.split("?")[0] + " 응답 " + r.status);
      return r.json();
    });
  }
  function abs(u) {
    return /^https?:\/\//.test(u) ? u : location.origin + u;
  }
  function fileUrl(item, file, v) {
    return abs((item.urlBase || C.dataRoot) + "/" + item.path + "/" + file + "?v=" + encodeURIComponent(v || item.generated_at));
  }
  function frameUrl(i) {
    var f = S.frames.files.replace("{i:03d}", String(i).padStart(3, "0"));
    return fileUrl(S.cur, f, S.frames.generated_at);
  }
  function versionKey(v) {
    var m = String(v).match(/(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  // ------------------------------------------------------------ 시나리오 목록 (게시된 것 + 웹 계산 완료분)
  function loadList() {
    return getJSON(C.dataRoot + "/index.json", { cache: "no-cache" }).then(function (idx) {
      var vs = idx.scenarios.map(function (s) {
        return s.model_version;
      });
      vs.sort(function (a, b) {
        return versionKey(a) - versionKey(b);
      });
      var version = vs[vs.length - 1];
      S.version = version;
      S.items = idx.scenarios
        .filter(function (s) {
          return s.model_version === version;
        })
        .map(function (s) {
          return { id: s.scenario_id, label: shortLabel(s.label), path: s.path, generated_at: s.generated_at, params: s.params || null };
        });
      if (!C.supabaseUrl || !C.anonKey) return;
      var h = { apikey: C.anonKey, Authorization: "Bearer " + C.anonKey };
      var url =
        C.supabaseUrl +
        "/rest/v1/runs?select=id,status,files_prefix,finished_at,model_version&status=eq.done&model_version=eq." +
        encodeURIComponent(version) +
        "&order=id.desc&limit=6";
      return getJSON(url, { headers: h, cache: "no-store" })
        .then(function (rows) {
          rows
            .filter(function (r) {
              return r.files_prefix;
            })
            .reverse()
            .forEach(function (r) {
              S.items.push({
                id: "run-" + r.id,
                label: "웹 계산 " + r.id,
                path: r.files_prefix,
                generated_at: r.finished_at,
                urlBase: C.supabaseUrl + "/storage/v1/object/public/results",
                runId: r.id,
              });
            });
        })
        .catch(function () {});
    });
  }

  function defaultItem() {
    var q = new URLSearchParams(location.search);
    var run = q.get("run");
    var s = q.get("s");
    var hit = S.items.find(function (it) {
      return (run && it.runId === Number(run)) || (s && it.id === s);
    });
    if (hit) return hit;
    // 실제 사건 재현 조건 가운데 도시 침수를 넣은 것 (이름은 자료에서 온 것)
    return (
      S.items.find(function (it) {
        return !it.params && !it.runId && /도시 침수/.test(it.label);
      }) || S.items[0]
    );
  }

  // ------------------------------------------------------------ 3D 지도
  function startMap(center) {
    if (!window.vw) {
      status("브이월드 3D 지도를 불러오지 못했습니다. 등록된 주소(배포 주소)에서만 열립니다.", "err");
      return;
    }
    var done = false;
    function onReady() {
      if (done || !window.ws3d || !ws3d.viewer) return;
      done = true;
      S.viewer = ws3d.viewer;
      S.ready = true;
      status("");
      setupPick();
      guardRender();
      S.viewer.camera.moveEnd.addEventListener(function () {
        try {
          updateRoofs();
        } catch (e) {}
      });
      enhanceScene();
      initOwnBuildings();
      setBuildingStyle(S.bstyle);
      setBuildings($("bld").checked);
      setNames($("names").checked);
      setAdmin($("adm").checked);
      ensureFlowLines();
      applyScenario();
      // 처음 비스듬한 시점으로. 브이월드가 초기화 뒤 카메라를 자기 처음 위치(우주·수직 시점 등)로 옮기는 일이 있어,
      // 사용자가 지도를 만지기 전까지 2.5초마다 확인해 목표(높이 약 2.2 km)에서 멀면 다시 보낸다 (최대 20초)
      var touched = false;
      var hh = new Cesium.ScreenSpaceEventHandler(S.viewer.scene.canvas);
      [Cesium.ScreenSpaceEventType.LEFT_DOWN, Cesium.ScreenSpaceEventType.RIGHT_DOWN, Cesium.ScreenSpaceEventType.WHEEL,
        Cesium.ScreenSpaceEventType.PINCH_START].forEach(function (t) {
        hh.setInputAction(function () {
          touched = true;
        }, t);
      });
      var n = 0;
      (function tilt() {
        if (touched) return;
        var h = S.viewer.camera.positionCartographic.height;
        if (n === 0 || h > 3000) view("tilt");
        if (++n < 8) setTimeout(tilt, 2500);
      })();
    }
    try {
      var opts = {
        mapId: "vmap",
        initPosition: new vw.CameraPosition(new vw.CoordZ(center[0], center[1], 9000), new vw.Direction(0, -90, 0)),
        logo: true,
        navigation: true,
      };
      vw.ws3dInitCallBack = onReady;
      S.map = new vw.Map();
      window.__view3d = S; // 확인용 (브라우저 콘솔에서 지도 상태 보기)
      S.map.setOption(opts);
      S.map.setMapId("vmap");
      S.map.start();
    } catch (e) {
      status("3D 지도를 만들지 못했습니다: " + e.message, "err");
      return;
    }
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (done || tries > 100) {
        clearInterval(t);
        if (!done) status("3D 지도가 응답하지 않습니다. 새로고침해 보세요.", "err");
        return;
      }
      onReady();
    }, 200);
  }

  function view(kind) {
    if (!S.viewer || !S.tiles) return;
    var c = S.tiles.wet_centroid_lonlat || [(S.tiles.bounds[0] + S.tiles.bounds[2]) / 2, (S.tiles.bounds[1] + S.tiles.bounds[3]) / 2];
    var cam = S.viewer.camera;
    if (kind === "top") {
      cam.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(c[0], c[1], 6500),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration: 1.6,
      });
    } else {
      // 남쪽에서 북쪽을 비스듬히 (높이 1.2 km, 아래로 30°). 브이월드 건물(흰 상자)은 카메라가 약 1.6 km보다 낮을 때만 보인다
      var h = 1200;
      var back = h / Math.tan(Cesium.Math.toRadians(30)) / 111000; // 바라보는 곳에서 남쪽으로 물러난 거리 (도)
      cam.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(c[0], c[1] - back, h),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-30), roll: 0 },
        duration: 1.6,
      });
    }
  }

  // ------------------------------------------------------------ 브이월드 레이어: 건물·이름·행정경계
  // 건물: facility_build(사진 입힌 LoD4)와 facility_build_lod1(건물 바닥 모양을 높이 자료 BLDH_HT만큼 올린 상자)이
  // 겹쳐 떠서 색이 섞였고, LoD1은 건물 구분(BULD_SE)별로 파란 계열·노랑·분홍으로 칠해져 침수심 색과 헷갈렸다 (2026-11-11)
  // → LoD1만 쓰고 한 가지 중립색으로 칠한다. 레이어가 늦게 생기면 몇 번 다시 시도.
  // LoD1 모형은 재질이 반투명(alphaMode BLEND)이고 법선이 없어 건물이 비쳐 겹쳐 보이고 면 구분이 안 됐다 (사용자 지적 11/11)
  // → 직접 쓴 셰이더로 불투명하게 그리고, 화면 미분으로 면 방향을 구해 남서쪽 빛으로 벽·지붕 명암을 준다.
  //   건물마다 밝기를 ±4 % 달리해 붙은 건물도 구별되게. 셰이더를 쓸 수 없거나 오류가 나면 단색으로 돌아간다.
  // 지붕에는 브이월드 항공사진(WMTS Satellite, 2D 지도와 같은 키)을 입힌다 — 카메라가 보는 곳 둘레 약 2 km를 z17 타일 8×8로
  // 이어 붙여 텍스처로 넘기고, 보는 곳이 500 m쯤 옮겨 가면 다시 만든다. 벽은 실제 외관 사진이 없어 단색 + 명암
  // (카카오·네이버 로드뷰 사진은 실시간 보기 외 캡처·가공이 허용되지 않아 쓰지 않는다, 2026-11-11 확인)
  var BLD_COLOR = "#d6d0c4";
  var BLD_FS = [
    "void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {",
    "  vec3 pEC = fsInput.attributes.positionEC;",
    "  vec3 pMC = fsInput.attributes.positionMC;",
    "  vec3 n = normalize(cross(dFdx(pEC), dFdy(pEC)));",
    "  if (dot(n, -pEC) < 0.0) n = -n;",
    // 타일 원점(지구 중심 좌표)의 경위도·동/북 방향. 건물 좌표는 원점에서의 차이(모형 좌표)로 더해 정밀도를 지킨다
    "  vec3 O = czm_model[3].xyz;",
    "  vec3 upW = normalize(O);",
    "  float lon0 = atan(O.y, O.x);",
    "  float lat0 = atan(O.z, length(O.xy) * (1.0 - 0.00669438));",
    "  vec3 eastW = vec3(-sin(lon0), cos(lon0), 0.0);",
    "  vec3 northW = vec3(-sin(lat0) * cos(lon0), -sin(lat0) * sin(lon0), cos(lat0));",
    "  vec3 d = mat3(czm_model) * pMC;",
    "  vec3 upEC = normalize(czm_viewRotation * upW);",
    "  vec3 L = normalize(czm_viewRotation * normalize(upW * 0.75 - eastW * 0.45 - northW * 0.55));",
    "  float diff = max(dot(n, L), 0.0);",
    "  float roof = smoothstep(0.55, 0.85, dot(n, upEC));",
    "  float id = float(fsInput.featureIds.featureId_0);",
    "  float tint = fract(sin(id * 12.9898) * 43758.5453) * 0.08 - 0.04;",
    "  vec3 base = vec3(0.80, 0.77, 0.72) * (1.0 + tint);",
    "  vec3 wall = base * (0.55 + 0.45 * diff);",
    "  vec3 top = base * 1.1;",
    // 지붕: 카메라 주변 항공사진(웹 메르카토르 타일을 이어 붙인 텍스처, u_roofRect = 서·동 경도, 남·북 메르카토르 y, 라디안)
    "  if (u_roofOn > 0.5) {",
    "    float cl = cos(lat0);",
    "    float wE = u_roofRect.y - u_roofRect.x;",
    "    float wN = u_roofRect.w - u_roofRect.z;",
    "    float s = (lon0 - u_roofRect.x) / wE + dot(d, eastW) / (6371000.0 * cl * wE);",
    "    float t = (u_roofRect.w - log(tan(0.7853981634 + lat0 * 0.5))) / wN - dot(d, northW) / (6371000.0 * cl * wN);",
    "    if (s > 0.0 && s < 1.0 && t > 0.0 && t < 1.0) top = texture2D(u_roof, vec2(s, t)).rgb;",
    "  }",
    "  material.diffuse = mix(wall, top, roof);",
    "  material.alpha = 1.0;",
    "}",
  ].join("\n");
  function vwEl(id) {
    try {
      return (S.map && (S.map.getElementById(id) || S.map.getLayerElement(id))) || null;
    } catch (e) {
      return null;
    }
  }
  function vwShow(id, on) {
    var el = vwEl(id);
    if (!el) return false;
    try {
      if (on) el.show();
      else el.hide();
      return true;
    } catch (e) {
      return false;
    }
  }
  function buildingShader() {
    if (S.bldShader === undefined) {
      S.bldShader = null;
      try {
        if (Cesium.CustomShader && Cesium.CustomShaderTranslucencyMode && S.viewer.scene.context.standardDerivatives)
          S.bldShader = new Cesium.CustomShader({
            lightingModel: Cesium.LightingModel.UNLIT,
            translucencyMode: Cesium.CustomShaderTranslucencyMode.OPAQUE,
            fragmentShaderText: BLD_FS,
            uniforms: {
              u_roof: { type: Cesium.UniformType.SAMPLER_2D, value: new Cesium.TextureUniform({ typedArray: new Uint8Array([200, 196, 184, 255]), width: 1, height: 1 }) },
              u_roofRect: { type: Cesium.UniformType.VEC4, value: new Cesium.Cartesian4(0, 1, 0, 1) },
              u_roofOn: { type: Cesium.UniformType.FLOAT, value: 0 },
            },
          });
      } catch (e) {
        S.bldShader = null;
      }
    }
    return S.bldShader;
  }
  function styleBuildings() {
    var ts = S.bldTs;
    if (!ts || (ts.isDestroyed && ts.isDestroyed())) {
      var el = vwEl("facility_build_lod1");
      ts = S.bldTs = (el && el._tileset) || null;
    }
    if (!ts) return false;
    var sh = buildingShader();
    if (!S.bldStyle) S.bldStyle = new Cesium.Cesium3DTileStyle({ color: sh ? "color('white')" : "color('" + BLD_COLOR + "')" });
    if (ts.style !== S.bldStyle) ts.style = S.bldStyle;
    if (sh && ts.customShader !== sh) ts.customShader = sh;
    if (!ts.__hnSse) {
      ts.__hnSse = true;
      ts.maximumScreenSpaceError = Math.min(ts.maximumScreenSpaceError || 16, 12); // 가까운 건물을 조금 더 촘촘히
    }
    return true;
  }
  // ---- 지붕 항공사진
  var ROOF_Z = 17,
    ROOF_N = 8; // 8×8 타일 = 2048 화소 ≈ 2 km (위도 36°에서 화소 약 1 m)
  function updateRoofs() {
    if (ownBuildings()) return;
    var sh = S.bldShader;
    if (!sh || !C.vworldKey || !$("bld").checked || (S.roof && S.roof.loading)) return;
    var cam = S.viewer.camera;
    if (cam.positionCartographic.height > 3000) return; // 건물(LoD1)이 안 보이는 높이
    var cv = S.viewer.scene.canvas;
    var hit = cam.pickEllipsoid(new Cesium.Cartesian2(cv.clientWidth / 2, cv.clientHeight * 0.6));
    if (!hit) return;
    var c = Cesium.Cartographic.fromCartesian(hit);
    var n = Math.pow(2, ROOF_Z);
    var cx = Math.floor(((c.longitude + Math.PI) / (2 * Math.PI)) * n);
    var cy = Math.floor(((1 - Math.log(Math.tan(c.latitude) + 1 / Math.cos(c.latitude)) / Math.PI) / 2) * n);
    if (S.roof && Math.abs(cx - S.roof.cx) <= 2 && Math.abs(cy - S.roof.cy) <= 2) return;
    var x0 = cx - ROOF_N / 2,
      y0 = cy - ROOF_N / 2,
      size = 256 * ROOF_N;
    var canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgb(200,196,184)";
    ctx.fillRect(0, 0, size, size);
    S.roof = { cx: cx, cy: cy, loading: true };
    var jobs = [];
    for (var j = 0; j < ROOF_N; j++)
      for (var i = 0; i < ROOF_N; i++)
        (function (i, j) {
          var url = "https://api.vworld.kr/req/wmts/1.0.0/" + encodeURIComponent(C.vworldKey) + "/Satellite/" + ROOF_Z + "/" + (y0 + j) + "/" + (x0 + i) + ".jpeg";
          jobs.push(
            fetch(url, { mode: "cors" })
              .then(function (r) {
                if (!r.ok) throw new Error(r.status);
                return r.blob();
              })
              .then(function (b) {
                return createImageBitmap(b);
              })
              .then(function (img) {
                ctx.drawImage(img, i * 256, j * 256);
              })
              .catch(function () {})
          );
        })(i, j);
    Promise.all(jobs).then(function () {
      S.roof.loading = false;
      if (S.bldShader !== sh) return;
      try {
        var px = new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer);
        var lon = function (x) {
          return (x / n) * 2 * Math.PI - Math.PI;
        };
        var merc = function (y) {
          return Math.PI * (1 - (2 * y) / n);
        };
        sh.setUniform(
          "u_roof",
          new Cesium.TextureUniform({
            typedArray: px,
            width: size,
            height: size,
            minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
            magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
          })
        );
        sh.setUniform("u_roofRect", new Cesium.Cartesian4(lon(x0), lon(x0 + ROOF_N), merc(y0 + ROOF_N), merc(y0)));
        sh.setUniform("u_roofOn", S.bstyle === "white" ? 0 : 1);
        S.viewer.scene.requestRender();
      } catch (e) {
        console.warn("[3D] 지붕 사진을 넣지 못함", e);
      }
    });
  }

  function dropBuildingShader() {
    if (!S.bldShader) return;
    S.bldShader = null;
    S.bldStyle = new Cesium.Cesium3DTileStyle({ color: "color('" + BLD_COLOR + "')" });
    if (S.bldTs) {
      S.bldTs.customShader = undefined;
      S.bldTs.style = S.bldStyle;
    }
  }
  // 실사풍 건물 (buildings.js — GIS건물통합정보로 직접 세움). 자료를 못 불러오거나 그리기 오류가 나면 브이월드 LoD1 상자로 돌아간다
  function ownBuildings() {
    return !!S.bld && !S.bldFailed;
  }
  function initOwnBuildings() {
    if (S.bld || !window.HnBuildings || !C.vworldKey) return;
    try {
      S.bld = window.HnBuildings.create(S.viewer, {
        key: C.vworldKey,
        style: S.bstyle,
        onState: function (msg, st) {
          $("bldnote").textContent = (st.buildings > 0 ? "건물 " + st.buildings.toLocaleString("ko-KR") + "동" : "") + (msg ? (st.buildings > 0 ? " · " : "") + msg : "");
        },
        onFail: function () {
          dropOwnBuildings("건물통합정보를 불러오지 못해 브이월드 상자 건물로 보여 줍니다.");
        },
      });
    } catch (e) {
      S.bld = null;
    }
  }
  function dropOwnBuildings(note) {
    if (!S.bld || S.bldFailed) return;
    S.bldFailed = true;
    try {
      S.bld.setActive(false);
    } catch (e) {}
    $("bldnote").textContent = note || "";
    setBuildings($("bld").checked);
  }
  // 건물 표현: 실사화(지붕 항공사진·용도별 벽) / 흰색 모형. 브이월드 상자로 돌아간 경우에는 흰색 상자 + (실사화면) 지붕 사진
  function setBuildingStyle(st) {
    S.bstyle = st === "white" ? "white" : "real";
    try {
      localStorage.setItem("hinnamno.bldStyle", S.bstyle);
    } catch (e) {}
    if (ownBuildings()) S.bld.setStyle(S.bstyle);
    else if (S.bldShader) {
      try {
        S.bldShader.setUniform("u_roofOn", S.bstyle === "white" ? 0 : S.roof && !S.roof.loading ? 1 : 0);
      } catch (e) {}
    }
    document.querySelectorAll("[data-bstyle]").forEach(function (b) {
      b.setAttribute("aria-checked", String(b.getAttribute("data-bstyle") === S.bstyle));
    });
    if (S.viewer) S.viewer.scene.requestRender();
  }

  // 장면 품질: 건물 명암과 같은 남서쪽 빛, 그림자(휴대폰 제외), 가까이 볼 때 선명한 항공사진(브이월드 WMTS z19)
  function enhanceScene() {
    var v = S.viewer,
      sc = v.scene;
    try {
      var b = (S.tiles && S.tiles.bounds) || [129.3, 35.85, 129.5, 36.1];
      var c0 = Cesium.Cartesian3.fromDegrees((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
      var enu = Cesium.Transforms.eastNorthUpToFixedFrame(c0);
      var E = Cesium.Matrix4.getColumn(enu, 0, new Cesium.Cartesian4()),
        N = Cesium.Matrix4.getColumn(enu, 1, new Cesium.Cartesian4()),
        U = Cesium.Matrix4.getColumn(enu, 2, new Cesium.Cartesian4());
      var toL = new Cesium.Cartesian3(U.x * 0.75 - E.x * 0.45 - N.x * 0.55, U.y * 0.75 - E.y * 0.45 - N.y * 0.55, U.z * 0.75 - E.z * 0.45 - N.z * 0.55);
      Cesium.Cartesian3.normalize(toL, toL);
      sc.light = new Cesium.DirectionalLight({ direction: Cesium.Cartesian3.negate(toL, new Cesium.Cartesian3()), intensity: 2.0 });
      if (!window.matchMedia("(max-width: 767px)").matches) {
        v.shadows = true;
        v.terrainShadows = Cesium.ShadowMode.RECEIVE_ONLY;
        sc.shadowMap.softShadows = true;
        sc.shadowMap.size = 2048;
        sc.shadowMap.darkness = 0.55;
        sc.shadowMap.maximumDistance = 1500;
      }
      if (C.vworldKey && !S.hiLayer) {
        var p = new Cesium.UrlTemplateImageryProvider({
          url: "https://api.vworld.kr/req/wmts/1.0.0/" + encodeURIComponent(C.vworldKey) + "/Satellite/{z}/{y}/{x}.jpeg",
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          minimumLevel: 14,
          maximumLevel: 19,
          rectangle: Cesium.Rectangle.fromDegrees(b[0] - 0.03, b[1] - 0.03, b[2] + 0.03, b[3] + 0.03),
          credit: "브이월드 항공사진",
        });
        S.hiLayer = v.imageryLayers.addImageryProvider(p, Math.min(2, v.imageryLayers.length));
      }
    } catch (e) {
      console.warn("[3D] 장면 품질 설정 일부 실패", e);
    }
  }

  function setBuildings(on, tries) {
    if (ownBuildings()) {
      vwShow("facility_build", false);
      vwShow("facility_build_lod1", false);
      S.bld.setActive(on);
      if (!on) $("bldnote").textContent = "";
      // 브이월드 레이어가 늦게 생겨 다시 켜지는 경우가 있어 몇 번 더 끈다
      if ((tries || 0) < 10)
        setTimeout(function () {
          if (ownBuildings()) {
            vwShow("facility_build", false);
            vwShow("facility_build_lod1", false);
          }
        }, 1000 * ((tries || 0) + 1));
      return;
    }
    vwShow("facility_build", false);
    var ok = vwShow("facility_build_lod1", on);
    if (on) ok = styleBuildings() && ok;
    if (S.viewer) S.viewer.scene.requestRender();
    if (!ok && (tries || 0) < 15)
      setTimeout(function () {
        setBuildings($("bld").checked, (tries || 0) + 1);
      }, 1000);
  }
  // 이름: poi_base(한글 명칭 — 건물·상호), poi_eng(영문). 처음에는 끈다 (사용자 요청 2026-11-11: 건물 이름이 많아 복잡함)
  function setNames(on, tries) {
    var ok = vwShow("poi_base", on);
    vwShow("poi_eng", false);
    if (S.viewer) S.viewer.scene.requestRender();
    if (!ok && (tries || 0) < 15)
      setTimeout(function () {
        setNames($("names").checked, (tries || 0) + 1);
      }, 1000);
  }
  // 행정구역: 우리 자료(행정동 2022-07, data/admin/boundaries.geojson)를 쓰고, 브이월드 법정경계 선(hybrid_bound)은 그동안 끈다
  // (법정동·행정동 경계가 섞여 보이지 않게)
  var INK = "#17212b";
  function setAdmin(on) {
    vwShow("hybrid_bound", !on);
    vwShow("poi_bound", false);
    if (on) ensureAdmin();
    if (S.admin) S.admin.show = on;
    if (S.viewer) S.viewer.scene.requestRender();
  }
  function ensureAdmin() {
    if (S.admin || S.adminLoading || !S.viewer) return;
    S.adminLoading = true;
    getJSON(C.dataRoot + "/admin/boundaries.geojson")
      .then(function (fc) {
        var ds = new Cesium.CustomDataSource("admin");
        var ink = Cesium.Color.fromCssColorString(INK);
        var white = Cesium.Color.WHITE;
        var ground = { clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN };
        function line(pos, width, material) {
          ds.entities.add({ polyline: Object.assign({ positions: pos, width: width, material: material }, ground) });
        }
        function label(c, text, font, offsetY, near, far, fill) {
          ds.entities.add({
            position: Cesium.Cartesian3.fromDegrees(c[0], c[1]),
            label: {
              text: text,
              font: font,
              fillColor: fill || white,
              outlineColor: ink,
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              pixelOffset: new Cesium.Cartesian2(0, offsetY),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(near, far),
            },
          });
        }
        fc.features.forEach(function (f) {
          var p = f.properties;
          if (p.kind === "boundary") {
            var pos = Cesium.Cartesian3.fromDegreesArray([].concat.apply([], f.geometry.coordinates));
            if (p.level === "sgg") {
              line(pos, 6, white.withAlpha(0.85));
              line(pos, 2.5, ink);
            } else {
              line(pos, 2.5, new Cesium.PolylineDashMaterialProperty({ color: white.withAlpha(0.9), gapColor: ink.withAlpha(0.35), dashLength: 18 }));
            }
          } else if (p.kind === "label") {
            var c = f.geometry.coordinates;
            if (p.level === "emd") {
              label(c, p.name, '700 15px "Noto Sans KR", sans-serif', 0, 0, 16000);
              label(c, p.sgg, '500 11px "Noto Sans KR", sans-serif', 15, 0, 16000, Cesium.Color.fromCssColorString("#e6edf3"));
            } else {
              label(c, p.name, '700 17px "Noto Sans KR", sans-serif', 0, 16000, 400000);
            }
          }
        });
        S.viewer.dataSources.add(ds);
        S.admin = ds;
        ds.show = $("adm").checked;
        S.viewer.scene.requestRender();
      })
      .catch(function () {})
      .then(function () {
        S.adminLoading = false;
      });
  }

  // 그리기 오류(셰이더 등)가 나면 Cesium이 화면 갱신을 멈춘다 → 이 화면이 더한 물 표면·흐름을 걷어내고 다시 그린다
  function guardRender() {
    S.viewer.scene.renderError.addEventListener(function (scene, err) {
      console.warn("[3D] 그리기 오류 — 물결·건물 셰이더를 끄고 다시 그림", err);
      dropWater();
      S.water = false;
      dropBuildingShader();
      S.bldShader = null;
      dropOwnBuildings("건물 그리기 오류로 브이월드 상자 건물로 보여 줍니다.");
      try {
        S.viewer.shadows = false;
      } catch (e) {}
      setTimeout(function () {
        try {
          S.viewer.useDefaultRenderLoop = true;
          var box = document.querySelector(".cesium-widget-errorPanel");
          if (box) box.remove();
          applyScenario();
        } catch (e) {}
      }, 0);
    });
  }

  function rect(b) {
    return Cesium.Rectangle.fromDegrees(b[0], b[1], b[2], b[3]);
  }

  function setMaxLayer() {
    var layers = S.viewer.imageryLayers;
    if (S.maxLayer) layers.remove(S.maxLayer, true);
    var p = new Cesium.UrlTemplateImageryProvider({
      url: fileUrl(S.cur, "tiles/{z}/{x}/{y}.png"),
      rectangle: rect(S.tiles.bounds),
      minimumLevel: S.tiles.minzoom,
      maximumLevel: S.tiles.maxzoom,
      credit: "HEC-RAS 모의 결과",
    });
    S.maxLayer = layers.addImageryProvider(p);
    S.maxLayer.alpha = 0.9;
    S.maxLayer.show = S.mode === "max";
  }

  function clearFrame() {
    S.swap++;
    if (S.frameLayer && S.viewer) S.viewer.imageryLayers.remove(S.frameLayer, true);
    S.frameLayer = null;
    if (S.water) S.water.prim.show = false;
  }

  function makeSingle(url, rectangle) {
    var P = Cesium.SingleTileImageryProvider;
    if (typeof P.fromUrl === "function") return P.fromUrl(url, { rectangle: rectangle });
    var p = new P({ url: url, rectangle: rectangle });
    return p.readyPromise ? Promise.resolve(p.readyPromise).then(function () {
      return p;
    }) : Promise.resolve(p);
  }

  // 새 이미지를 위에 올린 뒤 이전 것을 지운다 (바꿔 끼울 때 깜빡이지 않게)
  function showFrame(i) {
    if (!S.viewer || !S.frames) return;
    if (ensureWater()) {
      setWaterFrame(i);
      return;
    }
    var token = ++S.swap;
    var url = frameUrl(i);
    makeSingle(url, rect(S.frames.bounds))
      .then(function (p) {
        if (token !== S.swap) return;
        var layers = S.viewer.imageryLayers;
        var layer = layers.addImageryProvider(p);
        layer.alpha = 0.9;
        var old = S.frameLayer;
        S.frameLayer = layer;
        if (old)
          setTimeout(function () {
            if (layers.contains(old)) layers.remove(old, true);
          }, 250);
      })
      .catch(function () {});
  }

  function preloadFrames() {
    if (!S.frames) return;
    for (var i = 0; i < S.frames.count; i++) {
      var key = S.cur.id + "|" + i;
      if (S.images[key]) continue;
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.src = frameUrl(i);
      S.images[key] = img;
    }
  }

  // ------------------------------------------------------------ 화면
  function applyScenario() {
    if (!S.ready || !S.cur || !S.tiles) return;
    setMaxLayer();
    clearFrame();
    if (S.mode === "time" && S.frames) {
      preloadFrames();
      showFrame(S.frame);
    }
  }

  function selectItem(item) {
    stop();
    dropWater();
    if (S.water === false) S.water = null; // 결과가 바뀌면 물 표면을 다시 시도
    setFlow2d(null);
    S.cur = item;
    S.tiles = null;
    S.frames = null;
    S.kpi = null;
    $("pick").innerHTML = '<span class="muted">지도를 누르면 그 자리의 침수심 등급을 보여 줍니다.</span>';
    var q = new URLSearchParams(location.search);
    q.delete("s");
    q.delete("run");
    if (item.runId) q.set("run", String(item.runId));
    else q.set("s", item.id);
    history.replaceState(null, "", "?" + q.toString());
    return Promise.all([
      getJSON(fileUrl(item, "tiles/tiles.json")),
      getJSON(fileUrl(item, "frames/frames.json"), { cache: "no-cache" }).catch(function () {
        return null;
      }),
      getJSON(fileUrl(item, "kpi.json")).catch(function () {
        return null;
      }),
      getJSON(fileUrl(item, "river_flow.json"), { cache: "no-cache" }).catch(function () {
        return null;
      }),
    ]).then(function (r) {
      if (S.cur !== item) return;
      S.tiles = r[0];
      S.frames = r[1];
      S.kpi = r[2];
      setFlowData(r[3]);
      if (!S.frames && S.mode === "time") S.mode = "max";
      if (S.frames) S.frame = Math.min(S.frame, S.frames.count - 1);
      S.peak = peakFrame();
      renderControls();
      applyScenario();
      loadFlow2d(item);
    });
  }

  function setMode(m) {
    if (m === "time" && !S.frames) return;
    S.mode = m;
    if (S.viewer) S.viewer.scene.requestRender();
    if (m === "max") stop();
    if (S.maxLayer) S.maxLayer.show = m === "max";
    if (m === "max") clearFrame();
    else {
      preloadFrames();
      showFrame(S.frame);
    }
    renderControls();
  }

  function setFrame(i) {
    S.frame = Math.max(0, Math.min(S.frames.count - 1, i));
    showFrame(S.frame);
    renderControls();
  }

  function stop() {
    S.playing = false;
    if (S.timer) clearInterval(S.timer);
    S.timer = null;
  }

  function play() {
    if (!S.frames) return;
    if (S.playing) {
      stop();
      renderControls();
      return;
    }
    if (S.mode !== "time") setMode("time");
    if (S.frame >= S.frames.count - 1) setFrame(0);
    S.playing = true;
    S.timer = setInterval(function () {
      if (S.frame >= S.frames.count - 1) {
        stop();
        renderControls();
        return;
      }
      setFrame(S.frame + 1);
    }, 800);
    renderControls();
  }

  var PLAY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>';
  var PAUSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';

  function renderControls() {
    document.querySelectorAll("[data-mode]").forEach(function (b) {
      b.setAttribute("aria-checked", String(b.getAttribute("data-mode") === S.mode));
      if (b.getAttribute("data-mode") === "time") {
        b.disabled = !S.frames;
        b.title = S.frames ? "" : "이 결과는 시간대별 이미지가 아직 없습니다";
      }
    });
    var tb = $("timebox");
    tb.hidden = S.mode !== "time" || !S.frames;
    var fb = $("flowbtn");
    var anyFlow = !!(S.flow && S.flow.model) || !!S.f2;
    fb.disabled = !anyFlow;
    fb.setAttribute("aria-pressed", String(S.flowOn && anyFlow));
    fb.title = anyFlow ? "" : "이 결과는 흐름 자료가 없습니다";
    $("flownote").hidden = !(S.flowOn && anyFlow);
    var info = "";
    if (S.flowOn && anyFlow) {
      var times = (S.frames && S.frames.times) || (S.f2 && S.f2.meta.times) || null;
      var t = flowFrame();
      info = (S.mode === "time" ? "" : "침수면적이 가장 넓은 ") + (times ? hhmm(times[t]) : "") + " 흐름" + (S.f2 ? " · 하천+범람 구역" : " · 하천만 (범람 구역 자료 없음)");
    }
    $("flowinfo").textContent = info;
    var play = $("play");
    play.innerHTML = S.playing ? PAUSE : PLAY;
    play.setAttribute("aria-label", S.playing ? "멈춤" : "재생");
    var now = $("nowline");
    if (S.mode === "time" && S.frames) {
      var sl = $("slider");
      sl.max = String(S.frames.count - 1);
      sl.value = String(S.frame);
      $("tlabel").textContent = hhmm(S.frames.times[S.frame]);
      var a = S.frames.area_2d_km2 && S.frames.area_2d_km2[S.frame];
      now.textContent = hhmm(S.frames.times[S.frame]) + " 침수면적 " + (a != null ? a.toFixed(2) : "—") + " km² (0.1 m 이상, 하천 물 제외)";
    } else {
      var k = S.kpi && S.kpi.inundation_area_km2 && S.kpi.inundation_area_km2["ge_0.1m"];
      now.textContent = "모의 기간 최대 침수심" + (k != null ? " · 침수면적 " + k.toFixed(2) + " km²" : "") + (S.frames ? "" : " · 시간대별 이미지 없음");
    }
  }

  function renderLegend() {
    $("legend").innerHTML = (C.classes || [])
      .map(function (c) {
        return '<li><i style="background:' + c.color + '"></i><b>' + c.range + "</b><span>" + c.body + "</span></li>";
      })
      .join("");
  }

  function renderSelect() {
    var sel = $("scn");
    sel.innerHTML = S.items
      .map(function (it) {
        return '<option value="' + it.id + '">' + it.label.replace(/</g, "&lt;") + "</option>";
      })
      .join("");
    sel.value = S.cur ? S.cur.id : "";
  }


  // ------------------------------------------------------------ 흐름 보기 (하천 river_flow.json + 범람 구역 flow2d)
  // 흰 줄이 그 시각 유속의 SPEEDUP배로 흐른다. 시간대별이면 그 시각, 최대 침수심이면 침수면적이 가장 넓은 시각.
  // 화면 표현용 (방향·빠르기 비교). 계산은 pipeline/river_flow.py, pipeline/flow2d_web.py
  var SPEEDUP = 100;
  var N_FLOW = 260; // 하천
  var N_FLOOD = 900; // 범람 구역
  var VMAX = 4; // 물결 무늬용 유속 부호화 범위 (m/s)

  function lowerBound(a, v) {
    var lo = 0,
      hi = a.length - 1;
    while (lo < hi) {
      var m = (lo + hi) >> 1;
      if (a[m] < v) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  function FlowModel(d) {
    var lat0 = d.centerline.reduce(function (a, p) {
      return a + p[1];
    }, 0) / d.centerline.length;
    this.d = d;
    this.kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    this.ky = 110540;
    this.x = [];
    this.y = [];
    this.cum = [];
    var c = 0,
      self = this;
    d.centerline.forEach(function (p, i) {
      var x = p[0] * self.kx,
        y = p[1] * self.ky;
      if (i) c += Math.hypot(x - self.x[i - 1], y - self.y[i - 1]);
      self.x.push(x);
      self.y.push(y);
      self.cum.push(c);
    });
    this.length = c;
    this.scale = d.length_m > 0 ? d.length_m / c : 1;
  }
  FlowModel.prototype.at = function (s) {
    var i = Math.max(1, Math.min(this.cum.length - 1, lowerBound(this.cum, s)));
    var L = this.cum[i] - this.cum[i - 1] || 1;
    var f = Math.max(0, Math.min(1, (s - this.cum[i - 1]) / L));
    var dx = this.x[i] - this.x[i - 1],
      dy = this.y[i] - this.y[i - 1];
    var n = Math.hypot(dx, dy) || 1;
    return { x: this.x[i - 1] + dx * f, y: this.y[i - 1] + dy * f, tx: dx / n, ty: dy / n };
  };
  FlowModel.prototype.interp = function (table, s, t) {
    var row = table[Math.max(0, Math.min(table.length - 1, t))];
    var ch = this.d.xs.chainage_m;
    var c = s * this.scale;
    var i = Math.max(1, Math.min(ch.length - 1, lowerBound(ch, c)));
    var L = ch[i] - ch[i - 1];
    var f = L > 0 ? Math.max(0, Math.min(1, (c - ch[i - 1]) / L)) : 0;
    return row[i - 1] * (1 - f) + row[i] * f;
  };
  FlowModel.prototype.lonLat = function (s, off) {
    var p = this.at(s);
    return [(p.x - p.ty * off) / this.kx, (p.y + p.tx * off) / this.ky];
  };

  function peakFrame() {
    var a = S.frames && S.frames.area_2d_km2;
    if (!a || !a.length) return 0;
    var best = 0;
    for (var i = 1; i < a.length; i++) if (a[i] > a[best]) best = i;
    return best;
  }
  function flowFrame() {
    return S.mode === "time" && S.frames ? S.frame : S.peak;
  }
  function groundHeight(lon, lat) {
    var h = S.viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat));
    return h === undefined ? null : h;
  }

  // ---- 하천
  function spawn(m) {
    var life = 3 + Math.random() * 4;
    return { s: Math.random() * m.length, lane: (Math.random() * 2 - 1) * 0.85, age: Math.random() * life, life: life, h: null };
  }
  function setFlowData(d) {
    var lines = S.flow && S.flow.lines;
    if (!d) {
      if (lines) lines.show = false;
      S.flow = lines ? { lines: lines } : null;
      return;
    }
    var m = new FlowModel(d);
    var ps = [];
    for (var i = 0; i < N_FLOW; i++) ps.push(spawn(m));
    S.flow = { model: m, ps: ps, lines: lines || null, rr: 0 };
    if (S.viewer) ensureFlowLines();
  }

  // ---- 범람 구역 (flow2d.bin: Uint32 격자 번호[n] + 시각마다 Int8 동[n]·북[n], −128 = 마름)
  function loadFlow2d(item) {
    // no-cache: 파일이 나중에 생기는 경우(배치로 추가) 브라우저에 남은 404를 쓰지 않게 매번 확인
    getJSON(fileUrl(item, "flow2d.json"), { cache: "no-cache" })
      .then(function (meta) {
        return fetch(fileUrl(item, meta.file || "flow2d.bin", meta.generated_at))
          .then(function (r) {
            if (!r.ok) throw new Error("flow2d.bin " + r.status);
            return r.arrayBuffer();
          })
          .then(function (buf) {
            if (S.cur === item) setFlow2d(meta, buf);
          });
      })
      .catch(function () {});
  }
  function setFlow2d(meta, buf) {
    if (!meta || !buf) {
      S.f2 = null;
      if (S.flood) S.flood.ps = [];
      if (S.water) S.water.flowKey = null;
      if (S.ready) renderControls();
      return;
    }
    var n = meta.n,
      g = meta.grid;
    if (buf.byteLength < 4 * n + 2 * n * meta.count) return;
    var idx = new Uint32Array(buf, 0, n);
    var q = new Int8Array(buf, 4 * n);
    var lut = new Int32Array(g.width * g.height);
    lut.fill(-1);
    for (var k = 0; k < n; k++) lut[idx[k]] = k;
    var lat0 = g.north - (g.height * g.dlat) / 2;
    S.f2 = { meta: meta, n: n, g: g, idx: idx, q: q, lut: lut, wet: {}, kx: 111320 * Math.cos((lat0 * Math.PI) / 180), ky: 110540 };
    if (!S.flood) S.flood = { ps: [], lines: null, rr: 0 };
    S.flood.ps = [];
    if (S.water) S.water.flowKey = null;
    if (S.viewer) ensureFlowLines();
    renderControls();
    if (S.viewer) S.viewer.scene.requestRender();
  }
  function f2t(t) {
    return Math.max(0, Math.min(S.f2.meta.count - 1, t));
  }
  function f2Vel(t, lon, lat) {
    var F = S.f2,
      g = F.g;
    var c = Math.floor((lon - g.west) / g.dlon),
      r = Math.floor((g.north - lat) / g.dlat);
    if (c < 0 || r < 0 || c >= g.width || r >= g.height) return null;
    var k = F.lut[r * g.width + c];
    if (k < 0) return null;
    var base = f2t(t) * 2 * F.n;
    var u = F.q[base + k];
    if (u === -128) return null;
    return [u * F.meta.scale_ms, F.q[base + F.n + k] * F.meta.scale_ms];
  }
  function f2Wet(t) {
    var F = S.f2;
    t = f2t(t);
    if (F.wet[t]) return F.wet[t];
    var out = [],
      base = t * 2 * F.n,
      s = F.meta.scale_ms;
    for (var k = 0; k < F.n; k++) {
      var u = F.q[base + k];
      if (u === -128) continue;
      var v = F.q[base + F.n + k];
      if ((u * u + v * v) * s * s > 0.0036) out.push(k); // 0.06 m/s 넘는 곳만
    }
    F.wet[t] = out;
    return out;
  }
  function floodSpawn(t, aged) {
    var F = S.f2,
      g = F.g,
      list = f2Wet(t);
    if (!list.length) return null;
    var k = list[0];
    for (var tries = 0; tries < 6; tries++) {
      // 빠른 곳에 조금 더 많이
      k = list[Math.floor(Math.random() * list.length)];
      var base = f2t(t) * 2 * F.n;
      var sp = Math.hypot(F.q[base + k], F.q[base + F.n + k]) * F.meta.scale_ms;
      if (Math.random() < 0.2 + sp / 0.8) break;
    }
    var gi = F.idx[k],
      r = Math.floor(gi / g.width),
      c = gi - r * g.width;
    var lon = g.west + (c + Math.random()) * g.dlon,
      lat = g.north - (r + Math.random()) * g.dlat;
    var life = 2 + Math.random() * 3;
    return { lon: lon, lat: lat, age: aged ? Math.random() * life : 0, life: life, h: groundHeight(lon, lat) };
  }

  function makeLines(n, width) {
    var col = new Cesium.PolylineCollection();
    for (var i = 0; i < n; i++) {
      col.add({
        positions: [Cesium.Cartesian3.fromDegrees(0, 0, 0), Cesium.Cartesian3.fromDegrees(0, 0, 1)],
        width: width,
        show: false,
        material: Cesium.Material.fromType("Color", { color: new Cesium.Color(1, 1, 1, 0.85) }),
      });
    }
    S.viewer.scene.primitives.add(col);
    return col;
  }
  function ensureFlowLines() {
    if (!S.viewer) return;
    if (S.flow && !S.flow.lines) S.flow.lines = makeLines(N_FLOW, 2);
    if (S.flood && !S.flood.lines) S.flood.lines = makeLines(N_FLOOD, 2.2);
    if (S.loopOn) return;
    S.loopOn = true;
    var last = performance.now();
    S.viewer.scene.preRender.addEventListener(function () {
      var now = performance.now();
      var dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      try {
        if (!ownBuildings() && S.bldStyle && $("bld").checked) styleBuildings();
        if (!ownBuildings() && (S.tick = (S.tick || 0) + 1) % 30 === 0) updateRoofs();
        updateFlow(dt);
        updateFlood(dt);
        updateWater(now);
      } catch (e) {
        console.warn("[3D] 흐름 갱신 오류", e);
      }
    });
  }

  function updateFlow(dt) {
    var F = S.flow;
    if (!F || !F.lines) return;
    var on = S.flowOn && !!F.model;
    F.lines.show = on;
    if (!on) return;
    S.viewer.scene.requestRender(); // 화면이 바뀔 때만 그리는 설정이어도 흐름이 보이는 동안은 계속 그린다
    var m = F.model,
      t = flowFrame(),
      d = m.d;
    for (var k = 0; k < 30; k++) {
      // 지형 높이는 한 번에 몇 개씩만 다시 구한다 (getHeight는 무거움)
      var q = F.ps[F.rr++ % F.ps.length];
      var ll = m.lonLat(q.s, 0);
      var h = groundHeight(ll[0], ll[1]);
      if (h !== null) q.h = h;
    }
    for (var i = 0; i < F.ps.length; i++) {
      var p = F.ps[i];
      var v = m.interp(d.velocity_ms, p.s, t);
      p.s += v * dt * SPEEDUP;
      p.age += dt;
      if (p.age > p.life || p.s > m.length || p.s < 0) {
        F.ps[i] = p = spawn(m);
        v = m.interp(d.velocity_ms, p.s, t);
      }
      var line = F.lines.get(i);
      var half = m.interp(d.top_width_m, p.s, t) / 2;
      if (!(v > 0.05) || !(half > 1) || p.h === null) {
        line.show = false;
        continue;
      }
      var off = p.lane * half;
      var len = Math.max(12, Math.min(140, v * SPEEDUP * 0.22));
      var a = m.lonLat(Math.max(0, p.s - len), off),
        b = m.lonLat(p.s, off);
      line.positions = [Cesium.Cartesian3.fromDegrees(a[0], a[1], p.h + 3), Cesium.Cartesian3.fromDegrees(b[0], b[1], p.h + 3)];
      var kk = p.age / p.life;
      line.material.uniforms.color.alpha = 0.9 * Math.min(1, kk * 4, (1 - kk) * 4) * Math.min(1, 0.35 + v / 4);
      line.show = true;
    }
  }

  function updateFlood(dt) {
    var F = S.flood;
    if (!F || !F.lines) return;
    var on = S.flowOn && !!S.f2;
    F.lines.show = on;
    if (!on) return;
    S.viewer.scene.requestRender();
    var t = flowFrame();
    if (F.t !== t) {
      // 시각이 바뀌면 그 시각 젖은 곳에서 새로 뿌린다
      F.t = t;
      F.ps = [];
    }
    while (F.ps.length < N_FLOOD) {
      var np = floodSpawn(t, true);
      if (!np) break;
      F.ps.push(np);
    }
    var Z = S.f2;
    for (var k = 0; k < 40 && F.ps.length; k++) {
      var q = F.ps[F.rr++ % F.ps.length];
      var h = groundHeight(q.lon, q.lat);
      if (h !== null) q.h = h;
    }
    for (var i = 0; i < N_FLOOD; i++) {
      var line = F.lines.get(i);
      var p = F.ps[i];
      if (!p) {
        line.show = false;
        continue;
      }
      var v = f2Vel(t, p.lon, p.lat);
      p.age += dt;
      if (!v || p.age > p.life) {
        p = F.ps[i] = floodSpawn(t, false);
        if (!p) {
          line.show = false;
          continue;
        }
        v = f2Vel(t, p.lon, p.lat);
        if (!v) {
          line.show = false;
          continue;
        }
      }
      p.lon += (v[0] * dt * SPEEDUP) / Z.kx;
      p.lat += (v[1] * dt * SPEEDUP) / Z.ky;
      var sp = Math.hypot(v[0], v[1]);
      if (sp < 0.03 || p.h === null) {
        line.show = false;
        continue;
      }
      var len = Math.max(10, Math.min(90, sp * SPEEDUP * 0.25));
      var tl = p.lon - ((v[0] / sp) * len) / Z.kx,
        tt = p.lat - ((v[1] / sp) * len) / Z.ky;
      line.positions = [Cesium.Cartesian3.fromDegrees(tl, tt, p.h + 3), Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h + 3)];
      var kk = p.age / p.life;
      line.material.uniforms.color.alpha = 0.95 * Math.min(1, kk * 4, (1 - kk) * 4) * Math.min(1, 0.55 + sp);
      line.show = true;
    }
  }

  // ---- 시간대별 물 표면: 침수심 이미지(등급 색) 위에 그 시각 유속 방향으로 흐르는 물결 무늬 (flow map 기법)
  // 유속은 침수심 이미지 범위를 덮는 작은 캔버스(약 25 m 화소)에 R=동, G=북 (128 = 0, ±VMAX m/s)으로 넣는다.
  // 그리기 오류가 나면 guardRender가 걷어내고 예전 방식(이미지 덮기)으로 돌아간다.
  var WATER_SRC = [
    "uniform sampler2D depthImg;",
    "uniform sampler2D flowImg;",
    "uniform vec2 scale;",
    "uniform float time;",
    "uniform float advect;",
    "uniform float opacity;",
    "float hnHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
    "float hnNoise(vec2 p) {",
    "  vec2 i = floor(p); vec2 f = fract(p);",
    "  vec2 u = f * f * (3.0 - 2.0 * f);",
    "  float a = hnHash(i), b = hnHash(i + vec2(1.0, 0.0)), c = hnHash(i + vec2(0.0, 1.0)), d = hnHash(i + vec2(1.0, 1.0));",
    "  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;",
    "}",
    "float hnRipple(vec2 q) { return hnNoise(q) * 0.65 + hnNoise(q * 2.7 + 3.1) * 0.35; }",
    "czm_material czm_getMaterial(czm_materialInput materialInput) {",
    "  czm_material m = czm_getDefaultMaterial(materialInput);",
    "  vec2 st = materialInput.st;",
    // 부드럽게(쌍선형) 읽되, 물 가장자리에서 투명 화소(검정)와 섞여 어두워지는 것을 알파로 되돌린다.
    // 안쪽 화소는 알파가 등급 알파(0.82~0.94) 그대로라 색이 범례와 같다
    "  vec4 c = texture2D(depthImg, st);",
    "  if (c.a < 0.03) { m.alpha = 0.0; return m; }",
    "  c.rgb = clamp(c.rgb / c.a * clamp(c.a, 0.82, 0.94), 0.0, 1.0);",
    "  vec2 vel = (texture2D(flowImg, st).rg * 255.0 - 128.0) / 127.0;",
    "  vec2 p = st * scale;",
    "  float ph0 = fract(time * 0.2);",
    "  float ph1 = fract(time * 0.2 + 0.5);",
    "  float w = abs(ph0 - 0.5) * 2.0;",
    "  float n = mix(hnRipple(p - vel * ph0 * advect), hnRipple(p - vel * ph1 * advect + vec2(17.3, 5.1)), w);",
    "  float sp = clamp(length(vel) * 2.5, 0.0, 1.0);",
    "  float crest = smoothstep(0.3, 0.85, n);",
    "  vec3 col = c.rgb * (0.94 + 0.08 * n);",
    "  col = mix(col, vec3(0.93, 0.97, 1.0), crest * (0.10 + 0.35 * sp));",
    "  m.diffuse = col;",
    "  m.alpha = c.a * opacity;",
    "  return m;",
    "}",
  ].join("\n");
  var RIPPLE_M = 12; // 물결 한 무늬 크기 (m)
  var RIPPLE_SPEED = 15; // 물결이 실제 유속보다 몇 배 빠르게 움직일지

  function ensureWater() {
    if (S.water) return S.water;
    if (S.water === false || !S.viewer || !S.frames) return null;
    try {
      if (!Cesium.GroundPrimitive.supportsMaterials(S.viewer.scene)) {
        S.water = false;
        return null;
      }
      var fr = S.frames,
        b = fr.bounds,
        px = fr.pixel_m || 4;
      var fw = Math.max(2, Math.ceil((fr.width * px) / 25)),
        fh = Math.max(2, Math.ceil((fr.height * px) / 25));
      var mat = new Cesium.Material({
        translucent: true,
        fabric: {
          type: "HinnamnoWater",
          uniforms: {
            depthImg: frameUrl(S.frame),
            flowImg: neutralCanvas(fw, fh),
            scale: new Cesium.Cartesian2((fr.width * px) / RIPPLE_M, (fr.height * px) / RIPPLE_M),
            time: 0,
            advect: (VMAX * RIPPLE_SPEED * 5) / RIPPLE_M, // 한 주기(5초) 동안 무늬 이동량 = 유속 × RIPPLE_SPEED × 5 s
            opacity: 0.92,
          },
          source: WATER_SRC,
        },
      });
      var prim = new Cesium.GroundPrimitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.RectangleGeometry({ rectangle: rect(b), vertexFormat: Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT }),
        }),
        appearance: new Cesium.EllipsoidSurfaceAppearance({ aboveGround: false, material: mat }),
        classificationType: Cesium.ClassificationType.TERRAIN,
        show: false,
      });
      S.viewer.scene.groundPrimitives.add(prim);
      S.water = { prim: prim, mat: mat, fw: fw, fh: fh, bounds: b, frame: -1, flowKey: null };
      return S.water;
    } catch (e) {
      console.warn("[3D] 물 표면을 만들 수 없음 — 이미지 덮기로", e);
      S.water = false;
      return null;
    }
  }
  function dropWater() {
    if (S.water && S.viewer) {
      try {
        S.viewer.scene.groundPrimitives.remove(S.water.prim);
      } catch (e) {}
    }
    if (S.water) S.water = null;
  }
  function neutralCanvas(w, h) {
    var cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "rgb(128,128,0)";
    ctx.fillRect(0, 0, w, h);
    return cv;
  }
  function setWaterFrame(i) {
    var W = S.water;
    if (W.frame !== i) {
      W.mat.uniforms.depthImg = frameUrl(i);
      W.frame = i;
    }
    W.prim.show = S.mode === "time";
    updateWaterFlow(i);
    S.viewer.scene.requestRender();
  }
  // 그 시각 유속 캔버스: 범람 구역(flow2d) + 하천(river_flow, 중심선 방향 × 단면 평균 유속, 수면 폭 안)
  function updateWaterFlow(t) {
    var W = S.water;
    var key = t + "|" + (S.f2 ? 1 : 0) + "|" + (S.flow && S.flow.model ? 1 : 0);
    if (!W || W.flowKey === key) return;
    W.flowKey = key;
    var fw = W.fw,
      fh = W.fh,
      b = W.bounds;
    var cv = document.createElement("canvas");
    cv.width = fw;
    cv.height = fh;
    var ctx = cv.getContext("2d");
    var img = ctx.createImageData(fw, fh);
    var D = img.data;
    for (var j = 0; j < D.length; j += 4) {
      D[j] = 128;
      D[j + 1] = 128;
      D[j + 3] = 255;
    }
    function put(lon, lat, u, v) {
      var c = Math.floor(((lon - b[0]) / (b[2] - b[0])) * fw),
        r = Math.floor(((b[3] - lat) / (b[3] - b[1])) * fh);
      if (c < 0 || r < 0 || c >= fw || r >= fh) return;
      var o = (r * fw + c) * 4;
      D[o] = Math.max(1, Math.min(255, Math.round(128 + (u / VMAX) * 127)));
      D[o + 1] = Math.max(1, Math.min(255, Math.round(128 + (v / VMAX) * 127)));
    }
    if (S.f2) {
      var F = S.f2,
        g = F.g,
        base = f2t(t) * 2 * F.n,
        s = F.meta.scale_ms;
      for (var k = 0; k < F.n; k++) {
        var u = F.q[base + k];
        if (u === -128) continue;
        var gi = F.idx[k],
          rr = Math.floor(gi / g.width),
          cc = gi - rr * g.width;
        put(g.west + (cc + 0.5) * g.dlon, g.north - (rr + 0.5) * g.dlat, u * s, F.q[base + F.n + k] * s);
      }
    }
    if (S.flow && S.flow.model) {
      var m = S.flow.model,
        d = m.d;
      for (var sx = 0; sx < m.length; sx += 8) {
        var vel = m.interp(d.velocity_ms, sx, t);
        var half = m.interp(d.top_width_m, sx, t) / 2;
        if (!(vel > 0.02) || !(half > 1)) continue;
        var at = m.at(sx);
        for (var off = -half; off <= half; off += 8) {
          var ll = m.lonLat(sx, off);
          put(ll[0], ll[1], vel * at.tx, vel * at.ty);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    W.mat.uniforms.flowImg = cv;
  }
  function updateWater(now) {
    var W = S.water;
    if (!W || !W.prim.show) return;
    W.mat.uniforms.time = (now - S.t0) / 1000;
    S.viewer.scene.requestRender(); // 물결이 움직이는 동안 계속 그린다
  }

  // ------------------------------------------------------------ 누른 자리 침수심 등급 (이미지 색으로)
  function classOf(r, g, b, a) {
    if (a < 20) return null;
    var best = null,
      bd = 1e9;
    (C.classes || []).forEach(function (c) {
      var h = c.color.replace("#", "");
      var d = Math.abs(parseInt(h.slice(0, 2), 16) - r) + Math.abs(parseInt(h.slice(2, 4), 16) - g) + Math.abs(parseInt(h.slice(4, 6), 16) - b);
      if (d < bd) {
        bd = d;
        best = c;
      }
    });
    return bd < 60 ? best : null;
  }

  function pixelOf(img, x, y) {
    var cv = document.createElement("canvas");
    cv.width = 1;
    cv.height = 1;
    var ctx = cv.getContext("2d");
    ctx.drawImage(img, x, y, 1, 1, 0, 0, 1, 1);
    return ctx.getImageData(0, 0, 1, 1).data;
  }

  function loadImg(url) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = function () {
        res(im);
      };
      im.onerror = rej;
      im.src = url;
    });
  }

  function sample(lon, lat) {
    if (S.mode === "time" && S.frames) {
      var b = S.frames.bounds;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) return Promise.resolve(null);
      var key = S.cur.id + "|" + S.frame;
      var im = S.images[key];
      var p = im && im.complete && im.naturalWidth ? Promise.resolve(im) : loadImg(frameUrl(S.frame));
      return p.then(function (img) {
        var x = Math.floor(((lon - b[0]) / (b[2] - b[0])) * S.frames.width);
        var y = Math.floor(((b[3] - lat) / (b[3] - b[1])) * S.frames.height);
        var d = pixelOf(img, x, y);
        return classOf(d[0], d[1], d[2], d[3]);
      });
    }
    var z = S.tiles.maxzoom;
    var n = Math.pow(2, z);
    var xt = ((lon + 180) / 360) * n;
    var lr = (lat * Math.PI) / 180;
    var yt = ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n;
    var tx = Math.floor(xt),
      ty = Math.floor(yt);
    var url = fileUrl(S.cur, "tiles/" + z + "/" + tx + "/" + ty + ".png");
    return loadImg(url)
      .then(function (img) {
        var d = pixelOf(img, Math.floor((xt - tx) * 256), Math.floor((yt - ty) * 256));
        return classOf(d[0], d[1], d[2], d[3]);
      })
      .catch(function () {
        return null;
      });
  }

  function setupPick() {
    var h = new Cesium.ScreenSpaceEventHandler(S.viewer.scene.canvas);
    h.setInputAction(function (e) {
      // 건물 벽·지붕을 누르면 그 자리(깊이 버퍼), 아니면 지면
      var pos = null;
      try {
        if (S.viewer.scene.pickPositionSupported) pos = S.viewer.scene.pickPosition(e.position);
      } catch (err) {}
      if (!pos) {
        var ray = S.viewer.camera.getPickRay(e.position);
        pos = ray && S.viewer.scene.globe.pick(ray, S.viewer.scene);
      }
      if (!pos || !S.cur) return;
      var c = Cesium.Cartographic.fromCartesian(pos);
      var lon = Cesium.Math.toDegrees(c.longitude),
        lat = Cesium.Math.toDegrees(c.latitude);
      var when = S.mode === "time" && S.frames ? hhmm(S.frames.times[S.frame]) + " 침수심" : "최대 침수심";
      var link = (S.cur.runId ? "/?run=" + S.cur.runId : "/?s=" + encodeURIComponent(S.cur.id)) + "#map=17/" + lat.toFixed(5) + "/" + lon.toFixed(5);
      var bi = ownBuildings() && $("bld").checked ? S.bld.nearest(lon, lat) : null;
      var esc = function (t) {
        return String(t).replace(/[&<>"]/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
      };
      var bhtml = "";
      if (bi) {
        var a = bi.approved;
        bhtml =
          '<div class="v3-pick-row"><span>건물</span><b>' +
          esc((bi.name ? bi.name + " · " : "") + bi.use) +
          "</b></div>" +
          '<div class="v3-pick-row"><span>층수·높이</span><b>' +
          (bi.floors ? "지상 " + bi.floors + "층" : "층수 정보 없음") +
          (bi.underground ? " · 지하 " + bi.underground + "층" : "") +
          (bi.height ? " · " + bi.height.toFixed(1) + " m" : " · 높이 " + bi.heightUsed.toFixed(1) + " m(층수로 추정)") +
          "</b></div>" +
          (a && a.length === 8 ? '<div class="v3-pick-row"><span>사용승인</span><b>' + a.slice(0, 4) + "." + a.slice(4, 6) + "." + a.slice(6, 8) + "</b></div>" : "");
      }
      sample(lon, lat).then(function (cls) {
        $("pick").innerHTML =
          '<div class="v3-pick-row"><span>' +
          when +
          "</span><b>" +
          (cls ? cls.range + " · " + cls.body : "0.1 m 미만 또는 계산 범위 밖") +
          "</b></div>" +
          bhtml +
          '<a href="' +
          link +
          '">2D 지도에서 이 자리 자세히 보기</a>';
      });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  // ------------------------------------------------------------ 시작
  function bind() {
    $("scn").addEventListener("change", function (e) {
      var it = S.items.find(function (x) {
        return x.id === e.target.value;
      });
      if (it) selectItem(it).catch(function (err) {
        status("결과를 불러오지 못했습니다: " + err.message, "err");
      });
    });
    document.querySelectorAll("[data-mode]").forEach(function (b) {
      b.addEventListener("click", function () {
        setMode(b.getAttribute("data-mode"));
      });
    });
    $("play").addEventListener("click", play);
    $("slider").addEventListener("input", function (e) {
      stop();
      setFrame(Number(e.target.value));
    });
    document.querySelectorAll("[data-view]").forEach(function (b) {
      b.addEventListener("click", function () {
        view(b.getAttribute("data-view"));
      });
    });
    $("flowbtn").addEventListener("click", function () {
      S.flowOn = !S.flowOn;
      renderControls();
      if (S.viewer) S.viewer.scene.requestRender();
    });
    $("adm").addEventListener("change", function (e) {
      setAdmin(e.target.checked);
    });
    $("names").addEventListener("change", function (e) {
      setNames(e.target.checked);
    });
    document.querySelectorAll("[data-bstyle]").forEach(function (b) {
      b.addEventListener("click", function () {
        setBuildingStyle(b.getAttribute("data-bstyle"));
      });
    });
    $("bld").addEventListener("change", function (e) {
      setBuildings(e.target.checked);
    });
    $("fold").addEventListener("click", function () {
      var p = $("panel");
      var open = !p.classList.contains("folded");
      p.classList.toggle("folded", open);
      $("fold").setAttribute("aria-expanded", String(!open));
      $("fold").textContent = open ? "설정 펼치기" : "설정 접기";
    });
  }

  function main() {
    renderLegend();
    bind();
    if (!C.hasKey) {
      status("브이월드 키가 없어 3D 지도를 열 수 없습니다.", "err");
    }
    loadList()
      .then(function () {
        var it = defaultItem();
        renderSelect();
        return selectItem(it).then(function () {
          renderSelect();
          if (C.hasKey) startMap(S.tiles.wet_centroid_lonlat || [(S.tiles.bounds[0] + S.tiles.bounds[2]) / 2, (S.tiles.bounds[1] + S.tiles.bounds[3]) / 2]);
        });
      })
      .catch(function (e) {
        status("자료를 불러오지 못했습니다: " + e.message, "err");
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();
})();
