// ============================================================
// Core tree types
// ============================================================

export type Node = {
  id: number;
  name?: string;
  parent: number | null;
  children: number[];
  length: number;
  support?: number;
  isLeaf: boolean;
  depth: number;
  cumLen: number;
  leafIndex: number;
  /** Index of leftmost leaf in subtree */
  L: number;
  /** Index one past the rightmost leaf in subtree */
  R: number;
  propCat?: string;
};

export type Tree = {
  nodes: Node[];
  root: number;
  leaves: number[];
  nameToNode: Map<string, number>;
};

// ============================================================
// Annotation types
// ============================================================

export type AnnotationRow = {
  id: string;
  [key: string]: any;
};

export type TrackConfig = {
  key: string;
  label: string;
  type: "categorical" | "continuous";
  height: number;
  maxVal?: number;
  visible: boolean;
};

// ============================================================
// UI state types
// ============================================================

export type ColoredRange = { nodeId: number; color: string; label?: string };

export type PolarCoord = { x: number; y: number; angle: number; r: number };

export type EditingColorInfo = {
  trackKey: string;
  category: string;
};
