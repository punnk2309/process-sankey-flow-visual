# Process Sankey Flow Visual

Custom Power BI visual — multi-level Sankey diagram with full interaction support.  
Built with TypeScript + vanilla SVG (no D3). Packaged via `powerbi-visuals-tools` v5.6.0.

> **Contributor rule:** Every time a change is made to this visual — feature, fix, or refactor — update this README with a new entry under the relevant version (or a new version block if the version bumps). This file is the single source of truth for traceability across sessions.

---

## Changelog

### v1.1.0.0 — 2026-05-15 (patch 2026-05-15)

#### Fix: node height auto-expands to prevent connection overflow

- `layoutNodes` now runs a post-pass after computing `scaleF` and initial node heights.
- For every non-self-loop link it accumulates the actual ribbon thickness on each node's right edge (node is visually left) and left edge (node is visually right), using the same `colIndex` comparison as `renderLinks`.
- Each node's `h` is floored to `max(scaleF × value, rightEdgeTotal, leftEdgeTotal)` so connections are always contained within the node bar.
- Source, target, and flow values are unchanged — only the visual bar height grows when bidirectional or multi-target accumulation would otherwise overflow.
- `layoutNodes` signature updated to accept an optional `links` parameter (falls back to `this.links` when called from toolbar column +/− buttons).

---

#### Features added

**1. Dynamic node height on filter**
- Node X/Y/W positions persist across filter changes; height always recomputes from the current (filtered) data values.
- `h` is never stored in `NodePosition` — only `colIndex`, `y`, `w` are persisted.

**2. Column snap grid**
- Nodes snap to configurable vertical column lines on drag-release.
- `[−]` and `[+]` buttons in the top-right corner add/remove columns (1–20).
- Column count persisted via `columnCount` capability object.
- `colX(colIndex)` drives all x positions; viewport resize auto-reflows nodes proportionally.

**3. Value / stats display beside each node**
- Three lines shown beside every node label (font-size 9):
  - `↓ inflow` — total data flowing into this node (source→target direction in data)
  - `↑ outflow` — total data flowing out of this node
  - `↺ selfloop` — self-loop amount (hidden when zero)
- Values are based on **data direction** (source/target fields), NOT visual column position — numbers never change when nodes are moved.

**4. Viewport-constrained layout**
- Nodes are clamped inside the SVG viewport at all times.
- Column guides and toolbar always remain within the visual boundary.

**5. Bezier ribbon connections with directional arrowheads**
- Replaced elbow connections with cubic Bezier ribbons.
- Two arrowheads placed at t=0.33 and t=0.66 along the centre-line Bezier using parametric tangent (`bezierPt`) for correct rotation.
- Forward links: solid fill, full opacity.
- Backward / right-to-left links: dashed stroke, lower opacity.

**6. Column-based side routing (no wrapping)**
- Connection side selected by **visual `colIndex`**, not topological column:
  - Left node (smaller `colIndex`) → exit **right** edge, enter left edge of right node.
  - Right node (larger `colIndex`) → exit **left** edge, enter right edge of left node.
- Bidirectional connections between the same pair of nodes always use the **same two attachment points**, stacking together cleanly on both sides.
- Dragging a node to a different column **immediately switches sides** for all its connections on mouse-release.

**7. Node height = sum of connection thicknesses**
- Global `scaleF` (pixels per flow-value unit) computed as the minimum across all topological columns of `availH / totalColValue`.
- `node.h = scaleF × node.value` — height exactly fits the total ribbon thickness on the busiest side.
- `node.value = max(inflow, outflow)` based on data direction — **invariant to node position**.

**8. Self-loops rendered as arch above node**
- Connections where source = target are excluded from the node height calculation and offset pools.
- Drawn in a dedicated SVG layer above nodes as an arch-shaped ribbon (exits top of node, curves upward, re-enters).
- Arrowhead at the top of the arch pointing left (right-band → left-band) using reversed Bezier tangent.
- Self-loop arch follows the node **live during drag and resize** (redrawn on every mousemove).
- Tooltip shows self-loop value on hover.

**9. Symmetric width resize**
- Hover over the left or right edge of any node → `ew-resize` cursor + subtle highlight.
- Drag either edge: node expands/contracts **symmetrically** — centre stays pinned to its snap column; both edges move equally.
- New width persisted on mouse-release.

**10. Removed corner resize handles**
- White corner squares removed; width is the only resizable dimension (height is data-driven).

---

#### Architecture notes

| Concern | Mechanism |
|---|---|
| Position persistence | `host.persistProperties` → `nodePositions.positions` (JSON: `{colIndex, y, w}`) |
| Column count persistence | `host.persistProperties` → `columnCount.count` |
| Height computation | `computeNodeValues` (data-direction) → `layoutNodes` (scaleF) |
| Routing decision | `colIndex` comparison in `renderLinks` at render time |
| Self-loop layer | Separate `SVGGElement` above node layer; ref stored in `this.selfLoopLayer` |
| Node group children | [0] body rect · [1] label · [2] ↓inflow · [3] ↑outflow · [4] ↺selfloop · [5] left handle · [6] right handle |

---

#### Known limitations / trade-offs

- When two bidirectionally-connected nodes are in **different columns**, both flow directions route to the same side. Node height is now auto-expanded to fit all accumulated ribbon thickness so connections never overflow the node body.
- Self-loop ribbon thickness is capped at `min(scaleF × value, node.w × 0.55, 28px)` to stay within the node width.
- `pwsh` certificate warning during package is non-fatal; build still succeeds.

---

## Build

```
npx pbiviz package
```

Output: `dist/multiLevelSankeyA1B2C3D4E5F6G7H8.1.1.0.0.pbiviz`

Node.js location (portable): `%USERPROFILE%\AppData\Local\nodejs-portable\node-v20.18.3-win-x64`
