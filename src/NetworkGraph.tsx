import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import { select } from 'd3-selection';
import { zoom as d3zoom, zoomIdentity } from 'd3-zoom';
import { drag as d3drag } from 'd3-drag';
import { scaleOrdinal, scaleLinear } from 'd3-scale';
import { clearNetworkLayout, exportCandidateCsv, exportRecommendedFasta, loadNetworkLayout, saveNetworkLayout, type BrowserGraphNode, type BrowserGraphEdge, type NetworkLayoutSnapshot } from './api';
import { downloadButtonClass, downloadSelectClass } from './uiStyles';

// --- shared palette (same 18 colors as server buildCategoryColorMap) ---
const PALETTE = [
  '#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1',
  '#FF9DA7', '#9C755F', '#BAB0AC', '#1B9E77', '#D95F02', '#7570B3', '#E7298A',
  '#66A61E', '#E6AB02', '#A6761D', '#666666',
];

type RendererMode = 'd3' | 'cytoscape';
type CategoryCol = 'phylum' | 'class' | 'kingdom' | 'order' | 'family' | 'genus' | 'species' | 'cluster';
type GraphExportFormat = 'png' | 'svg';
type GraphExporter = (format: GraphExportFormat) => Promise<Blob>;
type LayoutDraft = Omit<NetworkLayoutSnapshot, 'formatVersion' | 'savedAt' | 'nodeFingerprint'>;
type RendererController = {
  getLayout: () => LayoutDraft;
  applyLayout: (layout: NetworkLayoutSnapshot) => void;
  setFrozen: (frozen: boolean) => void;
  runAutomaticLayout: () => void;
};

type VisibilityState = {
  threshold: number;
  hideSingletons: boolean;
};

type VisibilitySummary = {
  visibleEdgeCount: number;
  visibleNodeCount: number;
  hiddenSingletonCount: number;
  hiddenSingletonIds: Set<string>;
};

interface Props {
  nodes: BrowserGraphNode[];
  edges: BrowserGraphEdge[];
  mode: RendererMode;
  categoryColumn: CategoryCol;
  initialThreshold?: number;
  minThreshold?: number;
  highlightIds?: string[];
  onSelectNode?: (id: string) => void;
  height?: number;
  selectionStorageKey?: string;
}

/** Renderer internal props — threshold managed imperatively via ref */
interface RendererProps extends Omit<Props, 'mode' | 'initialThreshold'> {
  thresholdRef: React.MutableRefObject<number>;
  hideSingletonsRef: React.MutableRefObject<boolean>;
  /** Register a callback the slider will invoke directly (no React re-render) */
  onRegisterApply: (fn: (state: VisibilityState) => void) => void;
  /** Register an exporter for the currently mounted renderer. */
  onRegisterExporter: (fn: GraphExporter | null) => void;
  selectionModeRef: React.MutableRefObject<boolean>;
  selectedIdsRef: React.MutableRefObject<Set<string>>;
  onNodeInteraction: (id: string) => void;
  onRegisterSelectionApply: (fn: (() => void) | null) => void;
  onRegisterLayoutController: (controller: RendererController | null) => void;
}

function serializeSvgElement(svg: SVGSVGElement) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const width = Math.max(1, Math.round(svg.clientWidth || svg.getBoundingClientRect().width || 800));
  const height = Math.max(1, Math.round(svg.clientHeight || svg.getBoundingClientRect().height || 600));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('x', '0');
  background.setAttribute('y', '0');
  background.setAttribute('width', String(width));
  background.setAttribute('height', String(height));
  background.setAttribute('fill', '#ffffff');
  clone.insertBefore(background, clone.firstChild);

  return {
    text: `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`,
    width,
    height,
  };
}

async function svgTextToPngBlob(svgText: string, width: number, height: number) {
  const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Unable to render the graph as PNG'));
      image.src = url;
    });

    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is not available in this browser');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Unable to encode the graph as PNG')), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function dataUriToBlob(dataUri: string) {
  const [meta, data = ''] = dataUri.split(',', 2);
  const mime = /data:([^;,]+)/.exec(meta)?.[1] || 'application/octet-stream';
  const binary = meta.includes(';base64') ? atob(data) : decodeURIComponent(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

function buildCytoscapeSvg(cy: any) {
  const visibleNodes = cy.nodes().filter((node: any) => !node.hasClass('hidden') && node.style('display') !== 'none');
  if (!visibleNodes.length) throw new Error('There are no visible nodes to export');
  const visibleIds = new Set<string>();
  visibleNodes.forEach((node: any) => visibleIds.add(String(node.id())));
  const visibleEdges = cy.edges().filter((edge: any) => (
    !edge.hasClass('hidden')
    && edge.style('display') !== 'none'
    && visibleIds.has(String(edge.source().id()))
    && visibleIds.has(String(edge.target().id()))
  ));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  visibleNodes.forEach((node: any) => {
    const pos = node.position();
    const width = Number.parseFloat(node.style('width')) || 18;
    const height = Number.parseFloat(node.style('height')) || 18;
    const border = Number.parseFloat(node.style('border-width')) || 0;
    minX = Math.min(minX, pos.x - width / 2 - border);
    minY = Math.min(minY, pos.y - height / 2 - border);
    maxX = Math.max(maxX, pos.x + width / 2 + border);
    maxY = Math.max(maxY, pos.y + height / 2 + border);
  });

  const padding = 36;
  const viewX = minX - padding;
  const viewY = minY - padding;
  const width = Math.max(1, maxX - minX + padding * 2);
  const height = Math.max(1, maxY - minY + padding * 2);
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="${viewX} ${viewY} ${width} ${height}">`,
    `<rect x="${viewX}" y="${viewY}" width="${width}" height="${height}" fill="#ffffff"/>`,
    '<g class="edges">',
  ];
  visibleEdges.forEach((edge: any) => {
    const source = edge.source().position();
    const target = edge.target().position();
    const color = edge.style('line-color') || '#bbbbbb';
    const lineWidth = Number.parseFloat(edge.style('width')) || 1;
    const opacity = Number.parseFloat(edge.style('opacity'));
    parts.push(`<line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" stroke="${color}" stroke-width="${lineWidth}" stroke-opacity="${Number.isFinite(opacity) ? opacity : 0.5}"/>`);
  });
  parts.push('</g>', '<g class="nodes">');
  visibleNodes.forEach((node: any) => {
    const pos = node.position();
    const width = Number.parseFloat(node.style('width')) || 18;
    const height = Number.parseFloat(node.style('height')) || 18;
    const fill = node.style('background-color') || '#cccccc';
    const stroke = node.style('border-color') || '#555555';
    const strokeWidth = Number.parseFloat(node.style('border-width')) || 0;
    parts.push(`<ellipse cx="${pos.x}" cy="${pos.y}" rx="${width / 2}" ry="${height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`);
  });
  parts.push('</g>', '</svg>');
  return { text: parts.join('\n'), width: Math.ceil(width), height: Math.ceil(height) };
}

function computeVisibilitySummary(
  nodes: BrowserGraphNode[],
  edges: BrowserGraphEdge[],
  threshold: number,
  hideSingletons: boolean,
  protectedVisibleIds?: Iterable<string>,
): VisibilitySummary {
  const degreeById = new Map<string, number>();
  const protectedIds = protectedVisibleIds ? new Set(protectedVisibleIds) : null;
  let visibleEdgeCount = 0;

  for (const edge of edges) {
    if (edge.similarity < threshold) {
      continue;
    }
    visibleEdgeCount += 1;
    degreeById.set(edge.source, (degreeById.get(edge.source) || 0) + 1);
    degreeById.set(edge.target, (degreeById.get(edge.target) || 0) + 1);
  }

  const hiddenSingletonIds = new Set<string>();
  for (const node of nodes) {
    const isReference = String(node.is_reference || '0') === '1';
    if (isReference) {
      continue;
    }
    if (protectedIds?.has(node.id)) {
      continue;
    }
    if ((degreeById.get(node.id) || 0) === 0) {
      hiddenSingletonIds.add(node.id);
    }
  }

  return {
    visibleEdgeCount,
    visibleNodeCount: hideSingletons ? nodes.length - hiddenSingletonIds.size : nodes.length,
    hiddenSingletonCount: hiddenSingletonIds.size,
    hiddenSingletonIds,
  };
}

function buildClusterSeedPositions(nodes: BrowserGraphNode[]) {
  const grouped = new Map<string, BrowserGraphNode[]>();
  for (const node of nodes) {
    const clusterName = String(node.cluster || 'Unclustered') || 'Unclustered';
    const group = grouped.get(clusterName) || [];
    group.push(node);
    grouped.set(clusterName, group);
  }

  const clusterEntries = Array.from(grouped.entries())
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]));

  const cols = Math.max(1, Math.ceil(Math.sqrt(clusterEntries.length)));
  const centerGapX = 440;
  const centerGapY = 340;
  const positions = new Map<string, { x: number; y: number }>();

  clusterEntries.forEach(([_, members], clusterIndex) => {
    const centerX = (clusterIndex % cols) * centerGapX;
    const centerY = Math.floor(clusterIndex / cols) * centerGapY;

    members.forEach((node, memberIndex) => {
      if (memberIndex === 0) {
        positions.set(node.id, { x: centerX, y: centerY });
        return;
      }

      const ring = Math.floor((memberIndex - 1) / 12) + 1;
      const offsetIndex = (memberIndex - 1) % 12;
      const perRing = 12 + (ring - 1) * 6;
      const angle = (offsetIndex / perRing) * Math.PI * 2;
      const radius = 46 + ring * 32;
      positions.set(node.id, {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      });
    });
  });

  return positions;
}

function shouldDefaultHideSingletons(
  nodes: BrowserGraphNode[],
  edges: BrowserGraphEdge[],
  threshold: number,
  protectedVisibleIds?: Iterable<string>,
) {
  if (nodes.length < 120) {
    return false;
  }
  const summary = computeVisibilitySummary(nodes, edges, threshold, false, protectedVisibleIds);
  return summary.hiddenSingletonCount >= 80 && summary.hiddenSingletonCount / nodes.length >= 0.35;
}

// ====== D3 renderer ======
interface D3Node extends SimulationNodeDatum {
  id: string;
  data: BrowserGraphNode;
}
interface D3Link extends SimulationLinkDatum<D3Node> {
  weight: number;
  similarity: number;
}

function GraphTooltip({ tooltip }: { tooltip: { x: number; y: number; node: BrowserGraphNode } }) {
  return (
    <div className="absolute pointer-events-none bg-slate-800 text-white text-xs px-2 py-1.5 rounded shadow-lg max-w-xs z-50" style={{ left: tooltip.x + 12, top: tooltip.y }}>
      <div className="font-semibold">{tooltip.node.id}</div>
      {tooltip.node.cluster && <div>Cluster: {tooltip.node.cluster}</div>}
      {tooltip.node.is_reference === '1' && <div className="text-red-300 font-medium">Reference</div>}
      {tooltip.node.kingdom && <div>Kingdom: {tooltip.node.kingdom}</div>}
      {tooltip.node.phylum && <div>Phylum: {tooltip.node.phylum}</div>}
      {tooltip.node.class && <div>Class: {tooltip.node.class}</div>}
      {tooltip.node.order && <div>Order: {tooltip.node.order}</div>}
      {tooltip.node.family && <div>Family: {tooltip.node.family}</div>}
      {tooltip.node.genus && <div>Genus: {tooltip.node.genus}</div>}
      {tooltip.node.species && <div>Species: {tooltip.node.species}</div>}
    </div>
  );
}

function D3Renderer({
  nodes, edges, categoryColumn, thresholdRef, hideSingletonsRef, onRegisterApply, onRegisterExporter,
  highlightIds, onSelectNode, height, selectionModeRef, selectedIdsRef, onNodeInteraction,
  onRegisterSelectionApply, onRegisterLayoutController,
}: RendererProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: BrowserGraphNode } | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !nodes.length) return;
    const W = svg.clientWidth || 800;
    const H = height || 600;
    const idSet = new Set(nodes.map((node) => node.id));
    const d3nodes: D3Node[] = nodes.map((node) => ({ id: node.id, data: node }));
    const nodeMap = new Map(d3nodes.map((node) => [node.id, node]));
    const d3links: D3Link[] = edges.filter((edge) => idSet.has(edge.source) && idSet.has(edge.target)).map((edge) => ({
      source: nodeMap.get(edge.source)!, target: nodeMap.get(edge.target)!, weight: edge.weight, similarity: edge.similarity,
    }));
    const cats = Array.from(new Set(nodes.map((node) => (node as any)[categoryColumn] || '').filter(Boolean)));
    const color = scaleOrdinal<string>().domain(cats).range(PALETTE);
    const weights = d3links.map((link) => link.weight);
    const edgeWidth = scaleLinear().domain([Math.min(...weights, 0), Math.max(...weights, 1)]).range([0.3, 4]).clamp(true);
    const sel = select(svg);
    sel.selectAll('*').remove();
    const g = sel.append('g');
    let currentTransform: any = zoomIdentity;
    let frozen = false;
    const zoomBehavior = d3zoom<SVGSVGElement, unknown>().scaleExtent([0.1, 10]).on('zoom', (event) => {
      currentTransform = event.transform;
      g.attr('transform', event.transform);
    });
    sel.call(zoomBehavior);
    const sim = forceSimulation<D3Node>(d3nodes)
      .force('link', forceLink<D3Node, D3Link>(d3links).id((node) => node.id).distance(60).strength(0.3))
      .force('charge', forceManyBody().strength(-120).distanceMax(300))
      .force('center', forceCenter(W / 2, H / 2))
      .force('collide', forceCollide(10)).alphaDecay(0.03).velocityDecay(0.4).stop();
    const maxTicks = Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()));
    for (let index = 0; index < maxTicks; index += 1) sim.tick();
    const highlightSet = new Set(highlightIds || []);
    const initialVisibility = computeVisibilitySummary(nodes, edges, thresholdRef.current, hideSingletonsRef.current, highlightSet);
    const linkSel = g.append('g').attr('class', 'edges').selectAll('line').data(d3links).join('line')
      .attr('stroke', '#bbb').attr('stroke-width', (link) => edgeWidth(link.weight))
      .attr('stroke-opacity', (link) => (link.similarity >= thresholdRef.current ? 0.5 : 0));
    const nodeSel = g.append('g').attr('class', 'nodes').selectAll('circle').data(d3nodes).join('circle')
      .attr('fill', (node) => { const value = (node.data as any)[categoryColumn] || ''; return value ? color(value) : '#ccc'; })
      .attr('display', (node) => (hideSingletonsRef.current && initialVisibility.hiddenSingletonIds.has(node.id) ? 'none' : null))
      .style('cursor', 'pointer');
    const updatePositions = () => {
      linkSel.attr('x1', (link: any) => link.source.x).attr('y1', (link: any) => link.source.y)
        .attr('x2', (link: any) => link.target.x).attr('y2', (link: any) => link.target.y);
      nodeSel.attr('cx', (node) => node.x!).attr('cy', (node) => node.y!);
    };
    const applySelectionStyles = () => {
      nodeSel.attr('r', (node) => node.data.is_reference === '1' ? 14 : (selectedIdsRef.current.has(node.id) || highlightSet.has(node.id) ? 11 : 7))
        .attr('stroke', (node) => selectedIdsRef.current.has(node.id) ? '#0ea5e9' : (highlightSet.has(node.id) ? '#FFD700' : (node.data.is_reference === '1' ? '#FF3B30' : '#fff')))
        .attr('stroke-width', (node) => selectedIdsRef.current.has(node.id) ? 4 : (highlightSet.has(node.id) || node.data.is_reference === '1' ? 3 : 1));
    };
    updatePositions();
    applySelectionStyles();
    onRegisterSelectionApply(applySelectionStyles);
    onRegisterApply((state) => {
      const summary = computeVisibilitySummary(nodes, edges, state.threshold, state.hideSingletons, highlightSet);
      linkSel.attr('stroke-opacity', (link: D3Link) => (link.similarity >= state.threshold ? 0.5 : 0));
      nodeSel.attr('display', (node: D3Node) => (state.hideSingletons && summary.hiddenSingletonIds.has(node.id) ? 'none' : null));
    });
    sim.on('tick', updatePositions);
    let dragging = false;
    const dragBehavior = d3drag<SVGCircleElement, D3Node>().filter(() => !selectionModeRef.current && !frozen)
      .on('start', (_event, node) => { dragging = false; node.fx = node.x; node.fy = node.y; })
      .on('drag', (event, node) => { if (!dragging) { dragging = true; sim.alphaTarget(0.08).restart(); } node.fx = event.x; node.fy = event.y; })
      .on('end', (_event, node) => { if (dragging) sim.alphaTarget(0); if (!frozen) { node.fx = null; node.fy = null; } dragging = false; });
    nodeSel.call(dragBehavior as any)
      .on('mouseenter', (event, node) => { const rect = svg.getBoundingClientRect(); setTooltip({ x: event.clientX - rect.left, y: event.clientY - rect.top - 10, node: node.data }); })
      .on('mouseleave', () => setTooltip(null))
      .on('click', (_event, node) => { if (selectionModeRef.current) { onNodeInteraction(node.id); applySelectionStyles(); } else onSelectNode?.(node.id); });
    const setFrozen = (next: boolean) => {
      frozen = next;
      d3nodes.forEach((node) => { node.fx = next ? node.x : null; node.fy = next ? node.y : null; });
      if (next) sim.stop();
    };
    const fitGraph = () => {
      const bounds = g.node()?.getBBox();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
      const pad = 40;
      const scale = Math.min((W - pad) / bounds.width, (H - pad) / bounds.height, 2);
      sel.call(zoomBehavior.transform, zoomIdentity.translate(W / 2 - (bounds.x + bounds.width / 2) * scale, H / 2 - (bounds.y + bounds.height / 2) * scale).scale(scale));
    };
    const runAutomaticLayout = () => {
      frozen = false;
      d3nodes.forEach((node) => { node.fx = null; node.fy = null; });
      sim.alpha(1).stop();
      for (let index = 0; index < maxTicks; index += 1) sim.tick();
      updatePositions(); fitGraph();
    };
    // Establish a deterministic fallback before registering the controller. The
    // parent applies a saved snapshot synchronously during registration, so an
    // automatic layout must never run after that restore and overwrite it.
    runAutomaticLayout();
    onRegisterLayoutController({
      getLayout: () => ({ frozen, renderer: 'd3', zoom: Number(currentTransform?.k) || 1, pan: { x: Number(currentTransform?.x) || 0, y: Number(currentTransform?.y) || 0 }, positions: Object.fromEntries(d3nodes.map((node) => [node.id, { x: Number(node.x) || 0, y: Number(node.y) || 0 }])) }),
      applyLayout: (layout) => {
        d3nodes.forEach((node) => { const position = layout.positions?.[node.id]; if (position) { node.x = Number(position.x); node.y = Number(position.y); } });
        updatePositions();
        sel.call(zoomBehavior.transform, zoomIdentity.translate(layout.pan?.x || 0, layout.pan?.y || 0).scale(layout.zoom || 1));
        setFrozen(layout.frozen !== false);
      },
      setFrozen,
      runAutomaticLayout,
    });
    onRegisterExporter(async (format) => { const exported = serializeSvgElement(svg); return format === 'svg' ? new Blob([exported.text], { type: 'image/svg+xml;charset=utf-8' }) : svgTextToPngBlob(exported.text, exported.width, exported.height); });
    return () => { sim.stop(); onRegisterExporter(null); onRegisterSelectionApply(null); onRegisterLayoutController(null); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, categoryColumn, highlightIds, onSelectNode, height]);

  return <div className="relative w-full overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"><svg ref={svgRef} width="100%" height={height || 600} style={{ display: 'block' }} />{tooltip && <GraphTooltip tooltip={tooltip} />}</div>;
}

// ====== Cytoscape.js renderer ======
function CytoscapeRenderer({
  nodes, edges, categoryColumn, thresholdRef, hideSingletonsRef, onRegisterApply, onRegisterExporter,
  highlightIds, onSelectNode, height, selectionModeRef, selectedIdsRef, onNodeInteraction,
  onRegisterSelectionApply, onRegisterLayoutController,
}: RendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<any>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: BrowserGraphNode } | null>(null);

  // Main layout effect
  useEffect(() => {
    if (!containerRef.current || !nodes.length) return;
    let cy: any = null;
    let fitFrame = 0;
    let disposed = false;
    let activeLayout: any = null;
    let frozen = false;

    (async () => {
      const cytoscape = (await import('cytoscape')).default;
      if (disposed || !containerRef.current) {
        return;
      }
      const cats = Array.from(new Set(nodes.map((n) => (n as any)[categoryColumn] || '').filter(Boolean)));
      const colorMap = new Map<string, string>();
      cats.forEach((c, i) => colorMap.set(c, PALETTE[i % PALETTE.length]));

      const idSet = new Set(nodes.map((n) => n.id));
      const highlightSet = new Set(highlightIds || []);
      const curThreshold = thresholdRef.current;
      const curHideSingletons = hideSingletonsRef.current;
      const initialVisibility = computeVisibilitySummary(nodes, edges, curThreshold, curHideSingletons, highlightSet);
      const elements = [
        ...nodes.map((n) => ({
          group: 'nodes' as const,
          classes: [curHideSingletons && initialVisibility.hiddenSingletonIds.has(n.id) ? 'hidden' : '', selectedIdsRef.current.has(n.id) ? 'selected' : ''].filter(Boolean).join(' '),
          data: {
            id: n.id,
            ...n,
            _color: colorMap.get((n as any)[categoryColumn] || '') || '#ccc',
          },
        })),
        ...edges
          .filter((e) => idSet.has(e.source) && idSet.has(e.target))
          .map((e, i) => ({
            group: 'edges' as const,
            classes: e.similarity < curThreshold ? 'hidden' : '',
            data: {
              id: `e${i}`,
              source: e.source,
              target: e.target,
              weight: e.weight,
              similarity: e.similarity,
            },
          })),
      ];

      const weights = edges.map((e) => e.weight);
      const wMin = Math.min(...weights, 0);
      const wMax = Math.max(...weights, 1);
      const visibleLayout = {
        name: 'cose',
        animate: false,
        fit: false,
        padding: 36,
        randomize: true,
        // Make repulsion strong enough to push nodes apart uniformly
        nodeRepulsion: (node: any) => 800000,
        nodeOverlap: 120,
        idealEdgeLength: (edge: any) => {
          const w = edge.data('weight') || 0;
          const range = Math.max(0.01, wMax - wMin);
          const norm = Math.max(0, Math.min(1, (w - wMin) / range));
          // log-like buffer: high base distance (avoid clumping) + log penalty for distance
          return 140 + 60 * Math.log10(1 + 9 * (1 - norm));
        },
        // IMPORTANT: edgeElasticity is the DIVISOR for force. 
        // 32 is default. Using a very low number (0.1) caused runaway spring forces, making them clump into singularities!
        edgeElasticity: (edge: any) => 32,
        gravity: 0.1,
        nestingFactor: 1.2,
        componentSpacing: 100,
        numIter: 2500,
        initialTemp: 200,
        coolingFactor: 0.95,
        minTemp: 1,
      } as any;
      let lastHideSingletons = curHideSingletons;
      let lastVisibleNodeCount = initialVisibility.visibleNodeCount;

      cy = cytoscape({
        container: containerRef.current,
        elements,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': 'data(_color)',
              width: 18,
              height: 18,
              'border-width': 1,
              'border-color': '#555',
              label: '',
            },
          },
          {
            selector: 'node[is_reference = "1"]',
            style: {
              width: 32,
              height: 32,
              'border-width': 4,
              'border-color': '#FF3B30',
            },
          },
          {
            selector: 'edge',
            style: {
              'line-color': '#bbb',
              opacity: 0.5,
              width: `mapData(weight, ${wMin}, ${wMax}, 0.5, 5)`,
            } as any,
          },
          {
            selector: 'edge.hidden',
            style: { display: 'none' },
          },
          {
            selector: 'node.hidden',
            style: { display: 'none' },
          },
          {
            selector: 'node.selected',
            style: { 'border-width': 4, 'border-color': '#0ea5e9', width: 26, height: 26 },
          },
        ],
        layout: {
          name: 'preset',
          fit: false,
        } as any,
        minZoom: 0.1,
        maxZoom: 10,
      });

      const fitVisibleGraph = () => {
        if (disposed || !cy || (typeof cy.destroyed === 'function' && cy.destroyed())) {
          return;
        }
        const focus = cy.elements().filter((element: any) => !element.hasClass('hidden'));
        if (focus.length) {
          cy.fit(focus, 36);
        }
      };

      const scheduleFitVisibleGraph = () => {
        if (disposed) {
          return;
        }
        if (fitFrame) {
          cancelAnimationFrame(fitFrame);
        }
        fitFrame = requestAnimationFrame(() => {
          fitFrame = 0;
          fitVisibleGraph();
        });
      };

      const runVisibleLayout = () => {
        if (frozen) {
          scheduleFitVisibleGraph();
          return;
        }
        if (disposed || !cy || (typeof cy.destroyed === 'function' && cy.destroyed())) {
          return;
        }
        const visibleElements = cy.elements().filter((element: any) => !element.hasClass('hidden'));
        if (!visibleElements.length) {
          scheduleFitVisibleGraph();
          return;
        }

        if (activeLayout) {
          activeLayout.stop();
          activeLayout = null;
        }

        const layout = visibleElements.layout(visibleLayout);
        activeLayout = layout;
        layout.on('layoutstop', () => {
          if (disposed) {
            return;
          }
          if (activeLayout === layout) {
            activeLayout = null;
          }
          scheduleFitVisibleGraph();
        });
        layout.run();
      };

      const applyVisibility = (state: VisibilityState) => {
        if (disposed || !cy || (typeof cy.destroyed === 'function' && cy.destroyed())) {
          return;
        }
        const summary = computeVisibilitySummary(nodes, edges, state.threshold, state.hideSingletons, highlightSet);
        cy.startBatch();
        cy.edges().forEach((e: any) => {
          if (e.data('similarity') < state.threshold) {
            e.addClass('hidden');
          } else {
            e.removeClass('hidden');
          }
        });
        cy.nodes().forEach((n: any) => {
          const isReference = String(n.data('is_reference') || '0') === '1';
          const hideNode = state.hideSingletons && !isReference && summary.hiddenSingletonIds.has(n.id());
          if (hideNode) {
            n.addClass('hidden');
          } else {
            n.removeClass('hidden');
          }
        });
        cy.endBatch();
        const shouldRelayout =
          state.hideSingletons !== lastHideSingletons ||
          summary.visibleNodeCount !== lastVisibleNodeCount;
        lastHideSingletons = state.hideSingletons;
        lastVisibleNodeCount = summary.visibleNodeCount;
        if (shouldRelayout) {
          runVisibleLayout();
        } else {
          scheduleFitVisibleGraph();
        }
      };

      const applySelectionStyles = () => {
        if (!cy || (typeof cy.destroyed === 'function' && cy.destroyed())) return;
        cy.nodes().forEach((node: any) => {
          if (selectedIdsRef.current.has(node.id())) node.addClass('selected');
          else node.removeClass('selected');
        });
      };
      onRegisterSelectionApply(applySelectionStyles);
      // Register imperative threshold updater (called directly by slider, no React re-render)
      onRegisterApply((state: VisibilityState) => applyVisibility(state));

      runVisibleLayout();

      if (highlightSet.size) {
        cy.nodes().forEach((n: any) => {
          if (highlightSet.has(n.id())) {
            n.style({ 'border-width': 4, 'border-color': '#FFD700', width: 26, height: 26 });
          }
        });
      }

      cy.on('mouseover', 'node', (evt: any) => {
        const n = evt.target;
        const pos = evt.renderedPosition || n.renderedPosition();
        setTooltip({
          x: pos.x,
          y: pos.y - 10,
          node: {
            id: n.id(),
            cluster: n.data('cluster') || '',
            cluster_size: n.data('cluster_size') || 1,
            is_reference: n.data('is_reference') || '0',
            kingdom: n.data('kingdom') || '',
            phylum: n.data('phylum') || '',
            class: n.data('class') || '',
            order: n.data('order') || '',
            family: n.data('family') || '',
            genus: n.data('genus') || '',
            species: n.data('species') || '',
          },
        });
      });
      cy.on('mouseout', 'node', () => setTooltip(null));
      cy.on('tap', 'node', (evt: any) => {
        const id = evt.target.id();
        if (selectionModeRef.current) {
          onNodeInteraction(id);
          applySelectionStyles();
        } else {
          onSelectNode?.(id);
        }
      });

      const setFrozen = (next: boolean) => {
        frozen = next;
        if (next) cy.nodes().lock(); else cy.nodes().unlock();
      };
      onRegisterLayoutController({
        getLayout: () => ({
          frozen,
          renderer: 'cytoscape',
          zoom: Number(cy.zoom()) || 1,
          pan: { x: Number(cy.pan()?.x) || 0, y: Number(cy.pan()?.y) || 0 },
          positions: Object.fromEntries(cy.nodes().map((node: any) => [node.id(), { x: Number(node.position('x')) || 0, y: Number(node.position('y')) || 0 }])),
        }),
        applyLayout: (layout) => {
          // A preset snapshot wins over any in-flight automatic CoSE layout.
          if (activeLayout) {
            activeLayout.stop();
            activeLayout = null;
          }
          cy.startBatch();
          cy.nodes().forEach((node: any) => {
            const position = layout.positions?.[node.id()];
            if (position) node.position({ x: Number(position.x), y: Number(position.y) });
          });
          cy.endBatch();
          cy.zoom(layout.zoom || 1);
          cy.pan({ x: layout.pan?.x || 0, y: layout.pan?.y || 0 });
          setFrozen(layout.frozen !== false);
        },
        setFrozen,
        runAutomaticLayout: () => { frozen = false; cy.nodes().unlock(); runVisibleLayout(); },
      });
      cyRef.current = cy;
      onRegisterExporter(async (format) => {
        if (!cy || (typeof cy.destroyed === 'function' && cy.destroyed())) {
          throw new Error('The graph renderer is not ready');
        }
        if (format === 'png') {
          return dataUriToBlob(cy.png({ full: true, scale: 2, bg: '#ffffff', maxWidth: 8192, maxHeight: 8192 }));
        }
        const exported = buildCytoscapeSvg(cy);
        return new Blob([exported.text], { type: 'image/svg+xml;charset=utf-8' });
      });
    })();

    return () => {
      disposed = true;
      if (fitFrame) {
        cancelAnimationFrame(fitFrame);
      }
      if (activeLayout) {
        activeLayout.stop();
        activeLayout = null;
      }
      onRegisterExporter(null);
      onRegisterSelectionApply(null);
      onRegisterLayoutController(null);
      if (cy) cy.destroy();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, categoryColumn, highlightIds, onSelectNode, height]);

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div ref={containerRef} style={{ width: '100%', height: height || 600 }} />
{tooltip && <GraphTooltip tooltip={tooltip} />}
    </div>
  );
}

// ====== Legend ======
function GraphLegend({ nodes, categoryColumn }: { nodes: BrowserGraphNode[]; categoryColumn: CategoryCol }) {
  const cats = Array.from(new Set(nodes.map((n) => (n as any)[categoryColumn] || '').filter(Boolean)));
  if (!cats.length) return null;
  const color = scaleOrdinal<string>().domain(cats).range(PALETTE);
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {cats.map((c) => (
        <span key={c} className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: color(c) }} />
          {c}
        </span>
      ))}
      <span className="ml-2 inline-flex items-center gap-1 border-l border-slate-300 pl-2 dark:border-slate-600">
        <span className="inline-block w-3 h-3 rounded-full border-2 border-red-500 bg-white" />
        Reference
      </span>
    </div>
  );
}

// ====== Main component ======
export default function NetworkGraph({ nodes, edges, mode, categoryColumn, initialThreshold = 80, minThreshold = 40, highlightIds, onSelectNode, height, selectionStorageKey }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const defaultHideSingletons = shouldDefaultHideSingletons(nodes, edges, initialThreshold, highlightIds || []);
  const thresholdRef = useRef(initialThreshold);
  const hideSingletonsRef = useRef(defaultHideSingletons);
  const [hideSingletons, setHideSingletons] = useState(defaultHideSingletons);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [exportFormat, setExportFormat] = useState<GraphExportFormat>('png');
  const [exporting, setExporting] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const selectionModeRef = useRef(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const [selectedSearch, setSelectedSearch] = useState('');
  const [sequenceExportFormat, setSequenceExportFormat] = useState<'fasta' | 'csv'>('fasta');
  const [layoutState, setLayoutState] = useState<'checking' | 'missing' | 'ready' | 'partial' | 'stale'>('checking');
  const [layoutFrozen, setLayoutFrozen] = useState(false);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutMessage, setLayoutMessage] = useState('Checking for a saved layout…');
  const [viewportHeight, setViewportHeight] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 900));
  const applyRef = useRef<((state: VisibilityState) => void) | null>(null);
  const exporterRef = useRef<GraphExporter | null>(null);
  const selectionApplyRef = useRef<(() => void) | null>(null);
  const layoutControllerRef = useRef<RendererController | null>(null);
  const pendingLayoutRef = useRef<NetworkLayoutSnapshot | null>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const singletonRef = useRef<HTMLSpanElement>(null);
  const visibleNodesRef = useRef<HTMLSpanElement>(null);

  const persistSelection = useCallback((next: Set<string>) => {
    if (!selectionStorageKey) return;
    try { localStorage.setItem(selectionStorageKey, JSON.stringify(Array.from(next))); } catch { /* optional */ }
  }, [selectionStorageKey]);

  useEffect(() => {
    const valid = new Set(nodes.map((node) => node.id));
    let restored: string[] = [];
    if (selectionStorageKey) {
      try { restored = JSON.parse(localStorage.getItem(selectionStorageKey) || '[]'); } catch { restored = []; }
    }
    const next = new Set(restored.filter((id) => valid.has(String(id))));
    selectedIdsRef.current = next;
    setSelectedIds(next);
    selectionApplyRef.current?.();
  }, [nodes, selectionStorageKey]);

  const onRegisterApply = useCallback((fn: (state: VisibilityState) => void) => { applyRef.current = fn; }, []);
  const onRegisterExporter = useCallback((fn: GraphExporter | null) => { exporterRef.current = fn; }, []);
  const onRegisterSelectionApply = useCallback((fn: (() => void) | null) => { selectionApplyRef.current = fn; fn?.(); }, []);
  const onRegisterLayoutController = useCallback((controller: RendererController | null) => {
    layoutControllerRef.current = controller;
    if (controller && pendingLayoutRef.current) controller.applyLayout(pendingLayoutRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    pendingLayoutRef.current = null;
    setLayoutState('checking');
    setLayoutMessage('Checking for a saved layout…');
    loadNetworkLayout().then((result) => {
      if (cancelled) return;
      setLayoutState(result.state);
      if (!result.exists || !result.layout) {
        setLayoutFrozen(false);
        setLayoutMessage('No saved layout. The automatic layout is currently active.');
        return;
      }
      pendingLayoutRef.current = result.layout;
      layoutControllerRef.current?.applyLayout(result.layout);
      setLayoutFrozen(result.layout.frozen !== false);
      setLayoutMessage(result.state === 'ready'
        ? `Saved layout restored (${result.matchingCount || result.nodeCount} nodes).`
        : `Partially restored ${result.matchingCount || 0} matching node positions; the network contents have changed.`);
    }).catch((error) => {
      if (!cancelled) { setLayoutState('missing'); setLayoutMessage(`Saved layout unavailable: ${error?.message || error}`); }
    });
    return () => { cancelled = true; };
  }, [nodes, selectionStorageKey]);

  const updateSelection = useCallback((next: Set<string>) => {
    selectedIdsRef.current = next;
    setSelectedIds(new Set(next));
    persistSelection(next);
    selectionApplyRef.current?.();
  }, [persistSelection]);

  const onNodeInteraction = useCallback((id: string) => {
    const next = new Set(selectedIdsRef.current);
    if (next.has(id)) next.delete(id); else next.add(id);
    updateSelection(next);
  }, [updateSelection]);

  const handleExport = useCallback(async () => {
    const exporter = exporterRef.current;
    if (!exporter || exporting) return;
    setExporting(true);
    try {
      const blob = await exporter(exportFormat);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `sequence_similarity_network.${exportFormat}`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error: any) { alert(`Graph export failed: ${error?.message || error}`); }
    finally { setExporting(false); }
  }, [exportFormat, exporting]);

  const handleSequenceExport = useCallback(async () => {
    const ids = Array.from(selectedIdsRef.current);
    if (!ids.length) return;
    setExporting(true);
    try {
      const result = sequenceExportFormat === 'fasta' ? await exportRecommendedFasta(ids) : await exportCandidateCsv(ids);
      const content = sequenceExportFormat === 'fasta' ? (result as any).fasta : (result as any).csv;
      const blob = new Blob([content], { type: sequenceExportFormat === 'fasta' ? 'text/plain;charset=utf-8' : 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `selected_network_sequences.${sequenceExportFormat}`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error: any) { alert(`Sequence export failed: ${error?.message || error}`); }
    finally { setExporting(false); }
  }, [sequenceExportFormat]);

  const updateControlRefs = useCallback((summary: VisibilitySummary, nextHideSingletons: boolean) => {
    if (countRef.current) countRef.current.textContent = `(${summary.visibleEdgeCount} / ${edges.length} edges)`;
    if (visibleNodesRef.current) visibleNodesRef.current.textContent = `Visible ${summary.visibleNodeCount} / ${nodes.length} nodes`;
    if (singletonRef.current) singletonRef.current.textContent = nextHideSingletons ? `Hidden ${summary.hiddenSingletonCount} non-reference singleton(s)` : `Hideable ${summary.hiddenSingletonCount} non-reference singleton(s)`;
  }, [edges.length, nodes.length]);

  const applyVisibility = useCallback((threshold: number, nextHideSingletons: boolean) => {
    const summary = computeVisibilitySummary(nodes, edges, threshold, nextHideSingletons, highlightIds || []);
    updateControlRefs(summary, nextHideSingletons);
    applyRef.current?.({ threshold, hideSingletons: nextHideSingletons });
  }, [edges, highlightIds, nodes, updateControlRefs]);

  const handleSlider = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    thresholdRef.current = value;
    if (labelRef.current) labelRef.current.textContent = value.toFixed(1);
    applyVisibility(value, hideSingletonsRef.current);
  }, [applyVisibility]);
  const handleSingletonToggle = useCallback((next: boolean) => { hideSingletonsRef.current = next; setHideSingletons(next); applyVisibility(thresholdRef.current, next); }, [applyVisibility]);

  const selectVisible = useCallback(() => {
    const summary = computeVisibilitySummary(nodes, edges, thresholdRef.current, hideSingletonsRef.current, highlightIds || []);
    const next = new Set(selectedIdsRef.current);
    nodes.forEach((node) => { if (!summary.hiddenSingletonIds.has(node.id) || !hideSingletonsRef.current) next.add(node.id); });
    updateSelection(next);
  }, [edges, highlightIds, nodes, updateSelection]);
  const selectAllLoaded = useCallback(() => updateSelection(new Set(nodes.map((node) => node.id))), [nodes, updateSelection]);
  const clearSelection = useCallback(() => updateSelection(new Set()), [updateSelection]);

  const freezeAndSave = useCallback(async () => {
    const controller = layoutControllerRef.current;
    if (!controller) return;
    setLayoutBusy(true);
    try {
      controller.setFrozen(true);
      const result = await saveNetworkLayout({ ...controller.getLayout(), frozen: true, renderer: mode });
      pendingLayoutRef.current = result.layout;
      setLayoutFrozen(true); setLayoutState('ready');
      setLayoutMessage(`Layout frozen and saved for ${result.savedCount} nodes.`);
    } catch (error: any) { alert(`Layout save failed: ${error?.message || error}`); }
    finally { setLayoutBusy(false); }
  }, [mode]);
  const unlockLayout = useCallback(() => { layoutControllerRef.current?.setFrozen(false); setLayoutFrozen(false); setLayoutMessage('Layout unlocked. Dragging and automatic relayout are enabled; the saved snapshot is retained.'); }, []);
  const restoreLayout = useCallback(() => { if (pendingLayoutRef.current) { layoutControllerRef.current?.applyLayout(pendingLayoutRef.current); setLayoutFrozen(pendingLayoutRef.current.frozen !== false); setLayoutMessage('Saved layout restored.'); } }, []);
  const clearSavedLayout = useCallback(async () => {
    if (!window.confirm('Clear the saved network layout for this task?')) return;
    setLayoutBusy(true);
    try { await clearNetworkLayout(); pendingLayoutRef.current = null; setLayoutState('missing'); setLayoutFrozen(false); layoutControllerRef.current?.setFrozen(false); setLayoutMessage('Saved layout cleared.'); }
    catch (error: any) { alert(`Unable to clear layout: ${error?.message || error}`); }
    finally { setLayoutBusy(false); }
  }, []);
  const runAutomaticLayout = useCallback(() => { layoutControllerRef.current?.runAutomaticLayout(); setLayoutFrozen(false); setLayoutMessage('Automatic layout generated. Use Freeze & Save Layout to make it persistent.'); }, []);

  const handleFullscreenToggle = useCallback(async () => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    try { if (document.fullscreenElement === wrapper) await document.exitFullscreen(); else await wrapper.requestFullscreen(); }
    catch (error: any) { alert(`Fullscreen mode is unavailable: ${error?.message || error}`); }
  }, []);
  useEffect(() => {
    const update = () => { setIsFullscreen(document.fullscreenElement === wrapperRef.current); setViewportHeight(window.innerHeight); };
    document.addEventListener('fullscreenchange', update); window.addEventListener('resize', update);
    return () => { document.removeEventListener('fullscreenchange', update); window.removeEventListener('resize', update); };
  }, []);
  useEffect(() => {
    thresholdRef.current = initialThreshold; hideSingletonsRef.current = defaultHideSingletons; setHideSingletons(defaultHideSingletons);
    if (sliderRef.current) sliderRef.current.value = String(initialThreshold);
    if (labelRef.current) labelRef.current.textContent = initialThreshold.toFixed(1);
    updateControlRefs(computeVisibilitySummary(nodes, edges, initialThreshold, defaultHideSingletons, highlightIds || []), defaultHideSingletons);
  }, [defaultHideSingletons, edges, highlightIds, initialThreshold, nodes, updateControlRefs]);

  if (!nodes.length) return <div className="text-sm text-slate-400 p-4">No network data. Please compute sequence similarity first.</div>;
  const initSummary = computeVisibilitySummary(nodes, edges, initialThreshold, defaultHideSingletons, highlightIds || []);
  const graphHeight = isFullscreen ? Math.max(720, viewportHeight - 210) : (height || 600);
  const filteredSelected = Array.from(selectedIds).filter((id) => id.toLowerCase().includes(selectedSearch.trim().toLowerCase()));
  const rendererProps = { nodes, edges, categoryColumn, thresholdRef, hideSingletonsRef, onRegisterApply, onRegisterExporter, highlightIds, onSelectNode, height: graphHeight, selectionModeRef, selectedIdsRef, onNodeInteraction, onRegisterSelectionApply, onRegisterLayoutController };

  return (
    <div ref={wrapperRef} className={`network-graph-shell space-y-2 bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100 ${isFullscreen ? 'h-full w-full overflow-auto p-4' : ''}`}>
      <div className={`${isFullscreen ? 'sticky top-0 z-20 space-y-2 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/95' : 'space-y-2'}`}>
        <div className="flex flex-wrap items-center justify-between gap-3"><GraphLegend nodes={nodes} categoryColumn={categoryColumn} />{isFullscreen && <span className="text-xs text-slate-500 dark:text-slate-400">Press Esc or use Exit Fullscreen</span>}</div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-[320px] flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <label className="whitespace-nowrap text-xs text-slate-600 dark:text-slate-300">In-graph visibility threshold ({minThreshold.toFixed(1)}–100)</label>
              <input ref={sliderRef} type="range" min={minThreshold} max={100} step={0.1} defaultValue={initialThreshold} onChange={handleSlider} className="flex-1 h-2 accent-sky-600" />
              <span ref={labelRef} className="w-12 text-right font-mono text-xs text-slate-700 dark:text-slate-200">{initialThreshold.toFixed(1)}</span>
              <span ref={countRef} className="text-xs text-slate-500 dark:text-slate-400">({initSummary.visibleEdgeCount} / {edges.length} edges)</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1 text-xs dark:border-slate-700 dark:bg-slate-950">
                <button type="button" className={`rounded-md px-3 py-1.5 ${!hideSingletons ? 'bg-white text-slate-800 shadow-sm dark:bg-slate-700 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400'}`} onClick={() => handleSingletonToggle(false)}>Show All</button>
                <button type="button" className={`rounded-md px-3 py-1.5 ${hideSingletons ? 'bg-slate-800 text-white shadow-sm dark:bg-slate-600' : 'text-slate-500 dark:text-slate-400'}`} onClick={() => handleSingletonToggle(true)}>Hide Singletons</button>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400"><span ref={visibleNodesRef}>Visible {initSummary.visibleNodeCount} / {nodes.length} nodes</span><span ref={singletonRef}>Hideable {initSummary.hiddenSingletonCount} non-reference singleton(s)</span></div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1 text-xs dark:border-slate-700 dark:bg-slate-950">
              <button type="button" className={`rounded-md px-3 py-1.5 ${!selectionMode ? 'bg-white shadow-sm dark:bg-slate-700' : 'text-slate-500 dark:text-slate-400'}`} onClick={() => { selectionModeRef.current = false; setSelectionMode(false); }}>Navigate</button>
              <button type="button" className={`rounded-md px-3 py-1.5 ${selectionMode ? 'bg-sky-600 text-white shadow-sm' : 'text-slate-500 dark:text-slate-400'}`} onClick={() => { selectionModeRef.current = true; setSelectionMode(true); }}>Select Nodes</button>
            </div>
            <div className="inline-flex overflow-hidden rounded-lg border border-emerald-700 shadow-sm"><button type="button" className={downloadButtonClass(exporting)} onClick={handleExport} disabled={exporting}>{exporting ? 'Exporting…' : 'Download Image'}</button><select aria-label="Graph download format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as GraphExportFormat)} disabled={exporting} className={downloadSelectClass}><option value="png">PNG</option><option value="svg">SVG</option></select></div>
            <button type="button" className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium dark:border-slate-600 dark:bg-slate-800" onClick={handleFullscreenToggle}>{isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950/60">
          <div><span className={`font-medium ${layoutFrozen ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-700 dark:text-slate-200'}`}>{layoutFrozen ? 'Layout frozen' : 'Layout editable'}</span><span className="ml-2 text-slate-500 dark:text-slate-400">{layoutMessage}</span></div>
          <div className="flex flex-wrap items-center gap-2"><button disabled={layoutBusy} onClick={freezeAndSave} className="rounded-md bg-emerald-600 px-3 py-1.5 font-medium text-white disabled:opacity-50">Freeze & Save Layout</button><button disabled={!layoutFrozen || layoutBusy} onClick={unlockLayout} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800">Unlock</button><details className="relative"><summary className="cursor-pointer list-none rounded-md border border-slate-300 bg-white px-3 py-1.5 dark:border-slate-600 dark:bg-slate-800 [&::-webkit-details-marker]:hidden">More actions</summary><div className="absolute right-0 z-30 mt-1 min-w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"><button className="w-full rounded px-3 py-2 text-left hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800" disabled={!pendingLayoutRef.current} onClick={restoreLayout}>Restore Saved Layout</button><button className="w-full rounded px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={runAutomaticLayout}>Run Automatic Layout</button><button className="w-full rounded px-3 py-2 text-left text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/40" onClick={clearSavedLayout}>Clear Saved Layout</button></div></details></div>
        </div>
      </div>
      {selectionMode && <div className="rounded-lg border border-sky-200 bg-sky-50/70 p-3 text-xs dark:border-sky-800 dark:bg-sky-950/30"><div className="flex flex-wrap items-center justify-between gap-2"><div><b>{selectedIds.size}</b> node(s) selected. Click a node to select/unselect it.</div><div className="flex flex-wrap gap-2"><button onClick={selectVisible} className="rounded border border-sky-300 bg-white px-3 py-1.5 dark:bg-slate-900">Select Visible</button><button onClick={selectAllLoaded} className="rounded border border-sky-300 bg-white px-3 py-1.5 dark:bg-slate-900">Select All Loaded</button><button onClick={clearSelection} className="rounded border border-slate-300 bg-white px-3 py-1.5 dark:bg-slate-900">Clear Selection</button><div className="inline-flex overflow-hidden rounded border border-emerald-700"><button disabled={!selectedIds.size || exporting} onClick={handleSequenceExport} className="bg-emerald-600 px-3 py-1.5 font-medium text-white disabled:opacity-50">Save Selected</button><select value={sequenceExportFormat} onChange={(event) => setSequenceExportFormat(event.target.value as 'fasta' | 'csv')} className="border-l border-emerald-700 bg-white px-2 text-xs text-slate-700"><option value="fasta">FASTA</option><option value="csv">CSV</option></select></div></div></div>{selectedIds.size > 0 && <div className="mt-3"><input value={selectedSearch} onChange={(event) => setSelectedSearch(event.target.value)} placeholder="Search selected node IDs" className="w-full max-w-sm rounded border border-slate-300 bg-white px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900" /><div className="mt-2 flex max-h-24 flex-wrap gap-1 overflow-auto">{filteredSelected.slice(0, 200).map((id) => <button key={id} title="Unselect" onClick={() => onNodeInteraction(id)} className="rounded-full bg-white px-2 py-1 text-sky-700 shadow-sm dark:bg-slate-900 dark:text-sky-300">{id} ×</button>)}{filteredSelected.length > 200 && <span className="px-2 py-1 text-slate-500">+{filteredSelected.length - 200} more</span>}</div></div>}</div>}
      {mode === 'd3' ? <D3Renderer {...rendererProps} /> : <CytoscapeRenderer {...rendererProps} />}
      <div className="text-xs text-slate-400 dark:text-slate-500">{nodes.length} nodes · {edges.length} edges · Renderer: {mode === 'd3' ? 'D3 Force' : 'Cytoscape.js (Organic CoSE)'} · Layout: {layoutState}</div>
    </div>
  );
}
