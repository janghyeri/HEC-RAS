"use client";

// MapLibre 지도: 배경(브이월드) + 시나리오별 최대 수심 타일 + 선택한 격자 + 맨홀 위치.
// maplibre-gl은 브라우저에서만 불러온다 (서버 렌더링 중에는 window가 없음).
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, ImageSource, Map as MLMap, StyleSpecification } from "maplibre-gl";
import { BASE_LAYERS, baseStyle, hasVworld, type Basemap } from "@/lib/basemap";
import { absoluteUrl, scenarioUrl, type BBox, type Scenario } from "@/lib/data";
import type { TraceCollection } from "@/lib/reference";

export interface Pick {
  lngLat: [number, number];
}

interface Props {
  bbox: BBox;
  scenarios: Scenario[];
  activeId: string;
  basemap: Basemap;
  showManholes: boolean;
  /** 행정안전부 침수흔적도 (원자료 그대로, 테두리만 그림) */
  traces: TraceCollection | null;
  showTraces: boolean;
  selectedRing: [number, number][] | null;
  picked: [number, number] | null;
  onPick: (p: Pick) => void;
  /** 검색 등으로 지도를 옮길 때 (seq가 바뀔 때마다 이동) */
  focus: { lngLat: [number, number]; zoom: number; seq: number } | null;
  /** 휴대폰 지도 버튼 묶음의 배경지도 바꾸기 */
  onToggleBasemap: () => void;
  /** 시간대별 재생: 이 이미지(10분 침수심)를 최대 수심 대신 보여 준다 */
  frame?: { url: string; corners: [[number, number], [number, number], [number, number], [number, number]] } | null;
  /** 행정구역(시군구·읍면동) 경계선과 이름 */
  showAdmin?: boolean;
  /** 브이월드 지명(건물·상호·도로 이름) 레이어 — 항공사진일 때만 */
  showNames?: boolean;
}

const ADMIN_URL = "/data/admin/boundaries.geojson";
const ADMIN_LAYERS = ["admin-emd-casing", "admin-emd", "admin-sgg-casing", "admin-sgg"];
const EMD_MIN_ZOOM = 12.5; // 이보다 가까우면 읍면동 이름, 멀면 시군구 이름

const floodId = (s: Scenario) => `flood-${s.ref.scenario_id}`;
const manholeId = (s: Scenario) => `manholes-${s.ref.scenario_id}`;
const EMPTY = { type: "FeatureCollection" as const, features: [] as never[] };

function mapPadding() {
  if (typeof window === "undefined") return 40;
  const mobile = window.matchMedia("(max-width: 767px)").matches;
  return mobile
    ? { top: 72, bottom: Math.round(window.innerHeight * 0.5) + 8, left: 16, right: 60 } // 위 검색창, 아래 시트(globals.css --sheet-max)
    : { top: 64, bottom: 150, left: 24, right: 64 }; // 위 배경지도 선택, 아래 시간별 침수면적 카드
}

// 휴대폰: 배경지도 바꾸기 버튼을 MapLibre 버튼 묶음(확대·축소·내 위치) 안에 넣는다
class BasemapControl {
  private el: HTMLDivElement | null = null;
  constructor(private readonly onClick: () => void) {}
  onAdd() {
    const el = document.createElement("div");
    el.className = "maplibregl-ctrl maplibregl-ctrl-group basemap-ctrl";
    const b = document.createElement("button");
    b.type = "button";
    b.title = "배경지도 바꾸기 (항공사진·일반지도)";
    b.setAttribute("aria-label", "배경지도 바꾸기 (항공사진·일반지도)");
    b.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>';
    b.addEventListener("click", this.onClick);
    el.appendChild(b);
    this.el = el;
    return el;
  }
  onRemove() {
    this.el?.remove();
  }
}

export default function MapView(props: Props) {
  const { bbox, scenarios, activeId, basemap, showManholes, traces, showTraces, selectedRing, picked, onPick, focus, onToggleBasemap, frame = null,
    showAdmin = true, showNames = false } = props;
  const labelsRef = useRef<{ el: HTMLElement; level: string }[]>([]);
  const applyLabelsRef = useRef<() => void>(() => undefined);
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const toggleRef = useRef(onToggleBasemap);
  toggleRef.current = onToggleBasemap;

  // 지도 만들기 (한 번)
  useEffect(() => {
    let cancelled = false;
    let map: MLMap | null = null;
    (async () => {
      const ml = (await import("maplibre-gl")).default;
      if (cancelled || !box.current) return;
      map = new ml.Map({
        container: box.current,
        style: baseStyle(basemap) as StyleSpecification,
        bounds: [bbox[0], bbox[1], bbox[2], bbox[3]],
        fitBoundsOptions: { padding: mapPadding() },
        minZoom: 10,
        maxZoom: 19,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        attributionControl: { compact: true },
        hash: "map", // 주소창에 지도 위치(#map=줌/위도/경도)를 남겨 링크로 공유할 수 있게
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new ml.GeolocateControl({ trackUserLocation: false }), "top-right");
      if (hasVworld()) map.addControl(new BasemapControl(() => toggleRef.current()), "top-right");
      map.addControl(new ml.ScaleControl({ unit: "metric", maxWidth: 90 }), "bottom-left");

      map.on("load", () => {
        if (!map) return;
        const before = map.getLayer(BASE_LAYERS.label) ? BASE_LAYERS.label : undefined;
        for (const s of scenarios) {
          map.addSource(floodId(s), {
            type: "raster",
            tiles: [absoluteUrl(scenarioUrl(s.ref, "tiles/{z}/{x}/{y}.png"))],
            tileSize: s.tiles.tile_size,
            minzoom: s.tiles.minzoom,
            maxzoom: s.tiles.maxzoom,
            bounds: s.tiles.bounds,
          });
          map.addLayer(
            {
              id: floodId(s),
              type: "raster",
              source: floodId(s),
              layout: { visibility: s.ref.scenario_id === activeId ? "visible" : "none" },
              paint: { "raster-opacity": 0.9, "raster-fade-duration": 0 },
            },
            before,
          );
          if (s.hasManholes) {
            map.addSource(manholeId(s), { type: "geojson", data: absoluteUrl(scenarioUrl(s.ref, "manholes.geojson")) });
            map.addLayer({
              id: manholeId(s),
              type: "circle",
              source: manholeId(s),
              layout: { visibility: "none" },
              paint: {
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2, 16, 5],
                "circle-color": "#eb6834",
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 1,
              },
            });
          }
        }
        // 행정구역: 시군구 = 흰 테두리 + 진한 선, 같은 시군구 안 읍면동 = 흰 점선 (수심 파랑과 겹치지 않게 무채색)
        map.addSource("admin", { type: "geojson", data: absoluteUrl(ADMIN_URL) }); // 출처는 왼쪽 패널 아래에 (지도 구석 표기는 길어서 가림)
        const isLevel = (lv: string) => ["all", ["==", ["get", "kind"], "boundary"], ["==", ["get", "level"], lv]] as never;
        map.addLayer({ id: "admin-emd-casing", type: "line", source: "admin", filter: isLevel("emd"),
          paint: { "line-color": "#17212b", "line-opacity": 0.35, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.5, 16, 3.5] } });
        map.addLayer({ id: "admin-emd", type: "line", source: "admin", filter: isLevel("emd"),
          paint: { "line-color": "#ffffff", "line-opacity": 0.9, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.8, 16, 1.8], "line-dasharray": [3, 2] } });
        map.addLayer({ id: "admin-sgg-casing", type: "line", source: "admin", filter: isLevel("sgg"),
          paint: { "line-color": "#ffffff", "line-opacity": 0.85, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 6] } });
        map.addLayer({ id: "admin-sgg", type: "line", source: "admin", filter: isLevel("sgg"),
          paint: { "line-color": "#17212b", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 16, 2.4] } });
        // 이름은 HTML 표지로 (이 지도 양식에는 글꼴(glyphs)이 없어 기호 레이어 글자를 쓸 수 없음)
        fetch(absoluteUrl(ADMIN_URL))
          .then((r) => (r.ok ? r.json() : null))
          .then((fc) => {
            if (!fc || !map) return;
            for (const f of fc.features as { properties: Record<string, string>; geometry: { coordinates: [number, number] } }[]) {
              const p = f.properties;
              if (p.kind !== "label") continue;
              const el = document.createElement("div");
              el.className = `adm-label adm-${p.level}`;
              el.setAttribute("aria-hidden", "true");
              const b = document.createElement("b");
              b.textContent = p.name;
              el.appendChild(b);
              if (p.level === "emd" && p.sgg) {
                const sm = document.createElement("span");
                sm.textContent = p.sgg;
                el.appendChild(sm);
              }
              new ml.Marker({ element: el, anchor: "center" }).setLngLat(f.geometry.coordinates).addTo(map);
              labelsRef.current.push({ el, level: p.level });
            }
            applyLabelsRef.current();
          })
          .catch(() => undefined);
        // 실제 침수흔적: 흰 테두리 + 진한 적갈색 점선 (파란 수심 색·주황 맨홀 점과 구별)
        map.addSource("traces", { type: "geojson", data: EMPTY });
        map.addLayer({ id: "traces-halo", type: "line", source: "traces", layout: { visibility: "none" },
          paint: { "line-color": "#ffffff", "line-width": 3.5, "line-opacity": 0.85 } });
        map.addLayer({ id: "traces-line", type: "line", source: "traces", layout: { visibility: "none" },
          paint: { "line-color": "#8f1d14", "line-width": 1.8, "line-dasharray": [2, 1.5] } });
        map.addSource("selected", { type: "geojson", data: EMPTY });
        map.addLayer({ id: "selected-halo", type: "line", source: "selected", paint: { "line-color": "#ffffff", "line-width": 4 } });
        map.addLayer({ id: "selected-line", type: "line", source: "selected", paint: { "line-color": "#17212b", "line-width": 1.5 } });
        map.addSource("picked", { type: "geojson", data: EMPTY });
        map.addLayer({
          id: "picked",
          type: "circle",
          source: "picked",
          paint: { "circle-radius": 5, "circle-color": "#17212b", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
        });
        setReady(true);
      });
      map.on("click", (e) => onPickRef.current({ lngLat: [e.lngLat.lng, e.lngLat.lat] }));
      mapRef.current = map;
    })();
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 시간대별 이미지 (한 장을 계속 바꿔 끼운다 — 이미지는 브라우저 캐시에서 바로 읽힘)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("frame") as ImageSource | undefined;
    if (!frame) {
      if (map.getLayer("frame")) map.setLayoutProperty("frame", "visibility", "none");
      return;
    }
    const url = absoluteUrl(frame.url);
    if (!src) {
      map.addSource("frame", { type: "image", url, coordinates: frame.corners });
      const before = map.getLayer(BASE_LAYERS.label) ? BASE_LAYERS.label : map.getLayer("traces-halo") ? "traces-halo" : undefined;
      map.addLayer({ id: "frame", type: "raster", source: "frame", paint: { "raster-opacity": 0.9, "raster-fade-duration": 0, "raster-resampling": "nearest" } }, before);
    } else {
      src.updateImage({ url, coordinates: frame.corners });
      map.setLayoutProperty("frame", "visibility", "visible");
    }
  }, [ready, frame]);

  // 시나리오 · 맨홀 표시
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const s of scenarios) {
      map.setLayoutProperty(floodId(s), "visibility", s.ref.scenario_id === activeId && !frame ? "visible" : "none");
      if (s.hasManholes) {
        const on = showManholes && s.ref.scenario_id === activeId;
        map.setLayoutProperty(manholeId(s), "visibility", on ? "visible" : "none");
      }
    }
  }, [ready, scenarios, activeId, showManholes, frame !== null]);

  // 실제 침수흔적
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("traces") as GeoJSONSource).setData((traces ?? EMPTY) as never);
    const vis = showTraces && traces ? "visible" : "none";
    map.setLayoutProperty("traces-halo", "visibility", vis);
    map.setLayoutProperty("traces-line", "visibility", vis);
  }, [ready, traces, showTraces]);

  // 배경지도 전환 · 지명(건물·상호·도로 이름) 켜고 끄기
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !hasVworld()) return;
    map.setLayoutProperty(BASE_LAYERS.photo, "visibility", basemap === "photo" ? "visible" : "none");
    map.setLayoutProperty(BASE_LAYERS.label, "visibility", basemap === "photo" && showNames ? "visible" : "none");
    map.setLayoutProperty(BASE_LAYERS.map, "visibility", basemap === "map" ? "visible" : "none");
  }, [ready, basemap, showNames]);

  // 행정구역 경계·이름 (이름은 확대 정도에 따라 시군구 ↔ 읍면동)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const id of ADMIN_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", showAdmin ? "visible" : "none");
    const apply = () => {
      const near = map.getZoom() >= EMD_MIN_ZOOM;
      for (const l of labelsRef.current) l.el.style.display = showAdmin && (l.level === "emd") === near ? "" : "none";
    };
    applyLabelsRef.current = apply;
    apply();
    map.on("zoomend", apply);
    return () => {
      map.off("zoomend", apply);
    };
  }, [ready, showAdmin]);

  // 선택한 격자·위치
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("selected") as GeoJSONSource).setData(
      selectedRing
        ? { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [selectedRing] } }
        : EMPTY,
    );
    (map.getSource("picked") as GeoJSONSource).setData(
      picked ? { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: picked } } : EMPTY,
    );
  }, [ready, selectedRing, picked]);

  // 검색한 곳으로 이동
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !focus) return;
    map.flyTo({ center: focus.lngLat, zoom: focus.zoom, padding: mapPadding(), duration: 900 });
  }, [ready, focus]);

  return <div ref={box} className="map" aria-label="침수 지도" />;
}
