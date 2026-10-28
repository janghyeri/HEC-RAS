// 배경지도: 브이월드 WMTS (항공사진 Satellite + 지명 Hybrid, 일반지도 Base).
// 키(NEXT_PUBLIC_VWORLD_KEY)는 등록한 주소에서만 작동한다. 키가 없거나 다른 주소(미리보기 배포 등)이면
// OpenStreetMap으로 대신한다.
import type { StyleSpecification } from "maplibre-gl";

export type Basemap = "photo" | "map";

export const VWORLD_KEY = process.env.NEXT_PUBLIC_VWORLD_KEY ?? "";

const VWORLD_ATTR = '<a href="https://www.vworld.kr" target="_blank" rel="noreferrer">© 국토교통부 브이월드</a>';
const OSM_ATTR = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>';

function vworld(layer: string, ext: string): string {
  return `https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/${layer}/{z}/{y}/{x}.${ext}`;
}

/** 배경지도 레이어 id: 아래 둘은 침수 레이어 밑, 지명(label)은 침수 레이어 위에 둔다. */
export const BASE_LAYERS = { photo: "base-photo", map: "base-map", label: "base-label" } as const;

export function hasVworld(): boolean {
  return VWORLD_KEY.length > 0;
}

export function baseStyle(initial: Basemap): StyleSpecification {
  if (!hasVworld()) {
    return {
      version: 8,
      sources: {
        osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19, attribution: OSM_ATTR },
      },
      layers: [{ id: BASE_LAYERS.map, type: "raster", source: "osm" }],
    };
  }
  const vis = (on: boolean) => ({ visibility: on ? ("visible" as const) : ("none" as const) });
  return {
    version: 8,
    sources: {
      "vw-photo": { type: "raster", tiles: [vworld("Satellite", "jpeg")], tileSize: 256, minzoom: 6, maxzoom: 19, attribution: VWORLD_ATTR },
      "vw-label": { type: "raster", tiles: [vworld("Hybrid", "png")], tileSize: 256, minzoom: 6, maxzoom: 19 },
      "vw-base": { type: "raster", tiles: [vworld("Base", "png")], tileSize: 256, minzoom: 6, maxzoom: 19, attribution: VWORLD_ATTR },
    },
    layers: [
      { id: BASE_LAYERS.photo, type: "raster", source: "vw-photo", layout: vis(initial === "photo") },
      { id: BASE_LAYERS.map, type: "raster", source: "vw-base", layout: vis(initial === "map") },
      { id: BASE_LAYERS.label, type: "raster", source: "vw-label", layout: vis(initial === "photo"), paint: { "raster-opacity": 0.9 } },
    ],
  };
}
