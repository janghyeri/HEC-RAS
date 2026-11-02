"use client";

// MapLibre 지도: 배경(브이월드) + 시나리오별 최대 수심 타일 + 선택한 격자 + 맨홀 위치.
// maplibre-gl은 브라우저에서만 불러온다 (서버 렌더링 중에는 window가 없음).
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MLMap, StyleSpecification } from "maplibre-gl";
import { BASE_LAYERS, baseStyle, hasVworld, type Basemap } from "@/lib/basemap";
import { scenarioUrl, type BBox, type Scenario } from "@/lib/data";
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
}

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
  const { bbox, scenarios, activeId, basemap, showManholes, traces, showTraces, selectedRing, picked, onPick, focus, onToggleBasemap } =
    props;
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
            tiles: [`${location.origin}${scenarioUrl(s.ref, "tiles/{z}/{x}/{y}.png")}`],
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
            map.addSource(manholeId(s), { type: "geojson", data: `${location.origin}${scenarioUrl(s.ref, "manholes.geojson")}` });
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

  // 시나리오 · 맨홀 표시
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const s of scenarios) {
      map.setLayoutProperty(floodId(s), "visibility", s.ref.scenario_id === activeId ? "visible" : "none");
      if (s.hasManholes) {
        const on = showManholes && s.ref.scenario_id === activeId;
        map.setLayoutProperty(manholeId(s), "visibility", on ? "visible" : "none");
      }
    }
  }, [ready, scenarios, activeId, showManholes]);

  // 실제 침수흔적
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("traces") as GeoJSONSource).setData((traces ?? EMPTY) as never);
    const vis = showTraces && traces ? "visible" : "none";
    map.setLayoutProperty("traces-halo", "visibility", vis);
    map.setLayoutProperty("traces-line", "visibility", vis);
  }, [ready, traces, showTraces]);

  // 배경지도 전환
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !hasVworld()) return;
    map.setLayoutProperty(BASE_LAYERS.photo, "visibility", basemap === "photo" ? "visible" : "none");
    map.setLayoutProperty(BASE_LAYERS.label, "visibility", basemap === "photo" ? "visible" : "none");
    map.setLayoutProperty(BASE_LAYERS.map, "visibility", basemap === "map" ? "visible" : "none");
  }, [ready, basemap]);

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
