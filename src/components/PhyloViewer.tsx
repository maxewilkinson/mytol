import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import exampleNewick from "../../example/RTtree.nwk?raw";
import exampleCsv from "../../example/RTtreelabels.csv?raw";
import * as d3 from "d3";
import { HexColorPicker } from "react-colorful";

import {
  MIN_EDGE_PIXELS,
  MIN_SEG_PX,
  PADDING,
  TRACK_PADDING,
  CIRC_RADIUS_FRACTION,
  LABEL_RESERVE_PX,
} from "../lib/constants";
import type {
  Node,
  Tree,
  AnnotationRow,
  ColoredRange,
  PolarCoord,
  TrackConfig,
  EditingColorInfo,
} from "../lib/types";
import {
  clamp,
  lerp,
  hexToRgb,
  lerpColor,
  isPointInPolygon,
  originalCategoryColor,
} from "../lib/colorUtils";
import {
  parseNewick,
  pruneAst,
  buildTree,
  computeLeafCounts,
  ladderizeTree,
  rerootAtNode,
} from "../lib/treeUtils";
import {
  layoutRectangular,
  layoutUnrootedEqualAngle,
  rectToPolar,
} from "../lib/treeLayout";
import { parseAnnotations } from "../lib/parseAnnotations";

// ============================================================
// Categorical colour palettes
// ============================================================

const CATEGORICAL_PALETTES: { name: string; colors: string[] }[] = [
  { name: "Tableau 10",  colors: ["#4c78a8","#f58518","#e45756","#72b7b2","#54a24b","#eeca3b","#b279a2","#ff9da6","#9d755d","#bab0ac"] },
  { name: "Set1",        colors: ["#e41a1c","#377eb8","#4daf4a","#984ea3","#ff7f00","#a65628","#f781bf","#999999"] },
  { name: "Set2",        colors: ["#66c2a5","#fc8d62","#8da0cb","#e78ac3","#a6d854","#ffd92f","#e5c494","#b3b3b3"] },
  { name: "Dark2",       colors: ["#1b9e77","#d95f02","#7570b3","#e7298a","#66a61e","#e6ab02","#a6761d","#666666"] },
  { name: "Paired",      colors: ["#a6cee3","#1f78b4","#b2df8a","#33a02c","#fb9a99","#e31a1c","#ffdead","#ff7f00","#cab2d6","#6a3d9a","#ffff99","#b15928"] },
  { name: "Pastel",      colors: ["#fbb4ae","#b3cde3","#ccebc5","#decbe4","#fed9a6","#ffffcc","#e5d8bd","#fddaec","#f2f2f2"] },
];

// ============================================================
// Node fingerprint helpers — stable identifiers across tree rebuilds
// A fingerprint is "firstLeafName\x00lastLeafName" for the subtree.
// ============================================================

function nodeToFingerprint(tr: Tree, nodeId: number): string {
  const nd = tr.nodes[nodeId];
  const first = tr.nodes[tr.leaves[nd.L]].name ?? "";
  const last = tr.nodes[tr.leaves[nd.R - 1]].name ?? "";
  return `${first}\x00${last}`;
}

function fingerprintToNode(tr: Tree, fp: string): number | null {
  const sep = fp.indexOf("\x00");
  const firstName = fp.slice(0, sep);
  const lastName = fp.slice(sep + 1);
  const idA = tr.nameToNode.get(firstName);
  const idB = tr.nameToNode.get(lastName);
  if (idA === undefined || idB === undefined) return null;
  if (idA === idB) return idA;
  // LCA: collect ancestors of A, then walk up from B
  const pathA = new Set<number>();
  let cur: number | null = idA;
  while (cur !== null) { pathA.add(cur); cur = tr.nodes[cur].parent; }
  cur = idB;
  while (cur !== null) { if (pathA.has(cur)) return cur; cur = tr.nodes[cur].parent; }
  return null;
}

// ============================================================
// Component
// ============================================================

export default function Phylo() {
  // ------------ Data / annotations ------------

  const [newickFile, setNewickFile] = useState<File | null>(null);
  // Loaded annotation files. Each contributes its rows/columns to the merged
  // annotation map; users can stack multiple files and close them individually.
  const [annotationFiles, setAnnotationFiles] = useState<
    Array<{ name: string; rows: AnnotationRow[]; columns: string[] }>
  >([]);

  // Bug fix: store raw text so ladderize changes don't re-read from disk
  const [newickText, setNewickText] = useState<string | null>(null);

  const [tree, setTree] = useState<Tree | null>(null);
  const [annotations, setAnnotations] = useState<Map<string, AnnotationRow>>(
    new Map()
  );
  const [trackConfig, setTrackConfig] = useState<TrackConfig[]>([]);
  const [showTracks, setShowTracks] = useState(true);
  const [colorMaps, setColorMaps] = useState<Map<string, Map<string, string>>>(
    new Map()
  );
  const [showLegendKey, setShowLegendKey] = useState<string | null>(null);
  const [editingColor, setEditingColor] = useState<EditingColorInfo | null>(
    null
  );
  const [editingSupportSlot, setEditingSupportSlot] = useState<"low" | "mid" | "high" | null>(null);
  const [selectedPalette, setSelectedPalette] = useState(CATEGORICAL_PALETTES[0].name);

  // ------------ Track placement ------------

  const [trackOffset, setTrackOffset] = useState(6);
  const [trackOffsetMode, setTrackOffsetMode] = useState<"manual" | "auto">(
    "auto"
  );

  // ------------ Layout / view state ------------

  const [layout, setLayout] = useState<"rect" | "circular" | "unrooted">(
    "rect"
  );
  const [phylogram, setPhylogram] = useState<boolean>(true);

  const [vZoom, setVZoom] = useState(1); // vertical zoom (rect)
  const [gZoom, setGZoom] = useState(1); // global zoom (circular/unrooted)
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const [ranges, setRanges] = useState<ColoredRange[]>([]);
  const [activeRangeColor, setActiveRangeColor] = useState("#ffe08a");
  const [activeRangeLabel, setActiveRangeLabel] = useState("");
  const [showRangePanel, setShowRangePanel] = useState(false);
  const [rangeColorTrackKey, setRangeColorTrackKey] = useState<string | null>(null);
  const [editingRangeIndex, setEditingRangeIndex] = useState<number | null>(
    null
  );

  const [selectedNode, setSelectedNode] = useState<number | null>(null);

  const [collapsedNodes, setCollapsedNodes] = useState<Set<number>>(
    () => new Set()
  );
  // Leaf names removed from the tree entirely (triggers a tree rebuild).
  const [hiddenLeafNames, setHiddenLeafNames] = useState<Set<string>>(
    () => new Set()
  );

  const [showLeafLabels, setShowLeafLabels] = useState(true);

  const [ladderize, setLadderize] = useState<"none" | "asc" | "desc">("desc");
  const [rotation, setRotation] = useState(210);
  const [arc, setArc] = useState(350);
  const [hSpan, setHSpan] = useState<number>(0.0);
  const [lockHScale, setLocKHScale] = useState(false);

  // ------------ Support colouring ------------

  const [supportC0, setSupportC0] = useState("#e31919");
  const [supportC1, setSupportC1] = useState("#ffd424");
  const [supportC2, setSupportC2] = useState("#000000");
  const [supportV0, setSupportV0] = useState(0);
  const [supportV1, setSupportV1] = useState(0.5);
  const [supportV2, setSupportV2] = useState(1);
  const [supportAsPercent, setSupportAsPercent] = useState<boolean>(false);


  // ------------ Interaction / hover ------------

  const [hoverNode, setHoverNode] = useState<number | null>(null);
  const [hoverInfo, setHoverInfo] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(
    null
  );
  const [cursorStyle, setCursorStyle] = useState("grab");
  const [isDragOver, setIsDragOver] = useState(false);

  // ------------ Search UI ------------

  const [searchText, setSearchText] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestIx, setSuggestIx] = useState<number>(-1);
  const [showSuggests, setShowSuggests] = useState<boolean>(false);

  // ------------ Export / options ------------
  const [exportScale, setExportScale] = useState(2);

  // User-tunable rendering options
  const [optFontScale, setOptFontScale] = useState(1.0);
  const [optLodMinPx, setOptLodMinPx] = useState(1.5);
  const [optBranchThickness, setOptBranchThickness] = useState(1.5);
  const [optBarFill, setOptBarFill] = useState(1.0);
  const [optPctIncludeUnlabelled, setOptPctIncludeUnlabelled] = useState(false);
  const [optBackground, setOptBackground] = useState("#ffffff");
  const [optShowSupportLabels, setOptShowSupportLabels] = useState(false);
  const [optSupportColouring, setOptSupportColouring] = useState(true);
  const [optTaperBranches, setOptTaperBranches] = useState(true);
  const [rangeDisplayMode, setRangeDisplayMode] = useState<"background" | "branches">("background");

  const [panelVisible, setPanelVisible] = useState(true);
  const [sectionOpen, setSectionOpen] = useState({
    files: true, export: false, ranges: false, layout: true, tree: true, tracks: false, support: false, options: false,
  });
  const toggleSection = (key: keyof typeof sectionOpen) =>
    setSectionOpen((s) => ({ ...s, [key]: !s[key] }));

  // ------------ Refs ------------

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const wasDragging = useRef(false);

  // Pending remap: fingerprints saved before a hide/show-only rebuild so
  // collapsed nodes and ranges survive the tree rebuild.
  const remapCollapsedRef = useRef<string[]>([]);
  const remapRangesRef = useRef<Array<{ fp: string; color: string; label?: string }>>([]);
  const remapPendingRef = useRef(false);

  // ==========================================================
  // Derived layouts (memoised)
  // ==========================================================

  const rectLayout = useMemo(() => {
    if (!tree) return null;
    return layoutRectangular(tree, phylogram);
  }, [tree, phylogram]);

  const unrootedLayout = useMemo(() => {
    if (!tree) return null;
    return layoutUnrootedEqualAngle(tree, !phylogram);
  }, [tree, phylogram]);

  // Per-node branch width. Taper: width ∝ (cladeSize/N)^0.3, min 0.5×.
  // Memoised — only recomputes when tree topology or thickness options change, not on every pan/zoom.
  const nodeWidthPx = useMemo(() => {
    if (!tree) return new Float32Array(0);
    const { nodes, leaves } = tree;
    const N_leaves = leaves.length || 1;
    const arr = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      arr[i] = optTaperBranches
        ? optBranchThickness * Math.max(0.5, Math.pow((nd.R - nd.L) / N_leaves, 0.3))
        : optBranchThickness;
    }
    return arr;
  }, [tree, optTaperBranches, optBranchThickness]);

  // ==========================================================
  // Data loading
  // ==========================================================

  // Bug fix: separate file-reading from tree-building.
  // Effect 1: Read file bytes → store text. Resets view only on new file.
  useEffect(() => {
    if (!newickFile) return;
    newickFile.text().then((text) => {
      setNewickText(text);
      setVZoom(1);
      setGZoom(1);
      setOffset({ x: 0, y: 0 });
    });
  }, [newickFile]);

  // Effect 2: Parse + build tree from in-memory text.
  // Runs when text, ladderize, or hiddenLeafNames changes.
  // hiddenLeafNames prunes the AST before building so the layout is computed
  // on only the visible leaves — the tree genuinely looks as if those leaves
  // don't exist (correct spacing in all three layout modes).
  useEffect(() => {
    if (!newickText) return;
    try {
      const ast = parseNewick(newickText);
      const finalAst = hiddenLeafNames.size > 0
        ? (pruneAst(ast, hiddenLeafNames) ?? ast)
        : ast;
      const tr = buildTree(finalAst);
      computeLeafCounts(tr);
      if (ladderize !== "none") ladderizeTree(tr, ladderize);
      setTree(tr);
      // Remap collapsed nodes and ranges to new node IDs via leaf-name fingerprints.
      if (remapPendingRef.current) {
        remapPendingRef.current = false;
        const newCollapsed = new Set<number>();
        for (const fp of remapCollapsedRef.current) {
          const id = fingerprintToNode(tr, fp);
          if (id !== null) newCollapsed.add(id);
        }
        setCollapsedNodes(newCollapsed);
        const newRanges: ColoredRange[] = [];
        for (const r of remapRangesRef.current) {
          const id = fingerprintToNode(tr, r.fp);
          if (id !== null) newRanges.push({ nodeId: id, color: r.color, label: r.label });
        }
        setRanges(newRanges);
      }
    } catch (e) {
      console.error("Failed to parse Newick:", e);
    }
  }, [newickText, ladderize, hiddenLeafNames]);

  // When the set of hidden leaves changes, node IDs are remapped.
  // Only clear the selected node (its ID is no longer valid); collapsed nodes
  // and ranges are handled by the fingerprint remap above.
  useEffect(() => {
    setSelectedNode(null);
    setShowRangePanel(false);
  }, [hiddenLeafNames]);

  // Annotations: derive merged annotation map + track configs + colour maps
  // from the list of loaded files. Multiple files stack (later files overwrite
  // overlapping cells per id). User customisations on existing tracks/colours
  // are preserved when files are added or removed.
  useEffect(() => {
    // Merge rows by id across all files (later files override overlapping cells).
    const map = new Map<string, AnnotationRow>();
    for (const f of annotationFiles) {
      for (const r of f.rows) {
        const existing = map.get(r.id);
        if (existing) Object.assign(existing, r);
        else map.set(r.id, { ...r });
      }
    }
    setAnnotations(map);

    // Ordered union of columns across files (insertion order = load order).
    const allColumns: string[] = [];
    const seenCols = new Set<string>();
    for (const f of annotationFiles) {
      for (const c of f.columns) {
        if (!seenCols.has(c)) { seenCols.add(c); allColumns.push(c); }
      }
    }

    // Per-column type detection on merged rows.
    const rowsList = [...map.values()];
    const colMeta = new Map<string, { isContinuous: boolean; maxVal: number; cats: Set<string> }>();
    for (const col of allColumns) {
      let isContinuous = true;
      let maxVal = -Infinity;
      const cats = new Set<string>();
      for (const r of rowsList) {
        const val = r[col];
        if (val === null || val === undefined || val === "") continue;
        if (isContinuous) {
          const num = Number(val);
          if (isNaN(num)) isContinuous = false;
          else if (num > maxVal) maxVal = num;
        }
        if (!isContinuous) cats.add(val.toString());
      }
      colMeta.set(col, { isContinuous, maxVal: maxVal > 0 ? maxVal : 1, cats });
    }

    setTrackConfig(prev => {
      const prevByKey = new Map(prev.map(t => [t.key, t]));
      return allColumns.map(col => {
        const meta = colMeta.get(col)!;
        const existing = prevByKey.get(col);
        const desiredType = meta.isContinuous ? "continuous" : "categorical";
        if (existing && existing.type === desiredType) {
          if (existing.type === "continuous") {
            return { ...existing, maxVal: Math.max(existing.maxVal ?? 1, meta.maxVal) };
          }
          return existing;
        }
        if (meta.isContinuous) {
          return { key: col, label: col, type: "continuous" as const, height: 20, maxVal: meta.maxVal, visible: true };
        }
        return { key: col, label: col, type: "categorical" as const, height: 8, visible: true };
      });
    });

    setColorMaps(prev => {
      const next = new Map<string, Map<string, string>>();
      for (const col of allColumns) {
        const meta = colMeta.get(col)!;
        if (meta.isContinuous) continue;
        const old = prev.get(col);
        const colorMap = new Map<string, string>();
        for (const cat of meta.cats) {
          colorMap.set(cat, old?.get(cat) ?? originalCategoryColor(cat));
        }
        next.set(col, colorMap);
      }
      return next;
    });

    // Clear legend/colour-editor selections if their column went away.
    setShowLegendKey(prev => (prev && seenCols.has(prev) ? prev : null));
    setEditingColor(prev => (prev && seenCols.has(prev.trackKey) ? prev : null));
    setRangeColorTrackKey(prev => {
      if (prev && seenCols.has(prev)) {
        const meta = colMeta.get(prev);
        if (meta && !meta.isContinuous) return prev;
      }
      for (const col of allColumns) {
        if (!colMeta.get(col)!.isContinuous) return col;
      }
      return null;
    });
  }, [annotationFiles]);

  // Append an annotation file. Parses then pushes onto the file list — the
  // effect above rebuilds derived state.
  const addAnnotationFile = async (file: File) => {
    try {
      const { rows, columns } = await parseAnnotations(file);
      setAnnotationFiles(prev => [...prev, { name: file.name, rows, columns }]);
    } catch (e) {
      console.error("Failed to parse annotations:", e);
    }
  };

  const removeAnnotationFile = (idx: number) => {
    setAnnotationFiles(prev => prev.filter((_, i) => i !== idx));
  };

  // ==========================================================
  // Colouring helpers
  // ==========================================================

  function supportColor(val: number): string {
    let v = clamp(val, Math.min(supportV0, supportV2), Math.max(supportV0, supportV2));
    if (v <= supportV1) {
      const denom = supportV1 - supportV0;
      const t = denom > 0 ? (v - supportV0) / denom : 0;
      return lerpColor(supportC0, supportC1, t);
    } else {
      const denom = supportV2 - supportV1;
      const t = denom > 0 ? (v - supportV1) / denom : 0;
      return lerpColor(supportC1, supportC2, t);
    }
  }

  const getEffectiveTrackWidth = useCallback(() => {
    if (!showTracks) return 0;
    return d3.sum(
      trackConfig.filter((t) => t.visible),
      (t) => t.height + TRACK_PADDING
    );
  }, [trackConfig, showTracks]);

  // ==========================================================
  // Track positioning helpers (auto/manual)
  // ==========================================================

  // Computes the horizontal pixels-per-branch-length-unit for the rect layout.
  // In auto mode (hSpan === 0) the tree is sized to leave room for tracks + labels
  // so that both are always visible regardless of vertical zoom.
  function computeRectSx(W: number, maxX: number, trackWidth: number): number {
    const labelW = showLeafLabels ? LABEL_RESERVE_PX : 0;
    // 6px gap keeps leaf tips from touching the screen-space overlay
    const reserve = trackWidth + labelW + 6;
    if (hSpan > 0 && phylogram) return (W - 2 * PADDING - reserve) / hSpan;
    const treeAreaWidth = Math.max(50, W - 2 * PADDING - reserve);
    return maxX > 0 ? treeAreaWidth / maxX : treeAreaWidth;
  }

  // Track start position is simply the right edge of the tree plus an optional
  // manual offset — no need to scan visible leaves since sx already reserves space.
  function computeRectTrackStartX(W: number, sx: number, maxX: number): number {
    return -W / 2 + PADDING + sx * maxX + trackOffset;
  }

  function computeCircularTrackRadii(
    W: number,
    H: number,
    rectLayout: { coords: any[]; maxX: number },
    R: number,
    N: number,
    effectiveTrackWidth: number
  ): { trackStartRadius: number; trackOuterRadius: number } {
    const { coords, maxX } = rectLayout;
    const globalBaseRadius = R;

    if (!showTracks || trackOffsetMode === "manual") {
      const trackStartRadius = globalBaseRadius + trackOffset;
      return { trackStartRadius, trackOuterRadius: trackStartRadius + effectiveTrackWidth };
    }

    // AUTO: hug the outermost visible leaf radius
    let maxVisibleRadius = 0;
    const margin = 40;
    for (let i = 0; i < tree!.leaves.length; i++) {
      const leafId = tree!.leaves[i];
      const pRect = (coords as any)[leafId];
      if (!pRect) continue;
      const polar = rectToPolar(
        maxX > 0 ? pRect.x / maxX : 0,
        pRect.y,
        N,
        R,
        rotation,
        arc
      );
      const xScreen = W / 2 + offset.x + gZoom * polar.x;
      const yScreen = H / 2 + offset.y + gZoom * polar.y;
      if (xScreen < -margin || xScreen > W + margin || yScreen < -margin || yScreen > H + margin) continue;
      if (polar.radius > maxVisibleRadius) maxVisibleRadius = polar.radius;
    }

    const baseRadius = maxVisibleRadius > 0 ? maxVisibleRadius : globalBaseRadius;
    const trackStartRadius = baseRadius + trackOffset;
    return { trackStartRadius, trackOuterRadius: trackStartRadius + effectiveTrackWidth };
  }

  function computeUnrootedTrackRadii(
    W: number,
    H: number,
    unrootLayout: { coords: PolarCoord[]; maxR: number },
    R: number,
    effectiveTrackWidth: number
  ): { ringR: number; trackOuterRingR: number } {
    const { coords, maxR: computedMaxR } = unrootLayout;
    const globalBaseRadius = computedMaxR * R;

    if (!showTracks || trackOffsetMode === "manual") {
      const ringR = globalBaseRadius + trackOffset;
      return { ringR, trackOuterRingR: ringR + effectiveTrackWidth };
    }

    // AUTO: hug the outermost visible leaf
    let maxVisibleRadius = 0;
    const margin = 40;
    for (let i = 0; i < tree!.leaves.length; i++) {
      const leafId = tree!.leaves[i];
      const p = coords[leafId];
      if (!p) continue;
      const xScreen = W / 2 + offset.x + gZoom * (p.x * R);
      const yScreen = H / 2 + offset.y + gZoom * (p.y * R);
      if (xScreen < -margin || xScreen > W + margin || yScreen < -margin || yScreen > H + margin) continue;
      const rLeaf = Math.hypot(p.x * R, p.y * R);
      if (rLeaf > maxVisibleRadius) maxVisibleRadius = rLeaf;
    }

    const baseRadius = maxVisibleRadius > 0 ? maxVisibleRadius : globalBaseRadius;
    const ringR = baseRadius + trackOffset;
    return { ringR, trackOuterRingR: ringR + effectiveTrackWidth };
  }

  // ==========================================================
  // Rendering — main draw dispatcher
  // ==========================================================

  // draw() is a plain function (not useCallback). It is only ever called from
  // the useEffect below, which captures the latest closure on every render, so
  // stale-closure issues do not arise in practice.
  function draw() {
    const canvas = canvasRef.current;
    const cont = containerRef.current;
    if (!canvas || !cont || !tree) return;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

    const W = cont.clientWidth;
    const H = cont.clientHeight;

    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    ctx.fillStyle = optBackground;
    ctx.fillRect(0, 0, W, H);
    ctx.save();

    ctx.translate(W / 2 + offset.x, H / 2 + offset.y);
    if (layout === "rect") ctx.scale(1, vZoom);
    else ctx.scale(gZoom, gZoom);

    // World-space viewport bounds for cheap culling
    let worldXMin: number, worldXMax: number, worldYMin: number, worldYMax: number;
    if (layout === "rect") {
      worldXMin = -W / 2 - offset.x;
      worldXMax = W / 2 - offset.x;
      worldYMin = (-H / 2 - offset.y) / vZoom;
      worldYMax = (H / 2 - offset.y) / vZoom;
    } else {
      worldXMin = (-W / 2 - offset.x) / gZoom;
      worldXMax = (W / 2 - offset.x) / gZoom;
      worldYMin = (-H / 2 - offset.y) / gZoom;
      worldYMax = (H / 2 - offset.y) / gZoom;
    }
    const worldCullMargin = 10 / (layout === "rect" ? vZoom : gZoom);
    function worldVisible(x: number, y: number): boolean {
      return (
        x >= worldXMin - worldCullMargin &&
        x <= worldXMax + worldCullMargin &&
        y >= worldYMin - worldCullMargin &&
        y <= worldYMax + worldCullMargin
      );
    }

    const nodes = tree.nodes;
    const leaves = tree.leaves;
    const treeRoot = tree.root;
    const effectiveTrackWidth = getEffectiveTrackWidth();

    if (!rectLayout) { ctx.restore(); return; }

    const { coords: rectCoords, height: rectHeight, maxX: rectMaxX } = rectLayout;

    const sx = computeRectSx(W, rectMaxX, effectiveTrackWidth);
    const sy = (H - 2 * PADDING) / Math.max(1, rectHeight);

    // Visible leaf index range (rect only, for culling)
    let visibleLeafStart = 0;
    let visibleLeafEnd = tree.leaves.length;
    if (layout === "rect") {
      const topWy = (0 - H / 2 - offset.y) / vZoom;
      const bottomWy = (H - H / 2 - offset.y) / vZoom;
      const rawTopIdx = (topWy + H / 2 - PADDING) / sy;
      const rawBottomIdx = (bottomWy + H / 2 - PADDING) / sy;
      visibleLeafStart = clamp(Math.floor(rawTopIdx) - 1, 0, tree.leaves.length);
      visibleLeafEnd = clamp(Math.ceil(rawBottomIdx) + 1, 0, tree.leaves.length);
      if (visibleLeafEnd < visibleLeafStart)
        [visibleLeafStart, visibleLeafEnd] = [visibleLeafEnd, visibleLeafStart];
    }

    const trackStartX = computeRectTrackStartX(W, sx, rectMaxX);
    const trackRightEdgeX = trackStartX + effectiveTrackWidth;

    // skipNode: 0 = draw normally, 1 = draw as collapsed triangle/wedge, 2 = skip entirely.
    // Propagates manual collapse (collapsedNodes) and hide (hiddenNodes) to all descendants.
    // Applied in all three layout draw functions.
    const skipNode = new Uint8Array(nodes.length);
    {
      const stack = [treeRoot];
      while (stack.length) {
        const id = stack.pop()!;
        if (skipNode[id] === 2) continue;
        const nd = nodes[id];
        if (id !== treeRoot && collapsedNodes.has(id)) {
          skipNode[id] = 1;
          for (const ch of nd.children) {
            const inner = [ch];
            while (inner.length) {
              const u = inner.pop()!;
              skipNode[u] = 2;
              for (const c of nodes[u].children) inner.push(c);
            }
          }
          continue;
        }
        for (const ch of nd.children) stack.push(ch);
      }
    }

    // Per-node range colour map for "branches" display mode.
    // Processes ranges largest→smallest so innermost range wins.
    const nodeRangeColor = new Map<number, string>();
    if (rangeDisplayMode === "branches" && ranges.length > 0) {
      const sorted = [...ranges].sort(
        (a, b) => (nodes[b.nodeId].R - nodes[b.nodeId].L) - (nodes[a.nodeId].R - nodes[a.nodeId].L)
      );
      for (const r of sorted) {
        const stk = [r.nodeId];
        while (stk.length) {
          const id = stk.pop()!;
          nodeRangeColor.set(id, r.color);
          for (const ch of nodes[id].children) stk.push(ch);
        }
      }
    }

    // Branch colour: range override → support colour → default
    const nodeColor = (id: number, support?: number): string =>
      nodeRangeColor.get(id) ?? (optSupportColouring && support !== undefined ? supportColor(support) : "#333");

    // ------ Highlight helpers (defined here to close over shared vars) ------

    const drawHoverHighlightRect = () => {
      if (hoverNode === null || hoverNode === selectedNode || showRangePanel) return;
      const nd = nodes[hoverNode];
      const a = (rectCoords as any)[nd.id];
      const xNode = -W / 2 + PADDING + sx * a.x;
      const y1 = -H / 2 + PADDING + sy * nd.L;
      const y2 = -H / 2 + PADDING + sy * (nd.R - 1) + sy;
      const grad = ctx.createLinearGradient(xNode, 0, trackRightEdgeX, 0);
      grad.addColorStop(0, "rgba(80,140,255,0.35)");
      grad.addColorStop(1, "rgba(80,140,255,0.2)");
      ctx.fillStyle = grad;
      ctx.fillRect(xNode, y1, trackRightEdgeX - xNode, y2 - y1);
      const gradL = ctx.createLinearGradient(-W / 2, 0, xNode, 0);
      gradL.addColorStop(1, "rgba(80,140,255,0.06)");
      gradL.addColorStop(0, "rgba(80,140,255,0.0)");
      ctx.fillStyle = gradL;
      ctx.fillRect(-W / 2, y1, xNode - -W / 2, y2 - y1);
    };

    const drawSelectHighlightRect = () => {
      if (selectedNode === null) return;
      const color = showRangePanel ? activeRangeColor : "#FF8200";
      const [r, g, b] = hexToRgb(color);
      const alpha1 = showRangePanel ? 0.55 : 0.4;
      const alpha2 = showRangePanel ? 0.4 : 0.25;
      const nd = nodes[selectedNode];
      const a = (rectCoords as any)[nd.id];
      const xNode = -W / 2 + PADDING + sx * a.x;
      const y1 = -H / 2 + PADDING + sy * nd.L;
      const y2 = -H / 2 + PADDING + sy * (nd.R - 1) + sy;
      ctx.shadowColor = `rgba(${r},${g},${b},0.5)`;
      ctx.shadowBlur = 10;
      const grad = ctx.createLinearGradient(xNode, 0, trackRightEdgeX, 0);
      grad.addColorStop(0, `rgba(${r},${g},${b},${alpha1})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},${alpha2})`);
      ctx.fillStyle = grad;
      ctx.fillRect(xNode, y1, trackRightEdgeX - xNode, y2 - y1);
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
      const gradL = ctx.createLinearGradient(-W / 2, 0, xNode, 0);
      gradL.addColorStop(1, `rgba(${r},${g},${b},0.1)`);
      gradL.addColorStop(0, `rgba(${r},${g},${b},0.0)`);
      ctx.fillStyle = gradL;
      ctx.fillRect(-W / 2, y1, xNode - -W / 2, y2 - y1);
      // Bold left-edge bar
      ctx.fillStyle = `rgba(${r},${g},${b},0.85)`;
      ctx.fillRect(xNode - 1, y1, 2, y2 - y1);
    };

    const drawHoverHighlightCirc = () => {
      if (hoverNode === null || hoverNode === selectedNode || showRangePanel) return;
      const N = leaves.length || 1;
      const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
      const nd = nodes[hoverNode];
      const a0 = (rotation * Math.PI) / 180 - (nd.L / N) * ((arc * Math.PI) / 180);
      const a1 = (rotation * Math.PI) / 180 - (nd.R / N) * ((arc * Math.PI) / 180);
      const aRect = (rectCoords as any)[nd.id];
      const rNode = rectToPolar(rectMaxX > 0 ? aRect.x / rectMaxX : 0, aRect.y, N, R, rotation, arc).radius;
      const { trackOuterRadius } = computeCircularTrackRadii(W, H, { coords: rectCoords as any[], maxX: rectMaxX }, R, N, effectiveTrackWidth);
      const steps = 8;
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = (i + 1) / steps;
        const r0 = rNode + t0 * (trackOuterRadius - rNode);
        const r1 = rNode + t1 * (trackOuterRadius - rNode);
        const alpha = lerp(0.35, 0.2, t0);
        ctx.beginPath();
        ctx.arc(0, 0, r1, a1, a0, false);
        ctx.arc(0, 0, r0, a0, a1, true);
        ctx.closePath();
        ctx.fillStyle = `rgba(80,140,255,${alpha.toFixed(3)})`;
        ctx.fill();
      }
    };

    const drawSelectHighlightCirc = () => {
      if (selectedNode === null) return;
      const color = showRangePanel ? activeRangeColor : "#FF8200";
      const [r, g, b] = hexToRgb(color);
      const alphaStart = showRangePanel ? 0.55 : 0.4;
      const alphaEnd = showRangePanel ? 0.4 : 0.25;
      const N = leaves.length || 1;
      const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
      const nd = nodes[selectedNode];
      const a0 = (rotation * Math.PI) / 180 - (nd.L / N) * ((arc * Math.PI) / 180);
      const a1 = (rotation * Math.PI) / 180 - (nd.R / N) * ((arc * Math.PI) / 180);
      const aRect = (rectCoords as any)[nd.id];
      const rNode = rectToPolar(rectMaxX > 0 ? aRect.x / rectMaxX : 0, aRect.y, N, R, rotation, arc).radius;
      const { trackOuterRadius } = computeCircularTrackRadii(W, H, { coords: rectCoords as any[], maxX: rectMaxX }, R, N, effectiveTrackWidth);
      ctx.shadowColor = `rgba(${r},${g},${b},0.5)`;
      ctx.shadowBlur = 10;
      const steps = 8;
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = (i + 1) / steps;
        const r0 = rNode + t0 * (trackOuterRadius - rNode);
        const r1 = rNode + t1 * (trackOuterRadius - rNode);
        const alpha = lerp(alphaStart, alphaEnd, t0);
        ctx.beginPath();
        ctx.arc(0, 0, r1, a1, a0, false);
        ctx.arc(0, 0, r0, a0, a1, true);
        ctx.closePath();
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
    };


    const drawHoverHighlightUnrooted = () => {
      if (hoverNode === null || hoverNode === selectedNode || showRangePanel) return;
      if (!unrootedLayout) return;
      const { coords, maxR: computedMaxR } = unrootedLayout;
      const R = (Math.min(W, H) * CIRC_RADIUS_FRACTION) / (computedMaxR || 1);
      const nd = nodes[hoverNode];
      const { ringR } = computeUnrootedTrackRadii(W, H, { coords, maxR: computedMaxR }, R, effectiveTrackWidth);
      const points: [number, number][] = [];
      for (let i = nd.L; i < nd.R; i++) {
        const leafId = leaves[i];
        // Leaf tip — anchors the hull to the tree geometry
        points.push([coords[leafId].x * R, coords[leafId].y * R]);
        // Inner ring edge at the branch angle — hull touches but doesn't overlap annotations
        const angle = coords[leafId].angle;
        points.push([ringR * Math.cos(angle), ringR * Math.sin(angle)]);
      }
      points.push([coords[nd.id].x * R, coords[nd.id].y * R]);
      const hull = d3.polygonHull(points);
      if (!hull) return;
      ctx.beginPath();
      ctx.moveTo(hull[0][0], hull[0][1]);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i][0], hull[i][1]);
      ctx.closePath();
      ctx.fillStyle = "rgba(80,140,255,0.25)";
      ctx.fill();
    };

    const drawSelectHighlightUnrooted = () => {
      if (selectedNode === null || !unrootedLayout) return;
      const color = showRangePanel ? activeRangeColor : "#FF8200";
      const [r, g, b] = hexToRgb(color);
      const alpha = showRangePanel ? 0.45 : 0.3;
      const { coords, maxR: computedMaxR } = unrootedLayout;
      const R = (Math.min(W, H) * CIRC_RADIUS_FRACTION) / (computedMaxR || 1);
      const nd = nodes[selectedNode];
      const { ringR } = computeUnrootedTrackRadii(W, H, { coords, maxR: computedMaxR }, R, effectiveTrackWidth);
      const points: [number, number][] = [];
      for (let i = nd.L; i < nd.R; i++) {
        const leafId = leaves[i];
        points.push([coords[leafId].x * R, coords[leafId].y * R]);
        const angle = coords[leafId].angle;
        points.push([ringR * Math.cos(angle), ringR * Math.sin(angle)]);
      }
      points.push([coords[nd.id].x * R, coords[nd.id].y * R]);
      const hull = d3.polygonHull(points);
      if (!hull) return;
      ctx.beginPath();
      ctx.moveTo(hull[0][0], hull[0][1]);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i][0], hull[i][1]);
      ctx.closePath();
      ctx.shadowColor = `rgba(${r},${g},${b},0.5)`;
      ctx.shadowBlur = 10;
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${r},${g},${b},0.7)`;
      ctx.lineWidth = 1.5 / gZoom;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
    };

    // ---- Per-layout draw functions ----

    function drawRectLayout() {
      // Coloured ranges (background mode only)
      for (const r of ranges) {
        if (rangeDisplayMode !== "background") continue;
        const nd = nodes[r.nodeId];
        const a = (rectCoords as any)[nd.id];
        const xNode = -W / 2 + PADDING + sx * a.x;
        const y1 = -H / 2 + PADDING + sy * nd.L;
        const y2 = -H / 2 + PADDING + sy * (nd.R - 1) + sy;
        ctx.fillStyle = r.color + "55";
        ctx.fillRect(xNode, y1, trackRightEdgeX - xNode, y2 - y1);
      }

      for (const nd of nodes) {
        if (skipNode[nd.id] === 2) continue;
        if (nd.R <= visibleLeafStart || nd.L >= visibleLeafEnd) continue;

        const a = (rectCoords as any)[nd.id];
        const xp = -W / 2 + PADDING + sx * a.x;
        const yp = -H / 2 + PADDING + sy * a.y;

        // Auto-collapse when clade is too small to see (but not if manually collapsed)
        if (nd.id !== treeRoot && skipNode[nd.id] === 0) {
          const cladePx = (nd.R - nd.L) * sy * vZoom;
          if (cladePx < optLodMinPx && optLodMinPx > 0) continue;
        }

        // Draw triangle for manually collapsed nodes
        if (skipNode[nd.id] === 1) {
          const yTop = -H / 2 + PADDING + sy * nd.L;
          const yBot = -H / 2 + PADDING + sy * (nd.R - 1) + sy;
          const yMid = (yTop + yBot) / 2;
          const triLen = Math.min((nd.R - nd.L) * sy * 0.4, 60 / vZoom);
          ctx.beginPath();
          ctx.moveTo(xp, yMid);
          ctx.lineTo(xp + triLen, yTop);
          ctx.lineTo(xp + triLen, yBot);
          ctx.closePath();
          ctx.fillStyle = "rgba(100,100,100,0.18)";
          ctx.fill();
          ctx.strokeStyle = "#666";
          ctx.lineWidth = 1 / vZoom;
          ctx.stroke();
          continue;
        }

        if (nd.id === treeRoot) {
          ctx.fillStyle = "#000";
          ctx.beginPath();
          ctx.arc(xp, yp, 3 / vZoom, 0, 2 * Math.PI);
          ctx.fill();
        }

        const color_P = nodeColor(nd.id, nd.support);
        const lw_P = nodeWidthPx[nd.id];

        for (const ch of nd.children) {
          const b = (rectCoords as any)[ch];
          const xc = -W / 2 + PADDING + sx * b.x;
          const yc = -H / 2 + PADDING + sy * b.y;

          const color_C = nodeColor(ch, nodes[ch].support);
          const lw_C = nodeWidthPx[ch];

          // Vertical segment
          if (Math.abs(yc - yp) * vZoom >= MIN_EDGE_PIXELS) {
            ctx.fillStyle = color_P;
            const rw = lw_P;
            if (yp < yc) ctx.fillRect(xp - rw / 2, yp, rw, yc - yp);
            else ctx.fillRect(xp - rw / 2, yc, rw, yp - yc);
          }

          // Horizontal segment
          if (Math.abs(xc - xp) >= MIN_EDGE_PIXELS) {
            ctx.fillStyle = color_C;
            const rh = lw_C / vZoom;
            if (xp < xc) ctx.fillRect(xp, yc - rh / 2, xc - xp, rh);
            else ctx.fillRect(xc, yc - rh / 2, xp - xc, rh);
          }

          // Round elbow: filled ellipse at the corner compensates for vZoom Y-stretch
          ctx.beginPath();
          ctx.ellipse(xp, yc, lw_P / 2, lw_P / (2 * Math.max(vZoom, 0.01)), 0, 0, 2 * Math.PI);
          ctx.fillStyle = color_P;
          ctx.fill();
        }
      }

    }
    // Tracks and labels for rect layout are drawn as screen-space overlays after ctx.restore().

    function drawCircularLayout() {
      const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
      const N = leaves.length || 1;
      const startAngleDeg = rotation;
      const arcDeg = arc;

      const { trackStartRadius, trackOuterRadius } = computeCircularTrackRadii(
        W, H, { coords: rectCoords as any[], maxX: rectMaxX }, R, N, effectiveTrackWidth
      );

      // Coloured ranges (background mode only)
      for (const r of ranges) {
        if (rangeDisplayMode !== "background") continue;
        const nd = nodes[r.nodeId];
        const a0 = (startAngleDeg * Math.PI) / 180 - (nd.L / N) * ((arcDeg * Math.PI) / 180);
        const a1 = (startAngleDeg * Math.PI) / 180 - (nd.R / N) * ((arcDeg * Math.PI) / 180);
        const aRect = (rectCoords as any)[nd.id];
        const rNode = rectToPolar(rectMaxX > 0 ? aRect.x / rectMaxX : 0, aRect.y, N, R, startAngleDeg, arcDeg).radius;
        ctx.beginPath();
        ctx.arc(0, 0, trackOuterRadius, a1, a0, false);
        ctx.arc(0, 0, Math.max(0, rNode), a0, a1, true);
        ctx.closePath();
        ctx.fillStyle = r.color + "55";
        ctx.fill();
      }

      // Root dot
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.arc(0, 0, 3 / gZoom, 0, 2 * Math.PI);
      ctx.fill();

      const drawShortArc = (radius: number, a1: number, a2: number) => {
        let start = a1, end = a2;
        let da = end - start;
        if (da > Math.PI) { end -= 2 * Math.PI; da = end - start; }
        else if (da < -Math.PI) { end += 2 * Math.PI; da = end - start; }
        ctx.arc(0, 0, radius, start, end, da < 0);
      };

      const arcRad = (arcDeg * Math.PI) / 180;
      const anglePerLeaf = N > 0 ? arcRad / N : 0;

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Edges
      for (const nd of nodes) {
        if (skipNode[nd.id] === 2) continue;
        // Auto-collapse when arc is too small to see
        if (nd.id !== treeRoot && skipNode[nd.id] === 0) {
          const cladeArcLenPx = (nd.R - nd.L) * anglePerLeaf * trackOuterRadius * gZoom;
          if (cladeArcLenPx < optLodMinPx && optLodMinPx > 0) continue;
        }
        // Draw wedge for manually collapsed nodes
        if (skipNode[nd.id] === 1) {
          const a0 = (startAngleDeg * Math.PI) / 180 - (nd.L / N) * arcRad;
          const a1 = (startAngleDeg * Math.PI) / 180 - (nd.R / N) * arcRad;
          const aRect = (rectCoords as any)[nd.id];
          const rNode = rectToPolar(rectMaxX > 0 ? aRect.x / rectMaxX : 0, aRect.y, N, R, startAngleDeg, arcDeg).radius;
          const wedgeR = rNode + Math.min((nd.R - nd.L) * anglePerLeaf * R * 0.4, 40 / gZoom);
          ctx.beginPath();
          ctx.arc(0, 0, wedgeR, a1, a0, false);
          ctx.arc(0, 0, Math.max(0, rNode), a0, a1, true);
          ctx.closePath();
          ctx.fillStyle = "rgba(100,100,100,0.18)";
          ctx.fill();
          ctx.strokeStyle = "#666";
          ctx.lineWidth = 1 / gZoom;
          ctx.stroke();
          continue;
        }
        const aRect = (rectCoords as any)[nd.id];
        const P = rectToPolar(rectMaxX > 0 ? aRect.x / rectMaxX : 0, aRect.y, N, R, startAngleDeg, arcDeg);
        if (!worldVisible(P.x, P.y)) continue;

        const color_P = nodeColor(nd.id, nd.support);
        const lw_P = nodeWidthPx[nd.id] / gZoom;

        for (const ch of nd.children) {
          const bRect = (rectCoords as any)[ch];
          const C = rectToPolar(rectMaxX > 0 ? bRect.x / rectMaxX : 0, bRect.y, N, R, startAngleDeg, arcDeg);
          if (!worldVisible(P.x, P.y) && !worldVisible(C.x, C.y)) continue;

          const color_C = nodeColor(ch, nodes[ch].support);
          const lw_C = nodeWidthPx[ch] / gZoom;

          if (P.radius > 0) {
            ctx.beginPath();
            ctx.moveTo(P.x, P.y);
            drawShortArc(P.radius, P.angle, C.angle);
            ctx.strokeStyle = color_P;
            ctx.lineWidth = lw_P;
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.moveTo(P.radius * Math.cos(C.angle), P.radius * Math.sin(C.angle));
          ctx.lineTo(C.x, C.y);
          ctx.strokeStyle = color_C;
          ctx.lineWidth = lw_C;
          ctx.stroke();
        }
      }

      // Annotation tracks are drawn as a screen-space overlay after ctx.restore() below.

      // Leaf labels (circular)
      if (showLeafLabels) {
        const labelR = trackStartRadius + effectiveTrackWidth / gZoom + 6 / gZoom;
        const arcPerLeaf = N > 0 ? ((arcDeg * Math.PI) / 180) / N : 0;
        const labelSpacingPx = labelR * arcPerLeaf * gZoom;
        if (labelSpacingPx >= 6) {
          const fontSize = Math.min(Math.floor(labelSpacingPx * 0.75 * optFontScale), 13 * optFontScale);
          ctx.save();
          ctx.font = `${fontSize / gZoom}px sans-serif`;
          ctx.textBaseline = "middle";
          for (let i = 0; i < leaves.length; i++) {
            const leafId = leaves[i];
            if (skipNode[leafId] === 2) continue;
            const name = nodes[leafId].name;
            if (!name) continue;
            const pRect = (rectCoords as any)[leafId];
            const { angle } = rectToPolar(rectMaxX > 0 ? pRect.x / rectMaxX : 0, pRect.y, N, R, startAngleDeg, arcDeg);
            const lx = labelR * Math.cos(angle);
            const ly = labelR * Math.sin(angle);
            if (!worldVisible(lx, ly)) continue;
            ctx.fillStyle = nodeRangeColor.get(leafId) ?? "#222";
            ctx.save();
            ctx.translate(lx, ly);
            const cosA = Math.cos(angle);
            if (cosA >= 0) { ctx.rotate(angle); ctx.textAlign = "left"; }
            else { ctx.rotate(angle + Math.PI); ctx.textAlign = "right"; }
            ctx.fillText(name, 0, 0);
            ctx.restore();
          }
          ctx.restore();
        }
      }
    }

    function drawUnrootedLayout() {
      if (!unrootedLayout) return;
      const { coords, maxR: computedMaxR } = unrootedLayout;
      const R = (Math.min(W, H) * CIRC_RADIUS_FRACTION) / (computedMaxR || 1);

      const { ringR, trackOuterRingR } = computeUnrootedTrackRadii(W, H, { coords, maxR: computedMaxR }, R, effectiveTrackWidth);

      const N = leaves.length || 1;
      const anglePerLeaf = N > 0 ? (2 * Math.PI) / N : 0;

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Edges
      for (const nd of nodes) {
        if (skipNode[nd.id] === 2) continue;
        // Auto-collapse when arc too small to see
        if (nd.id !== treeRoot && skipNode[nd.id] === 0) {
          const cladeArcLenPx = (nd.R - nd.L) * anglePerLeaf * trackOuterRingR * gZoom;
          if (cladeArcLenPx < optLodMinPx && optLodMinPx > 0) continue;
        }
        // Small filled circle to mark manually collapsed subtrees in unrooted layout
        if (skipNode[nd.id] === 1) {
          const px = coords[nd.id].x * R, py = coords[nd.id].y * R;
          const r = Math.max(3, Math.min((nd.R - nd.L) * anglePerLeaf * trackOuterRingR * 0.15, 12)) / gZoom;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, 2 * Math.PI);
          ctx.fillStyle = "rgba(100,100,100,0.35)";
          ctx.fill();
          ctx.strokeStyle = "#666";
          ctx.lineWidth = nodeWidthPx[nd.id] / gZoom;
          ctx.stroke();
          continue;
        }
        for (const ch of nd.children) {
          const ax = coords[nd.id].x * R, ay = coords[nd.id].y * R;
          const bx = coords[ch].x * R, by = coords[ch].y * R;
          if (!worldVisible(ax, ay) && !worldVisible(bx, by)) continue;
          const segLenPx = Math.hypot((bx - ax) * gZoom, (by - ay) * gZoom);
          if (segLenPx <= MIN_SEG_PX) continue;
          const sup = nodes[ch].support;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.strokeStyle = nodeColor(ch, sup);
          ctx.lineWidth = nodeWidthPx[ch] / gZoom;
          ctx.stroke();
        }
      }

      // Annotation tracks — arc-segment ring.
      // coords[leafId].angle is the equal-angle BRANCH direction: the angle at
      // which the branch leading to this leaf points.  This is what the user
      // perceives as the leaf's angular position (looking at the branch).  It is
      // guaranteed non-overlapping and in the correct visual order by the
      // equal-angle algorithm.  atan2(y,x) is the direction to the leaf TIP —
      // different for non-radial trees and produces scrambled arc order.
      // LOD thinning keeps this O(screen_pixels) even at 1M leaves.
      if (showTracks) {
        // Collect and sort by equal-angle assigned direction (visual order)
        const sortedLeafIds = leaves
          .filter(id => skipNode[id] !== 2)
          .slice()
          .sort((a, b) => coords[a].angle - coords[b].angle);

        if (sortedLeafIds.length > 0) {
          const arcPerLeaf = (2 * Math.PI) / sortedLeafIds.length;
          let currentR = ringR;

          for (const track of trackConfig) {
            if (!track.visible) { currentR += track.height + TRACK_PADDING; continue; }
            const r1 = currentR, r2 = r1 + track.height;
            const arcPx = r1 * arcPerLeaf * gZoom;
            const leafStep = Math.max(1, Math.floor(optLodMinPx / Math.max(arcPx, 1e-9)));

            // Batch arc segments by colour — one fill() per distinct colour
            const colorSegs = new Map<string, Array<[number, number]>>();
            for (let i = 0; i < sortedLeafIds.length; i += leafStep) {
              const leafIdA = sortedLeafIds[i];
              const leafIdB = sortedLeafIds[(i + leafStep) % sortedLeafIds.length];
              const nd = nodes[leafIdA];
              const row = annotations.get(nd.name || "");
              const val = row ? row[track.key] : undefined;
              if (val === null || val === undefined || val === "") continue;

              let color: string;
              if (track.type === "categorical") {
                color = colorMaps.get(track.key)?.get(val.toString()) ?? "#aaa";
              } else {
                const num = Number(val);
                if (isNaN(num)) continue;
                const t = Math.min(1, Math.max(0, num / (track.maxVal || 1)));
                color = `rgba(80,80,80,${(0.1 + t * 0.85).toFixed(2)})`;
              }

              const a1 = coords[leafIdA].angle;
              const a2raw = coords[leafIdB].angle;
              const a2 = a2raw > a1 ? a2raw : a2raw + 2 * Math.PI;
              const midA = (a1 + a2) / 2;
              if (!worldVisible(r1 * Math.cos(midA), r1 * Math.sin(midA))) continue;

              if (!colorSegs.has(color)) colorSegs.set(color, []);
              colorSegs.get(color)!.push([a1, a2]);
            }

            for (const [color, segs] of colorSegs) {
              ctx.fillStyle = color;
              ctx.beginPath();
              for (const [a1, a2] of segs) {
                ctx.moveTo(r2 * Math.cos(a1), r2 * Math.sin(a1));
                ctx.arc(0, 0, r2, a1, a2, false);
                ctx.arc(0, 0, r1, a2, a1, true);
                ctx.closePath();
              }
              ctx.fill();
            }

            currentR += track.height + TRACK_PADDING;
          }
        }
      }

      // Leaf labels (unrooted) — anchored at actual leaf tips, extending outward
      if (showLeafLabels) {
        const arcPerLeaf = N > 0 ? (2 * Math.PI) / N : 0;
        const labelSpacingPx = ringR * arcPerLeaf * gZoom;
        if (labelSpacingPx >= 6) {
          const fontSize = Math.min(Math.floor(labelSpacingPx * 0.75 * optFontScale), 13 * optFontScale);
          const labelOffset = effectiveTrackWidth + trackOffset + 6 / gZoom;
          ctx.save();
          ctx.font = `${fontSize / gZoom}px sans-serif`;
          ctx.textBaseline = "middle";
          for (const leafId of leaves) {
            if (skipNode[leafId] === 2) continue;
            const name = nodes[leafId].name;
            if (!name) continue;
            const lx = coords[leafId].x * R;
            const ly = coords[leafId].y * R;
            const len = Math.hypot(lx, ly);
            if (len < 0.001) continue;
            const dirAngle = Math.atan2(ly, lx);
            const px = lx + labelOffset * (lx / len);
            const py = ly + labelOffset * (ly / len);
            if (!worldVisible(px, py)) continue;
            ctx.fillStyle = nodeRangeColor.get(leafId) ?? "#222";
            ctx.save();
            ctx.translate(px, py);
            const cosA = Math.cos(dirAngle);
            if (cosA >= 0) { ctx.rotate(dirAngle); ctx.textAlign = "left"; }
            else { ctx.rotate(dirAngle + Math.PI); ctx.textAlign = "right"; }
            ctx.fillText(name, 0, 0);
            ctx.restore();
          }
          ctx.restore();
        }
      }

      // Coloured hull ranges (background mode only)
      for (const r of ranges) {
        if (rangeDisplayMode !== "background") continue;
        const nd = nodes[r.nodeId];
        if (!nd) continue;
        const points: [number, number][] = [];
        for (let i = nd.L; i < nd.R; i++) {
          const leafId = leaves[i];
          const p = coords[leafId];
          points.push([p.x * R, p.y * R]);
        }
        points.push([coords[nd.id].x * R, coords[nd.id].y * R]);
        const hull = d3.polygonHull(points);
        if (!hull) continue;
        (r as any).hull = hull;
        ctx.beginPath();
        ctx.moveTo(hull[0][0], hull[0][1]);
        for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i][0], hull[i][1]);
        ctx.closePath();
        ctx.fillStyle = r.color + "55";
        ctx.fill();
      }
    }

    // ---- Dispatch to layout-specific draw ----

    if (layout === "rect") {
      drawRectLayout();
      drawHoverHighlightRect();
      drawSelectHighlightRect();
    } else if (layout === "circular") {
      drawCircularLayout();
      drawHoverHighlightCirc();
      drawSelectHighlightCirc();
    } else if (layout === "unrooted") {
      drawUnrootedLayout();
      drawHoverHighlightUnrooted();
      drawSelectHighlightUnrooted();
    }

    ctx.restore();

    // ---- Circular layout: annotation tracks as screen-space overlay ----
    // Drawn after ctx.restore() so track heights are constant screen pixels regardless of zoom.
    // The inner radius tracks the outermost visible branch (via computeCircularTrackRadii auto mode).
    if (layout === "circular" && showTracks && effectiveTrackWidth > 0 && rectLayout) {
      const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
      const N = leaves.length || 1;
      const arcRad = (arc * Math.PI) / 180;
      const anglePerLeaf = N > 0 ? arcRad / N : 0;
      const cx = W / 2 + offset.x, cy = H / 2 + offset.y;
      const { trackStartRadius } = computeCircularTrackRadii(
        W, H, { coords: rectCoords as any[], maxX: rectMaxX }, R, N, effectiveTrackWidth
      );
      const trackStartR_screen = trackStartRadius * gZoom;
      const leafArcPx = trackStartR_screen * anglePerLeaf;
      const leafStep = leafArcPx > 0 ? Math.max(1, Math.floor(optLodMinPx / leafArcPx)) : 1;

      const leafData: Array<{ a: number; row: any }> = [];
      for (let idx = 0; idx < leaves.length; idx += leafStep) {
        const leafId = leaves[idx];
        if (skipNode[leafId] === 2) continue;
        const nd = nodes[leafId];
        const pRect = (rectCoords as any)[leafId];
        const { angle } = rectToPolar(rectMaxX > 0 ? pRect.x / rectMaxX : 0, pRect.y, N, R, rotation, arc);
        const sx_l = cx + trackStartR_screen * Math.cos(angle);
        const sy_l = cy + trackStartR_screen * Math.sin(angle);
        if (sx_l < -50 || sx_l > W + 50 || sy_l < -50 || sy_l > H + 50) continue;
        leafData.push({ a: angle, row: annotations.get(nd.name || "") });
      }
      leafData.sort((a, b) => a.a - b.a);

      if (leafData.length > 0) {
        const maxSegAngle = arc < 360 ? 1.5 * (arcRad / leafData.length) : Infinity;
        ctx.save();
        ctx.translate(cx, cy);
        let currentR = trackStartR_screen;
        for (const track of trackConfig) {
          if (!track.visible) { currentR += track.height + TRACK_PADDING; continue; }
          const r1 = currentR, r2 = r1 + track.height;
          const colorSegs = new Map<string, Array<[number, number, number]>>();
          for (let i = 0; i < leafData.length; i++) {
            const { a, row } = leafData[i];
            const nextRaw = leafData[(i + 1) % leafData.length].a;
            const a2full = nextRaw > a ? nextRaw : nextRaw + 2 * Math.PI;
            if (a2full - a > maxSegAngle) continue;
            const a2 = a + (a2full - a) * optBarFill;
            const val = row ? row[track.key] : undefined;
            if (val === null || val === undefined || val === "") continue;
            let color: string, rEnd = r1;
            if (track.type === "categorical") {
              color = colorMaps.get(track.key)?.get(val.toString()) ?? "#aaa";
            } else {
              const num = Number(val);
              if (isNaN(num)) continue;
              rEnd = r1 + Math.min(1, Math.max(0, num / (track.maxVal || 1))) * (r2 - r1);
              color = "#666";
            }
            if (!colorSegs.has(color)) colorSegs.set(color, []);
            colorSegs.get(color)!.push([a, a2, rEnd]);
          }
          for (const [color, segs] of colorSegs) {
            ctx.fillStyle = color;
            ctx.beginPath();
            for (const [a1, a2, rEnd] of segs) {
              ctx.moveTo(r2 * Math.cos(a1), r2 * Math.sin(a1));
              ctx.arc(0, 0, r2, a1, a2, false);
              ctx.arc(0, 0, rEnd, a2, a1, true);
              ctx.closePath();
            }
            ctx.fill();
          }
          currentR += track.height + TRACK_PADDING;
        }
        ctx.restore();
      }
    }

    // ---- Rect layout: tracks and labels as screen-space overlay ----
    // Drawn after ctx.restore() so coordinates are pure screen pixels.
    // This keeps tracks/labels pinned to the right edge regardless of pan/zoom.
    if (layout === "rect") {
      const labelW = showLeafLabels ? LABEL_RESERVE_PX : 0;
      const overlayTrackX = W - PADDING - effectiveTrackWidth - labelW;
      const overlayLabelX = W - PADDING - labelW + 4;
      const leafSpacingPx = sy * vZoom;

      if (showTracks && effectiveTrackWidth > 0) {
        const leafStep = leafSpacingPx > 0 ? Math.max(1, Math.floor(optLodMinPx / leafSpacingPx)) : 1;
        // optBarFill=1 → bars fill full leaf spacing (always abutting); <1 → gap between bars
        const cellH = Math.max(leafSpacingPx * optBarFill, 1);
        for (let i = visibleLeafStart; i < visibleLeafEnd; i += leafStep) {
          const leafId = leaves[i];
          if (skipNode[leafId] === 2) continue;
          const screenY = H / 2 + offset.y + vZoom * (-H / 2 + PADDING + sy * i);
          const nd = nodes[leafId];
          const row = annotations.get(nd.name || "");
          let currentX = overlayTrackX;
          for (const track of trackConfig) {
            if (!track.visible) { currentX += track.height + TRACK_PADDING; continue; }
            const val = row ? row[track.key] : undefined;
            if (val === null || val === undefined || val === "") { currentX += track.height + TRACK_PADDING; continue; }
            if (track.type === "categorical") {
              const color = colorMaps.get(track.key)?.get(val.toString()) ?? "#aaa";
              ctx.fillStyle = color;
              ctx.fillRect(currentX, screenY - cellH / 2, track.height, cellH);
            } else {
              const num = Number(val);
              if (!isNaN(num)) {
                const barW = (num / (track.maxVal || 1)) * track.height;
                ctx.fillStyle = "#666";
                ctx.fillRect(currentX, screenY - cellH / 2, barW, cellH);
              }
            }
            currentX += track.height + TRACK_PADDING;
          }
        }
      }

      if (showLeafLabels && leafSpacingPx >= 6) {
        const fontSize = Math.min(Math.floor(leafSpacingPx * 0.75 * optFontScale), 13 * optFontScale);
        ctx.save();
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (let i = visibleLeafStart; i < visibleLeafEnd; i++) {
          const leafId = leaves[i];
          if (skipNode[leafId] === 2) continue;
          const name = nodes[leafId].name;
          if (!name) continue;
          const screenY = H / 2 + offset.y + vZoom * (-H / 2 + PADDING + sy * i);
          ctx.fillStyle = nodeRangeColor.get(leafId) ?? "#222";
          ctx.fillText(name, overlayLabelX, screenY);
        }
        ctx.restore();
      }

      // Support value labels (screen-space overlay — avoids horizontal squish from vZoom scale)
      if (optShowSupportLabels) {
        const fontSize = Math.min(Math.max(Math.floor(leafSpacingPx * 1.5 * optFontScale), 8), 11);
        ctx.save();
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        for (const nd of nodes) {
          if (skipNode[nd.id] === 2 || skipNode[nd.id] === 1) continue;
          if (nd.support === undefined || nd.children.length === 0) continue;
          if (nd.id !== treeRoot) {
            const cladePx = (nd.R - nd.L) * leafSpacingPx;
            if (cladePx < optLodMinPx && optLodMinPx > 0) continue;
          }
          const a = (rectCoords as any)[nd.id];
          const screenX = PADDING + sx * a.x + offset.x;
          const screenY = H / 2 + offset.y + vZoom * (-H / 2 + PADDING + sy * a.y);
          if (screenY < -fontSize || screenY > H + fontSize || screenX < 0 || screenX > W) continue;
          const label = supportAsPercent ? nd.support.toFixed(0) : nd.support.toFixed(2);
          ctx.fillStyle = optSupportColouring ? supportColor(nd.support) : "#555";
          ctx.fillText(label, screenX + 3, screenY);
        }
        ctx.restore();
      }
    }

    // ---- Scale bar (screen space) ----
    if (phylogram) {
      let pxPerUnit = 0;
      if (layout === "rect") {
        pxPerUnit = computeRectSx(W, rectMaxX, effectiveTrackWidth);
      } else {
        const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
        const rScale = layout === "unrooted" && unrootedLayout
          ? R / (unrootedLayout.maxR || 1)
          : R / (rectMaxX || 1);
        pxPerUnit = rScale * gZoom;
      }
      if (pxPerUnit > 0) {
        // Pick a nice round bar length: nearest power of 10 such that bar is 50–200px
        const rawLen = 100 / pxPerUnit;
        const mag = Math.pow(10, Math.floor(Math.log10(rawLen)));
        const niceMults = [1, 2, 5, 10];
        let barLen = mag;
        for (const m of niceMults) {
          const candidate = mag * m;
          if (candidate * pxPerUnit >= 50 && candidate * pxPerUnit <= 200) { barLen = candidate; break; }
        }
        const barPx = barLen * pxPerUnit;
        const bx = 16, by = H - 24;
        ctx.save();
        ctx.strokeStyle = "#333";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by);
        ctx.moveTo(bx, by - 5); ctx.lineTo(bx, by + 5);
        ctx.moveTo(bx + barPx, by - 5); ctx.lineTo(bx + barPx, by + 5);
        ctx.stroke();
        ctx.fillStyle = "#333";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(barLen < 0.01 ? barLen.toExponential(1) : barLen < 1 ? barLen.toPrecision(2) : String(barLen), bx + barPx / 2, by + 7);
        ctx.restore();
      }
    }
  }

  // Bug fix: added collapsedNodes and hiddenNodes to the dependency array so
  // that manual collapse/hide operations correctly trigger a redraw.
  useEffect(() => {
    draw();
  }, [
    tree,
    annotations,
    layout,
    phylogram,
    vZoom,
    gZoom,
    offset,
    ranges,
    hSpan,
    supportC0, supportC1, supportC2,
    supportV0, supportV1, supportV2,
    supportAsPercent,
    hoverNode,
    selectedNode,
    rotation,
    arc,
    trackConfig,
    showTracks,
    colorMaps,
    trackOffset,
    trackOffsetMode,
    showRangePanel,
    activeRangeColor,
    collapsedNodes,
    showLeafLabels,
    optFontScale, optLodMinPx, nodeWidthPx, optBarFill,
    optBackground, optShowSupportLabels, optSupportColouring,
    rangeDisplayMode,
  ]);

  // ==========================================================
  // Picking helpers
  // ==========================================================

  function getAngleAndIndexFromMouse(wx: number, wy: number) {
    if (!tree) return { idx: 0, inGap: true };
    const startRad = (rotation * Math.PI) / 180;
    const arcRad = (arc * Math.PI) / 180;
    const endRad = startRad - arcRad;
    let a = Math.atan2(wy, wx);

    if (!(startRad < endRad)) {
      if (a < endRad % (2 * Math.PI)) a += 2 * Math.PI;
    }

    let inGap = false;
    if (a > startRad || a < endRad) inGap = true;

    let t = startRad - a;
    while (t < 0) t += 2 * Math.PI;
    t = (t % (2 * Math.PI)) / arcRad;
    if (inGap) t = -1;

    const idx = clamp(Math.floor(t * tree.leaves.length), 0, tree.leaves.length - 1);
    return { idx, inGap };
  }

  function pickRangeFromWorld(
    wx: number,
    wy: number,
    W: number,
    H: number
  ): { range: ColoredRange; index: number } | null {
    if (!tree || !rectLayout) return null;
    const effectiveTrackWidth = getEffectiveTrackWidth();
    const { coords, height, maxX } = rectLayout;
    const sx = computeRectSx(W, maxX, effectiveTrackWidth);
    const sy = (H - 2 * PADDING) / Math.max(1, height);
    const N = tree.leaves.length || 1;

    for (let i = ranges.length - 1; i >= 0; i--) {
      const r = ranges[i];
      const nd = tree.nodes[r.nodeId];
      if (!nd) continue;

      if (layout === "rect") {
        const a = (coords as any)[nd.id];
        const xNode = -W / 2 + PADDING + sx * a.x;
        const y1 = -H / 2 + PADDING + sy * nd.L;
        const y2 = -H / 2 + PADDING + sy * (nd.R - 1) + sy;
        const xEdge = -W / 2 + PADDING + sx * maxX; // tree right edge
        if (wx >= xNode && wx <= xEdge && wy >= y1 && wy <= y2) return { range: r, index: i };

      } else if (layout === "circular") {
        const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
        const { trackOuterRadius } = computeCircularTrackRadii(W, H, { coords: coords as any[], maxX }, R, N, effectiveTrackWidth);
        const rMouse = Math.hypot(wx, wy);
        const aMouse = Math.atan2(wy, wx);
        const a0 = (rotation * Math.PI) / 180 - (nd.L / N) * ((arc * Math.PI) / 180);
        const a1 = (rotation * Math.PI) / 180 - (nd.R / N) * ((arc * Math.PI) / 180);
        const aRect = (coords as any)[nd.id];
        const rNode = rectToPolar(maxX > 0 ? aRect.x / maxX : 0, aRect.y, N, R, rotation, arc).radius;
        const inAngle = a1 < a0 ? aMouse <= a0 && aMouse >= a1 : aMouse <= a0 || aMouse >= a1;
        if (inAngle && rMouse >= rNode && rMouse <= trackOuterRadius) return { range: r, index: i };

      } else if (layout === "unrooted") {
        const hull = (r as any).hull;
        if (hull && isPointInPolygon([wx, wy], hull)) return { range: r, index: i };
      }
    }
    return null;
  }

  function pickNodeFromWorld(wx: number, wy: number, W: number, H: number): number | null {
    if (!tree || !rectLayout) return null;
    const { coords, height, maxX } = rectLayout;
    const effectiveTrackWidth = getEffectiveTrackWidth();
    const sx = computeRectSx(W, maxX, effectiveTrackWidth);
    const sy = (H - 2 * PADDING) / Math.max(1, height);

    if (layout === "rect") {
      const leafIdxEst = clamp(Math.round((wy + H / 2 - PADDING) / sy), 0, tree.leaves.length - 1);
      const leafId = tree.leaves[leafIdxEst];
      // Tracks are screen-space overlays: reconstruct screen x from world x
      const screenX = wx + W / 2 + offset.x;
      const labelW = showLeafLabels ? LABEL_RESERVE_PX : 0;
      const overlayTrackX = W - PADDING - effectiveTrackWidth - labelW;
      if (showTracks && screenX > overlayTrackX && screenX < W - PADDING + 6) return leafId;

      let cur: number | null = leafId;
      const pathNodes: number[] = [];
      while (cur != null) { pathNodes.push(cur); cur = tree.nodes[cur].parent; }

      let bestNode: number | null = null, bestDist = Infinity;
      for (const id of pathNodes) {
        const a = (coords as any)[id];
        const d = Math.hypot(wx - (-W / 2 + PADDING + sx * a.x), wy - (-H / 2 + PADDING + sy * a.y));
        if (d < bestDist) { bestDist = d; bestNode = id; }
      }
      return bestDist <= 18 ? bestNode : null;

    } else if (layout === "circular") {
      const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
      const N = tree.leaves.length || 1;
      const { trackStartRadius, trackOuterRadius } = computeCircularTrackRadii(W, H, { coords: coords as any[], maxX }, R, N, effectiveTrackWidth);
      const r = Math.hypot(wx, wy);
      if (r < 4 || r > trackOuterRadius + 80) return null;
      const { idx, inGap } = getAngleAndIndexFromMouse(wx, wy);
      if (inGap) return null;
      const leafId = tree.leaves[idx];
      if (showTracks && r > trackStartRadius && r < trackOuterRadius + 6) return leafId;

      let cur: number | null = leafId;
      const pathNodes: number[] = [];
      while (cur != null) { pathNodes.push(cur); cur = tree.nodes[cur].parent; }

      let bestNode: number | null = null, bestDist = Infinity;
      for (const id of pathNodes) {
        const aRect = (coords as any)[id];
        const P = rectToPolar(maxX > 0 ? aRect.x / maxX : 0, aRect.y, N, R, rotation, arc);
        const d = Math.hypot(wx - P.x, wy - P.y);
        if (d < bestDist) { bestDist = d; bestNode = id; }
      }
      return bestDist <= 18 / gZoom ? bestNode : null;

    } else {
      if (!unrootedLayout) return null;
      const { coords: uCoords, maxR: computedMaxR } = unrootedLayout;
      const R = (Math.min(W, H) * CIRC_RADIUS_FRACTION) / (computedMaxR || 1);
      const { ringR, trackOuterRingR } = computeUnrootedTrackRadii(W, H, { coords: uCoords, maxR: computedMaxR }, R, effectiveTrackWidth);
      const r = Math.hypot(wx, wy);

      if (showTracks && r > ringR && r < trackOuterRingR + 6) {
        const mouseAngle = Math.atan2(wy, wx);
        let bestDist = Infinity, bestLeaf: number | null = null;
        for (const leafId of tree.leaves) {
          let da = mouseAngle - uCoords[leafId].angle;
          while (da > Math.PI) da -= 2 * Math.PI;
          while (da < -Math.PI) da += 2 * Math.PI;
          if (Math.abs(da) < bestDist) { bestDist = Math.abs(da); bestLeaf = leafId; }
        }
        if (bestLeaf !== null && bestDist < (Math.PI / tree.leaves.length) * 1.5) return bestLeaf;
      }

      let bestNode: number | null = null, bestDist = Infinity;
      for (const nd of tree.nodes) {
        const d = Math.hypot(wx - uCoords[nd.id].x * R, wy - uCoords[nd.id].y * R);
        if (d < bestDist) { bestDist = d; bestNode = nd.id; }
      }
      return bestDist <= 20 / gZoom ? bestNode : null;
    }
  }

  // ==========================================================
  // Mouse move / tooltips
  // ==========================================================

  function onMouseMove(e: React.MouseEvent) {
    if (!tree || !rectLayout) return;
    const canvas = canvasRef.current!;
    const cont = containerRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const W = cont.clientWidth, H = cont.clientHeight;

    const wx = layout === "rect" ? x - W / 2 - offset.x : (x - W / 2 - offset.x) / gZoom;
    const wy = layout === "rect" ? (y - H / 2 - offset.y) / vZoom : (y - H / 2 - offset.y) / gZoom;

    let tip: string | null = null;
    let isHoveringClickable = false;
    const effectiveTrackWidth = getEffectiveTrackWidth();
    const { coords, height, maxX } = rectLayout;
    const sy = (H - 2 * PADDING) / Math.max(1, height);

    if (layout === "rect") {
      // Tracks and labels are screen-space overlays — use raw screen x for hit test
      const labelW = showLeafLabels ? LABEL_RESERVE_PX : 0;
      const overlayTrackX = W - PADDING - effectiveTrackWidth - labelW;
      if (x > overlayTrackX - 12 && x < W - PADDING + 20 && showTracks) {
        const leafIdxEst = clamp(Math.round((wy + H / 2 - PADDING) / sy), 0, tree.leaves.length - 1);
        const leafId = tree.leaves[leafIdxEst];
        isHoveringClickable = true;
        const name = tree.nodes[leafId].name || "";
        const row = annotations.get(name);
        tip = name;
        if (row) for (const t of trackConfig) if (t.visible) tip += `\n${t.key}: ${row[t.key] || "N/A"}`;
      }
    } else if (layout === "circular") {
      const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
      const N = tree.leaves.length || 1;
      const { trackStartRadius, trackOuterRadius } = computeCircularTrackRadii(W, H, { coords: coords as any[], maxX }, R, N, effectiveTrackWidth);
      const r = Math.hypot(wx, wy);
      if (showTracks && r > trackStartRadius - 12 && r < trackOuterRadius + 20) {
        const { idx, inGap } = getAngleAndIndexFromMouse(wx, wy);
        if (!inGap) {
          isHoveringClickable = true;
          const leafId = tree.leaves[idx];
          const name = tree.nodes[leafId].name || "";
          const row = annotations.get(name);
          tip = name;
          if (row) for (const t of trackConfig) if (t.visible) tip += `\n${t.key}: ${row[t.key] || "N/A"}`;
        }
      }
    } else if (layout === "unrooted" && unrootedLayout) {
      const { coords: uCoords, maxR: computedMaxR } = unrootedLayout;
      const R = (Math.min(W, H) * CIRC_RADIUS_FRACTION) / (computedMaxR || 1);
      const { ringR, trackOuterRingR } = computeUnrootedTrackRadii(W, H, { coords: uCoords, maxR: computedMaxR }, R, effectiveTrackWidth);
      const r = Math.hypot(wx, wy);
      if (showTracks && r > ringR - 12 && r < trackOuterRingR + 20) {
        const mouseAngle = Math.atan2(wy, wx);
        let bestDist = Infinity, bestLeaf: number | null = null;
        for (const leafId of tree.leaves) {
          let da = mouseAngle - uCoords[leafId].angle;
          while (da > Math.PI) da -= 2 * Math.PI;
          while (da < -Math.PI) da += 2 * Math.PI;
          if (Math.abs(da) < bestDist) { bestDist = Math.abs(da); bestLeaf = leafId; }
        }
        if (bestLeaf !== null && bestDist < (Math.PI / tree.leaves.length) * 1.5) {
          isHoveringClickable = true;
          const name = tree.nodes[bestLeaf].name || "";
          const row = annotations.get(name);
          tip = name;
          if (row) for (const t of trackConfig) if (t.visible) tip += `\n${t.key}: ${row[t.key] || "N/A"}`;
        }
      }
    }

    const nodeUnder = pickNodeFromWorld(wx, wy, W, H);
    setHoverNode(nodeUnder);
    if (nodeUnder !== null) isHoveringClickable = true;

    if (tip === null && nodeUnder != null && nodeUnder !== selectedNode) {
      const nd = tree.nodes[nodeUnder];
      const leaves = (nd as any).leaves ?? nd.R - nd.L;
      let info = `${leaves} leaves\nBranch: ${nd.length.toFixed(4)}`;
      if (nd.support !== undefined) info += `\nSupport: ${nd.support}`;
      if (nd.isLeaf) {
        const name = nd.name || "";
        const row = annotations.get(name);
        tip = name;
        if (row && showTracks) for (const t of trackConfig) if (t.visible) tip += `\n${t.key}: ${row[t.key] || "N/A"}`;
        tip += "\n" + info;
      } else {
        tip = info;
      }
    }

    if (tip === null) {
      const pickedRange = pickRangeFromWorld(wx, wy, W, H);
      if (pickedRange?.range.label) { tip = pickedRange.range.label; isHoveringClickable = true; }
    }

    setCursorStyle(isHoveringClickable ? "pointer" : dragging.current ? "grabbing" : "grab");
    setHoverPos({ x, y });
    setHoverInfo(tip);
  }

  // ==========================================================
  // Click & drag
  // ==========================================================

  function onClick(e: React.MouseEvent) {
    if (!tree || wasDragging.current) { wasDragging.current = false; return; }
    if (showRangePanel) { setShowRangePanel(false); setEditingRangeIndex(null); }

    const canvas = canvasRef.current!;
    const cont = containerRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const W = cont.clientWidth, H = cont.clientHeight;
    const wx = layout === "rect" ? x - W / 2 - offset.x : (x - W / 2 - offset.x) / gZoom;
    const wy = layout === "rect" ? (y - H / 2 - offset.y) / vZoom : (y - H / 2 - offset.y) / gZoom;

    const targetNode = pickNodeFromWorld(wx, wy, W, H);
    if (targetNode === selectedNode) { setSelectedNode(null); setShowRangePanel(false); }
    else { setSelectedNode(targetNode); setShowRangePanel(false); }
  }

  function onDoubleClick(e: React.MouseEvent) {
    if (!tree) return;
    const canvas = canvasRef.current!;
    const cont = containerRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const W = cont.clientWidth, H = cont.clientHeight;
    const wx = layout === "rect" ? x - W / 2 - offset.x : (x - W / 2 - offset.x) / gZoom;
    const wy = layout === "rect" ? (y - H / 2 - offset.y) / vZoom : (y - H / 2 - offset.y) / gZoom;

    const pickedRange = pickRangeFromWorld(wx, wy, W, H);
    if (pickedRange) {
      setSelectedNode(pickedRange.range.nodeId);
      setActiveRangeColor(pickedRange.range.color);
      setActiveRangeLabel(pickedRange.range.label || "");
      setEditingRangeIndex(pickedRange.index);
      setShowRangePanel(true);
    }
  }

  function onMouseDown(e: React.MouseEvent) {
    wasDragging.current = false;
    dragging.current = true;
    last.current = { x: e.clientX, y: e.clientY };
    setCursorStyle("grabbing");
  }

  function onMouseUp() {
    dragging.current = false;
    setCursorStyle(hoverNode !== null ? "pointer" : "grab");
  }

  function onMouseLeave() {
    dragging.current = false;
    setHoverInfo(null);
    setHoverNode(null);
    setCursorStyle("grab");
  }

  function onMouseMoveWrap(e: React.MouseEvent) {
    onMouseMove(e);
    if (!dragging.current) return;
    if (!wasDragging.current) { setShowRangePanel(false); setEditingRangeIndex(null); }
    wasDragging.current = true;
    const dx = e.clientX - last.current.x;
    const dy = e.clientY - last.current.y;
    last.current = { x: e.clientX, y: e.clientY };
    setOffset((o) => ({ x: o.x + dx, y: o.y + dy }));
  }

  // Bug fix: added lockHScale to the dependency array
  const onWheel = useCallback(
    (e: React.WheelEvent | WheelEvent) => {
      e.preventDefault();
      if (!canvasRef.current || !containerRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const W = containerRef.current.clientWidth, H = containerRef.current.clientHeight;

      let x = (e as any).clientX - rect.left;
      let y = (e as any).clientY - rect.top;

      if (tree && selectedNode !== null) {
        if (layout === "rect" && rectLayout) {
          const { coords, height, maxX } = rectLayout;
          const sx = computeRectSx(W, maxX, getEffectiveTrackWidth());
          const sy = (H - 2 * PADDING) / Math.max(1, height);
          const a = (coords as any)[selectedNode];
          if (a) {
            x = W / 2 + offset.x + (-W / 2 + PADDING + sx * a.x);
            y = H / 2 + offset.y + vZoom * (-H / 2 + PADDING + sy * a.y);
          }
        } else if (layout === "circular" && rectLayout) {
          const { coords, maxX } = rectLayout;
          const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
          const N = tree.leaves.length || 1;
          const aRect = (coords as any)[selectedNode];
          if (aRect) {
            const P = rectToPolar(maxX > 0 ? aRect.x / maxX : 0, aRect.y, N, R, rotation, arc);
            x = W / 2 + offset.x + gZoom * P.x;
            y = H / 2 + offset.y + gZoom * P.y;
          }
        } else if (layout === "unrooted" && unrootedLayout) {
          const { coords, maxR } = unrootedLayout;
          const R = (Math.min(W, H) * CIRC_RADIUS_FRACTION) / (maxR || 1);
          const p = coords[selectedNode];
          if (p) { x = W / 2 + offset.x + gZoom * p.x * R; y = H / 2 + offset.y + gZoom * p.y * R; }
        }
      }

      if (layout === "rect") {
        const new_vZoom = Math.max(0.01, vZoom * ((e as any).deltaY < 0 ? 1.1 : 0.9));
        const wy_before = (y - H / 2 - offset.y) / vZoom;
        const new_offsetY = y - H / 2 - new_vZoom * wy_before;
        let new_offsetX = offset.x;

        if (!lockHScale && phylogram && rectLayout && tree) {
          const { coords, height } = rectLayout;
          const metrics = computeVisibleRectMetricsAt(new_vZoom, { x: new_offsetX, y: new_offsetY }, W, H, tree, coords as any[], height);
          if (metrics) {
            const span = metrics.span > 0 ? metrics.span : metrics.maxVisibleX;
            setHSpan(span);
            new_offsetX = computeRectAutoPanX(W, span, metrics.localRootX, PADDING);
          }
        }
        setOffset({ x: new_offsetX, y: new_offsetY });
        setVZoom(new_vZoom);
      } else {
        const new_gZoom = Math.max(0.01, gZoom * ((e as any).deltaY < 0 ? 1.1 : 0.9));
        const wx_before = (x - W / 2 - offset.x) / gZoom;
        const wy_before = (y - H / 2 - offset.y) / gZoom;
        setOffset({ x: x - W / 2 - new_gZoom * wx_before, y: y - H / 2 - new_gZoom * wy_before });
        setGZoom(new_gZoom);
      }
    },
    [layout, vZoom, gZoom, offset.x, offset.y, rectLayout, unrootedLayout, tree, selectedNode, hSpan, phylogram, rotation, arc, lockHScale]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (e: WheelEvent) => onWheel(e as any);
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [onWheel]);

  // ==========================================================
  // Zoom helpers
  // ==========================================================

  const zoomByFactor = (factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    let x = W / 2, y = H / 2;

    if (tree && selectedNode !== null) {
      if (layout === "rect" && rectLayout) {
        const { coords, height, maxX } = rectLayout;
        const sx = computeRectSx(W, maxX, getEffectiveTrackWidth());
        const sy = (H - 2 * PADDING) / Math.max(1, height);
        const a = (coords as any)[selectedNode];
        if (a) { x = W / 2 + offset.x + (-W / 2 + PADDING + sx * a.x); y = H / 2 + offset.y + vZoom * (-H / 2 + PADDING + sy * a.y); }
      } else if (layout === "circular" && rectLayout) {
        const { coords, maxX } = rectLayout;
        const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
        const N = tree.leaves.length || 1;
        const aRect = (coords as any)[selectedNode];
        if (aRect) {
          const P = rectToPolar(maxX > 0 ? aRect.x / maxX : 0, aRect.y, N, R, rotation, arc);
          x = W / 2 + offset.x + gZoom * P.x; y = H / 2 + offset.y + gZoom * P.y;
        }
      } else if (layout === "unrooted" && unrootedLayout) {
        const { coords, maxR } = unrootedLayout;
        const R = (Math.min(W, H) * CIRC_RADIUS_FRACTION) / (maxR || 1);
        const p = coords[selectedNode];
        if (p) { x = W / 2 + offset.x + gZoom * p.x * R; y = H / 2 + offset.y + gZoom * p.y * R; }
      }
    }

    if (layout === "rect") {
      const new_vZoom = Math.max(0.01, vZoom * factor);
      const wy_before = (y - H / 2 - offset.y) / vZoom;
      setOffset((o) => ({ x: o.x, y: y - H / 2 - new_vZoom * wy_before }));
      setVZoom(new_vZoom);
    } else {
      const new_gZoom = Math.max(0.01, gZoom * factor);
      const wx_before = (x - W / 2 - offset.x) / gZoom;
      const wy_before = (y - H / 2 - offset.y) / gZoom;
      setOffset({ x: x - W / 2 - new_gZoom * wx_before, y: y - H / 2 - new_gZoom * wy_before });
      setGZoom(new_gZoom);
    }
  };

  const handleZoomIn = () => zoomByFactor(1.2);
  const handleZoomOut = () => zoomByFactor(1 / 1.2);
  const handleFrameAll = () => { setOffset({ x: 0, y: 0 }); setVZoom(1); setGZoom(1); };

  // Keyboard shortcuts — use a ref so the effect never needs to re-register.
  const kbRef = useRef<(e: KeyboardEvent) => void>(() => {});
  kbRef.current = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomByFactor(1.2); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomByFactor(1 / 1.2); }
    else if (e.key === "f" || e.key === "F") { e.preventDefault(); setOffset({ x: 0, y: 0 }); setVZoom(1); setGZoom(1); }
    else if (e.key === "Escape") { e.preventDefault(); setSelectedNode(null); setShowRangePanel(false); }
    else if ((e.key === "r" || e.key === "R") && selectedNode !== null && tree) { e.preventDefault(); handleReroot(); }
    else if ((e.key === "c" || e.key === "C") && selectedNode !== null) { e.preventDefault(); handleColorRangeClick(); }
    else if (e.key === "Enter" && showRangePanel) { e.preventDefault(); confirmColorRange(); }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => kbRef.current(e);
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // ==========================================================
  // Horizontal scale helpers (rect phylogram)
  // ==========================================================

  function computeRectAutoPanX(W: number, span: number, localRootX: number, padding = PADDING): number {
    const targetWidth = W - 2 * padding;
    const sx = span > 0 ? targetWidth / span : targetWidth;
    return -sx * localRootX;
  }

  function computeVisibleRectMetricsAt(
    vZoomP: number,
    offsetP: { x: number; y: number },
    W: number,
    H: number,
    tree: Tree,
    rectCoords: any[],
    rectHeight: number
  ) {
    const sy = (H - 2 * PADDING) / Math.max(1, rectHeight);
    const topWy = (0 - H / 2 - offsetP.y) / vZoomP;
    const bottomWy = (H - H / 2 - offsetP.y) / vZoomP;
    let visibleStart = clamp(Math.floor((topWy + H / 2 - PADDING) / sy) - 1, 0, tree.leaves.length);
    let visibleEnd = clamp(Math.ceil((bottomWy + H / 2 - PADDING) / sy) + 1, 0, tree.leaves.length);
    if (visibleEnd < visibleStart) [visibleStart, visibleEnd] = [visibleEnd, visibleStart];

    let maxVisibleX = 0;
    for (let i = visibleStart; i < visibleEnd; i++) {
      const p = rectCoords[tree.leaves[i]];
      if (p && p.x > maxVisibleX) maxVisibleX = p.x;
    }

    if (tree.leaves.length === 0) return { visibleStart, visibleEnd, localRootX: 0, maxVisibleX: 0, span: 0 };
    const leftLeafId = tree.leaves[clamp(visibleStart, 0, tree.leaves.length - 1)];
    const rightLeafId = tree.leaves[clamp(visibleEnd - 1, 0, tree.leaves.length - 1)];

    function lca(aId: number, bId: number): number {
      const j = tree.nodes[bId].leafIndex;
      let u: number | null = aId;
      while (u != null) {
        const n: Node = tree.nodes[u];
        if (n.L <= j && j < n.R) return u;
        u = n.parent;
      }
      return tree.root;
    }

    const rootId = lca(leftLeafId, rightLeafId);
    const localRootX = rectCoords[rootId]?.x ?? 0;
    const span = Math.max(0, maxVisibleX - localRootX);
    return { visibleStart, visibleEnd, localRootX, maxVisibleX, span };
  }

  // ==========================================================
  // Track UI helpers
  // ==========================================================

  const moveTrack = (index: number, direction: "up" | "down") => {
    const newConfig = [...trackConfig];
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= newConfig.length) return;
    [newConfig[index], newConfig[target]] = [newConfig[target], newConfig[index]];
    setTrackConfig(newConfig);
  };

  const updateTrack = (index: number, key: "type" | "height" | "visible" | "label", value: any) => {
    const newConfig = [...trackConfig];
    const track = { ...newConfig[index] };
    if (key === "type") track.type = value;
    if (key === "height") track.height = clamp(Number(value) || 0, 1, 100);
    if (key === "visible") track.visible = !!value;
    if (key === "label") track.label = String(value);
    newConfig[index] = track;
    setTrackConfig(newConfig);
  };

  const handleColorChange = (newColor: string) => {
    if (!editingColor) return;
    const { trackKey, category } = editingColor;
    setColorMaps((prev) => {
      const newMaps = new Map(prev);
      const trackMap = new Map(newMaps.get(trackKey));
      trackMap.set(category, newColor);
      newMaps.set(trackKey, trackMap);
      return newMaps;
    });
  };

  const applyPalette = (trackKey: string, paletteName: string) => {
    const palette = CATEGORICAL_PALETTES.find(p => p.name === paletteName);
    if (!palette) return;
    setColorMaps((prev) => {
      const newMaps = new Map(prev);
      const oldMap = newMaps.get(trackKey);
      if (!oldMap) return prev;
      const newMap = new Map<string, string>();
      let i = 0;
      for (const cat of oldMap.keys()) {
        newMap.set(cat, palette.colors[i % palette.colors.length]);
        i++;
      }
      newMaps.set(trackKey, newMap);
      return newMaps;
    });
  };

  const currentLegendMap = showLegendKey ? colorMaps.get(showLegendKey) : null;

  // ==========================================================
  // Selection actions
  // ==========================================================

  const handleReroot = () => {
    if (selectedNode === null || !tree) return;
    rerootAtNode(tree, selectedNode, ladderize);
    setOffset({ x: 0, y: 0 });
    setVZoom(1); setGZoom(1);
    setTree({ ...tree });
    setShowRangePanel(false);
  };

  const sessionInputRef = useRef<HTMLInputElement>(null);
  const newickInputRef = useRef<HTMLInputElement | null>(null);
  const csvInputRef = useRef<HTMLInputElement | null>(null);

  const handleExportSvg = () => {
    if (!tree || !containerRef.current) return;
    const cont = containerRef.current;
    const W = cont.clientWidth, H = cont.clientHeight;
    const f = (n: number) => n.toFixed(2);
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Rebuild skipNode (same logic as draw())
    const skipNode = new Uint8Array(tree.nodes.length);
    {
      const stk = [tree.root];
      while (stk.length) {
        const id = stk.pop()!;
        if (skipNode[id] === 2) continue;
        const nd = tree.nodes[id];
        if (id !== tree.root && collapsedNodes.has(id)) {
          skipNode[id] = 1;
          const inner = [...nd.children];
          while (inner.length) { const u = inner.pop()!; skipNode[u] = 2; for (const c of tree.nodes[u].children) inner.push(c); }
          continue;
        }
        for (const ch of nd.children) stk.push(ch);
      }
    }

    const effectiveTrackW = getEffectiveTrackWidth();
    const lines: string[] = [];
    lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
    lines.push('<rect width="100%" height="100%" fill="white"/>');

    // Screen-space visibility check (same role as worldVisible in canvas draw)
    const svgMargin = 20;
    const svgVisible = (sx: number, sy: number) =>
      sx >= -svgMargin && sx <= W + svgMargin && sy >= -svgMargin && sy <= H + svgMargin;

    // ── Rect layout ──────────────────────────────────────────────────────────
    if (layout === "rect" && rectLayout) {
      const { coords, height: rectHeight, maxX: rectMaxX } = rectLayout;
      const sx = computeRectSx(W, rectMaxX, effectiveTrackW);
      const sy = (H - 2 * PADDING) / Math.max(1, rectHeight);
      const labelW = showLeafLabels ? LABEL_RESERVE_PX : 0;
      const overlayTrackX = W - PADDING - effectiveTrackW - labelW;
      const overlayLabelX = W - PADDING - labelW + 4;
      const leafSpacingPx = sy * vZoom;
      const cx = W / 2 + offset.x, cy = H / 2 + offset.y;
      const nsX = (nodeX: number) => cx + (-W / 2 + PADDING + sx * nodeX);
      const nsY = (nodeY: number) => cy + vZoom * (-H / 2 + PADDING + sy * nodeY);
      const lw = optBranchThickness;

      // Visible leaf range (same calculation as canvas draw())
      const topWy = (0 - H / 2 - offset.y) / vZoom;
      const bottomWy = (H - H / 2 - offset.y) / vZoom;
      const visLeafStart = clamp(Math.floor((topWy + H / 2 - PADDING) / sy) - 1, 0, tree.leaves.length);
      const visLeafEnd   = clamp(Math.ceil((bottomWy + H / 2 - PADDING) / sy) + 1, 0, tree.leaves.length);

      // Colored ranges
      lines.push('<g id="ranges">');
      for (const r of ranges) {
        const nd = tree.nodes[r.nodeId]; const a = (coords as any)[nd.id];
        const x1 = nsX(a.x), y1 = nsY(nd.L), y2 = nsY(nd.R - 1) + leafSpacingPx;
        lines.push(`<rect x="${f(x1)}" y="${f(y1)}" width="${f(W - x1)}" height="${f(y2 - y1)}" fill="${r.color}" opacity="0.33"/>`);
      }
      lines.push('</g>');

      // Branches — stroked paths, LOD-culled like canvas.
      // vPaths: vertical clade-connector lines (stroke-width = lw)
      // hPaths: horizontal branch-length lines (stroke-width = lw/vZoom)
      const vPaths = new Map<string, string[]>();
      const hPaths = new Map<string, string[]>();
      for (const nd of tree.nodes) {
        if (skipNode[nd.id] === 2) continue;
        if (nd.R <= visLeafStart || nd.L >= visLeafEnd) continue;
        if (nd.id !== tree.root && skipNode[nd.id] === 0) {
          if ((nd.R - nd.L) * sy * vZoom < optLodMinPx && optLodMinPx > 0) continue;
        }
        const a = (coords as any)[nd.id];
        const xp = nsX(a.x), yp = nsY(a.y);
        const cP = nd.support !== undefined ? supportColor(nd.support) : "#333";
        for (const ch of nd.children) {
          if (skipNode[ch] === 2) continue;
          const b = (coords as any)[ch];
          const xc = nsX(b.x), yc = nsY(b.y);
          const cC = tree.nodes[ch].support !== undefined ? supportColor(tree.nodes[ch].support!) : "#333";
          const vh = Math.abs(yc - yp);
          if (vh >= MIN_EDGE_PIXELS) {
            if (!vPaths.has(cP)) vPaths.set(cP, []);
            vPaths.get(cP)!.push(`M ${f(xp)},${f(Math.min(yp, yc))} v ${f(vh)}`);
          }
          const hw = Math.abs(xc - xp);
          if (hw >= MIN_EDGE_PIXELS) {
            if (!hPaths.has(cC)) hPaths.set(cC, []);
            hPaths.get(cC)!.push(`M ${f(Math.min(xp, xc))},${f(yc)} h ${f(hw)}`);
          }
        }
      }
      lines.push('<g id="branches">');
      for (const [color, paths] of vPaths) lines.push(`<path stroke="${color}" stroke-width="${f(lw)}" fill="none" d="${paths.join(" ")}"/>`);
      const swH = f(lw / vZoom);
      for (const [color, paths] of hPaths) lines.push(`<path stroke="${color}" stroke-width="${swH}" fill="none" d="${paths.join(" ")}"/>`);
      lines.push('</g>');

      // Annotation tracks with same LOD as canvas
      if (showTracks && effectiveTrackW > 0) {
        const leafStep = leafSpacingPx > 0 ? Math.max(1, Math.floor(optLodMinPx / leafSpacingPx)) : 1;
        const cellH = Math.max(leafSpacingPx * optBarFill * leafStep, 1);
        lines.push('<g id="annotations">');
        let currentX = overlayTrackX;
        for (const track of trackConfig) {
          if (!track.visible) { currentX += track.height + TRACK_PADDING; continue; }
          const cRects = new Map<string, string[]>();
          for (let i = 0; i < tree.leaves.length; i += leafStep) {
            const leafId = tree.leaves[i];
            if (skipNode[leafId] === 2) continue;
            const sY = H / 2 + offset.y + vZoom * (-H / 2 + PADDING + sy * i);
            if (sY + cellH / 2 < 0 || sY - cellH / 2 > H) continue;
            const row = annotations.get(tree.nodes[leafId].name || "");
            const val = row ? row[track.key] : undefined;
            if (val === null || val === undefined || val === "") continue;
            let color: string, w: number;
            if (track.type === "categorical") { color = colorMaps.get(track.key)?.get(val.toString()) ?? "#aaa"; w = track.height; }
            else { const n = Number(val); if (isNaN(n)) continue; color = "#666"; w = (n / (track.maxVal || 1)) * track.height; }
            if (!cRects.has(color)) cRects.set(color, []);
            cRects.get(color)!.push(`M ${f(currentX)},${f(sY - cellH / 2)} h ${f(w)} v ${f(cellH)} h ${f(-w)} Z`);
          }
          for (const [color, paths] of cRects) lines.push(`<path fill="${color}" d="${paths.join(" ")}"/>`);
          currentX += track.height + TRACK_PADDING;
        }
        lines.push('</g>');
      }

      // Leaf labels — only within visible leaf range
      if (showLeafLabels && leafSpacingPx >= 6) {
        const fz = Math.min(Math.floor(leafSpacingPx * 0.75 * optFontScale), 13 * optFontScale);
        lines.push(`<g id="labels" font-family="sans-serif" font-size="${f(fz)}" fill="#222" dominant-baseline="middle">`);
        for (let i = visLeafStart; i < visLeafEnd; i++) {
          const leafId = tree.leaves[i]; if (skipNode[leafId] === 2) continue;
          const name = tree.nodes[leafId].name; if (!name) continue;
          const sY = H / 2 + offset.y + vZoom * (-H / 2 + PADDING + sy * i);
          if (sY < 0 || sY > H) continue;
          lines.push(`<text x="${f(overlayLabelX)}" y="${f(sY)}">${esc(name)}</text>`);
        }
        lines.push('</g>');
      }

    // ── Circular layout ───────────────────────────────────────────────────────
    } else if (layout === "circular" && rectLayout) {
      const { coords, maxX: rectMaxX } = rectLayout;
      const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
      const N = tree.leaves.length || 1;
      const startAngleDeg = rotation, arcDeg = arc;
      const cx = W / 2 + offset.x, cy = H / 2 + offset.y;
      const gp = (p: { x: number; y: number }) => ({ x: cx + gZoom * p.x, y: cy + gZoom * p.y });
      const getPolar = (id: number) => {
        const pr = (coords as any)[id];
        return rectToPolar(rectMaxX > 0 ? pr.x / rectMaxX : 0, pr.y, N, R, startAngleDeg, arcDeg);
      };
      const { trackStartRadius, trackOuterRadius } = computeCircularTrackRadii(W, H, { coords: coords as any[], maxX: rectMaxX }, R, N, effectiveTrackW);
      const arcRad = (arcDeg * Math.PI) / 180;
      const anglePerLeaf = N > 0 ? arcRad / N : 0;
      const lw = optBranchThickness;

      // Colored ranges
      lines.push('<g id="ranges">');
      for (const r of ranges) {
        const nd = tree.nodes[r.nodeId];
        const a0 = (startAngleDeg * Math.PI) / 180 - (nd.L / N) * arcRad;
        const a1 = (startAngleDeg * Math.PI) / 180 - (nd.R / N) * arcRad;
        const rNode = getPolar(nd.id).radius * gZoom;
        const rOuter = trackOuterRadius * gZoom;
        const large = (a0 - a1) > Math.PI ? 1 : 0;
        const [ox1, oy1] = [cx + rOuter * Math.cos(a1), cy + rOuter * Math.sin(a1)];
        const [ox2, oy2] = [cx + rOuter * Math.cos(a0), cy + rOuter * Math.sin(a0)];
        const [ix1, iy1] = [cx + rNode * Math.cos(a0), cy + rNode * Math.sin(a0)];
        const [ix2, iy2] = [cx + rNode * Math.cos(a1), cy + rNode * Math.sin(a1)];
        lines.push(`<path fill="${r.color}" opacity="0.33" d="M ${f(ox1)},${f(oy1)} A ${f(rOuter)},${f(rOuter)} 0 ${large},1 ${f(ox2)},${f(oy2)} L ${f(ix1)},${f(iy1)} A ${f(rNode)},${f(rNode)} 0 ${large},0 ${f(ix2)},${f(iy2)} Z"/>`);
      }
      lines.push('</g>');

      // Branches — batch by colour, LOD-culled like canvas
      const bPaths = new Map<string, string[]>();
      for (const nd of tree.nodes) {
        if (skipNode[nd.id] === 2) continue;
        // Auto-collapse tiny clades
        if (nd.id !== tree.root && skipNode[nd.id] === 0) {
          if ((nd.R - nd.L) * anglePerLeaf * trackOuterRadius * gZoom < optLodMinPx && optLodMinPx > 0) continue;
        }
        const P = getPolar(nd.id); const Ps = gp(P);
        if (!svgVisible(Ps.x, Ps.y)) continue;
        const cP = nd.support !== undefined ? supportColor(nd.support) : "#333";
        for (const ch of nd.children) {
          if (skipNode[ch] === 2) continue;
          const C = getPolar(ch); const Cs = gp(C);
          if (!svgVisible(Ps.x, Ps.y) && !svgVisible(Cs.x, Cs.y)) continue;
          const cC = tree.nodes[ch].support !== undefined ? supportColor(tree.nodes[ch].support!) : "#333";
          if (P.radius > 0) {
            let da = C.angle - P.angle;
            if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
            const sw = da >= 0 ? 1 : 0;
            const arcR = P.radius * gZoom;
            const ex = cx + arcR * Math.cos(C.angle), ey = cy + arcR * Math.sin(C.angle);
            if (!bPaths.has(cP)) bPaths.set(cP, []);
            bPaths.get(cP)!.push(`M ${f(Ps.x)},${f(Ps.y)} A ${f(arcR)},${f(arcR)} 0 0,${sw} ${f(ex)},${f(ey)}`);
            if (!bPaths.has(cC)) bPaths.set(cC, []);
            bPaths.get(cC)!.push(`M ${f(ex)},${f(ey)} L ${f(Cs.x)},${f(Cs.y)}`);
          } else {
            if (!bPaths.has(cC)) bPaths.set(cC, []);
            bPaths.get(cC)!.push(`M ${f(Ps.x)},${f(Ps.y)} L ${f(Cs.x)},${f(Cs.y)}`);
          }
        }
      }
      lines.push('<g id="branches">');
      for (const [color, paths] of bPaths) lines.push(`<path stroke="${color}" stroke-width="${f(lw)}" fill="none" d="${paths.join(" ")}"/>`);
      lines.push('</g>');

      // Annotation tracks — annular arc segments (matches canvas, supports optBarFill)
      if (showTracks) {
        const leafArcPx = trackOuterRadius * anglePerLeaf * gZoom;
        const leafStep = leafArcPx > 0 ? Math.max(1, Math.floor(optLodMinPx / leafArcPx)) : 1;
        // Collect leaf angles sorted ascending
        const svgLeafData: Array<{ a: number; row: any }> = [];
        for (let idx = 0; idx < tree.leaves.length; idx += leafStep) {
          const leafId = tree.leaves[idx]; if (skipNode[leafId] === 2) continue;
          const { angle } = getPolar(leafId);
          svgLeafData.push({ a: angle, row: annotations.get(tree.nodes[leafId].name || "") });
        }
        svgLeafData.sort((x, y) => x.a - y.a);
        lines.push('<g id="annotations">');
        if (svgLeafData.length > 0) {
          const svgMaxSegAngle = arcDeg < 360 ? 1.5 * (arcRad / svgLeafData.length) : Infinity;
          let curR = trackStartRadius;
          for (const track of trackConfig) {
            if (!track.visible) { curR += track.height + TRACK_PADDING; continue; }
            const r1s = curR * gZoom, r2s = (curR + track.height) * gZoom;
            const cPaths = new Map<string, string[]>();
            for (let i = 0; i < svgLeafData.length; i++) {
              const { a, row } = svgLeafData[i];
              const nextRaw = svgLeafData[(i + 1) % svgLeafData.length].a;
              const a2full = nextRaw > a ? nextRaw : nextRaw + 2 * Math.PI;
              if (a2full - a > svgMaxSegAngle) continue;
              const a2 = a + (a2full - a) * optBarFill;
              const val = row ? row[track.key] : undefined;
              if (val === null || val === undefined || val === "") continue;
              let color: string, rEnd = r1s;
              if (track.type === "categorical") { color = colorMaps.get(track.key)?.get(val.toString()) ?? "#aaa"; }
              else { const n = Number(val); if (isNaN(n)) continue; rEnd = r1s + Math.min(1, Math.max(0, n / (track.maxVal || 1))) * (r2s - r1s); color = "#666"; }
              if (!cPaths.has(color)) cPaths.set(color, []);
              // SVG annular arc: outer arc CW (sweep=1), inner arc CCW (sweep=0)
              let da = a2 - a; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
              const sf = da >= 0 ? 1 : 0;
              const large = Math.abs(da) > Math.PI ? 1 : 0;
              const [ox1, oy1] = [f(cx + r2s * Math.cos(a)), f(cy + r2s * Math.sin(a))];
              const [ox2, oy2] = [f(cx + r2s * Math.cos(a2)), f(cy + r2s * Math.sin(a2))];
              const [ix1, iy1] = [f(cx + rEnd * Math.cos(a2)), f(cy + rEnd * Math.sin(a2))];
              const [ix2, iy2] = [f(cx + rEnd * Math.cos(a)), f(cy + rEnd * Math.sin(a))];
              cPaths.get(color)!.push(`M ${ox1},${oy1} A ${f(r2s)},${f(r2s)} 0 ${large},${sf} ${ox2},${oy2} L ${ix1},${iy1} A ${f(rEnd)},${f(rEnd)} 0 ${large},${sf ^ 1} ${ix2},${iy2} Z`);
            }
            for (const [color, paths] of cPaths) lines.push(`<path fill="${color}" d="${paths.join(" ")}"/>`);
            curR += track.height + TRACK_PADDING;
          }
        }
        lines.push('</g>');
      }

      // Leaf labels
      if (showLeafLabels) {
        const labelR = trackOuterRadius + 6 / gZoom;
        const labelSpacingPx = labelR * anglePerLeaf * gZoom;
        if (labelSpacingPx >= 6) {
          const fz = Math.min(Math.floor(labelSpacingPx * 0.75 * optFontScale), 13 * optFontScale);
          lines.push(`<g id="labels" font-family="sans-serif" font-size="${f(fz)}" fill="#222" dominant-baseline="middle">`);
          for (let i = 0; i < tree.leaves.length; i++) {
            const leafId = tree.leaves[i]; if (skipNode[leafId] === 2) continue;
            const name = tree.nodes[leafId].name; if (!name) continue;
            const { angle } = getPolar(leafId);
            const lx = cx + labelR * gZoom * Math.cos(angle), ly = cy + labelR * gZoom * Math.sin(angle);
            if (!svgVisible(lx, ly)) continue;
            const cosA = Math.cos(angle);
            const ta = cosA >= 0 ? "start" : "end";
            const rot = cosA >= 0 ? angle * 180 / Math.PI : angle * 180 / Math.PI + 180;
            lines.push(`<text x="${f(lx)}" y="${f(ly)}" text-anchor="${ta}" transform="rotate(${f(rot)},${f(lx)},${f(ly)})">${esc(name)}</text>`);
          }
          lines.push('</g>');
        }
      }

    // ── Unrooted layout ───────────────────────────────────────────────────────
    } else if (layout === "unrooted" && unrootedLayout) {
      const { coords, maxR: computedMaxR } = unrootedLayout;
      const R = (Math.min(W, H) * CIRC_RADIUS_FRACTION) / (computedMaxR || 1);
      const cx = W / 2 + offset.x, cy = H / 2 + offset.y;
      const ns = (id: number) => ({ x: cx + gZoom * coords[id].x * R, y: cy + gZoom * coords[id].y * R });
      const { ringR, trackOuterRingR } = computeUnrootedTrackRadii(W, H, { coords, maxR: computedMaxR }, R, effectiveTrackW);
      const lw = optBranchThickness;
      const N = tree.leaves.length || 1;
      const anglePerLeaf = (2 * Math.PI) / N;

      // Colored ranges — convex hull of leaf positions + clade root
      lines.push('<g id="ranges">');
      for (const r of ranges) {
        const nd = tree.nodes[r.nodeId];
        if (!nd) continue;
        const points: [number, number][] = [];
        for (let i = nd.L; i < nd.R; i++) {
          const leafId = tree.leaves[i];
          const p = coords[leafId];
          points.push([p.x * R, p.y * R]);
        }
        points.push([coords[nd.id].x * R, coords[nd.id].y * R]);
        const hull = d3.polygonHull(points);
        if (!hull) continue;
        const hullPts = hull.map(([hx, hy]) => `${f(cx + gZoom * hx)},${f(cy + gZoom * hy)}`).join(" ");
        lines.push(`<polygon fill="${r.color}" opacity="0.33" points="${hullPts}"/>`);
      }
      lines.push('</g>');

      // Branches — batch by colour, LOD-culled like canvas
      const bPaths = new Map<string, string[]>();
      for (const nd of tree.nodes) {
        if (skipNode[nd.id] === 2) continue;
        // Auto-collapse tiny clades (same as canvas)
        if (nd.id !== tree.root && skipNode[nd.id] === 0) {
          if ((nd.R - nd.L) * anglePerLeaf * trackOuterRingR * gZoom < optLodMinPx && optLodMinPx > 0) continue;
        }
        const p = ns(nd.id);
        for (const ch of nd.children) {
          if (skipNode[ch] === 2) continue;
          const c = ns(ch);
          if (!svgVisible(p.x, p.y) && !svgVisible(c.x, c.y)) continue;
          const segLen = Math.hypot(c.x - p.x, c.y - p.y);
          if (segLen <= MIN_SEG_PX) continue;
          const color = tree.nodes[ch].support !== undefined ? supportColor(tree.nodes[ch].support!) : "#333";
          if (!bPaths.has(color)) bPaths.set(color, []);
          bPaths.get(color)!.push(`M ${f(p.x)},${f(p.y)} L ${f(c.x)},${f(c.y)}`);
        }
      }
      lines.push('<g id="branches">');
      for (const [color, paths] of bPaths) lines.push(`<path stroke="${color}" stroke-width="${f(lw)}" fill="none" d="${paths.join(" ")}"/>`);
      lines.push('</g>');

      // Annotation ring — arc segments, LOD-thinned, batched by colour
      if (showTracks) {
        const sortedLeafIds = tree.leaves
          .filter(id => skipNode[id] !== 2)
          .slice()
          .sort((a, b) => coords[a].angle - coords[b].angle);
        if (sortedLeafIds.length > 0) {
          const arcPerLeaf = (2 * Math.PI) / sortedLeafIds.length;
          let curR = ringR;
          lines.push('<g id="annotations">');
          for (const track of trackConfig) {
            if (!track.visible) { curR += track.height + TRACK_PADDING; continue; }
            const r1s = curR * gZoom, r2s = (curR + track.height) * gZoom;
            const arcPx = curR * arcPerLeaf * gZoom;
            const leafStep = Math.max(1, Math.floor(optLodMinPx / Math.max(arcPx, 1e-9)));
            const cPaths = new Map<string, string[]>();
            for (let i = 0; i < sortedLeafIds.length; i += leafStep) {
              const idA = sortedLeafIds[i];
              const idB = sortedLeafIds[(i + leafStep) % sortedLeafIds.length];
              const nd = tree.nodes[idA];
              const row = annotations.get(nd.name || "");
              const val = row ? row[track.key] : undefined;
              if (val === null || val === undefined || val === "") continue;
              let color: string;
              if (track.type === "categorical") { color = colorMaps.get(track.key)?.get(val.toString()) ?? "#aaa"; }
              else { const n = Number(val); if (isNaN(n)) continue; const t = Math.min(1, Math.max(0, n / (track.maxVal || 1))); color = `rgba(80,80,80,${(0.1 + t * 0.85).toFixed(2)})`; }
              const a1 = coords[idA].angle;
              const a2raw = coords[idB].angle;
              const a2 = a2raw > a1 ? a2raw : a2raw + 2 * Math.PI;
              const large = (a2 - a1) > Math.PI ? 1 : 0;
              const [ox1, oy1] = [cx + r2s * Math.cos(a1), cy + r2s * Math.sin(a1)];
              const [ox2, oy2] = [cx + r2s * Math.cos(a2), cy + r2s * Math.sin(a2)];
              const [ix1, iy1] = [cx + r1s * Math.cos(a2), cy + r1s * Math.sin(a2)];
              const [ix2, iy2] = [cx + r1s * Math.cos(a1), cy + r1s * Math.sin(a1)];
              if (!cPaths.has(color)) cPaths.set(color, []);
              cPaths.get(color)!.push(`M ${f(ox1)},${f(oy1)} A ${f(r2s)},${f(r2s)} 0 ${large},1 ${f(ox2)},${f(oy2)} L ${f(ix1)},${f(iy1)} A ${f(r1s)},${f(r1s)} 0 ${large},0 ${f(ix2)},${f(iy2)} Z`);
            }
            for (const [color, paths] of cPaths) lines.push(`<path fill="${color}" d="${paths.join(" ")}"/>`);
            curR += track.height + TRACK_PADDING;
          }
          lines.push('</g>');
        }
      }

      // Leaf labels
      if (showLeafLabels) {
        const arcPerLeaf = tree.leaves.length > 0 ? (2 * Math.PI) / tree.leaves.length : 0;
        const labelSpacingPx = ringR * arcPerLeaf * gZoom;
        if (labelSpacingPx >= 6) {
          const fz = Math.min(Math.floor(labelSpacingPx * 0.75 * optFontScale), 13 * optFontScale);
          const labelOffsetPx = (effectiveTrackW + trackOffset) * gZoom + 6;
          lines.push(`<g id="labels" font-family="sans-serif" font-size="${f(fz)}" fill="#222" dominant-baseline="middle">`);
          for (const leafId of tree.leaves) {
            if (skipNode[leafId] === 2) continue;
            const name = tree.nodes[leafId].name; if (!name) continue;
            const p = coords[leafId];
            const tipDist = Math.hypot(p.x, p.y) * R * gZoom;
            const angle = Math.atan2(p.y, p.x);
            const lx = cx + (tipDist + labelOffsetPx) * Math.cos(angle);
            const ly = cy + (tipDist + labelOffsetPx) * Math.sin(angle);
            if (!svgVisible(lx, ly)) continue;
            const cosA = Math.cos(angle);
            const ta = cosA >= 0 ? "start" : "end";
            const rot = cosA >= 0 ? angle * 180 / Math.PI : angle * 180 / Math.PI + 180;
            lines.push(`<text x="${f(lx)}" y="${f(ly)}" text-anchor="${ta}" transform="rotate(${f(rot)},${f(lx)},${f(ly)})">${esc(name)}</text>`);
          }
          lines.push('</g>');
        }
      }
    }

    lines.push("</svg>");
    const blob = new Blob([lines.join("\n")], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tree.svg";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleExportPng = () => {
    const canvas = canvasRef.current;
    const cont = containerRef.current;
    if (!canvas || !cont) return;
    if (exportScale === 1) {
      const url = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = "tree.png";
      a.click();
    } else {
      const W = cont.clientWidth * exportScale;
      const H = cont.clientHeight * exportScale;
      const offscreen = document.createElement("canvas");
      offscreen.width = W;
      offscreen.height = H;
      const ctx2 = offscreen.getContext("2d")!;
      ctx2.scale(exportScale, exportScale);
      ctx2.drawImage(canvas, 0, 0, cont.clientWidth, cont.clientHeight);
      const url = offscreen.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `tree-${exportScale}x.png`;
      a.click();
    }
  };

  const loadExample = async () => {
    setCollapsedNodes(new Set());
    setRanges([]);
    setSelectedNode(null);
    setNewickFile(new File([exampleNewick], "RTtree.nwk", { type: "text/plain" }));
    // Replace any loaded annotation files with the example file.
    const exFile = new File([exampleCsv], "RTtreelabels.csv", { type: "text/csv" });
    try {
      const { rows, columns } = await parseAnnotations(exFile);
      setAnnotationFiles([{ name: exFile.name, rows, columns }]);
    } catch (e) {
      console.error("Failed to parse example annotations:", e);
    }
  };

  const handleSaveSession = () => {
    if (!tree || !newickText) return;
    const session = {
      version: 1,
      newickText,
      layout, phylogram, ladderize, rotation, arc, hSpan,
      vZoom, gZoom, offset,
      showLeafLabels, showTracks, trackOffset, trackOffsetMode,
      trackConfig,
      colorMaps: Object.fromEntries(
        [...colorMaps.entries()].map(([k, v]) => [k, Object.fromEntries(v)])
      ),
      collapsedFingerprints: [...collapsedNodes].map((id) => nodeToFingerprint(tree, id)),
      ranges: ranges.map((r) => ({ fp: nodeToFingerprint(tree, r.nodeId), color: r.color, label: r.label })),
      hiddenLeafNames: [...hiddenLeafNames],
    };
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tree-session.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleLoadSession = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    file.text().then((text) => {
      try {
        const s = JSON.parse(text);
        if (s.newickText) {
          remapCollapsedRef.current = s.collapsedFingerprints ?? [];
          remapRangesRef.current = s.ranges ?? [];
          remapPendingRef.current = true;
          setHiddenLeafNames(new Set(s.hiddenLeafNames ?? []));
          setNewickText(s.newickText);
        }
        if (s.layout) setLayout(s.layout);
        if (s.phylogram !== undefined) setPhylogram(s.phylogram);
        if (s.ladderize) setLadderize(s.ladderize);
        if (s.rotation !== undefined) setRotation(s.rotation);
        if (s.arc !== undefined) setArc(s.arc);
        if (s.hSpan !== undefined) setHSpan(s.hSpan);
        if (s.vZoom !== undefined) setVZoom(s.vZoom);
        if (s.gZoom !== undefined) setGZoom(s.gZoom);
        if (s.offset) setOffset(s.offset);
        if (s.showLeafLabels !== undefined) setShowLeafLabels(s.showLeafLabels);
        if (s.showTracks !== undefined) setShowTracks(s.showTracks);
        if (s.trackOffset !== undefined) setTrackOffset(s.trackOffset);
        if (s.trackOffsetMode) setTrackOffsetMode(s.trackOffsetMode);
        if (s.trackConfig) setTrackConfig(s.trackConfig);
        if (s.colorMaps) {
          const cm = new Map<string, Map<string, string>>();
          for (const [k, v] of Object.entries(s.colorMaps)) {
            cm.set(k, new Map(Object.entries(v as Record<string, string>)));
          }
          setColorMaps(cm);
        }
      } catch (err) {
        console.error("Failed to load session:", err);
      }
    });
  };

  const handleResetTree = () => {
    setCollapsedNodes(new Set());
    setHiddenLeafNames(new Set());
    setRanges([]);
    setSelectedNode(null);
    setShowRangePanel(false);
    setOffset({ x: 0, y: 0 });
    setVZoom(1);
    setGZoom(1);
  };

  const handleMidpointRoot = () => {
    if (!tree) return;
    const n = tree.nodes.length;
    if (n === 0 || tree.leaves.length === 0) return;

    const adj: Array<Array<{ to: number; len: number }>> = Array.from({ length: n }, () => []);
    for (const nd of tree.nodes) {
      for (const ch of nd.children) {
        const len = tree.nodes[ch].length;
        adj[nd.id].push({ to: ch, len });
        adj[ch].push({ to: nd.id, len });
      }
    }

    const dfsDistances = (start: number) => {
      const dist = new Float64Array(n);
      dist.fill(NaN);
      dist[start] = 0;
      (function rec(u: number, parent: number) {
        for (const e of adj[u]) {
          if (e.to === parent) continue;
          dist[e.to] = dist[u] + e.len;
          rec(e.to, u);
        }
      })(start, -1);
      return dist;
    };

    const leaves = tree.leaves;
    const distA = dfsDistances(leaves[0]);
    let leafB = leaves[0]; let maxD = -1;
    for (const leaf of leaves) { const d = distA[leaf]; if (d > maxD) { maxD = d; leafB = leaf; } }

    const distB = dfsDistances(leafB);
    let leafC = leafB; maxD = -1;
    for (const leaf of leaves) { const d = distB[leaf]; if (d > maxD) { maxD = d; leafC = leaf; } }

    const diameter = maxD;
    if (!isFinite(diameter) || diameter <= 0) return;
    const target = diameter / 2;

    const path: number[] = [];
    function dfsPath(u: number, parent: number): boolean {
      if (u === leafC) { path.push(u); return true; }
      for (const e of adj[u]) {
        if (e.to === parent) continue;
        if (dfsPath(e.to, u)) { path.push(u); return true; }
      }
      return false;
    }
    dfsPath(leafB, -1);
    path.reverse();
    if (path.length === 0) return;

    let accum = 0, midNode = path[0];
    for (let i = 0; i < path.length - 1; i++) {
      const edge = adj[path[i]].find((e) => e.to === path[i + 1]);
      const len = edge ? edge.len : 0;
      if (accum + len >= target) { midNode = target - accum > accum + len - target ? path[i + 1] : path[i]; break; }
      accum += len;
    }

    rerootAtNode(tree, midNode, ladderize);
    setOffset({ x: 0, y: 0 }); setVZoom(1); setGZoom(1);
    setTree({ ...tree });
  };

  const getMostCommonCategory = (nodeId: number, trackKey: string): { color: string; name: string } => {
    if (!tree) return { color: "#ffe08a", name: "" };
    const nd = tree.nodes[nodeId];
    const counts = new Map<string, number>();
    for (let i = nd.L; i < nd.R; i++) {
      const name = tree.nodes[tree.leaves[i]].name || "";
      const row = annotations.get(name);
      const val = row?.[trackKey]?.toString();
      if (val !== undefined && val !== "") counts.set(val, (counts.get(val) ?? 0) + 1);
    }
    let bestCat = "", bestCount = 0;
    for (const [cat, count] of counts) { if (count > bestCount) { bestCount = count; bestCat = cat; } }
    return { color: colorMaps.get(trackKey)?.get(bestCat) ?? "#ffe08a", name: bestCat };
  };

  const handleColorRangeClick = () => {
    if (selectedNode === null) return;
    if (showRangePanel) { setShowRangePanel(false); setEditingRangeIndex(null); }
    else {
      setEditingRangeIndex(null);
      const { color: defaultColor, name: defaultName } = rangeColorTrackKey
        ? getMostCommonCategory(selectedNode, rangeColorTrackKey)
        : { color: "#ffe08a", name: "" };
      setActiveRangeColor(defaultColor);
      setActiveRangeLabel(defaultName);
      setShowRangePanel(true);
    }
  };

  const confirmColorRange = () => {
    if (selectedNode === null) return;
    const newRange = { nodeId: selectedNode, color: activeRangeColor, label: activeRangeLabel };
    if (editingRangeIndex !== null) {
      const newRanges = [...ranges]; newRanges[editingRangeIndex] = newRange; setRanges(newRanges);
    } else {
      setRanges((prev) => [newRange, ...prev]);
    }
    setShowRangePanel(false); setEditingRangeIndex(null);
  };

  const getSelectedLeaves = (): string[] => {
    if (selectedNode === null || !tree) return [];
    const nd = tree.nodes[selectedNode];
    const names: string[] = [];
    for (let i = nd.L; i < nd.R; i++) {
      const name = tree.nodes[tree.leaves[i]].name;
      if (name) names.push(name);
    }
    return names;
  };

  const handleSaveSelection = () => {
    const names = getSelectedLeaves();
    if (!names.length) return;
    const url = URL.createObjectURL(new Blob([names.join("\n")], { type: "text/plain" }));
    const aEl = document.createElement("a");
    aEl.href = url; aEl.download = "leaves.txt"; aEl.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveLeavesInRanges = () => {
    if (!tree) return;
    ranges.forEach((r, idx) => {
      const nd = tree.nodes[r.nodeId];
      if (!nd) return;
      const names: string[] = [];
      for (let i = nd.L; i < nd.R; i++) {
        const name = tree.nodes[tree.leaves[i]].name;
        if (name) names.push(name);
      }
      if (!names.length) return;
      const filename = (r.label ? r.label.trim() : `range_${r.nodeId}`) + ".txt";
      setTimeout(() => {
        const url = URL.createObjectURL(new Blob([names.join("\n")], { type: "text/plain" }));
        const aEl = document.createElement("a");
        aEl.href = url; aEl.download = filename; aEl.click();
        URL.revokeObjectURL(url);
      }, idx * 200);
    });
  };

  const handleCopyLeaves = () => {
    const names = getSelectedLeaves();
    if (!names.length) return;
    navigator.clipboard.writeText(names.join("\n")).catch((err) => console.error("Failed to copy:", err));
  };

  const handlePercentToggle = (isChecked: boolean) => {
    setSupportAsPercent(isChecked);
    const factor = isChecked ? 100 : 1 / 100;
    setSupportV0((v) => v * factor); setSupportV1((v) => v * factor); setSupportV2((v) => v * factor);
  };

  const selectedNodeInfo = selectedNode !== null && tree ? tree.nodes[selectedNode] : null;

  const handleCollapseSelected = () => {
    if (selectedNode === null || !tree || selectedNode === tree.root) return;
    setCollapsedNodes((prev) => { const next = new Set(prev); next.add(selectedNode); return next; });
  };

  // Rebuild the tree without the selected subtree's leaves.
  // The layout recomputes so spacing is correct in all three modes.
  const handleHideSelected = () => {
    if (selectedNode === null || !tree) return;
    const nd = tree.nodes[selectedNode];
    const toHide = new Set<string>();
    for (let i = nd.L; i < nd.R; i++) {
      const name = tree.nodes[tree.leaves[i]].name;
      if (name) toHide.add(name);
    }
    if (toHide.size === 0) return;
    remapCollapsedRef.current = [...collapsedNodes].map((id) => nodeToFingerprint(tree, id));
    remapRangesRef.current = ranges.map((r) => ({ fp: nodeToFingerprint(tree, r.nodeId), color: r.color, label: r.label }));
    remapPendingRef.current = true;
    setHiddenLeafNames((prev) => new Set([...prev, ...toHide]));
  };

  // Rebuild the tree with ONLY the selected subtree's leaves visible.
  // Everything else is structurally removed, giving a clean focused view.
  const handleShowOnly = () => {
    if (selectedNode === null || !tree) return;
    const nd = tree.nodes[selectedNode];
    const keepNames = new Set<string>();
    for (let i = nd.L; i < nd.R; i++) {
      const name = tree.nodes[tree.leaves[i]].name;
      if (name) keepNames.add(name);
    }
    const hideNames = new Set<string>();
    for (const leafId of tree.leaves) {
      const name = tree.nodes[leafId].name;
      if (name && !keepNames.has(name)) hideNames.add(name);
    }
    remapCollapsedRef.current = [...collapsedNodes].map((id) => nodeToFingerprint(tree, id));
    remapRangesRef.current = ranges.map((r) => ({ fp: nodeToFingerprint(tree, r.nodeId), color: r.color, label: r.label }));
    remapPendingRef.current = true;
    // Union with existing hidden leaves so serial "show only" keeps narrowing the view
    setHiddenLeafNames((prev) => new Set([...prev, ...hideNames]));
  };

  // ==========================================================
  // Hover clade stats
  // ==========================================================

  const hoverCladeStats = useMemo(() => {
    if (hoverNode === null || !tree) return null;
    const catTracks = trackConfig.filter((t) => t.type === "categorical" && t.visible);
    if (catTracks.length === 0) return null;
    const nd = tree.nodes[hoverNode];
    const counts = new Map<string, Map<string, number>>();
    catTracks.forEach((t) => counts.set(t.key, new Map()));
    for (let i = nd.L; i < nd.R; i++) {
      const name = tree.nodes[tree.leaves[i]].name;
      if (!name) continue;
      const row = annotations.get(name);
      if (!row) continue;
      for (const t of catTracks) {
        const val = row[t.key];
        if (val !== undefined && val !== null && val !== "") {
          const sVal = String(val);
          const m = counts.get(t.key)!;
          m.set(sVal, (m.get(sVal) || 0) + 1);
        }
      }
    }
    return catTracks.map((t) => {
      const m = counts.get(t.key)!;
      const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      const labelledCount = [...m.values()].reduce((s, v) => s + v, 0);
      return { key: t.key, label: t.label || t.key, topValues: sorted, totalLeaves: nd.R - nd.L, labelledCount };
    }).filter((g) => g.topValues.length > 0);
  }, [hoverNode, tree, annotations, trackConfig]);

  // ==========================================================
  // Search
  // ==========================================================

  const leafNameToId = useMemo(() => {
    const m = new Map<string, number>();
    if (!tree) return m;
    for (const id of tree.leaves) {
      const nm = tree.nodes[id].name;
      if (nm && !m.has(nm)) m.set(nm, id);
    }
    return m;
  }, [tree]);

  // Sorted by lowercased name — O(N log N) fast ASCII sort, much faster than localeCompare for large trees.
  const allLeafNames = useMemo(() => {
    const names = Array.from(leafNameToId.keys());
    names.sort((a, b) => { const al = a.toLowerCase(), bl = b.toLowerCase(); return al < bl ? -1 : al > bl ? 1 : 0; });
    return names;
  }, [leafNameToId]);

  useEffect(() => {
    if (!searchText.trim() || allLeafNames.length === 0) { setSuggestions([]); setSuggestIx(-1); return; }
    const q = searchText.trim().toLowerCase();
    const MAX = 50;

    // Binary search for first name whose lowercase >= q (O(log N) prefix lookup)
    let lo = 0, hi = allLeafNames.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allLeafNames[mid].toLowerCase() < q) lo = mid + 1; else hi = mid; }
    const starts: string[] = [];
    for (let i = lo; i < allLeafNames.length && starts.length < MAX; i++) {
      if (!allLeafNames[i].toLowerCase().startsWith(q)) break;
      starts.push(allLeafNames[i]);
    }

    // Contains search — scan once, stop as soon as we have MAX total
    const leftover = MAX - starts.length;
    const contains: string[] = [];
    if (leftover > 0) {
      for (const name of allLeafNames) {
        const lc = name.toLowerCase();
        if (!lc.startsWith(q) && lc.includes(q)) {
          contains.push(name);
          if (contains.length >= leftover) break;
        }
      }
    }
    const list = [...starts, ...contains];
    setSuggestions(list);
    setSuggestIx(list.length ? 0 : -1);
  }, [searchText, allLeafNames]);

  const focusLeafByName = useCallback((name: string) => {
    if (!tree || !rectLayout || !containerRef.current) return;
    const id = leafNameToId.get(name);
    if (id == null) return;
    setSelectedNode(id);
    const W = containerRef.current.clientWidth;
    const H = containerRef.current.clientHeight;

    if (layout === "rect") {
      const { coords, height, maxX } = rectLayout;
      const sx = computeRectSx(W, maxX, getEffectiveTrackWidth());
      const sy = (H - 2 * PADDING) / Math.max(1, height);
      const p = (coords as any)[id];
      setOffset({ x: -(-W / 2 + PADDING + sx * p.x), y: -vZoom * (-H / 2 + PADDING + sy * p.y) });
    } else if (layout === "circular") {
      const N = tree.leaves.length || 1;
      const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
      const aRect = (rectLayout.coords as any)[id];
      const P = rectToPolar(rectLayout.maxX > 0 ? aRect.x / rectLayout.maxX : 0, aRect.y, N, R, rotation, arc);
      setOffset({ x: -gZoom * P.x, y: -gZoom * P.y });
    } else if (layout === "unrooted" && unrootedLayout) {
      const { coords, maxR } = unrootedLayout;
      const R = (Math.min(W, H) * CIRC_RADIUS_FRACTION) / (maxR || 1);
      const p = coords[id];
      setOffset({ x: -gZoom * (p.x * R), y: -gZoom * (p.y * R) });
    }
    setShowSuggests(false); setSuggestions([]);
  }, [tree, rectLayout, unrootedLayout, layout, phylogram, hSpan, vZoom, gZoom, rotation, arc, leafNameToId]);

  useEffect(() => {
    const onDocClick = () => setShowSuggests(false);
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  // ==========================================================
  // Render
  // ==========================================================

  return (
    <div className="app-container">
      {/* Panel show button (visible only when panel is hidden) */}
      {!panelVisible && (
        <button
          type="button"
          className="panel-show-btn"
          onClick={() => setPanelVisible(true)}
          title="Show panel"
        >☰</button>
      )}

      {/* Left control panel */}
      <div className="panel" style={{ display: panelVisible ? undefined : "none" }}>

        {/* Panel header */}
        <div className="panel-header">
          <span style={{ fontWeight: 600, fontSize: 14 }}>myTOL</span>
          <button type="button" className="btn" onClick={() => setPanelVisible(false)} title="Hide panel" style={{ padding: "0 6px" }}>✕</button>
        </div>

        {/* ── SECTION: Load ── */}
        <div className="section-header" onClick={() => toggleSection("files")}>
          <span>Load</span><span>{sectionOpen.files ? "▲" : "▼"}</span>
        </div>
        {sectionOpen.files && (<>
          <div className="row">
            <label className="label">Tree (Newick)</label>
            <div className="file-input-row">
              <button type="button" className="btn" onClick={() => newickInputRef.current?.click()}>Choose file…</button>
              <span className="note file-input-name">{newickFile?.name ?? "No file chosen"}</span>
              <input type="file" ref={newickInputRef} accept=".nwk,.newick,.tree,.treefile,.txt" style={{ display: "none" }} onChange={(e) => setNewickFile(e.target.files?.[0] || null)} />
            </div>
            {tree && (
              <div className="note" style={{ marginTop: 4 }}>
                {tree.leaves.length.toLocaleString()} leaves · {tree.nodes.length.toLocaleString()} nodes
              </div>
            )}
          </div>
          <div className="row">
            <label className="label">Annotations (CSV/TSV)</label>
            <div className="file-input-row">
              <button type="button" className="btn" onClick={() => csvInputRef.current?.click()}>
                {annotationFiles.length > 0 ? "Add file…" : "Choose file…"}
              </button>
              <span className="note file-input-name">
                {annotationFiles.length === 0
                  ? "No file chosen"
                  : `${annotationFiles.length} file${annotationFiles.length === 1 ? "" : "s"} loaded`}
              </span>
              <input
                type="file"
                ref={csvInputRef}
                accept=".csv,.tsv"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) addAnnotationFile(file);
                  e.target.value = "";
                }}
              />
            </div>
            {annotationFiles.length > 0 && (
              <div style={{ marginTop: 4 }}>
                {annotationFiles.map((f, idx) => (
                  <span key={idx} className="chip" title={`${f.rows.length} rows · ${f.columns.length} columns`}>
                    <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.name}
                    </span>
                    <button
                      className="btn"
                      onClick={() => removeAnnotationFile(idx)}
                      title="Close this annotation file"
                    >×</button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="row">
            <button type="button" className="btn" style={{ width: "100%" }} onClick={loadExample}>
              Load example data
            </button>
          </div>
          <div className="row" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={handleSaveSession} disabled={!tree}>Save session</button>
            <button type="button" className="btn" onClick={() => sessionInputRef.current?.click()}>Load session</button>
            <input type="file" accept=".json" ref={sessionInputRef} style={{ display: "none" }} onChange={handleLoadSession} />
          </div>
        </>)}

        {/* ── SECTION: Export ── */}
        <div className="section-header" onClick={() => toggleSection("export")}>
          <span>Export</span><span>{sectionOpen.export ? "▲" : "▼"}</span>
        </div>
        {sectionOpen.export && (
          <div className="row">
            <div style={{ marginBottom: 6 }}>
              <label className="label" style={{ marginBottom: 4 }}>PNG</label>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
                {[1, 2, 4, 6, 8, 12, 16].map(s => (
                  <button
                    key={s}
                    type="button"
                    className={"btn" + (exportScale === s ? " active" : "")}
                    style={{ padding: "2px 6px", fontSize: 11 }}
                    onClick={() => setExportScale(s)}
                  >{s}×</button>
                ))}
              </div>
              <button type="button" className="btn" onClick={handleExportPng} disabled={!tree}>Export PNG</button>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 4 }}>SVG</label>
              <button type="button" className="btn" onClick={handleExportSvg} disabled={!tree}>Export SVG</button>
            </div>
          </div>
        )}

        {/* ── SECTION: Coloured Ranges ── */}
        <div className="section-header" onClick={() => toggleSection("ranges")}>
          <span>Coloured Ranges{ranges.length > 0 ? ` (${ranges.length})` : ""}</span>
          <span>{sectionOpen.ranges ? "▲" : "▼"}</span>
        </div>
        {sectionOpen.ranges && (
          <div className="row">
            <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
              {(["background", "branches"] as const).map((mode) => (
                <button
                  key={mode}
                  className={`btn${rangeDisplayMode === mode ? " active" : ""}`}
                  onClick={() => setRangeDisplayMode(mode)}
                  style={{ flex: 1, fontSize: 12 }}
                >
                  {mode === "background" ? "Background" : "Colour branches"}
                </button>
              ))}
            </div>
            {ranges.length === 0 ? (
              <div className="note">No ranges yet. Select a node and press <kbd>C</kbd>.</div>
            ) : (<>
              <div>
                {ranges.map((r, idx) => (
                  <span
                    key={idx}
                    className="chip"
                    onClick={() => {
                      setSelectedNode(r.nodeId);
                      setActiveRangeColor(r.color);
                      setActiveRangeLabel(r.label || "");
                      setEditingRangeIndex(idx);
                      setShowRangePanel(true);
                    }}
                  >
                    <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 2, background: r.color }} />
                    {r.label || `Node ${r.nodeId}`}
                    <button className="btn" onClick={(e) => { e.stopPropagation(); setRanges((prev) => prev.filter((_, i) => i !== idx)); }}>×</button>
                  </span>
                ))}
              </div>
              <div style={{ marginTop: 6 }}>
                <button className="btn" onClick={handleSaveLeavesInRanges}>Save leaves in ranges</button>
              </div>
            </>)}
          </div>
        )}

        <div className="row">
          <label className="label">Search leaf</label>
          <div className="search-box">
            <input
              type="text"
              value={searchText}
              placeholder="Type leaf name…"
              onChange={(e) => { setSearchText(e.target.value); setShowSuggests(true); }}
              onFocus={() => setShowSuggests(true)}
              onKeyDown={(e) => {
                if (!showSuggests && (e.key === "ArrowDown" || e.key === "ArrowUp")) setShowSuggests(true);
                if (e.key === "ArrowDown") { e.preventDefault(); setSuggestIx((i) => Math.min((i < 0 ? -1 : i) + 1, suggestions.length - 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setSuggestIx((i) => Math.max((i < 0 ? suggestions.length : i) - 1, 0)); }
                else if (e.key === "Enter") {
                  e.preventDefault();
                  const choice = (suggestIx >= 0 && suggestions[suggestIx]) || searchText.trim();
                  if (choice && leafNameToId.has(choice)) focusLeafByName(choice);
                } else if (e.key === "Escape") setShowSuggests(false);
              }}
            />
            {!!searchText && (
              <button type="button" className="search-clear" onClick={() => { setSearchText(""); setSuggestions([]); setSuggestIx(-1); setShowSuggests(false); }} aria-label="Clear search">×</button>
            )}
            {showSuggests && suggestions.length > 0 && (
              <div className="search-suggest-list" onMouseDown={(e) => e.preventDefault()}>
                {suggestions.map((s, i) => (
                  <div key={`${s}-${i}`} className={"search-suggest-item" + (i === suggestIx ? " active" : "")} onMouseEnter={() => setSuggestIx(i)} onMouseDown={() => { setSearchText(s); focusLeafByName(s); }}>
                    {s}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>


        {/* Selection panel */}
        {selectedNodeInfo && (
          <div className="row selection-panel">
            <div className="label-row">
              <span className="label">Selection: Node {selectedNodeInfo.id}</span>
              <button onClick={() => { setSelectedNode(null); setShowRangePanel(false); }} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 16 }}>×</button>
            </div>
            <div className="selection-info">
              <strong>Leaves:</strong> {(selectedNodeInfo as any).leaves ?? selectedNodeInfo.R - selectedNodeInfo.L}<br />
              <strong>Length:</strong> {selectedNodeInfo.length.toFixed(4)}<br />
              <strong>Support:</strong> {selectedNodeInfo.support ?? "N/A"}
            </div>
            <div className="selection-actions">
              <button className="btn active" onClick={handleColorRangeClick}>{showRangePanel ? "Cancel Range" : "Colour Range"} (C)</button>
              <button className="btn" onClick={handleSaveSelection}>Save Leaves</button>
              <button className="btn" onClick={handleCopyLeaves}>Copy Leaves</button>
            </div>
            <div className="selection-actions" style={{ marginTop: 4, opacity: 0.85 }}>
              <button className="btn" onClick={handleReroot}>Reroot (R)</button>
              <button className="btn" onClick={handleCollapseSelected}>Collapse</button>
              <button className="btn" onClick={handleHideSelected}>Hide</button>
              <button className="btn" onClick={handleShowOnly} title="Rebuild tree showing only leaves in this clade">Show only</button>
            </div>
          </div>
        )}

        {/* Inline range colour panel */}
        {selectedNode !== null && showRangePanel && (
          <div className="row range-panel" style={{ borderColor: activeRangeColor }}>
            <label className="label">{editingRangeIndex !== null ? "Edit Range" : "Add New Range"}</label>
            <div className="row">
              <label className="label" style={{ fontSize: 13, fontWeight: "normal" }}>Range Colour</label>
              <HexColorPicker color={activeRangeColor} onChange={setActiveRangeColor} />
            </div>
            <div className="row">
              <label className="label" style={{ fontSize: 13, fontWeight: "normal" }}>Range Label (optional)</label>
              <input type="text" value={activeRangeLabel} onChange={(e) => setActiveRangeLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirmColorRange(); } }} placeholder="e.g., Clade A" style={{ width: "100%", boxSizing: "border-box" }} />
            </div>
            <div className="modal-footer">
              <button className="btn active" onClick={confirmColorRange}>Confirm</button>
            </div>
          </div>
        )}


        {/* ── SECTION: Layout ── */}
        <div className="section-header" onClick={() => toggleSection("layout")}>
          <span>Layout &amp; View</span><span>{sectionOpen.layout ? "▲" : "▼"}</span>
        </div>
        {sectionOpen.layout && (<>
          <div className="row">
            <label className="label">Zoom</label>
            <div className="zoom-row">
              <button className="btn" type="button" onClick={handleZoomIn}>+</button>
              <button className="btn" type="button" onClick={handleZoomOut}>–</button>
              <button className="btn" type="button" onClick={handleFrameAll} title="Frame all (F)">Fit</button>
            </div>
          </div>
          <div className="row">
            <label className="label">Layout</label>
            <div className="layout-toggle-group">
              {(["rect", "circular", "unrooted"] as const).map((l) => (
                <button key={l} type="button" className={"layout-toggle-btn" + (layout === l ? " active" : "")} onClick={() => {
                  // Reset view when switching between rect and radial coordinate systems to avoid landing in white space
                  if ((layout === "rect") !== (l === "rect")) { setOffset({ x: 0, y: 0 }); setVZoom(1); setGZoom(1); }
                  setLayout(l); setSelectedNode(null); setShowRangePanel(false);
                }}>
                  <img src={`/icons/layout-${l === "rect" ? "rect" : l === "circular" ? "circular" : "unrooted"}.svg`} alt={l} />
                  {l === "rect" ? "Rect" : l === "circular" ? "Circ" : "Unrooted"}
                </button>
              ))}
            </div>
          </div>
          {layout === "circular" && (<>
            <div className="row">
              <label className="label">Rotation (deg)</label>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <button className="btn" type="button" style={{ padding: "2px 7px" }} onClick={() => setRotation(r => r - 15)}>−15</button>
                <input type="number" step={5} value={rotation} onChange={(e) => setRotation(Number(e.target.value))} style={{ flex: 1 }} />
                <button className="btn" type="button" style={{ padding: "2px 7px" }} onClick={() => setRotation(r => r + 15)}>+15</button>
              </div>
            </div>
            <div className="row">
              <label className="label">Arc (deg)</label>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <button className="btn" type="button" style={{ padding: "2px 7px" }} onClick={() => setArc(a => clamp(a - 10, 1, 360))}>−10</button>
                <input type="number" step={5} max={360} value={arc} onChange={(e) => setArc(clamp(Number(e.target.value), 1, 360))} style={{ flex: 1 }} />
                <button className="btn" type="button" style={{ padding: "2px 7px" }} onClick={() => setArc(a => clamp(a + 10, 1, 360))}>+10</button>
              </div>
            </div>
          </>)}
          <div className="row">
            <label className="label">Scale</label>
            <select value={phylogram ? "phylo" : "clado"} onChange={(e) => setPhylogram(e.target.value === "phylo")}>
              <option value="phylo">Phylogram</option>
              <option value="clado">Cladogram</option>
            </select>
          </div>
          <div className="row">
            <label className="label">Ladderize</label>
            <select value={ladderize} onChange={(e) => setLadderize(e.target.value as any)}>
              <option value="none">None</option>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </div>
          <div className="row">
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={showLeafLabels} onChange={(e) => setShowLeafLabels(e.target.checked)} />
              Leaf labels
            </label>
          </div>
          <div className="row" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={handleMidpointRoot}>Re-root at midpoint</button>
            <button type="button" className="btn" onClick={handleResetTree} disabled={!tree} title="Clear hidden/collapsed nodes and reset view">Reset tree</button>
          </div>
          {(collapsedNodes.size > 0 || hiddenLeafNames.size > 0) && (
            <div className="row">
              <span className="label">Collapsed / Hidden</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {collapsedNodes.size > 0 && <button type="button" className="btn" onClick={() => setCollapsedNodes(new Set())}>Uncollapse all ({collapsedNodes.size})</button>}
                {hiddenLeafNames.size > 0 && (
                  <button type="button" className="btn" onClick={() => setHiddenLeafNames(new Set())}>
                    Unhide all ({hiddenLeafNames.size})
                  </button>
                )}
              </div>
            </div>
          )}
          {layout === "rect" && (
            <div className="row">
              <label className="label">Horizontal Scale</label>
              {!phylogram && <div className="note" style={{ marginBottom: 6 }}>No effect in cladogram mode.</div>}
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", opacity: phylogram ? 1 : 0.45, pointerEvents: phylogram ? "auto" : "none" }}>
                <button className="btn" onClick={() => {
                  if (!tree || !rectLayout || !containerRef.current) return;
                  const W = containerRef.current.clientWidth;
                  const H = containerRef.current.clientHeight;
                  const { coords, height } = rectLayout;
                  const m = computeVisibleRectMetricsAt(vZoom, offset, W, H, tree, coords as any[], height);
                  if (!m) return;
                  const span = m.span > 0 ? m.span : m.maxVisibleX;
                  setHSpan(span);
                  setOffset((o) => ({ x: computeRectAutoPanX(W, span, m.localRootX, PADDING), y: o.y }));
                }}>Auto-fit visible</button>
                <input type="number" step="0.5" min="0" value={hSpan} onChange={(e) => setHSpan(Math.max(0, Number(e.target.value) || 0))} style={{ width: 80 }} />
                <label className="note" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <input type="checkbox" checked={lockHScale} onChange={(e) => setLocKHScale(e.target.checked)} />
                  Lock scale
                </label>
              </div>
              <div className="note">When unlocked, rectangular phylogram auto-fits horizontally as you zoom vertically.</div>
            </div>
          )}
        </>)}

        {/* ── SECTION: Support ── */}
        <div className="section-header" onClick={() => toggleSection("support")}>
          <span>Support colouring</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: "normal" }} onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={optSupportColouring} onChange={(e) => setOptSupportColouring(e.target.checked)} /> On
            </label>
            <div style={{ width: 12, height: 8, borderRadius: 3, background: supportC0 }} />
            <div style={{ width: 12, height: 8, borderRadius: 3, background: supportC1 }} />
            <div style={{ width: 12, height: 8, borderRadius: 3, background: supportC2 }} />
            <span>{sectionOpen.support ? "▲" : "▼"}</span>
          </div>
        </div>
        {sectionOpen.support && (
          <div className="row">
            <div className="note" style={{ marginTop: 4 }}>Three-colour gradient: low → mid → high. Click a swatch to edit.</div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 8, marginBottom: 4 }}>
              {([["Low", supportC0, "low"], ["Mid", supportC1, "mid"], ["High", supportC2, "high"]] as const).map(([lbl, col, slot]) => (
                <div key={slot} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, flex: 1 }}>
                  <div
                    className="legend-swatch"
                    style={{ width: "100%", height: 24, background: col, cursor: "pointer", borderRadius: 4 }}
                    onClick={() => setEditingSupportSlot(slot)}
                  />
                  <span className="note">{lbl}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "4px", marginTop: "8px" }}>
              {([["Low", supportV0, setSupportV0], ["Mid", supportV1, setSupportV1], ["High", supportV2, setSupportV2]] as const).map(([label, val, setter]) => (
                <div key={label}>
                  <label className="note">{label}</label>
                  <input type="number" step={supportAsPercent ? 1 : 0.01} value={val} onChange={(e) => (setter as any)(Number(e.target.value))} style={{ width: "100%" }} />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <label style={{ fontSize: 12 }}><input type="checkbox" checked={supportAsPercent} onChange={(e) => handlePercentToggle(e.target.checked)} /> Values are in % (0–100)</label>
            </div>
          </div>
        )}

        {/* ── SECTION: Annotation Tracks (moved to bottom) ── */}
        {trackConfig.length > 0 && (<>
          <div className="section-header" onClick={() => toggleSection("tracks")}>
            <span>Annotation Tracks</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: "normal" }} onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={showTracks} onChange={(e) => setShowTracks(e.target.checked)} /> Show
              </label>
              <span>{sectionOpen.tracks ? "▲" : "▼"}</span>
            </div>
          </div>
          {sectionOpen.tracks && (
            <div className="row">
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 4 }}>
                  <div className="toggle-pill">
                    <button type="button" className={trackOffsetMode === "auto" ? "active" : ""} onClick={() => setTrackOffsetMode("auto")}>Auto</button>
                    <button type="button" className={trackOffsetMode === "manual" ? "active" : ""} onClick={() => setTrackOffsetMode("manual")}>Manual</button>
                  </div>
                  <label className="note" style={{ display: "flex", alignItems: "center" }}>
                    Offset&nbsp;(px)
                    <input type="number" step={10} min={-999} value={trackOffset} onChange={(e) => setTrackOffset(Number(e.target.value) || 0)} style={{ width: 60, marginLeft: 4 }} />
                  </label>
                </div>
                <div className="note">Auto: tracks start at outermost visible branch + offset.</div>
              </div>
              {trackConfig.some(t => t.type === "categorical") && (
                <div style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="note">Default range colour source:</span>
                  <select
                    className="note"
                    value={rangeColorTrackKey ?? ""}
                    onChange={(e) => setRangeColorTrackKey(e.target.value || null)}
                    style={{ fontSize: 12 }}
                  >
                    <option value="">Manual</option>
                    {trackConfig.filter(t => t.type === "categorical").map(t => (
                      <option key={t.key} value={t.key}>{t.label || t.key}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="track-config-list">
                {trackConfig.map((track, i) => (
                  <div key={track.key}>
                    <div className="track-item">
                      <div className="track-item-order">
                        <button onClick={() => moveTrack(i, "up")} disabled={i === 0}>▲</button>
                        <button onClick={() => moveTrack(i, "down")} disabled={i === trackConfig.length - 1}>▼</button>
                      </div>
                      <input type="checkbox" style={{ gridColumn: "3 / 4", gridRow: "1 / 3" }} checked={track.visible} onChange={(e) => updateTrack(i, "visible", e.target.checked)} />
                      {/* Editable display name */}
                      <input
                        className="track-item-name"
                        value={track.label}
                        onChange={(e) => updateTrack(i, "label", e.target.value)}
                        title={`Column key: ${track.key}`}
                        style={{ border: "1px solid transparent", borderRadius: 3, background: "transparent", cursor: "text", width: "100%" }}
                        onFocus={(e) => (e.currentTarget.style.borderColor = "#999")}
                        onBlur={(e) => (e.currentTarget.style.borderColor = "transparent")}
                      />
                      <div className="track-item-controls">
                        <select value={track.type} onChange={(e) => updateTrack(i, "type", e.target.value)}>
                          <option value="categorical">Categorical</option>
                          <option value="continuous">Continuous</option>
                        </select>
                        <input type="number" value={track.height} onChange={(e) => updateTrack(i, "height", e.target.value)} style={{ width: 46 }} min="1" max="100" />
                        <span className="note">px</span>
                        {track.type === "categorical" && (
                          <button className="btn" style={{ padding: "2px 5px", fontSize: 11 }} onClick={() => setShowLegendKey(track.key === showLegendKey ? null : track.key)}>
                            Edit colours {showLegendKey === track.key ? "▴" : "▾"}
                          </button>
                        )}
                      </div>
                    </div>
                    {/* Inline legend for this track */}
                    {showLegendKey === track.key && colorMaps.get(track.key) && (
                      <div style={{ marginLeft: 8, marginBottom: 4, background: "#fff", border: "1px solid #ddd", padding: "4px 6px", borderRadius: 4 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
                          <span className="note" style={{ flexShrink: 0 }}>Apply palette:</span>
                          <select
                            className="note"
                            value={selectedPalette}
                            onChange={(e) => setSelectedPalette(e.target.value)}
                            style={{ fontSize: 11, flexGrow: 1 }}
                          >
                            {CATEGORICAL_PALETTES.map(p => (
                              <option key={p.name} value={p.name}>{p.name}</option>
                            ))}
                          </select>
                          <button className="btn" style={{ padding: "2px 6px", fontSize: 11 }} onClick={() => applyPalette(track.key, selectedPalette)}>
                            Apply
                          </button>
                        </div>
                        <div style={{ maxHeight: 140, overflowY: "auto" }}>
                          {[...colorMaps.get(track.key)!.entries()].map(([category, color]) => (
                            <div key={category} className="legend-item">
                              <div className="legend-swatch" style={{ background: color }} onClick={() => setEditingColor({ trackKey: track.key, category })} />
                              <span className="legend-label">{category || "(empty)"}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>)}

        {/* ── SECTION: Options ── */}
        <div className="section-header" onClick={() => toggleSection("options")}>
          <span>Options</span><span>{sectionOpen.options ? "▲" : "▼"}</span>
        </div>
        {sectionOpen.options && (
          <div className="row">
            <div className="note" style={{ fontWeight: 600, marginBottom: 6 }}>Display</div>
            {([
              ["Font scale", optFontScale, setOptFontScale, 0.1, 3, 0.1],
              ["Branch thickness", optBranchThickness, setOptBranchThickness, 0.5, 8, 0.5],
            ] as [string, number, (v: number) => void, number, number, number][]).map(([label, val, setter, min, max, step]) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 12 }}>{label}</span>
                <input type="number" min={min} max={max} step={step} value={val}
                  onChange={(e) => setter(clamp(Number(e.target.value), min, max))}
                  style={{ width: 70, fontSize: 12 }} />
              </div>
            ))}
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 6 }}>
              <input type="checkbox" checked={optTaperBranches}
                onChange={(e) => setOptTaperBranches(e.target.checked)} />
              Taper branches
            </label>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 12 }}>Background colour</span>
              <input type="color" value={optBackground} onChange={(e) => setOptBackground(e.target.value)}
                style={{ width: 44, height: 26, padding: 1, border: "1px solid #ccc", borderRadius: 4, cursor: "pointer" }} />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 2 }}>
              <input type="checkbox" checked={optShowSupportLabels}
                onChange={(e) => setOptShowSupportLabels(e.target.checked)} />
              Show support values on branches
            </label>
            <div className="note" style={{ marginBottom: 6 }}>Requires numeric bootstrap values in newick, e.g. <code>(A,B)95</code>. Rect layout only.</div>

            <div className="note" style={{ fontWeight: 600, marginBottom: 6, marginTop: 4 }}>Level of detail</div>
            {([
              ["LOD threshold (px)", optLodMinPx, setOptLodMinPx, 0, 50, 0.5],
              ["Annotation bar fill", optBarFill, setOptBarFill, 0, 2, 0.05],
            ] as [string, number, (v: number) => void, number, number, number][]).map(([label, val, setter, min, max, step]) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 12 }}>{label}</span>
                <input type="number" min={min} max={max} step={step} value={val}
                  onChange={(e) => setter(clamp(Number(e.target.value), min, max))}
                  style={{ width: 70, fontSize: 12 }} />
              </div>
            ))}
            <div className="note" style={{ marginBottom: 8 }}>LOD 0 = off (show all). Higher = skip smaller clades and thin annotations. Bar fill &gt; 1 slightly overlaps bars to fill gaps.</div>

            <div className="note" style={{ fontWeight: 600, marginBottom: 6 }}>Statistics</div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={optPctIncludeUnlabelled}
                onChange={(e) => setOptPctIncludeUnlabelled(e.target.checked)} />
              Clade % includes unlabelled leaves
            </label>
          </div>
        )}

        <div className="shortcut-strip">
          <div className="shortcut-strip-row">
            <span style={{ marginRight: 4 }}>Mouse:</span>
            <span>Click select · Drag pan · Scroll zoom</span>
          </div>
          <div className="shortcut-strip-row">
            <kbd>+</kbd><kbd>−</kbd>&nbsp;zoom&nbsp;
            <kbd>F</kbd>&nbsp;fit&nbsp;
            <kbd>R</kbd>&nbsp;reroot&nbsp;
            <kbd>C</kbd>&nbsp;colour range&nbsp;
            <kbd>Enter</kbd>&nbsp;confirm&nbsp;
            <kbd>Esc</kbd>&nbsp;deselect
          </div>
        </div>
      </div>

      {/* Canvas */}
      <div
        className="canvas-wrap"
        ref={containerRef}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          const file = e.dataTransfer.files[0];
          if (!file) return;
          const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
          if (["nwk","newick","tree","txt"].includes(ext)) setNewickFile(file);
          else if (["csv","tsv"].includes(ext)) addAnnotationFile(file);
        }}
      >
        {!tree && (
          <div className={"drop-zone-hint" + (isDragOver ? " drag-over" : "")}>
            <div className="drop-zone-hint-text">
              <div style={{ fontSize: 40, marginBottom: 10 }}>🌿</div>
              <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>Drop a Newick file here</div>
              <div style={{ fontSize: 13, color: "#999" }}>or use the Load panel on the left</div>
            </div>
          </div>
        )}
        <canvas
          ref={canvasRef}
          style={{ display: "block", width: "100%", height: "100%", background: optBackground, cursor: cursorStyle }}
          onMouseMove={onMouseMoveWrap}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseLeave}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
        />
        {/* Clade stats overlay — fixed to bottom-right of canvas so it never shifts sidebar layout */}
        {hoverCladeStats && hoverCladeStats.length > 0 && (
          <div style={{
            position: "absolute", bottom: 16, right: 16,
            background: "rgba(255,255,255,0.95)", border: "1px solid #ddd",
            borderRadius: 6, padding: "10px 14px", minWidth: 200, maxWidth: 280,
            pointerEvents: "none", boxShadow: "0 2px 8px rgba(0,0,0,0.15)", zIndex: 10,
            fontSize: 12,
          }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Clade statistics</div>
            {hoverCladeStats.map((stat) => (
              <div key={stat.key} style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: "bold", marginBottom: 3 }}>
                  {stat.label} <span style={{ fontWeight: "normal", color: "#666" }}>({stat.totalLeaves} leaves)</span>
                </div>
                {stat.topValues.map(([cat, count]) => {
                  const color = colorMaps.get(stat.key)?.get(cat) || "#aaa";
                  const denom = optPctIncludeUnlabelled ? stat.totalLeaves : stat.labelledCount;
                  const pct = denom > 0 ? ((count / denom) * 100).toFixed(1) : "0.0";
                  return (
                    <div key={cat} style={{ display: "flex", alignItems: "center", marginBottom: 2 }}>
                      <span style={{ width: 10, height: 10, background: color, marginRight: 6, borderRadius: 2, flexShrink: 0 }} />
                      <span style={{ marginRight: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cat}</span>
                      <strong style={{ marginLeft: 6 }}>{count}</strong>
                      <span style={{ color: "#888", marginLeft: 4, minWidth: 35, textAlign: "right" }}>({pct}%)</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tooltip */}
      {hoverInfo && hoverPos && (
        <div className="tooltip" style={{ position: "absolute", left: hoverPos.x + 5, top: hoverPos.y + 5, pointerEvents: "none" }}>
          {hoverInfo.split("\n").map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {/* Support colour picker modal */}
      {editingSupportSlot && (
        <>
          <div className="modal-backdrop" onClick={() => setEditingSupportSlot(null)} />
          <div className="modal-content">
            <div className="modal-header">
              <span>Support colour: {editingSupportSlot}</span>
              <button onClick={() => setEditingSupportSlot(null)} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 16 }}>×</button>
            </div>
            <HexColorPicker
              color={editingSupportSlot === "low" ? supportC0 : editingSupportSlot === "mid" ? supportC1 : supportC2}
              onChange={(c) => { if (editingSupportSlot === "low") setSupportC0(c); else if (editingSupportSlot === "mid") setSupportC1(c); else setSupportC2(c); }}
            />
          </div>
        </>
      )}

      {/* Colour picker modal for legend items */}
      {editingColor && (
        <>
          <div className="modal-backdrop" onClick={() => setEditingColor(null)} />
          <div className="modal-content">
            <div className="modal-header">
              <span>{editingColor.category || "(empty)"}</span>
              <button onClick={() => setEditingColor(null)} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 16 }}>×</button>
            </div>
            <HexColorPicker color={colorMaps.get(editingColor.trackKey)?.get(editingColor.category) || "#aaa"} onChange={handleColorChange} />
          </div>
        </>
      )}
    </div>
  );
}
