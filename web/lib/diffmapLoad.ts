// 차이 지도 자료 읽기 (브라우저 전용): depth2m/max.png·area2d_2m.png를 내려받아 화소값으로 풀고, 결과를 지도용 그림으로 만든다.
import { DATA_ROOT, type BBox, type ScenarioRef } from "./data";
import { classifyDiff, diffRGBA, type DepthGrid, type DiffResult } from "./diffmap";

interface Depth2mInfo {
  bounds: BBox;
  width: number;
  height: number;
  encoding: { step_m: number };
  max?: { file: string };
  generated_at?: string;
}

interface AreaInfo {
  bounds: BBox;
  width: number;
  height: number;
}

/** PNG(회색조) → 화소값. 색 공간 변환을 끄고 빨강 채널을 읽는다 (회색조라 세 채널이 같음). */
async function decodeGray(url: string): Promise<{ width: number; height: number; values: Uint8Array }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url.split("?")[0].split("/").slice(-3).join("/")} 응답 ${r.status}`);
  const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const { width, height } = bmp;
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (typeof OffscreenCanvas !== "undefined") {
    ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
  } else {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    ctx = c.getContext("2d", { willReadFrequently: true });
  }
  if (!ctx) throw new Error("이 브라우저에서는 그림을 읽을 수 없습니다");
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const data = ctx.getImageData(0, 0, width, height).data;
  const values = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < values.length; i++, j += 4) values[i] = data[j];
  return { width, height, values };
}

function base(ref: ScenarioRef): string {
  return `${ref.url_base ?? DATA_ROOT}/${ref.path}`;
}

const gridCache = new Map<string, Promise<DepthGrid>>();

/** 결과 하나의 최대 수심 격자 (depth2m/max.png) */
export function loadMaxDepthGrid(ref: ScenarioRef): Promise<DepthGrid> {
  const key = `${ref.url_base ?? ""}|${ref.path}|${ref.generated_at}`;
  let p = gridCache.get(key);
  if (!p) {
    p = (async () => {
      const r = await fetch(`${base(ref)}/depth2m/frames.json?v=${encodeURIComponent(ref.generated_at)}`, { cache: "no-cache" });
      if (!r.ok) throw new Error("이 결과에는 2 m 수심 이미지가 없어 차이 지도를 만들 수 없습니다");
      const info = (await r.json()) as Depth2mInfo;
      const file = info.max?.file ?? "depth2m/max.png";
      const img = await decodeGray(`${base(ref)}/${file}?v=${encodeURIComponent(info.generated_at ?? ref.generated_at)}`);
      if (img.width !== info.width || img.height !== info.height) throw new Error("수심 이미지 크기가 설명 파일과 다릅니다");
      return { width: img.width, height: img.height, bounds: info.bounds, step_m: info.encoding.step_m, values: img.values };
    })();
    p.catch(() => gridCache.delete(key));
    gridCache.set(key, p);
  }
  return p;
}

const maskCache = new Map<string, Promise<{ info: AreaInfo; values: Uint8Array } | null>>();

/** 2D 범위 (255 = 2D 셀 안). 없으면 null — 그때는 하천 물까지 들어간다는 것을 화면에 적는다 */
export function loadArea2d(version: string): Promise<{ info: AreaInfo; values: Uint8Array } | null> {
  let p = maskCache.get(version);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(`${DATA_ROOT}/${version}/area2d_2m.json`);
        if (!r.ok) return null;
        const info = (await r.json()) as AreaInfo;
        const img = await decodeGray(`${DATA_ROOT}/${version}/area2d_2m.png`);
        return { info, values: img.values };
      } catch {
        return null;
      }
    })();
    maskCache.set(version, p);
  }
  return p;
}

export interface DiffMap {
  result: DiffResult;
  url: string; // 지도에 얹을 그림 (blob 주소 — 다 쓰면 URL.revokeObjectURL)
  bounds: BBox;
  masked: boolean;
}

/** 두 결과 차이 지도: 분류·면적 + 지도용 그림 */
export async function makeDiffMap(version: string, a: ScenarioRef, b: ScenarioRef): Promise<DiffMap> {
  const [ga, gb, mask] = await Promise.all([loadMaxDepthGrid(a), loadMaxDepthGrid(b), loadArea2d(version)]);
  const useMask =
    mask && mask.info.width === ga.width && mask.info.height === ga.height && mask.values.length === ga.width * ga.height ? mask.values : null;
  const result = classifyDiff(ga, gb, useMask);
  const img = diffRGBA(result, 2);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("이 브라우저에서는 그림을 만들 수 없습니다");
  const data = ctx.createImageData(img.width, img.height);
  data.data.set(img.rgba);
  ctx.putImageData(data, 0, 0);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("차이 지도 그림을 만들지 못했습니다");
  return { result, url: URL.createObjectURL(blob), bounds: ga.bounds, masked: !!useMask };
}
