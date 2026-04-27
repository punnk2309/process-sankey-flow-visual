"use strict";

import powerbi from "powerbi-visuals-api";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import DataView = powerbi.DataView;

interface NodePosition {
    x: number;
    y: number;
    w: number;
    h: number;
}

interface SankeyNode {
    id: string;
    label: string;
    column: number;
    x: number;
    y: number;
    w: number;
    h: number;
    color: string;
    value: number;
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

    // Persisted positions survive filter changes
    private savedPositions: Map<string, NodePosition> = new Map();
    // Current visible nodes and links
    private nodes: Map<string, SankeyNode> = new Map();
    private links: SankeyLink[] = [];
    // SVG layer references for re-rendering links during drag/resize
    private defs: SVGDefsElement | null = null;
    private linkLayer: SVGGElement | null = null;

    // Stable color assignment per node id
    private colorMap: Map<string, string> = new Map();
    private colorIdx = 0;

    private readonly NODE_W = 24;
    private readonly NODE_MIN_W = 12;
    private readonly NODE_MIN_H = 16;
    private readonly HANDLE = 8;
    private readonly LINK_OPACITY = 0.45;
    private readonly MAX_LINK_THICK = 60;
    private readonly COL_SPACING = 12;

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
            "position:fixed","background:rgba(0,0,0,0.82)","color:#fff",
            "padding:6px 10px","border-radius:4px","font-size:12px",
            "font-family:Segoe UI,sans-serif","pointer-events:none",
            "z-index:9999","white-space:nowrap","display:none"
        ].join(";");
        document.body.appendChild(this.tooltip);
    }

    public update(options: VisualUpdateOptions) {
        const dataView = options.dataViews?.[0];
        if (!dataView?.table) {
            this.showMessage("Add Source, Target, and Value fields to the visual.");
            return;
        }

        this.loadSavedPositions(dataView);

        const { nodes, links } = this.parseData(dataView);
        if (!nodes.size) {
            this.showMessage("Map Source, Target, and Value columns in the Fields pane.");
            return;
        }

        this.assignColumns(nodes, links);
        this.detectBackward(nodes, links);
        this.computeNodeValues(nodes, links);
        this.layoutNodes(nodes, options.viewport.width, options.viewport.height);

        this.nodes = nodes;
        this.links = links;
        this.renderAll(options.viewport.width, options.viewport.height);
    }

    // ── Data parsing ───────────────────────────────────────────────────────────

    private loadSavedPositions(dataView: DataView) {
        try {
            const raw = (dataView.metadata?.objects as any)?.nodePositions?.positions as string | undefined;
            if (raw) {
                const parsed = JSON.parse(raw) as Record<string, NodePosition>;
                this.savedPositions = new Map(Object.entries(parsed));
            }
        } catch { /* ignore corrupt data */ }
    }

    private parseData(dataView: DataView) {
        const { columns, rows } = dataView.table!;
        let si = -1, ti = -1, vi = -1;

        // Prefer role-based mapping
        columns.forEach((col, i) => {
            if (col.roles?.["source"]) si = i;
            else if (col.roles?.["target"]) ti = i;
            else if (col.roles?.["value"]) vi = i;
        });
        // Fallback: match by display name
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
        return { id, label: id, column: 0, x: 0, y: 0, w: this.NODE_W, h: 60, color: this.colorMap.get(id)!, value: 0 };
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

    private computeNodeValues(nodes: Map<string, SankeyNode>, links: SankeyLink[]) {
        const fwd = links.filter(l => !l.isBackward);
        nodes.forEach((node, id) => {
            const inflow  = fwd.filter(l => l.target === id).reduce((s, l) => s + l.value, 0);
            const outflow = fwd.filter(l => l.source === id).reduce((s, l) => s + l.value, 0);
            node.value = Math.max(inflow, outflow, 1);
        });
    }

    // ── Layout ─────────────────────────────────────────────────────────────────

    private layoutNodes(nodes: Map<string, SankeyNode>, vw: number, vh: number) {
        const pad = { t: 30, r: 90, b: 30, l: 90 };
        const innerW = Math.max(vw - pad.l - pad.r, 100);
        const innerH = Math.max(vh - pad.t - pad.b, 100);

        const byCols = new Map<number, SankeyNode[]>();
        nodes.forEach(n => {
            if (!byCols.has(n.column)) byCols.set(n.column, []);
            byCols.get(n.column)!.push(n);
        });

        const numCols = Math.max(0, ...byCols.keys()) + 1;
        const colGap  = numCols > 1 ? innerW / (numCols - 1) : 0;

        byCols.forEach((colNodes, colIdx) => {
            colNodes.sort((a, b) => b.value - a.value);
            const totalVal = colNodes.reduce((s, n) => s + n.value, 0) || 1;

            // Apply saved positions immediately so new nodes can flow around them
            colNodes.forEach(node => {
                if (this.savedPositions.has(node.id)) {
                    const p = this.savedPositions.get(node.id)!;
                    node.x = p.x; node.y = p.y; node.w = p.w; node.h = p.h;
                }
            });

            // Auto-layout nodes without a saved position
            const newNodes = colNodes.filter(n => !this.savedPositions.has(n.id));
            const spacing    = this.COL_SPACING;
            const totalSpace = spacing * Math.max(0, newNodes.length - 1);
            const availH     = innerH - totalSpace;
            let y = pad.t;

            newNodes.forEach(node => {
                const nodeH = Math.max(this.NODE_MIN_H, Math.min(200, (node.value / totalVal) * availH));
                const cx    = numCols > 1 ? pad.l + colIdx * colGap : pad.l + innerW / 2;
                node.x = cx - this.NODE_W / 2;
                node.y = y;
                node.w = this.NODE_W;
                node.h = nodeH;
                y += nodeH + spacing;
            });
        });
    }

    // ── Rendering ──────────────────────────────────────────────────────────────

    private renderAll(width: number, height: number) {
        while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
        this.svg.setAttribute("width", String(width));
        this.svg.setAttribute("height", String(height));

        this.defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
        this.svg.appendChild(this.defs);

        this.linkLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
        this.svg.appendChild(this.linkLayer);

        const nodeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
        this.svg.appendChild(nodeLayer);

        this.renderLinks();
        this.renderNodes(nodeLayer);
    }

    private renderLinks() {
        if (!this.linkLayer || !this.defs) return;
        while (this.linkLayer.firstChild) this.linkLayer.removeChild(this.linkLayer.firstChild);
        while (this.defs.firstChild) this.defs.removeChild(this.defs.firstChild);

        // Track how far down each node's edge we've used so far
        const srcOff = new Map<string, number>();
        const tgtOff = new Map<string, number>();
        this.nodes.forEach((_, id) => { srcOff.set(id, 0); tgtOff.set(id, 0); });

        const totalFlow = this.links.filter(l => !l.isBackward).reduce((s, l) => s + l.value, 0) || 1;

        // Draw forward links first, then backward
        const sorted = [...this.links].sort((a, b) => (a.isBackward ? 1 : 0) - (b.isBackward ? 1 : 0));

        sorted.forEach((link, i) => {
            const src = this.nodes.get(link.source);
            const tgt = this.nodes.get(link.target);
            if (!src || !tgt) return;

            // Thickness proportional to flow value
            const thick   = Math.max(2, (link.value / totalFlow) * this.MAX_LINK_THICK);
            const capped  = Math.min(thick, src.h * 0.88, tgt.h * 0.88);

            const so = srcOff.get(link.source) || 0;
            const to = tgtOff.get(link.target) || 0;
            srcOff.set(link.source, so + capped);
            tgtOff.set(link.target, to + capped);

            // Determine attachment points
            let x1: number, y1: number, x2: number, y2: number;
            if (link.isBackward) {
                x1 = src.x;             y1 = src.y + so + capped / 2;
                x2 = tgt.x + tgt.w;    y2 = tgt.y + to + capped / 2;
            } else {
                x1 = src.x + src.w;    y1 = src.y + so + capped / 2;
                x2 = tgt.x;            y2 = tgt.y + to + capped / 2;
            }

            // Gradient along flow direction
            const gradId = `g${i}`;
            const grad = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
            grad.setAttribute("id", gradId);
            grad.setAttribute("gradientUnits", "userSpaceOnUse");
            grad.setAttribute("x1", String(x1)); grad.setAttribute("y1", String(y1));
            grad.setAttribute("x2", String(x2)); grad.setAttribute("y2", String(y2));

            for (const [off, color] of [[0, src.color], [1, tgt.color]] as [number, string][]) {
                const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
                stop.setAttribute("offset", String(off));
                stop.setAttribute("stop-color", color);
                stop.setAttribute("stop-opacity", String(link.isBackward ? 0.3 : this.LINK_OPACITY));
                grad.appendChild(stop);
            }
            this.defs.appendChild(grad);

            // Bezier ribbon path
            const dx   = Math.abs(x2 - x1) * 0.5;
            const cpx1 = link.isBackward ? x1 - dx : x1 + dx;
            const cpx2 = link.isBackward ? x2 + dx : x2 - dx;
            const half  = capped / 2;

            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", [
                `M ${x1} ${y1 - half}`,
                `C ${cpx1} ${y1 - half}, ${cpx2} ${y2 - half}, ${x2} ${y2 - half}`,
                `L ${x2} ${y2 + half}`,
                `C ${cpx2} ${y2 + half}, ${cpx1} ${y1 + half}, ${x1} ${y1 + half}`,
                "Z"
            ].join(" "));
            path.setAttribute("fill", `url(#${gradId})`);

            if (link.isBackward) {
                path.setAttribute("stroke", src.color);
                path.setAttribute("stroke-width", "1");
                path.setAttribute("stroke-dasharray", "4 3");
                path.setAttribute("stroke-opacity", "0.5");
            }

            path.style.cursor = "default";
            path.addEventListener("mouseenter", (e) => {
                path.style.opacity = "0.72";
                const label = `${link.source} → ${link.target}: ${link.value.toLocaleString()}${link.isBackward ? "  ↩ backward" : ""}`;
                this.showTooltip(e as MouseEvent, label);
            });
            path.addEventListener("mouseleave", () => {
                path.style.opacity = "";
                this.hideTooltip();
            });

            this.linkLayer.appendChild(path);
        });
    }

    private renderNodes(layer: SVGGElement) {
        this.nodes.forEach(node => layer.appendChild(this.buildNodeGroup(node)));
    }

    private buildNodeGroup(node: SankeyNode): SVGGElement {
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

        // ── Body rectangle ─────────────────────────────────────────────────────
        const rect = this.svgRect(node.x, node.y, node.w, node.h, node.color, 3);
        rect.style.cursor = "grab";
        rect.addEventListener("mouseenter", (e) => {
            rect.setAttribute("fill-opacity", "0.75");
            this.showTooltip(e as MouseEvent, `${node.label}  |  ${node.value.toLocaleString()}`);
        });
        rect.addEventListener("mouseleave", () => {
            rect.removeAttribute("fill-opacity");
            this.hideTooltip();
        });
        g.appendChild(rect); // child[0]

        // ── Label ─────────────────────────────────────────────────────────────
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        const maxCol = Math.max(0, ...Array.from(this.nodes.values()).map(n => n.column));
        text.setAttribute("y", String(node.y + node.h / 2));
        text.setAttribute("dominant-baseline", "middle");
        text.setAttribute("font-size", "11");
        text.setAttribute("font-family", "Segoe UI, sans-serif");
        text.setAttribute("fill", "#222");
        text.style.pointerEvents = "none";
        text.style.userSelect = "none";
        if (node.column === maxCol) {
            text.setAttribute("x", String(node.x - 4));
            text.setAttribute("text-anchor", "end");
        } else {
            text.setAttribute("x", String(node.x + node.w + 4));
            text.setAttribute("text-anchor", "start");
        }
        text.textContent = node.label;
        g.appendChild(text); // child[1]

        // ── Corner resize handles ─────────────────────────────────────────────
        const hs = this.HANDLE;
        for (const { dx, dy, cur, corner } of [
            { dx: 0, dy: 0, cur: "nw-resize", corner: "nw" },
            { dx: 1, dy: 0, cur: "ne-resize", corner: "ne" },
            { dx: 0, dy: 1, cur: "sw-resize", corner: "sw" },
            { dx: 1, dy: 1, cur: "se-resize", corner: "se" },
        ]) {
            const h = this.svgRect(node.x + node.w * dx - hs/2, node.y + node.h * dy - hs/2, hs, hs, "#ffffff", 2);
            h.setAttribute("stroke", node.color);
            h.setAttribute("stroke-width", "1.5");
            h.style.cursor = cur;
            this.attachResizeHandler(h, g, node, corner);
            g.appendChild(h); // child[2..5]
        }

        // Drag must be attached after handles so handles can stopPropagation
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
            if ((e.target as Element) !== rect) return; // let handle events through
            e.preventDefault();
            e.stopPropagation();
            this.hideTooltip();

            const sx = e.clientX, sy = e.clientY;
            const ox = node.x,    oy = node.y;
            rect.style.cursor = "grabbing";

            const onMove = (ev: MouseEvent) => {
                node.x = ox + (ev.clientX - sx);
                node.y = oy + (ev.clientY - sy);
                this.syncNodeDOM(g, node);
                this.renderLinks();
            };
            const onUp = () => {
                rect.style.cursor = "grab";
                this.persistPositions();
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
    }

    // ── Resize ─────────────────────────────────────────────────────────────────

    private attachResizeHandler(handle: SVGRectElement, g: SVGGElement, node: SankeyNode, corner: string) {
        handle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hideTooltip();

            const sx = e.clientX, sy = e.clientY;
            const ox = node.x, oy = node.y, ow = node.w, oh = node.h;

            const onMove = (ev: MouseEvent) => {
                const dx = ev.clientX - sx;
                const dy = ev.clientY - sy;

                if (corner.includes("e")) {
                    node.w = Math.max(this.NODE_MIN_W, ow + dx);
                } else {
                    const nw = Math.max(this.NODE_MIN_W, ow - dx);
                    node.x = ox + ow - nw;
                    node.w = nw;
                }
                if (corner.includes("s")) {
                    node.h = Math.max(this.NODE_MIN_H, oh + dy);
                } else {
                    const nh = Math.max(this.NODE_MIN_H, oh - dy);
                    node.y = oy + oh - nh;
                    node.h = nh;
                }

                this.syncNodeDOM(g, node);
                this.renderLinks();
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

    // ── DOM sync (update existing elements without full re-render) ─────────────

    private syncNodeDOM(g: SVGGElement, node: SankeyNode) {
        const ch = g.children;
        const hs = this.HANDLE;

        // [0] body rect
        const rect = ch[0] as SVGRectElement;
        rect.setAttribute("x", String(node.x));
        rect.setAttribute("y", String(node.y));
        rect.setAttribute("width", String(node.w));
        rect.setAttribute("height", String(node.h));

        // [1] label text
        const text = ch[1] as SVGTextElement;
        if (text?.tagName === "text") {
            const maxCol = Math.max(0, ...Array.from(this.nodes.values()).map(n => n.column));
            text.setAttribute("y", String(node.y + node.h / 2));
            if (node.column === maxCol) {
                text.setAttribute("x", String(node.x - 4));
            } else {
                text.setAttribute("x", String(node.x + node.w + 4));
            }
        }

        // [2..5] corner handles
        for (const [i, { dx, dy }] of [
            { dx: 0, dy: 0 }, { dx: 1, dy: 0 },
            { dx: 0, dy: 1 }, { dx: 1, dy: 1 }
        ].entries()) {
            const h = ch[2 + i] as SVGRectElement;
            if (h) {
                h.setAttribute("x", String(node.x + node.w * dx - hs/2));
                h.setAttribute("y", String(node.y + node.h * dy - hs/2));
            }
        }
    }

    // ── Position persistence ───────────────────────────────────────────────────

    private persistPositions() {
        const pos: Record<string, NodePosition> = {};
        // Keep positions of all nodes ever seen (including filtered-out ones)
        this.savedPositions.forEach((p, id) => { pos[id] = p; });
        // Overwrite with current node positions (drag/resize may have updated them)
        this.nodes.forEach((node, id) => {
            pos[id] = { x: node.x, y: node.y, w: node.w, h: node.h };
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

    // ── Utility ────────────────────────────────────────────────────────────────

    private showMessage(msg: string) {
        while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", "50%");
        text.setAttribute("y", "50%");
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("dominant-baseline", "middle");
        text.setAttribute("font-size", "14");
        text.setAttribute("font-family", "Segoe UI, sans-serif");
        text.setAttribute("fill", "#888");
        text.textContent = msg;
        this.svg.appendChild(text);
    }

    private showTooltip(e: MouseEvent, content: string) {
        this.tooltip.textContent = content;
        this.tooltip.style.display = "block";
        this.tooltip.style.left = `${e.clientX + 14}px`;
        this.tooltip.style.top  = `${e.clientY - 34}px`;
    }

    private hideTooltip() {
        this.tooltip.style.display = "none";
    }
}
