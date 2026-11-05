"use client";

// 하천 범람(A) vs 하천 범람 + 도시 침수(B) 지도.
//  - 원인 지도: 지도 하나에 분류 타일 (pipeline/compare_web.py)
//  - 밀어서 비교: 지도 두 장을 겹치고 위 지도(B)를 가르는 선 오른쪽만 보이게 자른다. 움직임은 서로 맞춘다.
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { Map as MLMap, StyleSpecification } from "maplibre-gl";
import { BASE_LAYERS, baseStyle, type Basemap } from "@/lib/basemap";
import { absoluteUrl, scenarioUrl, type BBox } from "@/lib/data";
import type { Summary } from "@/lib/summary";

export type CompareMode = "cause" | "swipe";

interface Props {
  a: Summary;
  b: Summary;
  aLabel: string;
  bLabel: string;
  causeTiles: string | null; // .../tiles/{z}/{x}/{y}.png
  causeBounds: BBox | null;
  mode: CompareMode;
  basemap: Basemap;
  bbox: BBox;
}

function floodSource(s: Summary) {
  return {
    type: "raster" as const,
    tiles: [absoluteUrl(scenarioUrl(s.ref, "tiles/{z}/{x}/{y}.png"))],
    tileSize: s.tiles.tile_size,
    minzoom: s.tiles.minzoom,
    maxzoom: s.tiles.maxzoom,
    bounds: s.tiles.bounds,
  };
}

export default function CompareMap({ a, b, aLabel, bLabel, causeTiles, causeBounds, mode, basemap, bbox }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const boxA = useRef<HTMLDivElement>(null);
  const boxB = useRef<HTMLDivElement>(null);
  const maps = useRef<{ a: MLMap | null; b: MLMap | null }>({ a: null, b: null });
  const [ready, setReady] = useState(0);
  const [pos, setPos] = useState(50);

  useEffect(() => {
    let cancelled = false;
    const made: MLMap[] = [];
    (async () => {
      const ml = (await import("maplibre-gl")).default;
      if (cancelled || !boxA.current || !boxB.current) return;
      const make = (el: HTMLDivElement, s: Summary, withCause: boolean, controls: boolean) => {
        const m = new ml.Map({
          container: el,
          style: baseStyle(basemap) as StyleSpecification,
          bounds: [bbox[0], bbox[1], bbox[2], bbox[3]],
          fitBoundsOptions: { padding: 24 },
          minZoom: 10,
          maxZoom: 18,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          attributionControl: controls ? { compact: true } : false,
        });
        m.touchZoomRotate.disableRotation();
        if (controls) m.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
        m.on("load", () => {
          const before = m.getLayer(BASE_LAYERS.label) ? BASE_LAYERS.label : undefined;
          m.addSource("flood", floodSource(s));
          m.addLayer({ id: "flood", type: "raster", source: "flood", paint: { "raster-opacity": 0.9, "raster-fade-duration": 0 } }, before);
          if (withCause && causeTiles) {
            m.addSource("cause", {
              type: "raster",
              tiles: [absoluteUrl(causeTiles)],
              tileSize: 256,
              minzoom: 10,
              maxzoom: 16,
              ...(causeBounds ? { bounds: causeBounds } : {}),
            });
            m.addLayer({ id: "cause", type: "raster", source: "cause", layout: { visibility: "none" }, paint: { "raster-opacity": 0.92, "raster-fade-duration": 0 } }, before);
          }
          setReady((r) => r + 1);
        });
        made.push(m);
        return m;
      };
      // 버튼은 두 지도 모두 (원인 지도에서는 위 지도가 가려지고, 밀어서 비교에서는 오른쪽 위가 위 지도라서)
      const ma = make(boxA.current, a, true, true);
      const mb = make(boxB.current, b, false, true);
      // 두 지도 움직임 맞추기 (한쪽이 움직이면 다른 쪽을 그 자리로)
      let syncing = false;
      const sync = (from: MLMap, to: MLMap) => () => {
        if (syncing) return;
        syncing = true;
        to.jumpTo({ center: from.getCenter(), zoom: from.getZoom(), bearing: from.getBearing(), pitch: from.getPitch() });
        syncing = false;
      };
      ma.on("move", sync(ma, mb));
      mb.on("move", sync(mb, ma));
      maps.current = { a: ma, b: mb };
    })();
    return () => {
      cancelled = true;
      made.forEach((m) => m.remove());
      maps.current = { a: null, b: null };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.ref.scenario_id, b.ref.scenario_id]);

  // 보기 방식: 원인 지도면 A 지도에 분류만, 밀어서 비교면 A·B 수심
  useEffect(() => {
    const { a: ma, b: mb } = maps.current;
    if (!ma || !mb || ready < 2) return;
    const cause = mode === "cause" && !!ma.getLayer("cause");
    ma.setLayoutProperty("flood", "visibility", cause ? "none" : "visible");
    if (ma.getLayer("cause")) ma.setLayoutProperty("cause", "visibility", cause ? "visible" : "none");
    ma.resize();
    mb.resize();
  }, [mode, ready]);

  // 배경지도
  useEffect(() => {
    const { a: ma, b: mb } = maps.current;
    if (!ma || !mb || ready < 2) return;
    for (const m of [ma, mb]) {
      if (!m.getLayer(BASE_LAYERS.photo)) continue;
      m.setLayoutProperty(BASE_LAYERS.photo, "visibility", basemap === "photo" ? "visible" : "none");
      m.setLayoutProperty(BASE_LAYERS.label, "visibility", basemap === "photo" ? "visible" : "none");
      m.setLayoutProperty(BASE_LAYERS.map, "visibility", basemap === "map" ? "visible" : "none");
    }
  }, [basemap, ready]);

  const drag = (e: RPointerEvent<HTMLDivElement>) => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    setPos(Math.max(2, Math.min(98, ((e.clientX - r.left) / r.width) * 100)));
  };

  const swipe = mode === "swipe";
  return (
    <div className="cmp-map" ref={wrap}>
      <div ref={boxA} className="cmp-layer" aria-label={swipe ? `${aLabel} 지도 (왼쪽)` : "침수 원인 지도"} />
      <div
        ref={boxB}
        className="cmp-layer"
        style={{ clipPath: swipe ? `inset(0 0 0 ${pos}%)` : "inset(0 0 0 100%)", pointerEvents: swipe ? undefined : "none" }}
        aria-hidden={!swipe}
      />
      {swipe && (
        <>
          <span className="cmp-tag left">{aLabel}</span>
          <span className="cmp-tag right">{bLabel}</span>
          <div
            className="cmp-divider"
            style={{ left: `${pos}%` }}
            role="slider"
            tabIndex={0}
            aria-label="비교 위치"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pos)}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              drag(e);
            }}
            onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && drag(e)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setPos((p) => Math.max(2, p - 5));
              if (e.key === "ArrowRight") setPos((p) => Math.min(98, p + 5));
            }}
          >
            <span className="cmp-handle" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M9 6l-5 6 5 6M15 6l5 6-5 6" />
              </svg>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
