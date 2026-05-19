"use strict";

import powerbi from "powerbi-visuals-api";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import DataView = powerbi.DataView;

interface NodePosition {
    colIndex: number;
    y: number;
    w: number;
    // h is not persisted — always recomputed from live data
}

interface SankeyNode {
    id: string;
    label: string;
    column: number;
    colIndex: number;
    x: number;
    y: number;
    w: number;
    h: number;
    color: string;
    value: number;   // max(inflow, outflow) — drives height
    inflow: number;  // sum of links where this node is target (data direction)
    outflow: number; // sum of links where this node is source (data direction)
    selfLoop: number; // sum of self-loop link values
}

interface SankeyLink {
    source: string;
    target: string;
    value: number;
    isBackward?: boolean;
}

export class Visual implements IVisual {
    private host: IVisualHost;
    private svg: SVGSVGElement;
    private container: HTMLDivElement;
    private tooltip: HTMLDivElement;

    private savedPositions: Map<string, NodePosition> = new Map();
    private nodes: Map<string, SankeyNode> = new Map();
    private links: SankeyLink[] = [];
    private defs: SVGDefsElement | null = null;
    private linkLayer: SVGGElement | null = null;

    private colorMap: Map<string, string> = new Map();
    private colorIdx = 0;

    private numColumns: number = 4;
    private vpW: number = 600;
    private vpH: number = 400;
    private scaleF: number = 1; // pixels per flow-value unit
    private selfLoopLayer: SVGGElement | null = null;

    private readonly PAD = { t: 50, r: 100, b: 30, l: 100 };
    private readonly NODE_W = 24;
    private readonly LINK_OPACITY = 0.45;
    private readonly COL_SPACING = 12;
    private readonly ARROW_SIZE = 6;

    private readonly COLORS = [
        "#2196F3","#4CAF50","#FF9800","#E91E63","#9C27B0",
        "#00BCD4","#FF5722","#607D8B","#8BC34A","#FFC107",
        "#3F51B5","#009688","#795548","#F44336","#CDDC39",
        "#FF6F00","#1B5E20","#880E4F","#01579B","#33691E"
    ];

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;

        this.container = document.createElement("div");
        this.container.style.cssText = [
            "width:100%","height:100%","overflow:hidden",
            "position:relative","user-select:none","-webkit-user-select:none"
        ].join(";");
        options.element.appendChild(this.container);

        this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        this.svg.style.cssText = "width:100%;height:100%;display:block;";
        this.container.appendChild(this.svg);

        this.tooltip = document.createElement("div");
        this.tooltip.style.cssText = [
            "position:fixed","background:rgba(0,0,0,0.85)","color:#fff",
            "padding:8px 12px","border-radius:5px","font-size:12px",
            "font-family:Segoe UI,sans-serif","pointer-events:none",
            "z-index:9999","display:none","min-width:180px"
        ].join(";");
        document.body.appendChild(this.tooltip);
    }

    public update(options: VisualUpdateOptions) {
        const dataView = options.dataViews?.[0];
        if (!dataView?.table) {
            this.showMessage("Add Source, Target, and Value fields to the visual.");
            return;
        }

        this.vpW = options.viewport.width;
        this.vpH = options.viewport.height;

        this.loadSavedPositions(dataView);

        const { nodes, links } = this.parseData(dataView);
        if (!nodes.size) {
            this.showMessage("Map Source, Target, and Value columns in the Fields pane.");
            return;
        }

        this.assignColumns(nodes, links);
        this.detectBackward(nodes, links);
        this.preAssignColIndex(nodes);   // needed so computeNodeValues can use colIndex
        this.computeNodeValues(nodes, links);
        this.layoutNodes(nodes, links);

        this.nodes = nodes;
        this.links = links;
        this.renderAll();
    }

    // ── Persistence loading ────────────────────────────────────────────────────

    private loadSavedPositions(dataView: DataView) {
        try {
            const raw = (dataView.metadata?.objects as any)?.nodePositions?.positions as string | undefined;
            if (raw) {
                const parsed = JSON.parse(raw) as Record<string, any>;
                this.savedPositions = new Map(
                    Object.entries(parsed).map(([id, p]) => {
                        if (typeof p.colIndex === "number") {
                            return [id, { colIndex: p.colIndex, y: p.y, w: p.w }] as [string, NodePosition];
                        } else {
                            const innerW = Math.max(this.vpW - this.PAD.l - this.PAD.r, 100);
                            const gap = this.numColumns > 1 ? innerW / (this.numColumns - 1) : 1;
                            const ci = Math.round((p.x - this.PAD.l) / gap);
                            return [id, { colIndex: Math.max(0, ci), y: p.y, w: p.w ?? this.NODE_W }] as [string, NodePosition];
                        }
                    })
                );
            }
        } catch { /* ignore */ }

        try {
            const count = (dataView.metadata?.objects as any)?.columnCount?.count as number | undefined;
            if (typeof count === "number" && count >= 1) {
                this.numColumns = Math.round(count);
            }
        } catch { /* ignore */ }
    }

    // ── Data parsing ───────────────────────────────────────────────────────────

    private parseData(dataView: DataView) {
        const { columns, rows } = dataView.table!;
        let si = -1, ti = -1, vi = -1;

        columns.forEach((col, i) => {
            if (col.roles?.["source"]) si = i;
            else if (col.roles?.["target"]) ti = i;
            else if (col.roles?.["value"]) vi = i;
        });
        if (si === -1 || ti === -1 || vi === -1) {
            columns.forEach((col, i) => {
                const n = col.displayName.toLowerCase();
                if (si === -1 && n.includes("source")) si = i;
                else if (ti === -1 && n.includes("target")) ti = i;
                else if (vi === -1 && (n.includes("value")||n.includes("amount")||n.includes("flow")||n.includes("weight"))) vi = i;
            });
        }
        if (si === -1 || ti === -1 || vi === -1) {
            return { nodes: new Map<string, SankeyNode>(), links: [] as SankeyLink[] };
        }

        const nodes = new Map<string, SankeyNode>();
        const links: SankeyLink[] = [];

        rows.forEach(row => {
            const source = String(row[si] ?? "").trim();
            const target = String(row[ti] ?? "").trim();
            const value  = parseFloat(String(row[vi] ?? "0")) || 0;
            if (!source || !target || value <= 0) return;

            if (!nodes.has(source)) nodes.set(source, this.newNode(source));
            if (!nodes.has(target)) nodes.set(target, this.newNode(target));
            links.push({ source, target, value });
        });

        return { nodes, links };
    }

    private newNode(id: string): SankeyNode {
        if (!this.colorMap.has(id)) {
            this.colorMap.set(id, this.COLORS[this.colorIdx++ % this.COLORS.length]);
        }
        return { id, label: id, column: 0, colIndex: 0, x: 0, y: 0, w: this.NODE_W, h: 60, color: this.colorMap.get(id)!, value: 0, inflow: 0, outflow: 0, selfLoop: 0 };
    }

    private assignColumns(nodes: Map<string, SankeyNode>, links: SankeyLink[]) {
        nodes.forEach(n => { n.column = 0; });
        const inDeg = new Map<string, number>();
        const adj   = new Map<string, string[]>();
        nodes.forEach((_, id) => { inDeg.set(id, 0); adj.set(id, []); });
        links.forEach(l => {
            adj.get(l.source)?.push(l.target);
            inDeg.set(l.target, (inDeg.get(l.target) || 0) + 1);
        });
        const queue: string[] = [];
        inDeg.forEach((d, id) => { if (d === 0) queue.push(id); });
        while (queue.length) {
            const id = queue.shift()!;
            const col = nodes.get(id)!.column;
            adj.get(id)?.forEach(tid => {
                const t = nodes.get(tid)!;
                t.column = Math.max(t.column, col + 1);
                const d = (inDeg.get(tid) || 1) - 1;
                inDeg.set(tid, d);
                if (d <= 0) queue.push(tid);
            });
        }
    }

    private detectBackward(nodes: Map<string, SankeyNode>, links: SankeyLink[]) {
        links.forEach(l => {
            const s = nodes.get(l.source), t = nodes.get(l.target);
            l.isBackward = !!(s && t && s.column >= t.column);
        });
    }

    private preAssignColIndex(nodes: Map<string, SankeyNode>) {
        const maxCol = nodes.size ? Math.max(...Array.from(nodes.values()).map(n => n.column)) : 0;
        const numDataCols = maxCol + 1;
        nodes.forEach(n => {
            if (this.savedPositions.has(n.id)) {
                const p = this.savedPositions.get(n.id)!;
                n.colIndex = Math.max(0, Math.min(this.numColumns - 1, p.colIndex));
            } else {
                const snap = Math.round(n.column * (this.numColumns - 1) / Math.max(numDataCols - 1, 1));
                n.colIndex = Math.max(0, Math.min(this.numColumns - 1, snap));
            }
        });
    }

    private computeNodeValues(nodes: Map<string, SankeyNode>, links: SankeyLink[]) {
        // Heights and displayed stats are based purely on DATA direction (source/target fields),
        // NOT on visual column position — so moving nodes never changes the numbers or height.
        nodes.forEach((node, id) => {
            node.inflow   = links.filter(l => l.target === id && l.source !== id).reduce((s, l) => s + l.value, 0);
            node.outflow  = links.filter(l => l.source === id && l.target !== id).reduce((s, l) => s + l.value, 0);
            node.selfLoop = links.filter(l => l.source === id && l.target === id).reduce((s, l) => s + l.value, 0);
            node.value = Math.max(node.inflow, node.outflow, 1);
        });
    }

    // ── Layout ─────────────────────────────────────────────────────────────────

    private colX(colIndex: number): number {
        const innerW = Math.max(this.vpW - this.PAD.l - this.PAD.r, 100);
        const gap = this.numColumns > 1 ? innerW / (this.numColumns - 1) : 0;
        return this.PAD.l + colIndex * gap;
    }

    private nearestColIndex(nodeX: number, nodeW: number): number {
        const cx = nodeX + nodeW / 2;
        const innerW = Math.max(this.vpW - this.PAD.l - this.PAD.r, 100);
        const gap = this.numColumns > 1 ? innerW / (this.numColumns - 1) : 1;
        const ci = Math.round((cx - this.PAD.l) / gap);
        return Math.max(0, Math.min(this.numColumns - 1, ci));
    }

    private layoutNodes(nodes: Map<string, SankeyNode>, links?: SankeyLink[]) {
        const activeLinks = links ?? this.links;
        const innerH = Math.max(this.vpH - this.PAD.t - this.PAD.b, 100);

        const byCols = new Map<number, SankeyNode[]>();
        nodes.forEach(n => {
            if (!byCols.has(n.column)) byCols.set(n.column, []);
            byCols.get(n.column)!.push(n);
        });

        const numDataCols = Math.max(0, ...byCols.keys()) + 1;

        // Global scaleF: pixels per flow-unit, limited by most constrained column
        let minScale = Infinity;
        byCols.forEach(colNodes => {
            const totalVal = colNodes.reduce((s, n) => s + n.value, 0) || 1;
            const spacing = this.COL_SPACING;
            const totalSpace = spacing * Math.max(0, colNodes.length - 1);
            const availH = Math.max(1, innerH - totalSpace);
            const scale = availH / totalVal;
            if (scale < minScale) minScale = scale;
        });
        this.scaleF = isFinite(minScale) ? minScale : 1;

        byCols.forEach((colNodes, colIdx) => {
            colNodes.sort((a, b) => b.value - a.value);
            const spacing = this.COL_SPACING;

            // Node height = scaleF * value so it exactly equals the sum of link thicknesses
            colNodes.forEach(n => {
                n.h = Math.max(4, this.scaleF * n.value);
            });

            const savedNodes = colNodes.filter(n => this.savedPositions.has(n.id));
            const newNodes   = colNodes.filter(n => !this.savedPositions.has(n.id));

            savedNodes.forEach(n => {
                const p = this.savedPositions.get(n.id)!;
                n.colIndex = Math.max(0, Math.min(this.numColumns - 1, p.colIndex));
                n.x = this.colX(n.colIndex) - p.w / 2;
                n.y = p.y;
                n.w = p.w;
            });

            const snapCol = Math.round(colIdx * (this.numColumns - 1) / Math.max(numDataCols - 1, 1));
            let y = this.PAD.t;
            newNodes.forEach(n => {
                n.colIndex = Math.max(0, Math.min(this.numColumns - 1, snapCol));
                n.w = this.NODE_W;
                n.x = this.colX(n.colIndex) - n.w / 2;
                n.y = y;
                y += n.h + spacing;
            });
        });

        // Expand node heights to guarantee connections never overflow the node body.
        // Accumulate actual ribbon thickness per edge (right edge of left node, left edge of right node)
        // using the same colIndex logic as renderLinks, then floor node.h to that total.
        // Source/target values are untouched — only the visual bar grows.
        const rightEdge = new Map<string, number>();
        const leftEdge  = new Map<string, number>();
        nodes.forEach((_, id) => { rightEdge.set(id, 0); leftEdge.set(id, 0); });
        activeLinks.filter(l => l.source !== l.target).forEach(link => {
            const src = nodes.get(link.source);
            const tgt = nodes.get(link.target);
            if (!src || !tgt) return;
            const thick = Math.max(2, this.scaleF * link.value);
            const leftNode  = src.colIndex <= tgt.colIndex ? src : tgt;
            const rightNode = src.colIndex <= tgt.colIndex ? tgt : src;
            rightEdge.set(leftNode.id,  (rightEdge.get(leftNode.id)  || 0) + thick);
            leftEdge.set(rightNode.id,  (leftEdge.get(rightNode.id)  || 0) + thick);
        });
        nodes.forEach(n => {
            const re = rightEdge.get(n.id) || 0;
            const le = leftEdge.get(n.id)  || 0;
            n.h = Math.max(n.h, re, le);
        });

        // Clamp all nodes to stay within the SVG viewport
        nodes.forEach(n => {
            n.x = Math.max(this.PAD.l - n.w / 2, Math.min(this.vpW - this.PAD.r - n.w / 2, n.x));
            n.y = Math.max(this.PAD.t, Math.min(this.vpH - this.PAD.b - n.h, n.y));
        });
    }

    // ── Rendering ──────────────────────────────────────────────────────────────

    private renderAll() {
        while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
        this.svg.setAttribute("width", String(this.vpW));
        this.svg.setAttribute("height", String(this.vpH));

        this.defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
        this.svg.appendChild(this.defs);

        const guideLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
        this.svg.appendChild(guideLayer);
        this.renderColumnGuides(guideLayer);

        this.linkLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
        this.svg.appendChild(this.linkLayer);

        const nodeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
        this.svg.appendChild(nodeLayer);

        this.selfLoopLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const selfLoopLayer = this.selfLoopLayer;
        this.svg.appendChild(selfLoopLayer);

        const toolbarLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
        this.svg.appendChild(toolbarLayer);
        this.renderToolbar(toolbarLayer);

        this.renderLinks();
        this.renderNodes(nodeLayer);
        this.renderSelfLoops(selfLoopLayer);
    }

    private refreshSelfLoops() {
        if (!this.selfLoopLayer) return;
        while (this.selfLoopLayer.firstChild) this.selfLoopLayer.removeChild(this.selfLoopLayer.firstChild);
        this.renderSelfLoops(this.selfLoopLayer);
    }

    private renderSelfLoops(layer: SVGGElement) {
        this.links.filter(l => l.source === l.target).forEach(link => {
            const node = this.nodes.get(link.source);
            if (!node) return;
            const thick = Math.max(3, Math.min(this.scaleF * link.value, node.w * 0.55, 28));
            this.drawSelfLoop(link, node, thick, layer);
        });
    }

    private drawSelfLoop(link: SankeyLink, node: SankeyNode, thick: number, layer: SVGGElement) {
        const halfW = node.w * 0.42;
        const archH = Math.max(34, thick * 2.5 + 10);
        const cx = node.x + node.w / 2;
        const y0 = node.y;

        const xOL = cx - halfW;
        const xOR = cx + halfW;
        const ins = Math.min(thick, halfW * 0.85);
        const xIL = xOL + ins;
        const xIR = xOR - ins;

        const d = [
            `M ${xOL} ${y0}`,
            `C ${xOL} ${y0 - archH} ${xOR} ${y0 - archH} ${xOR} ${y0}`,
            `L ${xIR} ${y0}`,
            `C ${xIR} ${y0 - archH + ins * 1.3} ${xIL} ${y0 - archH + ins * 1.3} ${xIL} ${y0}`,
            "Z"
        ].join(" ");

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        path.setAttribute("fill", node.color);
        path.setAttribute("fill-opacity", "0.42");
        path.setAttribute("stroke", node.color);
        path.setAttribute("stroke-width", "1");
        path.setAttribute("stroke-opacity", "0.55");
        path.style.cursor = "default";
        path.addEventListener("mouseenter", (e) => {
            path.setAttribute("fill-opacity", "0.72");
            this.showTooltip(e as MouseEvent, `${link.source} ↺: ${link.value.toLocaleString()} (self-loop)`);
        });
        path.addEventListener("mouseleave", () => {
            path.setAttribute("fill-opacity", "0.42");
            this.hideTooltip();
        });
        layer.appendChild(path);

        // Arrowhead at top of arch pointing left (top-right band → top-left band)
        // Use reversed outer arch bezier: P0=(xOR,y0) P1=(xOR,y0-archH) P2=(xOL,y0-archH) P3=(xOL,y0)
        const mid = this.bezierPt(xOR, y0, xOR, y0 - archH, xOL, y0 - archH, xOL, y0, 0.5);
        const s = this.ARROW_SIZE;
        const arrow = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        arrow.setAttribute("points", `${-s},${-s * 0.55} ${s},0 ${-s},${s * 0.55}`);
        arrow.setAttribute("fill", node.color);
        arrow.setAttribute("fill-opacity", "0.85");
        arrow.setAttribute("transform", `translate(${mid.x.toFixed(1)},${mid.y.toFixed(1)}) rotate(${mid.angle.toFixed(1)})`);
        arrow.style.pointerEvents = "none";
        layer.appendChild(arrow);
    }

    private renderColumnGuides(layer: SVGGElement) {
        for (let i = 0; i < this.numColumns; i++) {
            const cx = this.colX(i);
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", String(cx));
            line.setAttribute("y1", String(this.PAD.t));
            line.setAttribute("x2", String(cx));
            line.setAttribute("y2", String(this.vpH - this.PAD.b));
            line.setAttribute("stroke", "#ccc");
            line.setAttribute("stroke-width", "1");
            line.setAttribute("stroke-dasharray", "4 4");
            layer.appendChild(line);
        }
    }

    private renderToolbar(layer: SVGGElement) {
        const btnW = 22, btnH = 22, gap = 4;
        // Anchor to right-inside of right padding so it never leaves the SVG
        const x0 = this.vpW - this.PAD.r + 8;
        const y0 = 6;

        const makeBtn = (x: number, label: string, onClick: () => void) => {
            const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
            g.style.cursor = "pointer";

            const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("x", String(x));
            rect.setAttribute("y", String(y0));
            rect.setAttribute("width", String(btnW));
            rect.setAttribute("height", String(btnH));
            rect.setAttribute("rx", "3");
            rect.setAttribute("fill", "#e0e0e0");
            rect.setAttribute("stroke", "#aaa");
            rect.setAttribute("stroke-width", "1");

            const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
            text.setAttribute("x", String(x + btnW / 2));
            text.setAttribute("y", String(y0 + btnH / 2));
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("dominant-baseline", "middle");
            text.setAttribute("font-size", "14");
            text.setAttribute("font-family", "Segoe UI, sans-serif");
            text.setAttribute("fill", "#333");
            text.setAttribute("pointer-events", "none");
            text.textContent = label;

            g.appendChild(rect);
            g.appendChild(text);
            g.addEventListener("mouseenter", () => rect.setAttribute("fill", "#bdbdbd"));
            g.addEventListener("mouseleave", () => rect.setAttribute("fill", "#e0e0e0"));
            g.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
            g.addEventListener("click", (e) => {
                e.stopPropagation();
                onClick();
            });
            layer.appendChild(g);
        };

        makeBtn(x0, "−", () => {
            if (this.numColumns > 1) {
                this.numColumns--;
                this.persistColumnCount();
                this.layoutNodes(this.nodes);
                this.renderAll();
            }
        });

        const countLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
        countLabel.setAttribute("x", String(x0 + btnW + gap + 14));
        countLabel.setAttribute("y", String(y0 + btnH / 2));
        countLabel.setAttribute("text-anchor", "middle");
        countLabel.setAttribute("dominant-baseline", "middle");
        countLabel.setAttribute("font-size", "11");
        countLabel.setAttribute("font-family", "Segoe UI, sans-serif");
        countLabel.setAttribute("fill", "#555");
        countLabel.textContent = String(this.numColumns);
        countLabel.style.pointerEvents = "none";
        layer.appendChild(countLabel);

        makeBtn(x0 + btnW + gap + 28, "+", () => {
            if (this.numColumns < 20) {
                this.numColumns++;
                this.persistColumnCount();
                this.layoutNodes(this.nodes);
                this.renderAll();
            }
        });
    }

    // ── Link rendering (Bezier curves + directional arrows) ────────────────────

    private renderLinks() {
        if (!this.linkLayer || !this.defs) return;
        while (this.linkLayer.firstChild) this.linkLayer.removeChild(this.linkLayer.firstChild);
        while (this.defs.firstChild) this.defs.removeChild(this.defs.firstChild);

        // Routing is purely colIndex-based:
        //   left node (smaller colIndex) → right-edge exit
        //   right node (larger colIndex) → left-edge entry
        // All connections between the same pair share the same two offset pools,
        // so bidirectional flows stack together instead of splitting across sides.
        const rightOff = new Map<string, number>(); // right-edge exits (node is left of partner)
        const leftOff  = new Map<string, number>(); // left-edge entries (node is right of partner)
        this.nodes.forEach((_, id) => { rightOff.set(id, 0); leftOff.set(id, 0); });

        // Self-loops are rendered separately above nodes — exclude from offset pools
        const sorted = [...this.links]
            .filter(l => l.source !== l.target)
            .sort((a, b) => (a.isBackward ? 1 : 0) - (b.isBackward ? 1 : 0));

        sorted.forEach((link, i) => {
            const src = this.nodes.get(link.source);
            const tgt = this.nodes.get(link.target);
            if (!src || !tgt) return;

            const thick = Math.max(2, this.scaleF * link.value);
            const halfT = thick / 2;

            // Determine which node is visually to the left based on current snap column
            const srcIsLeft = src.colIndex <= tgt.colIndex;
            const leftNode  = srcIsLeft ? src : tgt;
            const rightNode = srcIsLeft ? tgt : src;

            // Always route: right edge of left node → left edge of right node
            const ro = rightOff.get(leftNode.id) || 0;
            const lo = leftOff.get(rightNode.id) || 0;
            const x1 = leftNode.x + leftNode.w;  const y1 = leftNode.y + ro + halfT;
            const x2 = rightNode.x;               const y2 = rightNode.y + lo + halfT;
            rightOff.set(leftNode.id, ro + thick);
            leftOff.set(rightNode.id, lo + thick);

            // Gradient: left-node color → right-node color (matches visual ribbon position)
            const gradId = `g${i}`;
            const grad = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
            grad.setAttribute("id", gradId);
            grad.setAttribute("gradientUnits", "userSpaceOnUse");
            grad.setAttribute("x1", String(x1)); grad.setAttribute("y1", String(y1));
            grad.setAttribute("x2", String(x2)); grad.setAttribute("y2", String(y2));
            // Flow goes right-to-left when !srcIsLeft, so swap stop colors
            const c0 = leftNode.color, c1 = rightNode.color;
            const opacity = srcIsLeft ? this.LINK_OPACITY : 0.32;
            for (const [off, color] of [[0, c0], [1, c1]] as [number, string][]) {
                const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
                stop.setAttribute("offset", String(off));
                stop.setAttribute("stop-color", color);
                stop.setAttribute("stop-opacity", String(opacity));
                grad.appendChild(stop);
            }
            this.defs.appendChild(grad);

            this.drawLink(link, src, tgt, x1, y1, x2, y2, halfT, gradId, srcIsLeft, i);
        });
    }

    private drawLink(
        link: SankeyLink,
        src: SankeyNode, tgt: SankeyNode,
        x1: number, y1: number, x2: number, y2: number,
        halfT: number, gradId: string, srcIsLeft: boolean, idx: number
    ) {
        // Bezier always goes left→right geometrically (x1 < x2).
        // When !srcIsLeft the flow is right→left — arrowheads are reversed.
        const dx = (x2 - x1) * 0.5;
        const cpx1 = x1 + dx;  const cpy1 = y1;
        const cpx2 = x2 - dx;  const cpy2 = y2;

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", [
            `M ${x1} ${y1 - halfT}`,
            `C ${cpx1} ${y1 - halfT}, ${cpx2} ${y2 - halfT}, ${x2} ${y2 - halfT}`,
            `L ${x2} ${y2 + halfT}`,
            `C ${cpx2} ${y2 + halfT}, ${cpx1} ${y1 + halfT}, ${x1} ${y1 + halfT}`,
            "Z"
        ].join(" "));
        path.setAttribute("fill", `url(#${gradId})`);

        // Right-to-left flows get a dashed stroke to distinguish direction
        if (!srcIsLeft) {
            path.setAttribute("stroke", src.color);
            path.setAttribute("stroke-width", "0.5");
            path.setAttribute("stroke-dasharray", "5 3");
            path.setAttribute("stroke-opacity", "0.5");
        }

        const arrow = srcIsLeft ? "→" : "↩";
        const suffix = srcIsLeft ? "" : " (backward)";
        const label = `${link.source} ${arrow} ${link.target}: ${link.value.toLocaleString()}${suffix}`;
        path.style.cursor = "default";
        path.addEventListener("mouseenter", (e) => {
            path.style.opacity = "0.8";
            this.showTooltip(e as MouseEvent, label);
        });
        path.addEventListener("mouseleave", () => { path.style.opacity = ""; this.hideTooltip(); });
        this.linkLayer!.appendChild(path);

        const opacity = srcIsLeft ? this.LINK_OPACITY : 0.32;
        if (srcIsLeft) {
            // Flow left→right: arrows along normal Bezier direction
            this.drawPathArrows(x1, y1, cpx1, cpy1, cpx2, cpy2, x2, y2, tgt.color, opacity, false);
        } else {
            // Flow right→left: swap p0↔p3 and p1↔p2 so tangents (and arrows) point leftward
            this.drawPathArrows(x2, y2, cpx2, cpy2, cpx1, cpy1, x1, y1, src.color, opacity, true);
        }
        void idx;
    }

    // ── Bezier math for arrowhead placement ────────────────────────────────────

    private bezierPt(
        p0x: number, p0y: number, p1x: number, p1y: number,
        p2x: number, p2y: number, p3x: number, p3y: number, t: number
    ): { x: number; y: number; angle: number } {
        const mt = 1 - t;
        const x = mt*mt*mt*p0x + 3*mt*mt*t*p1x + 3*mt*t*t*p2x + t*t*t*p3x;
        const y = mt*mt*mt*p0y + 3*mt*mt*t*p1y + 3*mt*t*t*p2y + t*t*t*p3y;
        // Tangent direction
        const dx = 3*mt*mt*(p1x-p0x) + 6*mt*t*(p2x-p1x) + 3*t*t*(p3x-p2x);
        const dy = 3*mt*mt*(p1y-p0y) + 6*mt*t*(p2y-p1y) + 3*t*t*(p3y-p2y);
        return { x, y, angle: Math.atan2(dy, dx) * 180 / Math.PI };
    }

    private drawPathArrows(
        p0x: number, p0y: number, p1x: number, p1y: number,
        p2x: number, p2y: number, p3x: number, p3y: number,
        color: string, opacity: number, isBackward: boolean
    ) {
        // Place 2 arrowheads at t=0.35 and t=0.65
        const positions = isBackward ? [0.35, 0.65] : [0.33, 0.66];
        const arrowOpacity = Math.min(1, opacity * 2.4);
        const s = this.ARROW_SIZE;

        for (const t of positions) {
            const { x, y, angle } = this.bezierPt(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y, t);

            // Skip arrows that land outside the SVG
            if (x < 0 || x > this.vpW || y < 0 || y > this.vpH) continue;

            const arrow = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
            // Triangle pointing right, centered at origin, then rotated + translated
            arrow.setAttribute("points", `${-s},${-s * 0.55} ${s},0 ${-s},${s * 0.55}`);
            arrow.setAttribute("fill", color);
            arrow.setAttribute("fill-opacity", String(arrowOpacity));
            arrow.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${angle.toFixed(1)})`);
            arrow.style.pointerEvents = "none";
            this.linkLayer!.appendChild(arrow);
        }
    }

    // ── Node rendering ─────────────────────────────────────────────────────────

    private renderNodes(layer: SVGGElement) {
        this.nodes.forEach(node => layer.appendChild(this.buildNodeGroup(node)));
    }

    private buildNodeGroup(node: SankeyNode): SVGGElement {
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

        // [0] Body rect
        const rect = this.svgRect(node.x, node.y, node.w, node.h, node.color, 3);
        rect.style.cursor = "grab";
        rect.addEventListener("mouseenter", (e) => {
            rect.setAttribute("fill-opacity", "0.75");
            this.showNodeTooltip(e as MouseEvent, node);
        });
        rect.addEventListener("mouseleave", () => { rect.removeAttribute("fill-opacity"); this.hideTooltip(); });
        g.appendChild(rect);

        // [1] Label text — clipped to stay within SVG
        const maxCol = this.numColumns - 1;
        const isLastCol = node.colIndex === maxCol;
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("y", String(node.y + node.h / 2 - 15));
        text.setAttribute("dominant-baseline", "middle");
        text.setAttribute("font-size", "11");
        text.setAttribute("font-family", "Segoe UI, sans-serif");
        text.setAttribute("fill", "#222");
        text.style.pointerEvents = "none";
        text.style.userSelect = "none";
        if (isLastCol) {
            const lx = Math.max(4, node.x - 4);
            text.setAttribute("x", String(lx));
            text.setAttribute("text-anchor", "end");
        } else {
            const lx = Math.min(this.vpW - 4, node.x + node.w + 4);
            text.setAttribute("x", String(lx));
            text.setAttribute("text-anchor", "start");
        }
        text.textContent = node.label;
        g.appendChild(text);

        // [2] Inflow stat  [3] Outflow stat  [4] Self-loop stat
        const statX = isLastCol ? Math.max(4, node.x - 4) : Math.min(this.vpW - 4, node.x + node.w + 4);
        const anchor = isLastCol ? "end" : "start";
        const makeStatText = (yOff: number, content: string): SVGTextElement => {
            const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
            t.setAttribute("x", String(statX));
            t.setAttribute("y", String(node.y + node.h / 2 + yOff));
            t.setAttribute("dominant-baseline", "middle");
            t.setAttribute("font-size", "9");
            t.setAttribute("font-family", "Segoe UI, sans-serif");
            t.setAttribute("fill", "#666");
            t.setAttribute("text-anchor", anchor);
            t.style.pointerEvents = "none";
            t.style.userSelect = "none";
            t.textContent = content;
            return t;
        };
        g.appendChild(makeStatText(-3,  `↓ ${node.inflow.toLocaleString()}`));
        g.appendChild(makeStatText(+8,  `↑ ${node.outflow.toLocaleString()}`));
        g.appendChild(makeStatText(+19, node.selfLoop > 0 ? `↺ ${node.selfLoop.toLocaleString()}` : ""));

        // [5] Left edge resize handle (invisible 8px strip, ew-resize cursor)
        const leftHandle = this.makeEdgeHandle(node.x - 4, node.y, node.h);
        this.attachWidthResizeHandler(leftHandle, g, node);
        g.appendChild(leftHandle);

        // [6] Right edge resize handle
        const rightHandle = this.makeEdgeHandle(node.x + node.w - 4, node.y, node.h);
        this.attachWidthResizeHandler(rightHandle, g, node);
        g.appendChild(rightHandle);

        this.attachDragHandler(rect, g, node);
        return g;
    }

    private svgRect(x: number, y: number, w: number, h: number, fill: string, rx: number): SVGRectElement {
        const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        r.setAttribute("x", String(x)); r.setAttribute("y", String(y));
        r.setAttribute("width", String(w)); r.setAttribute("height", String(h));
        r.setAttribute("fill", fill); r.setAttribute("rx", String(rx));
        return r;
    }

    // ── Drag ───────────────────────────────────────────────────────────────────

    private attachDragHandler(rect: SVGRectElement, g: SVGGElement, node: SankeyNode) {
        rect.addEventListener("mousedown", (e) => {
            if ((e.target as Element) !== rect) return;
            e.preventDefault(); e.stopPropagation();
            this.hideTooltip();

            const sx = e.clientX, sy = e.clientY;
            const ox = node.x,    oy = node.y;
            rect.style.cursor = "grabbing";

            const onMove = (ev: MouseEvent) => {
                node.x = ox + (ev.clientX - sx);
                node.y = oy + (ev.clientY - sy);
                this.syncNodeDOM(g, node);
                this.renderLinks();
                this.refreshSelfLoops();
            };
            const onUp = () => {
                rect.style.cursor = "grab";
                // Snap to nearest column and clamp to viewport
                node.colIndex = this.nearestColIndex(node.x, node.w);
                node.x = this.colX(node.colIndex) - node.w / 2;
                node.x = Math.max(this.PAD.l - node.w / 2, Math.min(this.vpW - this.PAD.r - node.w / 2, node.x));
                node.y = Math.max(this.PAD.t, Math.min(this.vpH - this.PAD.b - node.h, node.y));
                this.syncNodeDOM(g, node);
                this.renderLinks();
                this.persistPositions();
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
    }

    private makeEdgeHandle(x: number, y: number, h: number): SVGRectElement {
        const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        r.setAttribute("x", String(x));
        r.setAttribute("y", String(y));
        r.setAttribute("width", "8");
        r.setAttribute("height", String(h));
        r.setAttribute("fill", "transparent");
        r.style.cursor = "ew-resize";
        r.addEventListener("mouseenter", () => r.setAttribute("fill", "rgba(0,0,0,0.10)"));
        r.addEventListener("mouseleave", () => r.setAttribute("fill", "transparent"));
        return r;
    }

    private attachWidthResizeHandler(handle: SVGRectElement, g: SVGGElement, node: SankeyNode) {
        handle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hideTooltip();

            // Center stays fixed; both edges expand/contract symmetrically
            const centerX = node.x + node.w / 2;
            const MIN_HALF_W = 6;

            const onMove = (ev: MouseEvent) => {
                const svgBounds = this.svg.getBoundingClientRect();
                const mouseX = ev.clientX - svgBounds.left;
                const halfW = Math.max(MIN_HALF_W, Math.abs(mouseX - centerX));
                node.w = halfW * 2;
                node.x = centerX - halfW;
                this.syncNodeDOM(g, node);
                this.renderLinks();
                this.refreshSelfLoops();
            };
            const onUp = () => {
                this.persistPositions();
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
    }

    // ── DOM sync ───────────────────────────────────────────────────────────────

    private syncNodeDOM(g: SVGGElement, node: SankeyNode) {
        const ch = g.children;
        const isLastCol = node.colIndex === (this.numColumns - 1);
        const tx = isLastCol ? Math.max(4, node.x - 4) : Math.min(this.vpW - 4, node.x + node.w + 4);

        // [0] body rect
        const rect = ch[0] as SVGRectElement;
        rect.setAttribute("x", String(node.x));
        rect.setAttribute("y", String(node.y));
        rect.setAttribute("width", String(node.w));
        rect.setAttribute("height", String(node.h));

        // [1] label
        const lbl = ch[1] as SVGTextElement;
        if (lbl?.tagName === "text") {
            lbl.setAttribute("y", String(node.y + node.h / 2 - 15));
            lbl.setAttribute("x", String(tx));
        }

        // [2] inflow  [3] outflow  [4] self-loop
        const yMid = node.y + node.h / 2;
        const offsets = [-3, 8, 19];
        for (let i = 0; i < 3; i++) {
            const el = ch[2 + i] as SVGTextElement;
            if (el?.tagName === "text") {
                el.setAttribute("x", String(tx));
                el.setAttribute("y", String(yMid + offsets[i]));
            }
        }

        // [5] left edge handle
        const leftH = ch[5] as SVGRectElement;
        if (leftH) {
            leftH.setAttribute("x", String(node.x - 4));
            leftH.setAttribute("y", String(node.y));
            leftH.setAttribute("height", String(node.h));
        }

        // [6] right edge handle
        const rightH = ch[6] as SVGRectElement;
        if (rightH) {
            rightH.setAttribute("x", String(node.x + node.w - 4));
            rightH.setAttribute("y", String(node.y));
            rightH.setAttribute("height", String(node.h));
        }
    }

    // ── Position persistence ───────────────────────────────────────────────────

    private persistPositions() {
        const pos: Record<string, NodePosition> = {};
        this.savedPositions.forEach((p, id) => { pos[id] = p; });
        this.nodes.forEach((node, id) => {
            pos[id] = { colIndex: node.colIndex, y: node.y, w: node.w };
        });
        this.savedPositions = new Map(Object.entries(pos));

        this.host.persistProperties({
            merge: [{
                objectName: "nodePositions",
                properties: { positions: JSON.stringify(pos) },
                selector: null
            }]
        });
    }

    private persistColumnCount() {
        this.host.persistProperties({
            merge: [{
                objectName: "columnCount",
                properties: { count: this.numColumns },
                selector: null
            }]
        });
    }

    // ── Utility ────────────────────────────────────────────────────────────────

    private showMessage(msg: string) {
        while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", "50%"); text.setAttribute("y", "50%");
        text.setAttribute("text-anchor", "middle"); text.setAttribute("dominant-baseline", "middle");
        text.setAttribute("font-size", "14"); text.setAttribute("font-family", "Segoe UI, sans-serif");
        text.setAttribute("fill", "#888");
        text.textContent = msg;
        this.svg.appendChild(text);
    }

    private showNodeTooltip(e: MouseEvent, node: SankeyNode) {
        const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const incoming = this.links.filter(l => l.target === node.id && l.source !== node.id);
        const outgoing = this.links.filter(l => l.source === node.id && l.target !== node.id);
        const maxRows = Math.max(incoming.length, outgoing.length, 1);

        let html = `<div style="font-weight:600;text-align:center;margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.25)">${esc(node.label)}</div>`;
        html += `<table style="border-collapse:collapse;width:100%">`;
        html += `<tr>`;
        html += `<th style="text-align:left;padding:0 14px 4px 0;opacity:0.65;font-weight:600;font-size:11px;letter-spacing:.04em">FROM</th>`;
        html += `<th style="text-align:left;padding:0 0 4px 0;opacity:0.65;font-weight:600;font-size:11px;letter-spacing:.04em">TO</th>`;
        html += `</tr>`;

        for (let i = 0; i < maxRows; i++) {
            const fromLink = incoming[i];
            const toLink   = outgoing[i];
            const fromCell = fromLink
                ? `<span style="opacity:0.85">${esc(fromLink.source)}</span>&nbsp;<span style="opacity:0.5">→</span>&nbsp;<strong>${fromLink.value.toLocaleString()}</strong>`
                : `<span style="opacity:0.25">—</span>`;
            const toCell = toLink
                ? `<span style="opacity:0.85">${esc(toLink.target)}</span>&nbsp;<span style="opacity:0.5">→</span>&nbsp;<strong>${toLink.value.toLocaleString()}</strong>`
                : `<span style="opacity:0.25">—</span>`;
            html += `<tr>`;
            html += `<td style="padding:2px 14px 2px 0;white-space:nowrap">${fromCell}</td>`;
            html += `<td style="padding:2px 0;white-space:nowrap">${toCell}</td>`;
            html += `</tr>`;
        }

        html += `</table>`;
        this.tooltip.innerHTML = html;
        this.tooltip.style.display = "block";
        this.tooltip.style.left = `${e.clientX + 14}px`;
        this.tooltip.style.top  = `${e.clientY - 34}px`;
    }

    private showTooltip(e: MouseEvent, content: string) {
        this.tooltip.textContent = content;
        this.tooltip.style.display = "block";
        this.tooltip.style.left = `${e.clientX + 14}px`;
        this.tooltip.style.top  = `${e.clientY - 34}px`;
    }

    private hideTooltip() { this.tooltip.style.display = "none"; }
}
