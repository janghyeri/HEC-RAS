"use client";

// 주소·건물명 검색 (브이월드, /api/search). 입력 후 Enter 또는 검색 버튼 → 결과 목록 → 고르면 지도가 그 자리로 간다.
import { useId, useState, type FormEvent } from "react";
import type { BBox } from "@/lib/data";

export interface Place {
  title: string;
  address: string;
  lon: number;
  lat: number;
}

interface Props {
  bbox: BBox | null;
  onSelect: (p: Place) => void;
  className?: string;
}

export default function SearchBox({ bbox, onSelect, className }: Props) {
  const id = useId();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Place[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const query = q.trim();
    if (query.length < 2) {
      setMsg("두 글자 이상 입력하세요");
      setItems(null);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const u = new URLSearchParams({ q: query });
      if (bbox) u.set("bbox", bbox.join(","));
      const r = await fetch(`/api/search?${u}`);
      const j = (await r.json()) as { items: Place[]; error?: string };
      setItems(j.items);
      if (j.error) setMsg(j.error);
      else if (!j.items.length) setMsg("포항 냉천 일대에서 찾은 곳이 없습니다");
    } catch {
      setItems(null);
      setMsg("검색하지 못했습니다. 잠시 뒤 다시 해 주세요");
    } finally {
      setBusy(false);
    }
  };

  const pick = (p: Place) => {
    setItems(null);
    setMsg(null);
    setQ(p.title);
    onSelect(p);
  };

  return (
    <div className={`search ${className ?? ""}`}>
      <form role="search" onSubmit={submit} className="search-box">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
        <label htmlFor={`${id}-q`} className="sr-only">
          주소 또는 건물명 검색
        </label>
        <input
          id={`${id}-q`}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="주소 또는 건물명으로 찾기"
          autoComplete="off"
          enterKeyHint="search"
        />
        <button type="submit" className="search-go" disabled={busy}>
          {busy ? "찾는 중" : "검색"}
        </button>
      </form>
      {(items?.length || msg) && (
        <div className="search-results" role="region" aria-live="polite" aria-label="검색 결과">
          {msg && <p className="muted small">{msg}</p>}
          {!!items?.length && (
            <ul>
              {items.map((p) => (
                <li key={`${p.lon},${p.lat}`}>
                  <button type="button" onClick={() => pick(p)}>
                    <strong>{p.title}</strong>
                    {p.address && p.address !== p.title && <span className="muted small">{p.address}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
