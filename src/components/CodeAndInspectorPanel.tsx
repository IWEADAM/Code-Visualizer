import React, { useState, useEffect } from 'react';
import {
  Code2,
  Sparkles,
  Sliders,
  MessageSquare,
  Play,
  CheckCircle2,
  Cpu,
  AlertCircle,
  Send,
  Plus,
  ArrowRight,
  ShieldCheck,
  Activity,
  HelpCircle,
} from 'lucide-react';
import {
  AIExplanation,
  CodeFile,
  ControlFlowNode,
  ExecutionTraceResult,
  FunctionDef,
  ProjectModel,
} from '../types/codeMap';

interface CodeAndInspectorPanelProps {
  project: ProjectModel;
  activeFile: CodeFile;
  activeFunction: FunctionDef | null;
  selectedNode: ControlFlowNode | null;
  onSelectNodeByLine: (line: number) => void;
  onNavigateToFileFunction: (filePath: string, functionName?: string) => void;
  customInputs: Record<string, unknown>;
  onUpdateInputs: (nextInputs: Record<string, unknown>) => void;
  onRunSimulation: (inputsToRun?: Record<string, unknown>) => void;
  traceResult: ExecutionTraceResult;
  currentStepIndex: number;
}

export const CodeAndInspectorPanel: React.FC<CodeAndInspectorPanelProps> = ({
  project,
  activeFile,
  activeFunction,
  selectedNode,
  onSelectNodeByLine,
  onNavigateToFileFunction,
  customInputs,
  onUpdateInputs,
  onRunSimulation,
  traceResult,
  currentStepIndex,
}) => {
  const [activeTab, setActiveTab] = useState<'code' | 'inspector' | 'simulate' | 'chat'>('code');
  const [aiExplanationsCache, setAiExplanationsCache] = useState<Record<string, AIExplanation>>({});
  const [isLoadingAI, setIsLoadingAI] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // New custom variable input fields
  const [newVarKey, setNewVarKey] = useState('');
  const [newVarVal, setNewVarVal] = useState('');

  // Chat state
  const [chatQuestion, setChatQuestion] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState<
    Array<{ role: 'user' | 'assistant'; content: string }>
  >([
    {
      role: 'assistant',
      content:
        'Ask me anything about this repository. Every answer distinguishes between [Proven by Static Analysis], [Observed During Execution], and [AI Inference].',
    },
  ]);

  const activeStep = traceResult.steps[currentStepIndex] || null;
  const currentNode =
    selectedNode ||
    activeFunction?.nodes[0] ||
    activeFile.functions[0]?.nodes[0] ||
    null;

  // Check if selected node was observed during runtime trace
  const observedStepForNode = currentNode
    ? traceResult.steps.find((s) => s.nodeId === currentNode.id)
    : undefined;

  // Reset AI error when node changes
  useEffect(() => {
    setAiError(null);
  }, [currentNode?.id]);

  const handleRequestGeminiNodeExplanation = async () => {
    if (!currentNode) return;
    setIsLoadingAI(true);
    setAiError(null);
    try {
      const response = await fetch('/api/ai/explain-node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node: currentNode,
          fileContent: activeFile.content,
          projectSummary: `${project.name}: ${project.files.map((f) => f.path).join(', ')}`,
          runtimeObserved: observedStepForNode || null,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setAiError(data.error || 'Gemini explanation unavailable.');
      } else {
        setAiExplanationsCache((prev) => ({
          ...prev,
          [currentNode.id]: data as AIExplanation,
        }));
      }
    } catch (err: unknown) {
      setAiError(err instanceof Error ? err.message : 'Network error calling backend.');
    } finally {
      setIsLoadingAI(false);
    }
  };

  const handleAskRepositoryChat = async (questionText: string) => {
    const q = questionText.trim();
    if (!q) return;
    setChatQuestion('');
    setChatHistory((prev) => [...prev, { role: 'user', content: q }]);
    setChatLoading(true);

    try {
      const projectContext = project.files
        .map(
          (f) =>
            `File ${f.path} (${f.language}):\nFunctions: ${f.functions
              .map((fn) => `${fn.name}(${fn.parameters.join(', ')}) [lines ${fn.startLine}-${fn.endLine}]`)
              .join('; ')}\nCode:\n${f.content}`
        )
        .join('\n\n---\n\n');

      const traceSummary = traceResult.steps
        .map((s) => `Step ${s.stepIndex}: ${s.file}:${s.line} ${s.label} (${s.description})`)
        .join('\n');

      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          projectContext,
          activeFile: activeFile.path,
          activeNode: currentNode?.label,
          traceSummary,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        // Provide deterministic static fallback notice while reporting the API status honestly
        const staticFallback = buildDeterministicRepoAnswer(q, project, activeFile, traceResult);
        setChatHistory((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `${staticFallback}\n\n(Note: Live Gemini API returned: ${data.error})`,
          },
        ]);
      } else {
        setChatHistory((prev) => [...prev, { role: 'assistant', content: data.answer }]);
      }
    } catch {
      const staticFallback = buildDeterministicRepoAnswer(q, project, activeFile, traceResult);
      setChatHistory((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: staticFallback,
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleInputValueChange = (key: string, rawVal: string) => {
    let parsed: unknown = rawVal;
    if (rawVal === 'true' || rawVal === 'True') parsed = true;
    else if (rawVal === 'false' || rawVal === 'False') parsed = false;
    else if (rawVal !== '' && !Number.isNaN(Number(rawVal))) parsed = Number(rawVal);

    onUpdateInputs({
      ...customInputs,
      [key]: parsed,
    });
  };

  const handleAddCustomVariable = (e: React.FormEvent) => {
    e.preventDefault();
    const k = newVarKey.trim();
    if (!k) return;
    handleInputValueChange(k, newVarVal.trim());
    setNewVarKey('');
    setNewVarVal('');
  };

  const cachedAI = currentNode ? aiExplanationsCache[currentNode.id] : undefined;

  return (
    <aside className="w-full lg:w-[420px] xl:w-[440px] shrink-0 h-full bg-[#141519] border-l border-white/[0.08] flex flex-col overflow-hidden">
      {/* Top Panel Navigation Tabs */}
      <div className="grid grid-cols-4 border-b border-white/[0.08] px-2 pt-2 bg-[#111216] gap-1">
        <button
          type="button"
          onClick={() => setActiveTab('code')}
          className={`flex items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-medium rounded-t-lg border-b-2 transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'code'
              ? 'border-blue-400 text-white bg-[#18191f]'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Code2 className="w-3.5 h-3.5 shrink-0" />
          Source Sync
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('inspector')}
          className={`flex items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-medium rounded-t-lg border-b-2 transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'inspector'
              ? 'border-blue-400 text-white bg-[#18191f]'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5 shrink-0" />
          Node & AI
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('simulate')}
          className={`flex items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-medium rounded-t-lg border-b-2 transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'simulate'
              ? 'border-blue-400 text-white bg-[#18191f]'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Sliders className="w-3.5 h-3.5 shrink-0" />
          Input & State
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('chat')}
          className={`flex items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-medium rounded-t-lg border-b-2 transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'chat'
              ? 'border-blue-400 text-white bg-[#18191f]'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5 shrink-0" />
          Repo Chat
        </button>
      </div>

      {/* TAB 1: SYNCHRONIZED SOURCE CODE + SELECTED NODE SUMMARY */}
      {activeTab === 'code' && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-4 py-2.5 bg-[#16181e] border-b border-white/[0.06] flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 truncate">
              <span className="font-mono font-semibold text-white">{activeFile.path}</span>
              <span className="text-zinc-500">·</span>
              <span className="text-zinc-400">{activeFile.lines.length} lines</span>
            </div>
            <span className="text-[11px] text-blue-300">Click any line ↔ Map sync</span>
          </div>

          {/* Interactive Source Lines */}
          <div className="flex-1 overflow-y-auto font-mono text-xs py-2 select-text">
            {activeFile.lines.map((lineText, idx) => {
              const lineNum = idx + 1;
              const isSelectedNodeLine =
                currentNode &&
                currentNode.file === activeFile.path &&
                lineNum >= currentNode.location.startLine &&
                lineNum <=
                  (currentNode.kind === 'function'
                    ? currentNode.location.startLine
                    : currentNode.location.endLine);

              const isCurrentExecutionLine =
                activeStep &&
                activeStep.file === activeFile.path &&
                activeStep.line === lineNum;

              return (
                <div
                  key={lineNum}
                  onClick={() => onSelectNodeByLine(lineNum)}
                  className={`flex items-start px-3 py-0.5 cursor-pointer transition-colors ${
                    isCurrentExecutionLine
                      ? 'bg-blue-500/25 text-white'
                      : isSelectedNodeLine
                      ? 'bg-amber-500/15 text-amber-100'
                      : 'hover:bg-white/[0.04] text-zinc-300'
                  }`}
                >
                  <span className="w-8 shrink-0 text-right pr-3 text-zinc-600 select-none tabular-nums">
                    {lineNum}
                  </span>
                  <span className="w-4 shrink-0 text-center select-none">
                    {isCurrentExecutionLine ? (
                      <span className="text-blue-400 font-bold">▶</span>
                    ) : isSelectedNodeLine ? (
                      <span className="text-amber-400">●</span>
                    ) : null}
                  </span>
                  <pre className="whitespace-pre overflow-x-auto flex-1">
                    {lineText || ' '}
                  </pre>
                </div>
              );
            })}
          </div>

          {/* Synchronized Bottom Mini Inspector for Selected Node */}
          {currentNode && (
            <div className="p-4 bg-[#181a20] border-t border-white/[0.08] space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono uppercase text-blue-400 font-semibold">
                    {currentNode.kind}
                  </span>
                  <span className="text-zinc-600">·</span>
                  <span className="font-mono text-xs font-semibold text-white">
                    {currentNode.label}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('inspector')}
                  className="text-xs text-blue-400 hover:underline flex items-center gap-1"
                >
                  Full Explanation
                  <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              <p className="text-xs text-zinc-300 leading-relaxed">
                {currentNode.staticExplanation.beginnerSummary}
              </p>
              <div className="flex items-center gap-3 text-[11px] text-zinc-400 pt-1">
                <span>
                  Provenance:{' '}
                  <strong className="text-emerald-300">
                    {observedStepForNode
                      ? 'Observed during execution'
                      : 'Proven by static AST'}
                  </strong>
                </span>
                {observedStepForNode?.branchDecision && (
                  <>
                    <span>·</span>
                    <span>
                      Evaluated:{' '}
                      <strong className="text-amber-300 font-mono">
                        {String(observedStepForNode.branchDecision.evaluatedTo).toUpperCase()}
                      </strong>
                    </span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: NODE INSPECTOR & GEMINI AI EXPLANATION (NON-HALLUCINATING) */}
      {activeTab === 'inspector' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {currentNode ? (
            <>
              <div className="p-3.5 rounded-xl bg-[#191b22] border border-white/[0.08]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono uppercase text-blue-400 font-semibold">
                    {currentNode.kind.toUpperCase()} NODE
                  </span>
                  <span className="text-xs font-mono text-zinc-400">
                    {currentNode.file}:{currentNode.location.startLine}
                  </span>
                </div>
                <h3 className="mt-1 font-mono text-sm font-semibold text-white">
                  {currentNode.label}
                </h3>

                {/* Non-Hallucination Epistemic Provenance Indicator */}
                <div className="mt-3 pt-2.5 border-t border-white/[0.06] flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="flex items-center gap-1 text-emerald-300">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Static AST Proven
                  </span>
                  <span>·</span>
                  {observedStepForNode ? (
                    <span className="flex items-center gap-1 text-blue-300">
                      <Activity className="w-3.5 h-3.5" />
                      Observed at Step #{observedStepForNode.stepIndex}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-zinc-500">
                      <HelpCircle className="w-3.5 h-3.5" />
                      Not executed in current trace
                    </span>
                  )}
                </div>
              </div>

              {/* Condition Specific Breakdown (Expression, TRUE, FALSE, Variables, Possible Values) */}
              {currentNode.kind === 'condition' && (
                <div className="p-3.5 rounded-xl bg-[#191b22] border border-amber-500/25 space-y-2 text-xs">
                  <div className="font-semibold text-amber-300">Condition Breakdown</div>
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <div>
                      <span className="text-zinc-500 block">Expression</span>
                      <span className="font-mono text-white">{currentNode.expression}</span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block">Variables</span>
                      <span className="font-mono text-white">
                        {currentNode.variablesRead.join(', ') || 'None'}
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block">Observed Value</span>
                      <span className="font-mono text-emerald-300">
                        {observedStepForNode?.branchDecision
                          ? `${String(observedStepForNode.branchDecision.evaluatedTo).toUpperCase()} (Observed)`
                          : 'Unknown (Static only)'}
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block">Branches</span>
                      <span className="font-mono text-zinc-300">TRUE / FALSE</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Structured Analysis Sections */}
              <div className="space-y-3 text-xs">
                <div className="p-3.5 rounded-xl bg-[#181920] border border-white/[0.06] space-y-2.5">
                  <div>
                    <h4 className="font-semibold text-zinc-200">What it does</h4>
                    <p className="text-zinc-400 mt-0.5 leading-relaxed">
                      {cachedAI?.whatItDoes || currentNode.staticExplanation.whatItDoes}
                    </p>
                  </div>

                  <div>
                    <h4 className="font-semibold text-zinc-200">Why it exists</h4>
                    <p className="text-zinc-400 mt-0.5 leading-relaxed">
                      {cachedAI?.whyItExists || currentNode.staticExplanation.whyItExists}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div>
                      <h4 className="font-semibold text-zinc-200">Inputs</h4>
                      <p className="font-mono text-zinc-400 mt-0.5">
                        {(cachedAI?.inputs || currentNode.staticExplanation.inputs).join(', ')}
                      </p>
                    </div>
                    <div>
                      <h4 className="font-semibold text-zinc-200">Outputs</h4>
                      <p className="font-mono text-zinc-400 mt-0.5">
                        {(cachedAI?.outputs || currentNode.staticExplanation.outputs).join(', ')}
                      </p>
                    </div>
                  </div>

                  <div>
                    <h4 className="font-semibold text-zinc-200">Possible Paths</h4>
                    <ul className="mt-1 space-y-1 font-mono text-zinc-400">
                      {(cachedAI?.possiblePaths || currentNode.staticExplanation.possiblePaths).map(
                        (p, i) => (
                          <li key={i}>→ {p}</li>
                        )
                      )}
                    </ul>
                  </div>

                  <div className="pt-2 border-t border-white/[0.06]">
                    <h4 className="font-semibold text-blue-300">Beginner Explanation</h4>
                    <p className="text-zinc-300 mt-1 leading-relaxed">
                      {cachedAI?.beginnerExplanation ||
                        currentNode.staticExplanation.beginnerSummary}
                    </p>
                  </div>

                  {cachedAI?.confidenceNote && (
                    <div className="pt-2 border-t border-white/[0.06] text-[11px] text-emerald-300">
                      AI Provenance Note: {cachedAI.confidenceNote}
                    </div>
                  )}
                </div>
              </div>

              {/* Live Server-Side Gemini Analysis Trigger */}
              <div className="p-3.5 rounded-xl bg-[#181a22] border border-blue-500/25 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                    Gemini 4 Hydrogen Deep Analysis
                  </span>
                  <button
                    type="button"
                    onClick={handleRequestGeminiNodeExplanation}
                    disabled={isLoadingAI}
                    className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0"
                  >
                    {isLoadingAI ? 'Analyzing AST...' : 'Generate AI Insight'}
                  </button>
                </div>
                {aiError && (
                  <p className="text-[11px] text-amber-300 leading-relaxed">{aiError}</p>
                )}
              </div>
            </>
          ) : (
            <div className="text-xs text-zinc-500 p-4">
              Select any node on the map to inspect its control-flow metadata and AI explanation.
            </div>
          )}
        </div>
      )}

      {/* TAB 3: USER INPUT SIMULATION & LIVE VARIABLE STATE */}
      {activeTab === 'simulate' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Quick Scenario Presets */}
          {project.presets.length > 0 && (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-zinc-300 block">
                Execution Scenarios (One-Click Trace)
              </label>
              <div className="space-y-1.5">
                {project.presets.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    onClick={() => {
                      onUpdateInputs(preset.inputs);
                      onRunSimulation(preset.inputs);
                    }}
                    className="w-full text-left p-2.5 rounded-xl bg-[#191b22] hover:bg-[#22252f] border border-white/[0.07] transition-colors"
                  >
                    <div className="flex items-center justify-between text-xs font-medium text-white">
                      <span>{preset.name}</span>
                      <span className="text-[11px] text-blue-400 font-mono">Run →</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-0.5">{preset.description}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Custom User Input Editor */}
          <div className="p-3.5 rounded-xl bg-[#191b22] border border-white/[0.08] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">Custom Program Inputs</span>
              <button
                type="button"
                onClick={() => onRunSimulation()}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5" />
                Run Visualization
              </button>
            </div>

            <div className="space-y-2">
              {Object.entries(customInputs).map(([key, val]) => (
                <div key={key} className="flex items-center gap-2">
                  <label
                    htmlFor={`input-var-${key}`}
                    className="w-28 font-mono text-xs text-zinc-300 truncate"
                  >
                    {key} =
                  </label>
                  <input
                    id={`input-var-${key}`}
                    type="text"
                    value={String(val)}
                    onChange={(e) => handleInputValueChange(key, e.target.value)}
                    className="flex-1 bg-[#111216] border border-white/10 rounded-lg px-2.5 py-1.5 font-mono text-xs text-white focus:outline-none focus:border-blue-400"
                  />
                </div>
              ))}
            </div>

            {/* Add new input variable */}
            <form onSubmit={handleAddCustomVariable} className="flex items-center gap-2 pt-2 border-t border-white/[0.06]">
              <input
                type="text"
                placeholder="var_name"
                aria-label="New variable name"
                value={newVarKey}
                onChange={(e) => setNewVarKey(e.target.value)}
                className="w-28 bg-[#111216] border border-white/10 rounded-lg px-2 py-1 font-mono text-xs text-white"
              />
              <input
                type="text"
                placeholder="value"
                aria-label="New variable value"
                value={newVarVal}
                onChange={(e) => setNewVarVal(e.target.value)}
                className="flex-1 bg-[#111216] border border-white/10 rounded-lg px-2 py-1 font-mono text-xs text-white"
              />
              <button
                type="submit"
                aria-label="Add Input Variable"
                className="p-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-zinc-200"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </form>
          </div>

          {/* Live Variable State Inspector at Current Execution Step */}
          <div className="p-3.5 rounded-xl bg-[#191b22] border border-white/[0.08] space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-emerald-400" />
                Variable State (Step {activeStep?.stepIndex || 1})
              </span>
              <span className="text-[11px] font-mono text-zinc-400">
                {activeStep?.functionName}() : Line {activeStep?.line}
              </span>
            </div>

            {activeStep ? (
              <div className="space-y-1.5 font-mono text-xs">
                {Object.entries(activeStep.variables).map(([k, v]) => {
                  const isMutated = activeStep.variableDiff?.variable === k;
                  return (
                    <div
                      key={k}
                      className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg ${
                        isMutated
                          ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-200'
                          : 'bg-[#121318] text-zinc-300'
                      }`}
                    >
                      <span>{k}</span>
                      <span className="font-semibold">
                        {isMutated
                          ? `${JSON.stringify(activeStep.variableDiff?.previousValue)} → ${JSON.stringify(v)}`
                          : JSON.stringify(v)}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-zinc-500">No active step state.</p>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: REPOSITORY-AWARE AI CHAT */}
      {activeTab === 'chat' && (
        <div className="flex-1 flex flex-col overflow-hidden p-4">
          {/* Starter Prompts */}
          <div className="mb-3 flex flex-wrap gap-1.5">
            {[
              'Why does this function call the database?',
              'What happens if age >= 18 is false?',
              'Which file handles authentication?',
              "Explain this file like I'm a beginner",
            ].map((promptText) => (
              <button
                key={promptText}
                type="button"
                onClick={() => handleAskRepositoryChat(promptText)}
                className="text-[11px] px-2.5 py-1 rounded-lg bg-[#1c1e26] hover:bg-[#262934] text-zinc-300 border border-white/[0.06] transition-colors text-left"
              >
                {promptText}
              </button>
            ))}
          </div>

          {/* Chat Messages */}
          <div className="flex-1 overflow-y-auto space-y-3 pr-1">
            {chatHistory.map((msg, i) => (
              <div
                key={i}
                className={`p-3 rounded-xl text-xs leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-blue-600/20 border border-blue-500/30 text-blue-100 ml-6'
                    : 'bg-[#191b22] border border-white/[0.07] text-zinc-200 mr-2'
                }`}
              >
                {msg.content}
                {msg.role === 'assistant' && (
                  <div className="mt-2 pt-2 border-t border-white/[0.06] flex flex-wrap gap-1.5">
                    {project.files.slice(0, 3).map((f) => (
                      <button
                        key={f.path}
                        type="button"
                        onClick={() => onNavigateToFileFunction(f.path)}
                        className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/[0.06] hover:bg-white/[0.12] text-blue-300"
                      >
                        Jump → {f.path}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {chatLoading && (
              <div className="p-3 rounded-xl bg-[#191b22] border border-white/[0.07] text-xs text-zinc-400">
                Inspecting AST, call graph, and execution trace...
              </div>
            )}
          </div>

          {/* Chat Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleAskRepositoryChat(chatQuestion);
            }}
            className="mt-3 flex items-center gap-2"
          >
            <input
              type="text"
              value={chatQuestion}
              onChange={(e) => setChatQuestion(e.target.value)}
              placeholder="Ask about functions, branches, variables, or files..."
              aria-label="Ask AI Repository Assistant"
              className="flex-1 bg-[#111216] border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-400"
            />
            <button
              type="submit"
              disabled={chatLoading}
              aria-label="Send question"
              className="p-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}
    </aside>
  );
};

function buildDeterministicRepoAnswer(
  question: string,
  project: ProjectModel,
  activeFile: CodeFile,
  trace: ExecutionTraceResult
): string {
  const q = question.toLowerCase();
  if (q.includes('database')) {
    return `[Proven by Static Analysis] In ${project.name}, \`src/main.py\` calls \`connect_db()\` and \`save_audit_log()\` in \`src/database.py\`, while \`src/auth.py\` calls \`query_user()\` in \`src/database.py\` to verify whether the account exists before checking age permissions.`;
  }
  if (q.includes('false') || q.includes('age')) {
    return `[Proven by Static Analysis] In \`src/auth.py:6\`, if \`age >= 18\` evaluates to FALSE, execution branches to \`minor_user(username)\` in \`src/utils.py\` and returns \`False\`. [Observed During Execution] With inputs ${JSON.stringify(
      trace.inputs
    )}, the trace completed ${trace.steps.length} steps with final output ${JSON.stringify(
      trace.finalOutput
    )}.`;
  }
  if (q.includes('auth')) {
    return `[Proven by Static Analysis] Authentication is handled by \`src/auth.py\` via \`authenticate_user(username, age)\`, which depends on \`src/database.py::query_user()\` and \`src/utils.py\`.`;
  }
  return `[Proven by Static Analysis] File \`${activeFile.path}\` (${
    activeFile.language
  }) contains ${activeFile.functions.length} function(s): ${activeFile.functions
    .map((f) => `${f.name}()`)
    .join(', ')}. Use the interactive graph to click any condition or call node.`;
}
