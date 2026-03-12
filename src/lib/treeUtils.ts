import type { Node, Tree } from "./types";

// ============================================================
// Newick parsing
// ============================================================

export function parseNewick(newick: string): any {
  let i = 0;

  function skipWs() {
    while (i < newick.length && /\s/.test(newick[i])) i++;
  }

  function sub(): any {
    skipWs();
    const children: any[] = [];
    let name = "";
    let length: number | undefined;

    if (newick[i] === "(") {
      // internal node
      i++;
      while (true) {
        children.push(sub());
        skipWs();
        if (newick[i] === ",") {
          i++;
          continue;
        }
        if (newick[i] === ")") {
          i++;
          break;
        }
        throw new Error("Newick parse error at position " + i);
      }
      skipWs();
      while (i < newick.length && /[A-Za-z0-9_.\-]/.test(newick[i])) {
        name += newick[i++];
      }
    } else {
      // leaf
      while (i < newick.length && !/[:),;\s]/.test(newick[i])) {
        name += newick[i++];
      }
    }

    skipWs();
    if (newick[i] === ":") {
      i++;
      let len = "";
      while (i < newick.length && !/[),;\s]/.test(newick[i])) len += newick[i++];
      length = parseFloat(len);
    }
    skipWs();
    return { name: name || undefined, length: length ?? 0, children };
  }

  const t = sub();
  skipWs();
  if (newick[i] !== ";") {
    throw new Error("Newick parse error: missing trailing ';'");
  }
  return t;
}

// ============================================================
// AST pruning (remove leaves by name before building tree)
// ============================================================

/**
 * Prune an AST (output of parseNewick) by removing leaves whose names are in
 * hideNames. Single-child internal nodes are elided so the result stays a
 * proper tree with no redundant nodes. Elided nodes' branch lengths are merged
 * into the surviving child so cumulative distances remain correct.
 * Returns null if every leaf is removed.
 */
export function pruneAst(node: any, hideNames: Set<string>): any | null {
  if (!node.children || node.children.length === 0) {
    return hideNames.has(node.name || "") ? null : node;
  }
  const kept: any[] = [];
  for (const ch of node.children) {
    const pruned = pruneAst(ch, hideNames);
    if (pruned !== null) kept.push(pruned);
  }
  if (kept.length === 0) return null;
  if (kept.length === 1) {
    return { ...kept[0], length: (kept[0].length || 0) + (node.length || 0) };
  }
  return { ...node, children: kept };
}

// ============================================================
// Tree construction
// ============================================================

export function buildTree(ast: any): Tree {
  const nodes: Node[] = [];
  const nameToNode = new Map<string, number>();

  function add(a: any, parent: number | null): number {
    const id = nodes.length;
    const node: Node = {
      id,
      name: a.children?.length ? undefined : a.name,
      parent,
      children: [],
      length: a.length || 0,
      support: undefined,
      isLeaf: !a.children?.length,
      depth: 0,
      cumLen: 0,
      leafIndex: -1,
      L: 0,
      R: 0,
      propCat: undefined,
    };

    // Numeric internal-node name → bootstrap support value
    if (!node.isLeaf && a.name && /^-?\d+(\.\d+)?$/.test(a.name)) {
      node.support = parseFloat(a.name);
    }

    nodes.push(node);
    if (node.name) nameToNode.set(node.name, id);

    const kids: number[] = [];
    for (const ch of a.children || []) kids.push(add(ch, id));
    nodes[id].children = kids;

    return id;
  }

  const root = add(ast, null);

  const leaves: number[] = [];
  function dfs(u: number, depth: number, cumLen: number) {
    const nd = nodes[u];
    nd.depth = depth;
    nd.cumLen = cumLen;
    if (nd.isLeaf) {
      nd.leafIndex = leaves.length;
      nd.L = nd.leafIndex;
      nd.R = nd.leafIndex + 1;
      leaves.push(u);
    } else {
      nd.L = Infinity as any;
      nd.R = -Infinity as any;
      for (const v of nd.children) {
        dfs(v, depth + 1, cumLen + nodes[v].length);
        nd.L = Math.min(nd.L, nodes[v].L);
        nd.R = Math.max(nd.R, nodes[v].R);
      }
    }
  }
  dfs(root, 0, 0);

  return { nodes, root, leaves, nameToNode };
}

// ============================================================
// Leaf-count annotation (used by layout and ladderize)
// ============================================================

export function computeLeafCounts(tree: Tree): void {
  const { nodes, root } = tree;
  const leavesInSubtree = new Uint32Array(nodes.length);
  const order: number[] = [];

  (function post(u: number) {
    for (const v of nodes[u].children) post(v);
    order.push(u);
  })(root);

  for (const u of order) {
    const nd = nodes[u];
    if (nd.isLeaf) {
      leavesInSubtree[u] = 1;
    } else {
      let s = 0;
      for (const v of nd.children) s += leavesInSubtree[v];
      leavesInSubtree[u] = s;
    }
    (nd as any).leaves = leavesInSubtree[u];
  }
}

// ============================================================
// Tree manipulation: ladderize, reroot
// ============================================================

function computeSubtreeStats(t: Tree): Uint32Array {
  const sz = new Uint32Array(t.nodes.length);
  const order: number[] = [];

  (function post(u: number) {
    for (const v of t.nodes[u].children) post(v);
    order.push(u);
  })(t.root);

  for (const u of order) {
    const nd = t.nodes[u];
    if (nd.isLeaf) {
      sz[u] = 1;
    } else {
      let s = 0;
      for (const v of nd.children) s += sz[v];
      sz[u] = s;
    }
  }
  return sz;
}

/** Sort children by subtree size and recompute leaf indices */
export function ladderizeTree(t: Tree, dir: "asc" | "desc"): void {
  const sz = computeSubtreeStats(t);
  const st = [t.root];

  while (st.length) {
    const u = st.pop()!;
    const nd = t.nodes[u];
    nd.children.sort((a, b) =>
      dir === "asc" ? sz[a] - sz[b] : sz[b] - sz[a]
    );
    for (const v of nd.children) st.push(v);
  }

  // Recompute leaf order and L/R intervals after sorting
  const leaves: number[] = [];
  function dfs(u: number) {
    const nd = t.nodes[u];
    if (nd.isLeaf) {
      nd.leafIndex = leaves.length;
      nd.L = nd.leafIndex;
      nd.R = nd.leafIndex + 1;
      leaves.push(u);
    } else {
      nd.L = Infinity as any;
      nd.R = -Infinity as any;
      for (const v of nd.children) {
        dfs(v);
        nd.L = Math.min(nd.L, t.nodes[v].L);
        nd.R = Math.max(nd.R, t.nodes[v].R);
      }
    }
  }
  dfs(t.root);
  t.leaves = leaves;
}

/** Re-root the tree at a given node (mutates the tree in place) */
export function rerootAtNode(
  t: Tree,
  newRoot: number,
  ladderizeDir: "asc" | "desc" | "none"
): void {
  const n = t.nodes.length;

  // Build undirected adjacency
  const adj: Array<Array<{ to: number; len: number }>> = Array.from(
    { length: n },
    () => []
  );
  for (const nd of t.nodes) {
    for (const ch of nd.children) {
      const len = t.nodes[ch].length;
      adj[nd.id].push({ to: ch, len });
      adj[ch].push({ to: nd.id, len });
    }
  }

  // BFS from new root to find parent relationships
  const parent = new Int32Array(n).fill(-1);
  const plen = new Float32Array(n).fill(0);
  const order: number[] = [newRoot];
  parent[newRoot] = -2; // sentinel for "no parent"

  for (let i = 0; i < order.length; i++) {
    const u = order[i];
    for (const e of adj[u]) {
      if (parent[e.to] === -1) {
        parent[e.to] = u;
        plen[e.to] = e.len;
        order.push(e.to);
      }
    }
  }

  // Rebuild children arrays
  for (const nd of t.nodes) {
    nd.parent = null;
    nd.children = [];
  }

  for (let v = 0; v < n; v++) {
    const p = parent[v];
    if (p === -2) {
      t.root = v;
      t.nodes[v].parent = null;
      t.nodes[v].length = 0;
    } else {
      t.nodes[v].parent = p;
      t.nodes[v].length = plen[v];
      t.nodes[p].children.push(v);
    }
  }

  // Recompute depth, cumLen, leafIndex, L, R
  const leaves: number[] = [];
  function dfs(u: number, d: number, c: number) {
    const nd = t.nodes[u];
    nd.depth = d;
    nd.cumLen = c;
    if (nd.isLeaf) {
      nd.leafIndex = leaves.length;
      nd.L = nd.leafIndex;
      nd.R = nd.leafIndex + 1;
      leaves.push(u);
    } else {
      nd.L = Infinity as any;
      nd.R = -Infinity as any;
      for (const v of nd.children) {
        dfs(v, d + 1, c + t.nodes[v].length);
        nd.L = Math.min(nd.L, t.nodes[v].L);
        nd.R = Math.max(nd.R, t.nodes[v].R);
      }
    }
  }
  dfs(t.root, 0, 0);
  t.leaves = leaves;

  if (ladderizeDir !== "none") {
    ladderizeTree(t, ladderizeDir);
  }
  computeLeafCounts(t);
}
