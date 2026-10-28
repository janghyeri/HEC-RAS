"use client";

// MapLibre 지도: 배경(브이월드) + 시나리오별 최대 수심 타일 + 선택한 격자 + 맨홀 위치.
// maplibre-gl은 브라우저에서만 불러온다 (서버 렌더링 중에는 window가 없음).
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MLMap, StyleSpecification } from "maplibre-gl";
import { BASE_LAYERS, baseStyle, hasVworld, type Basemap } from "@/lib/basemap";
import { DATA_ROOT, type BBox, type Scenario } from "@/lib/data";

export interface Pick {
  lngLat: [number, number];
}

interface Props {
  bbox: BBox;
  scenarios: Scenario[];
  activeId: string;
  basemap: Basemap;
  showManholes: boolean;
  selectedRing: [number, number][] | null;
  picked: [number, number] | null;
  onPick: (p: Pick) => void;
}

const floodId = (s: Scenario) => `flood-${s.ref.scenario_id}`;
const manholeId = (s: Scenario) => `manholes-${s.ref.scenario_id}`;
const EMPTY = { type: "FeatureCollection" as const, features: [] as never[] };

function mapPadding() {
  if (typeof window === "undefined") return 40;
  const mobile = window.matchMedia("(max-width: 767px)").matches;
  return mobile
    ? { top: 64, bottom: Math.round(window.innerHeight * 0.42), left: 16, right: 16 }
    : { top: 40, bottom: 40, left: 380, right: 60 };
}

export default function MapView(props: Props) {
  const { bbox, scenarios, activeId, basemap, showManholes, selectedRing, picked, onPick } = props;
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

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
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new ml.ScaleControl({ unit: "metric", maxWidth: 90 }), "bottom-left");
      map.addControl(new ml.GeolocateControl({ trackUserLocation: false }), "top-right");

      map.on("load", () => {
        if (!map) return;
        const before = map.getLayer(BASE_LAYERS.label) ? BASE_LAYERS.label : undefined;
        for (const s of scenarios) {
          map.addSource(floodId(s), {
            type: "raster",
            tiles: [`${location.origin}${DATA_ROOT}/${s.ref.path}/tiles/{z}/{x}/{y}.png`],
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
            map.addSource(manholeId(s), { type: "geojson", data: `${location.origin}${DATA_ROOT}/${s.ref.path}/manholes.geojson` });
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

  return <div ref={box} className="map" aria-label="침수 지도" />;
}
