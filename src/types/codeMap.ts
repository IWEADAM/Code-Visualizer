export type SupportedLanguage =
  | 'python'
  | 'typescript'
  | 'javascript'
  | 'java'
  | 'cpp'
  | 'c'
  | 'rust'
  | 'go'
  | 'php'
  | 'csharp'
  | 'html'
  | 'css'
  | 'json'
  | 'unsupported';

export type NodeKind =
  | 'start'
  | 'end'
  | 'function'
  | 'class'
  | 'condition'
  | 'switch'
  | 'case'
  | 'loop'
  | 'call'
  | 'statement'
  | 'return'
  | 'exception'
  | 'input'
  | 'output'
  | 'file'
  | 'module';

export type ProvenanceKind = 'static_proven' | 'runtime_observed' | 'ai_inferred' | 'unknown';

export interface SourceLocation {
  file: string;
  startLine: number;
  endLine: number;
  column?: number;
  codeSnippet: string;
}

export interface ControlFlowNode {
  id: string;
  label: string;
  sublabel?: string;
  kind: NodeKind;
  file: string;
  functionName?: string;
  location: SourceLocation;
  expression?: string;
  variablesRead: string[];
  variablesWritten: string[];
  callsTarget?: {
    file: string;
    functionName: string;
    isExternalFile: boolean;
  };
  metrics?: {
    branches?: number;
    calls?: number;
    loopIterations?: number;
  };
  provenance: ProvenanceKind;
  staticExplanation: {
    whatItDoes: string;
    whyItExists: string;
    inputs: string[];
    outputs: string[];
    dependencies: string[];
    possiblePaths: string[];
    beginnerSummary: string;
  };
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface ControlFlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string; // 'TRUE' | 'FALSE' | 'LOOP' | 'CASE' | 'CALL' | 'NEXT' | 'ERROR'
  branchType?: 'true' | 'false' | 'loop_back' | 'case' | 'normal' | 'cross_file' | 'exception';
}

export interface FunctionDef {
  id: string;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  parameters: string[];
  returnType?: string;
  calls: Array<{
    calleeName: string;
    targetFile: string;
    line: number;
  }>;
  calledBy: Array<{
    callerName: string;
    callerFile: string;
    line: number;
  }>;
  nodes: ControlFlowNode[];
  edges: ControlFlowEdge[];
  summary: string;
}

export interface ClassDef {
  id: string;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  methods: string[];
  properties: string[];
}

export interface DependencyEdge {
  id: string;
  sourceFile: string;
  targetFile: string;
  importedSymbols: string[];
  line: number;
}

export interface CodeFile {
  path: string;
  name: string;
  folder: string;
  language: SupportedLanguage;
  isFullySupported: boolean;
  sizeBytes: number;
  content: string;
  lines: string[];
  functions: FunctionDef[];
  classes: ClassDef[];
  imports: string[];
  variables: string[];
  analysisStatus: 'analyzed' | 'partial' | 'unsupported';
  fileNodes: ControlFlowNode[];
  fileEdges: ControlFlowEdge[];
}

export interface EntryPoint {
  id: string;
  file: string;
  functionName: string;
  line: number;
  reason: string;
}

export interface ExecutionStep {
  stepIndex: number;
  nodeId: string;
  file: string;
  functionName: string;
  line: number;
  label: string;
  description: string;
  branchDecision?: {
    expression: string;
    evaluatedTo: boolean | string;
  };
  loopIteration?: number;
  variables: Record<string, unknown>;
  variableDiff?: {
    variable: string;
    previousValue: unknown;
    newValue: unknown;
  };
  isError?: boolean;
  errorDetails?: {
    type: string;
    message: string;
    file: string;
    line: number;
    callStack: string[];
  };
}

export interface ExecutionTraceResult {
  entryPointId: string;
  inputs: Record<string, unknown>;
  steps: ExecutionStep[];
  visitedNodeIds: string[];
  visitedEdgeIds: string[];
  loopCounts: Record<string, number>;
  finalOutput?: unknown;
  error?: {
    type: string;
    message: string;
    file: string;
    line: number;
    path: string[];
    explanation: string;
  };
  executionMode: 'sandboxed_interpreter' | 'static_symbolic';
}

export interface AIExplanation {
  nodeId: string;
  whatItDoes: string;
  whyItExists: string;
  inputs: string[];
  outputs: string[];
  dependencies: string[];
  possiblePaths: string[];
  beginnerExplanation: string;
  provenance: ProvenanceKind;
  confidenceNote: string;
}

export interface ProjectModel {
  id: string;
  name: string;
  description: string;
  repoUrl?: string;
  languages: SupportedLanguage[];
  files: CodeFile[];
  dependencies: DependencyEdge[];
  entryPoints: EntryPoint[];
  defaultInputs: Record<string, unknown>;
  presets: Array<{
    name: string;
    description: string;
    inputs: Record<string, unknown>;
  }>;
}

export interface SearchResultItem {
  id: string;
  symbolName: string;
  kind: 'function' | 'class' | 'variable' | 'file' | 'condition';
  file: string;
  line: number;
  nodeId?: string;
  functionName?: string;
  calledBy: string[];
  calls: string[];
  snippet: string;
}
