import React, { useState, useMemo, useRef } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  RotateCcw,
  GitBranch,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  FastForward,
  RefreshCw,
  FolderGit2,
  FileCode2,
  ArrowRight,
  AlertTriangle,
  EyeOff,
  Eye,
  Layers,
  CornerDownRight,
  Sparkles,
} from 'lucide-react';
import {
  CodeFile,
  ControlFlowEdge,
  ControlFlowNode,
  ExecutionTraceResult,
  FunctionDef,
  ProjectModel,
} from '../types/codeMap';

interface InteractiveMapCanvasProps {
  project: ProjectModel;
  activeFile: CodeFile;
  activeFunction: FunctionDef | null;
  selectedNode: ControlFlowNode | null;
  viewMode: 'flow' | 'dependencies' | 'trace' | 'architecture';
  onViewModeChange: (mode: 'flow' | 'dependencies' | 'trace' | 'architecture') => void;
  onSelectNode: (node: ControlFlowNode) => void;
  onNavigateToFileFunction: (filePath: string, functionName?: string) => void;
  traceResult: ExecutionTraceResult;
  currentStepIndex: number;
  onStepChange: (stepIdx: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onRestartTrace: () => void;
  breadcrumbs: Array<{ label: string; file?: string; functionName?: string }>;
  onBreadcrumbClick: (idx: number) => void;
}

interface PositionedNode {
  node: ControlFlowNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const InteractiveMapCanvas: React.FC<InteractiveMapCanvasProps> = ({
  project,
  activeFile,
  activeFunction,
  selectedNode,
  viewMode,
  onViewModeChange,
  onSelectNode,
  onNavigateToFileFunction,
  traceResult,
  currentStepIndex,
  onStepChange,
  isPlaying,
  onTogglePlay,
  onRestartTrace,
  breadcrumbs,
  onBreadcrumbClick,
}) => {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hideInactiveNodes, setHideInactiveNodes] = useState(false);
  const [showExecutionOverlay, setShowExecutionOverlay] = useState(true);
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(new Set());
  const svgContainerRef = useRef<HTMLDivElement>(null);

  const activeStep = traceResult.steps[currentStepIndex] || null;

  const visitedSet = useMemo(
    () => new Set(traceResult.visitedNodeIds),
    [traceResult.visitedNodeIds]
  );
  const visitedEdgesSet = useMemo(
    () => new Set(traceResult.visitedEdgeIds),
    [traceResult.visitedEdgeIds]
  );

  // Compute 2D hierarchical layout for the active function's Control Flow Graph
  const { positionedNodes, layoutEdges, canvasWidth, canvasHeight } = useMemo(() => {
    const fn = activeFunction || activeFile.functions[0];
    if (!fn) {
      return { positionedNodes: [], layoutEdges: [], canvasWidth: 920, canvasHeight: 650 };
    }

    let rawNodes = fn.nodes;
    let rawEdges = fn.edges;

    if (hideInactiveNodes && visitedSet.size > 0) {
      rawNodes = rawNodes.filter((n) => visitedSet.has(n.id) || n.kind === 'function' || n.kind === 'end');
      const allowedIds = new Set(rawNodes.map((n) => n.id));
      rawEdges = rawEdges.filter((e) => allowedIds.has(e.source) && allowedIds.has(e.target));
    }

    const NODE_W = 236;
    const NODE_H = 80;
    const V_GAP = 116;
    const BRANCH_OFFSET = 165;
    const CENTER_X = 460;

    const positioned: PositionedNode[] = [];
    const posMap = new Map<string, PositionedNode>();
    const placedIds = new Set<string>();

    const placeNode = (node: ControlFlowNode, x: number, y: number) => {
      if (placedIds.has(node.id)) return;
      const item: PositionedNode = { node, x, y, width: NODE_W, height: NODE_H };
      positioned.push(item);
      posMap.set(node.id, item);
      placedIds.add(node.id);
    };

    // Helper to follow a linear chain of nodes starting from a branch target until a merge or end node
    const collectBranchChain = (startId: string | undefined): ControlFlowNode[] => {
      const chain: ControlFlowNode[] = [];
      let currId = startId;
      const seen = new Set<string>();
      while (currId && !seen.has(currId)) {
        seen.add(currId);
        const nodeObj = rawNodes.find((n) => n.id === currId);
        if (!nodeObj || nodeObj.kind === 'end') break;
        // Stop if node has multiple non-loop incoming edges (it's a merge node)
        const inEdges = rawEdges.filter(
          (e) => e.target === currId && e.branchType !== 'loop_back'
        );
        if (chain.length > 0 && inEdges.length > 1) break;
        chain.push(nodeObj);
        const nextEdge = rawEdges.find(
          (e) => e.source === currId && e.branchType !== 'loop_back'
        );
        currId = nextEdge?.target;
      }
      return chain;
    };

    let currentY = 44;

    for (const node of rawNodes) {
      if (placedIds.has(node.id)) continue;
      if (node.kind === 'end') continue;

      placeNode(node, CENTER_X - NODE_W / 2, currentY);
      currentY += V_GAP;

      if (node.kind === 'condition') {
        const trueEdge = rawEdges.find(
          (e) => e.source === node.id && e.branchType === 'true'
        );
        const falseEdge = rawEdges.find(
          (e) => e.source === node.id && e.branchType === 'false'
        );

        const trueChain = collectBranchChain(trueEdge?.target);
        const falseChain = collectBranchChain(falseEdge?.target);

        if (trueChain.length > 0 || falseChain.length > 0) {
          const maxLen = Math.max(trueChain.length, falseChain.length);
          for (let step = 0; step < maxLen; step++) {
            const tNode = trueChain[step];
            const fNode = falseChain[step];
            if (tNode) {
              placeNode(tNode, CENTER_X - BRANCH_OFFSET - NODE_W / 2, currentY);
            }
            if (fNode) {
              placeNode(fNode, CENTER_X + BRANCH_OFFSET - NODE_W / 2, currentY);
            }
            currentY += V_GAP;
          }
        }
      }
    }

    const endNode = rawNodes.find((n) => n.kind === 'end');
    if (endNode && !placedIds.has(endNode.id)) {
      placeNode(endNode, CENTER_X - NODE_W / 2, currentY);
      currentY += V_GAP;
    }

    return {
      positionedNodes: positioned,
      layoutEdges: rawEdges.filter((e) => posMap.has(e.source) && posMap.has(e.target)),
      canvasWidth: 920,
      canvasHeight: Math.max(640, currentY + 60),
    };
  }, [activeFunction, activeFile, hideInactiveNodes, visitedSet]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    setZoom((z) => Math.min(2.2, Math.max(0.45, Number((z + delta).toFixed(2)))));
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-node-card="true"]')) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const resetCamera = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const toggleCollapseNode = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setCollapsedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const getNodeAccent = (node: ControlFlowNode, isVisited: boolean, isCurrentStep: boolean) => {
    if (isCurrentStep) {
      return {
        border: 'border-blue-400 ring-2 ring-blue-500/40',
        bg: 'bg-[#1c2230]',
        badgeBg: 'bg-blue-500/20 text-blue-300',
      };
    }
    if (node.kind === 'exception') {
      return {
        border: isVisited ? 'border-red-500 ring-2 ring-red-500/30' : 'border-red-500/50',
        bg: 'bg-[#251619]',
        badgeBg: 'bg-red-500/20 text-red-300',
      };
    }
    if (node.kind === 'condition' || node.kind === 'switch') {
      return {
        border: isVisited ? 'border-amber-400/80' : 'border-amber-500/30',
        bg: 'bg-[#1b1a16]',
        badgeBg: 'bg-amber-500/15 text-amber-300',
      };
    }
    if (node.kind === 'loop') {
      return {
        border: isVisited ? 'border-purple-400/80' : 'border-purple-500/35',
        bg: 'bg-[#1c1824]',
        badgeBg: 'bg-purple-500/15 text-purple-300',
      };
    }
    if (node.kind === 'call') {
      return {
        border: isVisited ? 'border-emerald-400/80' : 'border-emerald-500/35',
        bg: 'bg-[#15201c]',
        badgeBg: 'bg-emerald-500/15 text-emerald-300',
      };
    }
    if (node.kind === 'function') {
      return {
        border: 'border-blue-400/70',
        bg: 'bg-[#171c26]',
        badgeBg: 'bg-blue-500/20 text-blue-300',
      };
    }
    if (node.kind === 'return' || node.kind === 'end') {
      return {
        border: isVisited ? 'border-cyan-400/75' : 'border-white/15',
        bg: 'bg-[#16191e]',
        badgeBg: 'bg-cyan-500/15 text-cyan-300',
      };
    }
    return {
      border: isVisited ? 'border-blue-400/60' : 'border-white/10',
      bg: 'bg-[#17181c]',
      badgeBg: 'bg-white/10 text-zinc-300',
    };
  };

  return (
    <div className="flex flex-col h-full bg-[#0e0f12] select-none relative overflow-hidden">
      {/* Top Map Toolbar + Breadcrumbs + View Mode Switcher */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 bg-[#141519] border-b border-white/[0.07] z-10">
        {/* Breadcrumb Trail */}
        <nav aria-label="Code Map Breadcrumbs" className="flex items-center gap-1 text-xs overflow-x-auto min-w-0">
          {breadcrumbs.map((crumb, idx) => (
            <React.Fragment key={`${crumb.label}-${idx}`}>
              {idx > 0 && <span className="text-zinc-600 shrink-0">/</span>}
              <button
                type="button"
                onClick={() => onBreadcrumbClick(idx)}
                className={`px-2 py-1 rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  idx === breadcrumbs.length - 1
                    ? 'bg-white/[0.08] text-white font-medium'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]'
                }`}
              >
                {crumb.label}
              </button>
            </React.Fragment>
          ))}
        </nav>

        {/* Map View Mode Segmented Control */}
        <div className="flex items-center gap-1 p-1 bg-[#0e0f12] border border-white/[0.07] rounded-lg shrink-0">
          <button
            type="button"
            onClick={() => onViewModeChange('flow')}
            className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'flow'
                ? 'bg-[#23252c] text-white'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Code Flow
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange('architecture')}
            className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'architecture'
                ? 'bg-[#23252c] text-white'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Architecture
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange('dependencies')}
            className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'dependencies'
                ? 'bg-[#23252c] text-white'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Dependencies
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange('trace')}
            className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'trace'
                ? 'bg-[#23252c] text-white'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Trace ({traceResult.steps.length})
          </button>
        </div>
      </div>

      {/* Floating Map Camera & Filter Controls (Bottom-Right above Debugger Bar, zero overlap) */}
      <div className="absolute bottom-14 right-4 z-20 flex items-center gap-1.5 bg-[#16171c]/95 backdrop-blur-md border border-white/[0.08] p-1.5 rounded-xl shadow-xl">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(2.2, Number((z + 0.15).toFixed(2))))}
          title="Zoom In"
          aria-label="Zoom In"
          className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/[0.06] rounded-lg transition-colors"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <span className="text-[11px] font-mono text-zinc-400 px-1 tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.45, Number((z - 0.15).toFixed(2))))}
          title="Zoom Out"
          aria-label="Zoom Out"
          className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/[0.06] rounded-lg transition-colors"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-white/10 mx-0.5" />
        <button
          type="button"
          onClick={resetCamera}
          title="Fit & Reset Camera"
          aria-label="Fit and Reset Camera"
          className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/[0.06] rounded-lg transition-colors"
        >
          <Maximize2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setShowExecutionOverlay((v) => !v)}
          title="Toggle Active Execution Highlight"
          aria-label="Toggle Active Execution Highlight"
          className={`px-2 py-1 text-[11px] rounded-lg flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 ${
            showExecutionOverlay
              ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
              : 'text-zinc-400 hover:text-white'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          Path Flow
        </button>
        <button
          type="button"
          onClick={() => setHideInactiveNodes((v) => !v)}
          title="Hide Unrelated / Unvisited Branches"
          aria-label="Hide Unvisited Branches"
          className={`px-2 py-1 text-[11px] rounded-lg flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 ${
            hideInactiveNodes
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
              : 'text-zinc-400 hover:text-white'
          }`}
        >
          {hideInactiveNodes ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          {hideInactiveNodes ? 'Show All' : 'Isolate Active'}
        </button>
      </div>

      {/* Unsupported Language Banner if current file is not fully parsed */}
      {!activeFile.isFullySupported && (
        <div className="mx-4 mt-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-center justify-between z-10">
          <div>
            <p className="font-semibold">This language ({activeFile.language}) is not fully supported yet.</p>
            <p className="text-amber-300/80 mt-0.5">
              Available analysis: ✓ File structure · ✓ Basic syntax · ✓ AI explanation | Unavailable: ✗ Full execution tracing · ✗ Complete control-flow analysis
            </p>
          </div>
        </div>
      )}

      {/* Runtime Error Alert Overlay when execution encounters an exception */}
      {traceResult.error && showExecutionOverlay && (
        <div className="mx-4 mt-3 p-3.5 rounded-xl bg-red-950/60 border border-red-500/40 text-xs text-red-200 flex items-start justify-between gap-4 z-10">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-red-200">
                Runtime Error — {traceResult.error.type} at {traceResult.error.file}:{traceResult.error.line}
              </div>
              <p className="text-red-300/90 mt-0.5">{traceResult.error.explanation}</p>
              <div className="mt-1.5 font-mono text-[11px] text-red-300">
                Path: START → {traceResult.error.path.join(' → ')} → ERROR
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigateToFileFunction(traceResult.error!.file)}
            className="px-2.5 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-200 font-medium whitespace-nowrap shrink-0"
          >
            Jump to Failing Node
          </button>
        </div>
      )}

      {/* MAIN INTERACTIVE GRAPH CANVAS */}
      <div
        ref={svgContainerRef}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        data-testid="code-map-canvas"
        className={`flex-1 relative overflow-hidden ${
          isDragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        style={{
          backgroundImage:
            'radial-gradient(rgba(255, 255, 255, 0.06) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      >
        {viewMode === 'flow' && (
          <div
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'top center',
              transition: isDragging ? 'none' : 'transform 120ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
            className="w-full h-full flex justify-center"
          >
            <div
              className="relative"
              style={{ width: `${canvasWidth}px`, height: `${canvasHeight}px` }}
            >
              {/* SVG Edges Layer */}
              <svg
                width={canvasWidth}
                height={canvasHeight}
                className="absolute inset-0 pointer-events-none overflow-visible"
              >
                <defs>
                  <marker
                    id="arrow-active"
                    viewBox="0 0 10 10"
                    refX="7"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 8 5 L 0 9 z" fill="#60a5fa" />
                  </marker>
                  <marker
                    id="arrow-true"
                    viewBox="0 0 10 10"
                    refX="7"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 8 5 L 0 9 z" fill="#34d399" />
                  </marker>
                  <marker
                    id="arrow-false"
                    viewBox="0 0 10 10"
                    refX="7"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 8 5 L 0 9 z" fill="#fbbf24" />
                  </marker>
                  <marker
                    id="arrow-muted"
                    viewBox="0 0 10 10"
                    refX="7"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 8 5 L 0 9 z" fill="#52525b" />
                  </marker>
                </defs>

                {layoutEdges.map((edge: ControlFlowEdge) => {
                  const sourcePos = positionedNodes.find((p) => p.node.id === edge.source);
                  const targetPos = positionedNodes.find((p) => p.node.id === edge.target);
                  if (!sourcePos || !targetPos) return null;

                  const isVisitedEdge =
                    showExecutionOverlay &&
                    (visitedEdgesSet.has(edge.id) ||
                      (visitedSet.has(edge.source) && visitedSet.has(edge.target)));

                  const x1 = sourcePos.x + sourcePos.width / 2;
                  const y1 = sourcePos.y + sourcePos.height;
                  const x2 = targetPos.x + targetPos.width / 2;
                  const y2 = targetPos.y;

                  // Cyclic loop-back arc on the right side
                  if (edge.branchType === 'loop_back' || y2 <= y1) {
                    const loopX = Math.max(sourcePos.x, targetPos.x) + sourcePos.width + 52;
                    const pathData = `M ${sourcePos.x + sourcePos.width} ${sourcePos.y + sourcePos.height / 2} C ${loopX} ${sourcePos.y + sourcePos.height / 2}, ${loopX} ${targetPos.y + targetPos.height / 2}, ${targetPos.x + targetPos.width} ${targetPos.y + targetPos.height / 2}`;
                    return (
                      <g key={edge.id}>
                        <path
                          d={pathData}
                          fill="none"
                          stroke={isVisitedEdge ? '#c084fc' : '#3f3f46'}
                          strokeWidth={isVisitedEdge ? 2.5 : 1.5}
                          className={isVisitedEdge ? 'animate-flow-edge' : ''}
                          markerEnd={isVisitedEdge ? 'url(#arrow-active)' : 'url(#arrow-muted)'}
                        />
                        {edge.label && (
                          <text
                            x={loopX - 18}
                            y={(sourcePos.y + targetPos.y) / 2 + 30}
                            fill="#c084fc"
                            fontSize="10"
                            fontFamily="JetBrains Mono"
                          >
                            {edge.label}
                          </text>
                        )}
                      </g>
                    );
                  }

                  const midY = (y1 + y2) / 2;
                  const d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;

                  let strokeColor = '#3f3f46';
                  let marker = 'url(#arrow-muted)';
                  if (isVisitedEdge) {
                    if (edge.branchType === 'true') {
                      strokeColor = '#34d399';
                      marker = 'url(#arrow-true)';
                    } else if (edge.branchType === 'false') {
                      strokeColor = '#fbbf24';
                      marker = 'url(#arrow-false)';
                    } else {
                      strokeColor = '#60a5fa';
                      marker = 'url(#arrow-active)';
                    }
                  }

                  return (
                    <g key={edge.id}>
                      <path
                        d={d}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={isVisitedEdge ? 2.5 : 1.5}
                        opacity={showExecutionOverlay && !isVisitedEdge ? 0.35 : 0.95}
                        className={isVisitedEdge ? 'animate-flow-edge' : ''}
                        markerEnd={marker}
                      />
                      {edge.label && (
                        <g transform={`translate(${(x1 + x2) / 2}, ${midY - 4})`}>
                          <rect
                            x="-26"
                            y="-9"
                            width="52"
                            height="16"
                            rx="4"
                            fill="#0e0f12"
                            stroke={strokeColor}
                            strokeWidth="1"
                          />
                          <text
                            textAnchor="middle"
                            y="2"
                            fill={
                              edge.branchType === 'true'
                                ? '#6ee7b7'
                                : edge.branchType === 'false'
                                ? '#fcd34d'
                                : '#cbd5e1'
                            }
                            fontSize="9.5"
                            fontWeight="600"
                            fontFamily="JetBrains Mono"
                          >
                            {edge.label}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
              </svg>

              {/* Interactive Graph Nodes Layer */}
              {positionedNodes.map(({ node, x, y, width, height }) => {
                const isVisited = showExecutionOverlay && visitedSet.has(node.id);
                const isCurrentStep = activeStep?.nodeId === node.id;
                const isSelected = selectedNode?.id === node.id;
                const isCollapsed = collapsedNodeIds.has(node.id);
                const style = getNodeAccent(node, isVisited, isCurrentStep);
                const loopIterCount = traceResult.loopCounts[node.id];

                return (
                  <div
                    key={node.id}
                    data-node-card="true"
                    style={{
                      left: `${x}px`,
                      top: `${y}px`,
                      width: `${width}px`,
                      minHeight: isCollapsed ? '48px' : `${height}px`,
                    }}
                    onClick={() => onSelectNode(node)}
                    onDoubleClick={() => {
                      if (node.kind === 'call' && node.callsTarget) {
                        onNavigateToFileFunction(
                          node.callsTarget.file,
                          node.callsTarget.functionName
                        );
                      }
                    }}
                    className={`absolute rounded-xl border p-3 transition-all cursor-pointer shadow-lg ${
                      style.bg
                    } ${style.border} ${
                      isSelected ? 'ring-2 ring-white/60 scale-[1.02]' : 'hover:border-white/35'
                    } ${
                      showExecutionOverlay && !isVisited && node.kind !== 'function'
                        ? 'opacity-45 hover:opacity-90'
                        : 'opacity-100'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${style.badgeBg}`}
                      >
                        {node.kind}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {loopIterCount && loopIterCount > 0 && (
                          <span className="text-[10px] font-mono text-purple-300 bg-purple-500/20 px-1.5 py-0.5 rounded">
                            {loopIterCount}x iter
                          </span>
                        )}
                        {isVisited && (
                          <span
                            title="Visited in execution trace"
                            className="text-[10px] font-mono text-emerald-300"
                          >
                            ● traced
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={(e) => toggleCollapseNode(e, node.id)}
                          aria-label={`Toggle details for ${node.label}`}
                          className="text-[10px] text-zinc-500 hover:text-zinc-200 px-1"
                        >
                          {isCollapsed ? '+' : '−'}
                        </button>
                      </div>
                    </div>

                    <div className="mt-1.5 font-mono text-xs font-semibold text-white truncate">
                      {node.label}
                    </div>

                    {!isCollapsed && (
                      <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-400">
                        <span className="truncate">{node.sublabel}</span>
                        {node.metrics && (
                          <span className="font-mono text-[10px] text-zinc-400 shrink-0">
                            {node.metrics.branches}br · {node.metrics.calls}c
                          </span>
                        )}
                      </div>
                    )}

                    {/* Cross-file or internal function jump button on CALL nodes */}
                    {!isCollapsed && node.kind === 'call' && node.callsTarget && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNavigateToFileFunction(
                            node.callsTarget!.file,
                            node.callsTarget!.functionName
                          );
                        }}
                        className="mt-2 w-full py-1 px-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-[11px] font-medium flex items-center justify-between transition-colors"
                      >
                        <span className="truncate">
                          Enter {node.callsTarget.functionName}()
                        </span>
                        <CornerDownRight className="w-3 h-3 shrink-0" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* VIEW 2: HIGH-LEVEL ARCHITECTURE MAP */}
        {viewMode === 'architecture' && (
          <div className="p-6 max-w-5xl mx-auto overflow-y-auto h-full">
            <div className="mb-5">
              <h2 className="text-base font-semibold text-white">
                Project Architecture Map — {project.name}
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Hierarchical repository structure. Click any file or function to enter its interactive control-flow map.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {project.files.map((file) => {
                const isEntryFile = project.entryPoints.some((e) => e.file === file.path);
                return (
                  <div
                    key={file.path}
                    className={`rounded-xl border p-4 bg-[#141519] transition-all ${
                      activeFile.path === file.path
                        ? 'border-blue-500/60 ring-1 ring-blue-500/30'
                        : 'border-white/[0.08] hover:border-white/20'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileCode2 className="w-4 h-4 text-blue-400 shrink-0" />
                        <span className="font-mono text-xs font-semibold text-white truncate">
                          {file.path}
                        </span>
                      </div>
                      {isEntryFile && (
                        <span className="text-[10px] font-mono text-emerald-300">
                          ENTRY POINT
                        </span>
                      )}
                    </div>

                    <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-400">
                      <span>{file.language.toUpperCase()}</span>
                      <span>·</span>
                      <span>{file.functions.length} functions</span>
                      <span>·</span>
                      <span>{file.sizeBytes} B</span>
                    </div>

                    <div className="mt-3 space-y-1.5">
                      {file.functions.map((fn) => (
                        <button
                          key={fn.id}
                          type="button"
                          onClick={() => {
                            onNavigateToFileFunction(file.path, fn.name);
                            onViewModeChange('flow');
                          }}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg bg-[#1c1d22] hover:bg-[#25272e] border border-white/[0.05] flex items-center justify-between text-xs transition-colors"
                        >
                          <span className="font-mono text-zinc-200 truncate">
                            ⚙ {fn.name}({fn.parameters.join(', ')})
                          </span>
                          <ArrowRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* VIEW 3: CROSS-FILE IMPORT & DEPENDENCY GRAPH */}
        {viewMode === 'dependencies' && (
          <div className="p-6 max-w-4xl mx-auto overflow-y-auto h-full">
            <div className="mb-5">
              <h2 className="text-base font-semibold text-white">
                Cross-File Import & Call Dependency Graph
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Shows how modules import each other and where cross-file function calls cross file boundaries.
              </p>
            </div>

            <div className="space-y-3">
              {project.files.map((file) => {
                const outgoingDeps = project.dependencies.filter(
                  (d) => d.sourceFile === file.path
                );
                const crossCalls = file.functions.flatMap((fn) =>
                  fn.calls
                    .filter((c) => c.targetFile !== file.path)
                    .map((c) => ({
                      caller: fn.name,
                      callee: c.calleeName,
                      targetFile: c.targetFile,
                      line: c.line,
                    }))
                );

                return (
                  <div
                    key={file.path}
                    className="rounded-xl border border-white/[0.08] bg-[#141519] p-4"
                  >
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => {
                          onNavigateToFileFunction(file.path);
                          onViewModeChange('flow');
                        }}
                        className="font-mono text-sm font-semibold text-blue-400 hover:underline flex items-center gap-2"
                      >
                        <FolderGit2 className="w-4 h-4" />
                        {file.path}
                      </button>
                      <span className="text-xs text-zinc-500">
                        {outgoingDeps.length} module imports · {crossCalls.length} cross-file calls
                      </span>
                    </div>

                    {outgoingDeps.length > 0 || crossCalls.length > 0 ? (
                      <div className="mt-3 pl-4 border-l border-white/10 space-y-2">
                        {outgoingDeps.map((dep) => (
                          <div
                            key={dep.id}
                            className="flex items-center justify-between text-xs bg-[#1b1c22] px-3 py-2 rounded-lg"
                          >
                            <div className="flex items-center gap-2 font-mono">
                              <span className="text-zinc-400">imports</span>
                              <ArrowRight className="w-3.5 h-3.5 text-zinc-500" />
                              <button
                                type="button"
                                onClick={() => {
                                  onNavigateToFileFunction(dep.targetFile);
                                  onViewModeChange('flow');
                                }}
                                className="text-emerald-400 hover:underline font-medium"
                              >
                                {dep.targetFile}
                              </button>
                            </div>
                            <span className="text-[11px] font-mono text-zinc-500">
                              {dep.importedSymbols.join(', ')}
                            </span>
                          </div>
                        ))}

                        {crossCalls.map((cc, i) => (
                          <div
                            key={`${cc.caller}-${cc.callee}-${i}`}
                            className="flex items-center justify-between text-xs bg-[#181f2c] border border-blue-500/20 px-3 py-2 rounded-lg"
                          >
                            <div className="flex items-center gap-2 font-mono">
                              <span className="text-zinc-200">{cc.caller}()</span>
                              <ArrowRight className="w-3.5 h-3.5 text-blue-400" />
                              <button
                                type="button"
                                onClick={() => {
                                  onNavigateToFileFunction(cc.targetFile, cc.callee);
                                  onViewModeChange('flow');
                                }}
                                className="text-blue-300 hover:underline font-semibold"
                              >
                                {cc.targetFile} :: {cc.callee}()
                              </button>
                            </div>
                            <span className="text-[11px] font-mono text-zinc-400">
                              Line {cc.line}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-zinc-500">
                        Leaf module — no external file dependencies.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* VIEW 4: COMPLETE END-TO-END EXECUTION TRACE MAP (POINT 0 -> END) */}
        {viewMode === 'trace' && (
          <div className="p-6 max-w-3xl mx-auto overflow-y-auto h-full">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-base font-semibold text-white">
                  End-to-End Execution Trace (POINT 0 → {traceResult.error ? 'ERROR' : 'END'})
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Click any step below to jump directly to its control-flow node, source line, and variable snapshot.
                </p>
              </div>
              <div className="text-xs font-mono text-zinc-400">
                Inputs: {JSON.stringify(traceResult.inputs)}
              </div>
            </div>

            <div className="space-y-2.5 pb-12">
              {traceResult.steps.map((step, idx) => {
                const isCurrent = idx === currentStepIndex;
                return (
                  <div
                    key={`${step.nodeId}-${idx}`}
                    onClick={() => {
                      onStepChange(idx);
                      onNavigateToFileFunction(step.file, step.functionName);
                    }}
                    className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                      step.isError
                        ? 'bg-red-950/40 border-red-500/50'
                        : isCurrent
                        ? 'bg-[#1c2333] border-blue-400 ring-1 ring-blue-400/40'
                        : 'bg-[#141519] border-white/[0.07] hover:border-white/20'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-white/[0.07] text-zinc-300 tabular-nums">
                          STEP {step.stepIndex}
                        </span>
                        <span className="font-mono font-semibold text-white">
                          {step.label}
                        </span>
                        {step.branchDecision && (
                          <span
                            className={`font-mono text-[11px] px-2 py-0.5 rounded font-semibold ${
                              step.branchDecision.evaluatedTo
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-amber-500/20 text-amber-300'
                            }`}
                          >
                            → {String(step.branchDecision.evaluatedTo).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[11px] text-zinc-400">
                        {step.file}:{step.line} ({step.functionName})
                      </span>
                    </div>
                    <p className="text-xs text-zinc-300 mt-1.5">{step.description}</p>
                    {step.variableDiff && (
                      <div className="mt-2 font-mono text-[11px] text-emerald-300 bg-emerald-500/10 px-2.5 py-1 rounded inline-block">
                        State Change: {step.variableDiff.variable} ={' '}
                        {JSON.stringify(step.variableDiff.previousValue)} →{' '}
                        {JSON.stringify(step.variableDiff.newValue)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Step-by-Step Execution Debugger Bar */}
      <div className="px-4 py-2.5 bg-[#141519] border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-4 z-10">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onRestartTrace}
            title="Restart Execution Trace (Point 0)"
            aria-label="Restart Execution"
            className="p-1.5 rounded-lg bg-[#1d1f26] hover:bg-[#282b34] text-zinc-300 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onStepChange(Math.max(0, currentStepIndex - 1))}
            disabled={currentStepIndex <= 0}
            title="Previous Step"
            aria-label="Previous Step"
            className="px-2.5 py-1 rounded-lg bg-[#1d1f26] hover:bg-[#282b34] disabled:opacity-40 text-xs font-medium text-zinc-200 flex items-center gap-1 transition-colors"
          >
            <SkipBack className="w-3.5 h-3.5" />
            Prev
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            title={isPlaying ? 'Pause Trace' : 'Play Step-by-Step'}
            aria-label={isPlaying ? 'Pause Trace' : 'Play Trace'}
            className="px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white flex items-center gap-1.5 transition-colors"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          <button
            type="button"
            onClick={() =>
              onStepChange(Math.min(traceResult.steps.length - 1, currentStepIndex + 1))
            }
            disabled={currentStepIndex >= traceResult.steps.length - 1}
            title="Next Step"
            aria-label="Next Step"
            className="px-2.5 py-1 rounded-lg bg-[#1d1f26] hover:bg-[#282b34] disabled:opacity-40 text-xs font-medium text-zinc-200 flex items-center gap-1 transition-colors"
          >
            Next
            <SkipForward className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onStepChange(Math.max(0, traceResult.steps.length - 1))}
            title="Continue to End"
            aria-label="Continue to End"
            className="px-2.5 py-1 rounded-lg bg-[#1d1f26] hover:bg-[#282b34] text-xs font-medium text-zinc-300 flex items-center gap-1 transition-colors"
          >
            Continue
            <FastForward className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Current Step Status Telemetry */}
        {activeStep && (
          <div className="flex items-center gap-3 text-xs font-mono">
            <span className="text-blue-400 font-semibold tabular-nums">
              STEP {activeStep.stepIndex} / {traceResult.steps.length}
            </span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-300">
              {activeStep.functionName}()
            </span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-400 tabular-nums">
              Line {activeStep.line}
            </span>
            {traceResult.finalOutput !== undefined &&
              currentStepIndex === traceResult.steps.length - 1 && (
                <>
                  <span className="text-zinc-600">·</span>
                  <span className="text-emerald-400 font-semibold">
                    RETURN = {JSON.stringify(traceResult.finalOutput)}
                  </span>
                </>
              )}
          </div>
        )}
      </div>
    </div>
  );
};
