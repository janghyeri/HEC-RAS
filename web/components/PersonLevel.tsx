// 사람 키(1.8 m) 그림 위에 물 높이를 그린다 — 범례·선택한 곳에 쓰는 "무릎·허리·키" 기준.
// viewBox 40×100, 발바닥 y=98, 키 1.8 m ≈ 92 단위 → 1 m ≈ 51 단위.

interface Props {
  depth: number; // m
  color: string;
  width?: number;
  height?: number;
  label?: string; // 있으면 그림으로 읽힘, 없으면 장식
}

export default function PersonLevel({ depth, color, width = 26, height = 64, label }: Props) {
  const wy = Math.max(0, 98 - depth * 51);
  return (
    <svg width={width} height={height} viewBox="0 0 40 100" {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      <rect x="0" y={wy} width="40" height={100 - wy} fill={color} opacity="0.92" />
      <circle cx="20" cy="13" r="7" fill="none" stroke="#1E2124" strokeWidth="3" />
      <path
        d="M20 20 L20 58 M8 44 L20 30 L32 44 M20 58 L12 96 M20 58 L28 96"
        fill="none"
        stroke="#1E2124"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="0" y1="98" x2="40" y2="98" stroke="#5F6B76" strokeWidth="2" />
    </svg>
  );
}
