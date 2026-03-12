import * as d3 from "d3";
import type { Tree, PolarCoord } from "./types";

// ============================================================
// Rectangular layout (phylogram or cladogram)
// ============================================================

/**
 * Assigns 2D coordinates to every node for the rectangular layout.
 * x = cumulative branch length (phylogram) or depth (cladogram)
 * y = leaf index (leaves) or midpoint of child range (internal nodes)
 */
export function layoutRectangular(
  tree: Tree,
  phylogram: boolean
): { coords: { x: number; y: number }[]; height: number; maxX: number } {
  const { nodes } = tree;
  const maxX = d3.max(nodes, (n) => (phylogram ? n.cumLen : n.depth)) || 1;

  const coords = new Array(nodes.length)
    .fill(0)
    .map(() => ({ x: 0, y: 0 }));

  for (const nd of nodes) {
    const x = phylogram ? nd.cumLen : nd.depth;
    const y = nd.isLeaf ? nd.leafIndex : (nd.L + nd.R - 1) / 2;
    coords[nd.id] = { x, y };
  }

  const height = tree.leaves.length > 0 ? tree.leaves.length - 1 : 1;
  return { coords, height, maxX };
}

// ============================================================
// Unrooted equal-angle layout
// ============================================================

/**
 * Computes 2D positions for all nodes using the equal-angle algorithm.
 * Each subtree is allocated an angular sector proportional to its leaf count.
 */
export function layoutUnrootedEqualAngle(
  tree: Tree,
  ignoreBranchLength: boolean
): { coords: PolarCoord[]; maxR: number } {
  const { nodes, root } = tree;

  const coords: PolarCoord[] = new Array(nodes.length)
    .fill(0)
    .map(() => ({ x: 0, y: 0, angle: 0, r: 0 }));

  const rootLeaves = (nodes[root] as any).leaves || tree.leaves.length || 1;
  const shift = (2 * Math.PI) / rootLeaves;

  function rec(u: number, baseAngle: number, px: number, py: number) {
    const node = nodes[u];
    const nodeLeaves = (node as any).leaves || 1;
    let a = baseAngle - (nodeLeaves * shift) / 2;

    // Sort children smallest→largest for a consistent layout
    const children = [...node.children];
    children.sort((aId, bId) => {
      const la = (nodes[aId] as any).leaves || 1;
      const lb = (nodes[bId] as any).leaves || 1;
      return la - lb;
    });

    for (const v of children) {
      const child = nodes[v];
      const vLeaves = (child as any).leaves || 1;
      const span = child.isLeaf ? 1 : vLeaves;
      const midAngle = a + (span * shift) / 2;
      const len = ignoreBranchLength ? 0.1 : child.length || 0.01;

      const x = px + len * Math.cos(midAngle);
      const y = py + len * Math.sin(midAngle);

      coords[v] = { x, y, angle: midAngle, r: Math.hypot(x, y) };

      if (!child.isLeaf) {
        rec(v, midAngle, x, y);
      }
      a += span * shift;
    }
  }

  coords[root] = { x: 0, y: 0, angle: 0, r: 0 };
  rec(root, 0, 0, 0);

  const maxR = d3.max(coords, (c) => c.r) || 1;
  return { coords, maxR };
}

// ============================================================
// Rectangular → Polar coordinate conversion (circular layout)
// ============================================================

/**
 * Maps a rectangular-layout coordinate to polar canvas coordinates.
 * Used to derive the circular layout from the rectangular one.
 *
 * @param xRect  Normalised x in [0, 1] (0 = root, 1 = tip)
 * @param yRect  Leaf index in [0, N)
 * @param N      Total number of leaves
 * @param R      Outer radius in canvas pixels
 * @param startAngleDeg  Start angle of the arc (degrees, clockwise from right)
 * @param arcDeg         Total arc swept by all leaves (degrees)
 */
export function rectToPolar(
  xRect: number,
  yRect: number,
  N: number,
  R: number,
  startAngleDeg: number,
  arcDeg: number
): { x: number; y: number; angle: number; radius: number } {
  const startAngleRad = (startAngleDeg * Math.PI) / 180;
  const arcRad = (arcDeg * Math.PI) / 180;
  const t = N > 0 ? (yRect + 0.5) / N : 0;
  const angle = startAngleRad - t * arcRad;
  const radius = xRect * R;
  return {
    x: radius * Math.cos(angle),
    y: radius * Math.sin(angle),
    angle,
    radius,
  };
}

