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
        if (n === 0 || h > 4000) view("tilt");
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
      // 남쪽에서 북쪽을 비스듬히 (높이 2.2 km, 아래로 32°)
      cam.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(c[0], c[1] - 0.031, 2200),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-32), roll: 0 },
        duration: 1.6,
      });
    }
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
    ]).then(function (r) {
      if (S.cur !== item) return;
      S.tiles = r[0];
      S.frames = r[1];
      S.kpi = r[2];
      if (!S.frames && S.mode === "time") S.mode = "max";
      if (S.frames) S.frame = Math.min(S.frame, S.frames.count - 1);
      renderControls();
      applyScenario();
    });
  }

  function setMode(m) {
    if (m === "time" && !S.frames) return;
    S.mode = m;
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
      var ray = S.viewer.camera.getPickRay(e.position);
      var pos = ray && S.viewer.scene.globe.pick(ray, S.viewer.scene);
      if (!pos || !S.cur) return;
      var c = Cesium.Cartographic.fromCartesian(pos);
      var lon = Cesium.Math.toDegrees(c.longitude),
        lat = Cesium.Math.toDegrees(c.latitude);
      var when = S.mode === "time" && S.frames ? hhmm(S.frames.times[S.frame]) + " 침수심" : "최대 침수심";
      var link = (S.cur.runId ? "/?run=" + S.cur.runId : "/?s=" + encodeURIComponent(S.cur.id)) + "#map=17/" + lat.toFixed(5) + "/" + lon.toFixed(5);
      sample(lon, lat).then(function (cls) {
        $("pick").innerHTML =
          '<div class="v3-pick-row"><span>' +
          when +
          "</span><b>" +
          (cls ? cls.range + " · " + cls.body : "0.1 m 미만 또는 계산 범위 밖") +
          '</b></div><a href="' +
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
    $("bld").addEventListener("change", function (e) {
      try {
        var l = S.map && S.map.getLayerElement("facility_build");
        if (l) e.target.checked ? l.show() : l.hide();
      } catch (err) {
        /* 건물 레이어 이름이 바뀌면 무시 */
      }
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
