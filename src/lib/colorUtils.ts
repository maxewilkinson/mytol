// ============================================================
// General math helpers
// ============================================================

export function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ============================================================
// Color helpers
// ============================================================

/** FNV-1a hash for stable colour assignment from strings */
export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

export function lerpColor(c1: string, c2: string, t: number): string {
  const A = hexToRgb(c1);
  const B = hexToRgb(c2);
  return `rgb(${Math.round(lerp(A[0], B[0], t))},${Math.round(
    lerp(A[1], B[1], t)
  )},${Math.round(lerp(A[2], B[2], t))})`;
}

// ============================================================
// Geometry helpers
// ============================================================

/** Ray-casting point-in-polygon test (used for hull hit-testing in unrooted layout) */
export function isPointInPolygon(
  point: [number, number],
  polygon: [number, number][]
): boolean {
  const [x, y] = point;
  let isInside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect =
      (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) isInside = !isInside;
  }
  return isInside;
}

// ============================================================
// Categorical colour palette
// ============================================================

export const CAT_COLORS = [
  "#4e79a7",
  "#59a14f",
  "#e15759",
  "#f28e2b",
  "#76b7b2",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ab",
  "#a6cee3",
  "#b2df8a",
  "#fb9a99",
  "#fdbf6f",
  "#cab2d6",
  "#ffff99",
  "#1f78b4",
  "#33a02c",
  "#e31a1c",
  "#ff7f00",
];

/** Assigns a stable colour from CAT_COLORS based on string hash */
export function originalCategoryColor(cat?: string): string {
  if (!cat) return "#aaa";
  const i = Math.abs(hashString(cat)) % CAT_COLORS.length;
  return CAT_COLORS[i];
}
