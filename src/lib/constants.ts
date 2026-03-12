// ============================================================
// Rendering performance thresholds
// ============================================================

/** Minimum vertical spacing (px) between leaves before thinning kicks in (rect layout) */
export const MIN_LEAF_PX = 0.1;

/** Minimum arc length (px) between leaves before thinning kicks in (circular/unrooted) */
export const MIN_ARC_PX = 0.1;

/** Skip vertical/horizontal segments shorter than this many px (rect layout) */
export const MIN_EDGE_PIXELS = 0.5;

/** Auto-collapse clades whose screen span is smaller than this (px) */
export const MIN_CLADE_PIXELS = 4;

/** Skip edge segments shorter than this many px (unrooted layout) */
export const MIN_SEG_PX = 2;

// ============================================================
// Layout geometry
// ============================================================

/** Canvas inner padding (px) */
export const PADDING = 40;

/** Gap between adjacent annotation tracks (px) */
export const TRACK_PADDING = 2;

/** Tree radius as a fraction of min(canvasWidth, canvasHeight) for circular/unrooted layouts */
export const CIRC_RADIUS_FRACTION = 0.45;

/** Pixels reserved on the right of the rect tree for leaf labels */
export const LABEL_RESERVE_PX = 150;
