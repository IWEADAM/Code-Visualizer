import React, { useState, useMemo, useEffect } from 'react';
import {
  FolderGit2,
  FileCode2,
  Search,
  Plus,
  ChevronRight,
  ChevronDown,
  Upload,
} from 'lucide-react';
import { searchProject } from './engine/parser';
import { traceProgramExecution } from './engine/tracer';
import {
  CodeFile,
  ControlFlowNode,
  FunctionDef,
  ProjectModel,
  SearchResultItem,
} from './types/codeMap';
import { InteractiveMapCanvas } from './components/InteractiveMapCanvas';
import { CodeAndInspectorPanel } from './components/CodeAndInspectorPanel';
import { ImportModal } from './components/ImportModal';

export default function App() {
  const [project, setProject] = useState<ProjectModel | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string>('');
  const [activeFunctionName, setActiveFunctionName] = useState<string>('');
  const [selectedNode, setSelectedNode] = useState<ControlFlowNode | null>(null);
  const [viewMode, setViewMode] = useState<'flow' | 'dependencies' | 'trace' | 'architecture'>('flow');
  const [selectedEntryPointId, setSelectedEntryPointId] = useState<string>('');
  const [customInputs, setCustomInputs] = useState<Record<string, unknown>>({});
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isImportModalOpen, setIsImportModalOpen] = useState<boolean>(true);
  const [importAnimKey, setImportAnimKey] = useState<number>(1);

  const openImportWithFade = () => {
    setImportAnimKey((k) => k + 1);
    setIsImportModalOpen(true);
  };
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    src: true,
    config: true,
    tests: true,
    '/': true,
  });

  // Active file & function lookup
  const activeFile: CodeFile | null = useMemo(() => {
    if (!project || project.files.length === 0) return null;
    return project.files.find((f) => f.path === activeFilePath) || project.files[0];
  }, [project, activeFilePath]);

  const activeFunction: FunctionDef | null = useMemo(() => {
    if (!activeFile) return null;
    return (
      activeFile.functions.find((fn) => fn.name === activeFunctionName) ||
      activeFile.functions[0] ||
      null
    );
  }, [activeFile, activeFunctionName]);

  // Compute execution trace whenever project, customInputs, or entryPoint changes
  const traceResult = useMemo(() => {
    if (!project) {
      return {
        entryPointId: '',
        inputs: {},
        steps: [],
        visitedNodeIds: [],
        visitedEdgeIds: [],
        loopCounts: {},
        executionMode: 'sandboxed_interpreter' as const,
      };
    }
    return traceProgramExecution(project, customInputs, selectedEntryPointId);
  }, [project, customInputs, selectedEntryPointId]);

  // Auto-advance step-by-step debugger when Play is active
  useEffect(() => {
    if (!isPlaying || !project) return;
    const timer = window.setInterval(() => {
      setCurrentStepIndex((prev) => {
        if (prev >= traceResult.steps.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        const nextIdx = prev + 1;
        const nextStep = traceResult.steps[nextIdx];
        if (nextStep) {
          setActiveFilePath(nextStep.file);
          setActiveFunctionName(nextStep.functionName);
          const fileObj = project.files.find((f) => f.path === nextStep.file);
          const fnObj = fileObj?.functions.find((fn) => fn.name === nextStep.functionName);
          const nodeObj = fnObj?.nodes.find((n) => n.id === nextStep.nodeId);
          if (nodeObj) setSelectedNode(nodeObj);
        }
        return nextIdx;
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [isPlaying, traceResult.steps, project]);

  // Global symbol search results
  const searchResults: SearchResultItem[] = useMemo(() => {
    if (!project) return [];
    return searchProject(project, searchQuery);
  }, [project, searchQuery]);

  // Group files by folder for IDE File Explorer
  const folderGroups = useMemo(() => {
    const groups: Record<string, CodeFile[]> = {};
    if (!project) return groups;
    project.files.forEach((file) => {
      const folderKey = file.folder || '/';
      if (!groups[folderKey]) groups[folderKey] = [];
      groups[folderKey].push(file);
    });
    return groups;
  }, [project]);

  // Breadcrumb navigation stack
  const breadcrumbs = useMemo(() => {
    if (!project || !activeFile) return [];
    const crumbs: Array<{ label: string; file?: string; functionName?: string }> = [
      { label: project.name },
      { label: activeFile.path, file: activeFile.path },
    ];
    if (activeFunction) {
      crumbs.push({
        label: `${activeFunction.name}()`,
        file: activeFile.path,
        functionName: activeFunction.name,
      });
    }
    if (selectedNode && selectedNode.kind !== 'function') {
      crumbs.push({
        label: selectedNode.label,
        file: activeFile.path,
        functionName: activeFunction?.name,
      });
    }
    return crumbs;
  }, [project, activeFile, activeFunction, selectedNode]);

  const handleSelectProject = (nextProj: ProjectModel) => {
    setProject(nextProj);
    const firstFile = nextProj.files[0];
    setActiveFilePath(firstFile?.path || '');
    const firstFn = firstFile?.functions[0];
    setActiveFunctionName(firstFn?.name || '');
    setSelectedNode(firstFn?.nodes[0] || null);
    setSelectedEntryPointId(nextProj.entryPoints[0]?.id || '');
    setCustomInputs(nextProj.defaultInputs);
    setCurrentStepIndex(0);
    setIsPlaying(false);
  };

  const handleNavigateToFileFunction = (filePath: string, functionName?: string) => {
    if (!project) return;
    const targetFile = project.files.find((f) => f.path === filePath);
    if (!targetFile) return;
    setActiveFilePath(targetFile.path);
    const targetFn =
      (functionName && targetFile.functions.find((fn) => fn.name === functionName)) ||
      targetFile.functions[0];
    if (targetFn) {
      setActiveFunctionName(targetFn.name);
      setSelectedNode(targetFn.nodes[0] || null);
    }
  };

  const handleSelectNodeByLine = (line: number) => {
    if (!activeFile) return;
    const fnForLine =
      activeFile.functions.find((fn) => line >= fn.startLine && line <= fn.endLine) ||
      activeFunction;
    if (!fnForLine) return;

    setActiveFunctionName(fnForLine.name);
    const matchedNode =
      fnForLine.nodes.find(
        (n) =>
          n.kind !== 'function' &&
          line >= n.location.startLine &&
          line <= n.location.endLine
      ) || fnForLine.nodes[0];

    if (matchedNode) {
      setSelectedNode(matchedNode);
    }
  };

  const handleStepChange = (stepIdx: number) => {
    if (!project) return;
    setIsPlaying(false);
    setCurrentStepIndex(stepIdx);
    const step = traceResult.steps[stepIdx];
    if (step) {
      setActiveFilePath(step.file);
      setActiveFunctionName(step.functionName);
      const fileObj = project.files.find((f) => f.path === step.file);
      const fnObj = fileObj?.functions.find((fn) => fn.name === step.functionName);
      const nodeObj = fnObj?.nodes.find((n) => n.id === step.nodeId);
      if (nodeObj) setSelectedNode(nodeObj);
    }
  };

  const handleRunSimulation = (inputsOverride?: Record<string, unknown>) => {
    if (inputsOverride) {
      setCustomInputs(inputsOverride);
    }
    setCurrentStepIndex(0);
    setIsPlaying(true);
  };

  const totalFunctions = project
    ? project.files.reduce((acc, f) => acc + f.functions.length, 0)
    : 0;
  const totalClasses = project
    ? project.files.reduce((acc, f) => acc + f.classes.length, 0)
    : 0;

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0e0f12] text-[#e8eaed] overflow-hidden">
      {/* Top Bar Contract: Zone 1 (Brand) — Zone 2 (Navigation Links) — Zone 3 (Primary Actions) */}
      <header className="flex items-center justify-between gap-8 px-5 py-3 bg-[#111216] border-b border-white/[0.08] shrink-0 z-30">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setViewMode('flow');
          }}
          className="text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          Code Visualizer
        </a>

        <nav
          aria-label="Primary Workspace Views"
          className="hidden md:flex items-center gap-6 text-xs font-medium text-zinc-400"
        >
          <button
            type="button"
            onClick={() => setViewMode('architecture')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'architecture' ? 'text-white underline underline-offset-4' : ''
            }`}
          >
            Architecture
          </button>
          <button
            type="button"
            onClick={() => setViewMode('flow')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'flow' ? 'text-white underline underline-offset-4' : ''
            }`}
          >
            Execution Flow
          </button>
          <button
            type="button"
            onClick={() => setViewMode('dependencies')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'dependencies' ? 'text-white underline underline-offset-4' : ''
            }`}
          >
            Dependencies
          </button>
          <button
            type="button"
            onClick={() => setViewMode('trace')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'trace' ? 'text-white underline underline-offset-4' : ''
            }`}
          >
            Trace Steps
          </button>
        </nav>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={openImportWithFade}
            className="px-3.5 py-1.5 text-xs font-medium text-blue-200 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-400/30 rounded-full transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5 text-blue-400" />
            Import Repo / Files
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      {project && activeFile ? (
        <main className="flex-1 flex overflow-hidden animate-fade-in">
          {/* LEFT SIDEBAR: Project Dashboard, Search, Entry Points, & File Explorer */}
          <aside className="w-64 xl:w-72 shrink-0 bg-[#111215] border-r border-white/[0.07] flex flex-col justify-between overflow-hidden">
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              {/* "+ New Repository / Upload" Button */}
              <button
                type="button"
                onClick={openImportWithFade}
                className="w-full px-3.5 py-2 rounded-full bg-blue-500/10 hover:bg-blue-500/20 border border-blue-400/25 text-xs font-medium text-blue-200 flex items-center gap-2 transition-colors"
              >
                <Plus className="w-4 h-4 text-blue-400" />
                <span>New Repository / Upload</span>
              </button>

              {/* Global Symbol & Cross-File Search */}
              <div className="relative">
                <div className="flex items-center bg-[#18191f] border border-white/[0.08] rounded-xl px-2.5 py-1.5">
                  <Search className="w-3.5 h-3.5 text-zinc-500 mr-2 shrink-0" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search symbols, functions..."
                    aria-label="Global Symbol Search"
                    className="w-full bg-transparent text-xs text-white placeholder-zinc-500 focus:outline-none"
                  />
                </div>

                {/* Live Global Search Results Dropdown */}
                {searchQuery.trim() !== '' && (
                  <div className="mt-1.5 rounded-xl bg-[#1a1c23] border border-white/15 shadow-2xl max-h-64 overflow-y-auto divide-y divide-white/[0.06]">
                    {searchResults.length > 0 ? (
                      searchResults.map((res) => (
                        <button
                          key={res.id}
                          type="button"
                          onClick={() => {
                            handleNavigateToFileFunction(res.file, res.functionName);
                            if (res.nodeId) {
                              const f = project.files.find((fl) => fl.path === res.file);
                              const fn = f?.functions.find((fnItem) => fnItem.name === res.functionName);
                              const n = fn?.nodes.find((nd) => nd.id === res.nodeId);
                              if (n) setSelectedNode(n);
                            }
                            setSearchQuery('');
                            setViewMode('flow');
                          }}
                          className="w-full text-left p-2.5 hover:bg-white/[0.06] transition-colors text-xs"
                        >
                          <div className="flex items-center justify-between font-mono">
                            <span className="font-semibold text-blue-300">{res.symbolName}</span>
                            <span className="text-[10px] text-zinc-400">
                              {res.file}:{res.line}
                            </span>
                          </div>
                          {res.calledBy.length > 0 && (
                            <div className="text-[10px] text-zinc-400 mt-1">
                              Called by: <span className="font-mono text-zinc-300">{res.calledBy.join(', ')}</span>
                            </div>
                          )}
                          {res.calls.length > 0 && (
                            <div className="text-[10px] text-zinc-400">
                              Calls: <span className="font-mono text-emerald-300">{res.calls.join(', ')}</span>
                            </div>
                          )}
                        </button>
                      ))
                    ) : (
                      <div className="p-3 text-xs text-zinc-500">No matching symbols found.</div>
                    )}
                  </div>
                )}
              </div>

              {/* Project Summary & Entry Point Selector */}
              <div className="space-y-2 pt-1">
                <div className="px-1 flex items-center justify-between text-[11px] font-medium text-zinc-500">
                  <span>Project Summary</span>
                  <span className="text-blue-400">● Analyzed</span>
                </div>

                <div className="p-2.5 rounded-xl bg-[#17181d] border border-white/[0.06] space-y-2 text-xs">
                  <div className="font-semibold text-white truncate">{project.name}</div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-400 font-mono tabular-nums">
                    <span>{project.files.length} files</span>
                    <span>·</span>
                    <span>{totalFunctions} funcs</span>
                    <span>·</span>
                    <span>{totalClasses} classes</span>
                    <span>·</span>
                    <span>{project.dependencies.length} deps</span>
                  </div>

                  {/* Entry Point Dropdown */}
                  <div className="pt-1.5 border-t border-white/[0.06]">
                    <label
                      htmlFor="entry-point-select"
                      className="block text-[10px] text-zinc-400 mb-1"
                    >
                      Detected Entry Point
                    </label>
                    <select
                      id="entry-point-select"
                      value={selectedEntryPointId}
                      onChange={(e) => {
                        setSelectedEntryPointId(e.target.value);
                        const ep = project.entryPoints.find((item) => item.id === e.target.value);
                        if (ep) {
                          handleNavigateToFileFunction(ep.file, ep.functionName);
                        }
                      }}
                      className="w-full bg-[#111216] border border-white/10 rounded-lg px-2 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-blue-400"
                    >
                      {project.entryPoints.map((ep) => (
                        <option key={ep.id} value={ep.id}>
                          {ep.file} :: {ep.functionName}()
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* IDE File Explorer Tree */}
              <div className="space-y-1.5">
                <div className="px-1 text-[11px] font-medium text-zinc-500">
                  File Explorer ({project.files.length})
                </div>

                {Object.entries(folderGroups).map(([folder, files]) => {
                  const isExpanded = expandedFolders[folder] ?? true;
                  return (
                    <div key={folder} className="space-y-1">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedFolders((prev) => ({
                            ...prev,
                            [folder]: !isExpanded,
                          }))
                        }
                        className="w-full flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-400 hover:text-white rounded-lg transition-colors"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                        )}
                        <FolderGit2 className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                        <span className="font-mono truncate">{folder}</span>
                      </button>

                      {isExpanded && (
                        <div className="pl-3 space-y-1">
                          {files.map((file) => {
                            const isSelectedFile = file.path === activeFile.path;
                            return (
                              <div key={file.path} className="space-y-0.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    handleNavigateToFileFunction(file.path);
                                    setViewMode('flow');
                                  }}
                                  className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between text-xs transition-colors ${
                                    isSelectedFile
                                      ? 'bg-[#25272f] text-white font-medium'
                                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]'
                                  }`}
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <FileCode2
                                      className={`w-3.5 h-3.5 shrink-0 ${
                                        isSelectedFile ? 'text-blue-400' : 'text-zinc-500'
                                      }`}
                                    />
                                    <span className="font-mono truncate">{file.name}</span>
                                  </div>
                                  <span className="text-[10px] font-mono text-zinc-500 shrink-0 tabular-nums">
                                    {file.functions.length}fn
                                  </span>
                                </button>

                                {/* Nested Function List under Active File */}
                                {isSelectedFile && file.functions.length > 0 && (
                                  <div className="pl-5 py-0.5 space-y-0.5">
                                    {file.functions.map((fn) => (
                                      <button
                                        key={fn.id}
                                        type="button"
                                        onClick={() => {
                                          setActiveFunctionName(fn.name);
                                          setSelectedNode(fn.nodes[0] || null);
                                          setViewMode('flow');
                                        }}
                                        className={`w-full text-left px-2 py-1 rounded-md font-mono text-[11px] flex items-center justify-between transition-colors ${
                                          activeFunction?.name === fn.name
                                            ? 'text-blue-300 bg-blue-500/15 font-medium'
                                            : 'text-zinc-400 hover:text-zinc-200'
                                        }`}
                                      >
                                        <span className="truncate">↳ {fn.name}()</span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </aside>

          {/* CENTER PANE: Interactive Graphical Code Map & Step-by-Step Debugger */}
          <section className="flex-1 h-full overflow-hidden">
            <InteractiveMapCanvas
              project={project}
              activeFile={activeFile}
              activeFunction={activeFunction}
              selectedNode={selectedNode}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              onSelectNode={(node) => setSelectedNode(node)}
              onNavigateToFileFunction={handleNavigateToFileFunction}
              traceResult={traceResult}
              currentStepIndex={currentStepIndex}
              onStepChange={handleStepChange}
              isPlaying={isPlaying}
              onTogglePlay={() => setIsPlaying((p) => !p)}
              onRestartTrace={() => handleStepChange(0)}
              breadcrumbs={breadcrumbs}
              onBreadcrumbClick={(idx) => {
                const crumb = breadcrumbs[idx];
                if (idx === 0) {
                  setViewMode('architecture');
                } else if (crumb.file) {
                  handleNavigateToFileFunction(crumb.file, crumb.functionName);
                  setViewMode('flow');
                }
              }}
            />
          </section>

          {/* RIGHT PANE: Synchronized Source Code, Node Inspector, Input Simulator & AI Chat */}
          <CodeAndInspectorPanel
            project={project}
            activeFile={activeFile}
            activeFunction={activeFunction}
            selectedNode={selectedNode}
            onSelectNodeByLine={handleSelectNodeByLine}
            onNavigateToFileFunction={handleNavigateToFileFunction}
            customInputs={customInputs}
            onUpdateInputs={setCustomInputs}
            onRunSimulation={handleRunSimulation}
            traceResult={traceResult}
            currentStepIndex={currentStepIndex}
          />
        </main>
      ) : (
        <main className="flex-1 flex items-center justify-center p-6 bg-[#0e0f12]">
          <div className="text-center max-w-md space-y-4 animate-fade-in">
            <p className="text-sm text-zinc-400">
              No repository or source files loaded yet.
            </p>
            <button
              type="button"
              onClick={openImportWithFade}
              className="px-4 py-2 rounded-full bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white inline-flex items-center gap-2 transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              Import Repo / Files
            </button>
          </div>
        </main>
      )}

      {/* Animated Import Repo / Files Modal */}
      <ImportModal
        isOpen={isImportModalOpen}
        canClose={project !== null}
        animKey={importAnimKey}
        onClose={() => setIsImportModalOpen(false)}
        onSelectProject={handleSelectProject}
      />
    </div>
  );
}
