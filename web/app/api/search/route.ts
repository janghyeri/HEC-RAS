// 주소·건물명 검색 — 브이월드 검색 API 2.0을 서버에서 대신 부른다 (브이월드 응답에 CORS 헤더가 없음, GUIDE §4.4.5).
// 키는 등록한 서비스 주소에서만 작동하므로 요청한 사이트 주소를 domain으로 넘긴다.
// 검색 범위(bbox)는 화면이 보낸 모의 범위(격자 경계)를 조금 넓혀 쓴다 — 지역 값을 코드에 적지 않는다.
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
// 브이월드는 국내에서 부르는 것이 안전하므로 서울 지역(icn1)에서 실행한다
export const preferredRegion = "icn1";

interface Hit {
  title: string;
  address: string;
  lon: number;
  lat: number;
}

type VwItem = {
  title?: string;
  category?: string;
  address?: { road?: string; parcel?: string; bldnm?: string } | string;
  point?: { x: string; y: string };
};

function parseBbox(s: string | null): string | null {
  if (!s) return null;
  const v = s.split(",").map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n))) return null;
  const [w, so, e, n] = v;
  if (!(w < e && so < n) || w < 120 || e > 135 || so < 30 || n > 40) return null;
  const pad = 0.05;
  return [w - pad, so - pad, e + pad, n + pad].map((n2) => n2.toFixed(4)).join(",");
}

async function vworld(params: Record<string, string>): Promise<VwItem[]> {
  const url = new URL("https://api.vworld.kr/req/search");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { cache: "no-store", headers: { Referer: params.domain ?? "" } });
  const text = await r.text();
  if (!r.ok) throw new Error(`vworld HTTP ${r.status} ${text.slice(0, 120)}`);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`vworld 응답이 JSON이 아님: ${text.slice(0, 120)}`);
  }
  const res = j?.response;
  if (res?.status === "NOT_FOUND") return [];
  if (res?.status !== "OK") throw new Error(`vworld ${res?.status ?? "?"} ${res?.error?.text ?? ""}`);
  return (res.result?.items ?? []) as VwItem[];
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const bbox = parseBbox(req.nextUrl.searchParams.get("bbox"));
  const key = process.env.VWORLD_KEY ?? process.env.NEXT_PUBLIC_VWORLD_KEY ?? "";
  if (q.length < 2 || q.length > 60) return NextResponse.json({ items: [], error: "검색어를 2자 이상 입력하세요" }, { status: 400 });
  if (!key) return NextResponse.json({ items: [], error: "검색을 쓸 수 없습니다 (배경지도 키 없음)" }, { status: 503 });

  const base: Record<string, string> = {
    service: "search",
    request: "search",
    version: "2.0",
    crs: "EPSG:4326",
    size: "8",
    page: "1",
    query: q,
    format: "json",
    errorformat: "json",
    key,
    domain: req.nextUrl.origin,
  };
  if (bbox) base.bbox = bbox;

  const kinds: Record<string, string>[] = [
    { type: "place" },
    { type: "address", category: "road" },
    { type: "address", category: "parcel" },
  ];
  const settled = await Promise.allSettled(kinds.map((k) => vworld({ ...base, ...k })));
  const seen = new Set<string>();
  const items: Hit[] = [];
  let failed = 0;
  const detail: string[] = [];
  for (const s of settled) {
    if (s.status === "rejected") {
      failed++;
      detail.push(String(s.reason instanceof Error ? s.reason.message : s.reason).replace(key, "***").slice(0, 200));
      continue;
    }
    for (const it of s.value) {
      const lon = Number(it.point?.x);
      const lat = Number(it.point?.y);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const k = `${lon.toFixed(5)},${lat.toFixed(5)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const a = typeof it.address === "string" ? { road: it.address } : it.address ?? {};
      items.push({
        title: it.title || a.bldnm || a.road || a.parcel || q,
        address: a.road || a.parcel || "",
        lon,
        lat,
      });
    }
  }
  if (failed === kinds.length)
    return NextResponse.json({ items: [], error: "검색 서비스에 연결하지 못했습니다", detail }, { status: 502 });
  return NextResponse.json({ items: items.slice(0, 8) }, { headers: { "Cache-Control": "public, s-maxage=3600" } });
}
