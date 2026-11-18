import {
  ClassDef,
  CodeFile,
  ControlFlowEdge,
  ControlFlowNode,
  DependencyEdge,
  EntryPoint,
  FunctionDef,
  ProjectModel,
  SearchResultItem,
  SupportedLanguage,
} from '../types/codeMap';

export function detectLanguage(filename: string): {
  language: SupportedLanguage;
  isFullySupported: boolean;
} {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'py':
      return { language: 'python', isFullySupported: true };
    case 'ts':
    case 'tsx':
      return { language: 'typescript', isFullySupported: true };
    case 'js':
    case 'jsx':
    case 'mjs':
      return { language: 'javascript', isFullySupported: true };
    case 'java':
      return { language: 'java', isFullySupported: true };
    case 'cpp':
    case 'cc':
    case 'hpp':
      return { language: 'cpp', isFullySupported: true };
    case 'c':
    case 'h':
      return { language: 'c', isFullySupported: true };
    case 'rs':
      return { language: 'rust', isFullySupported: true };
    case 'go':
      return { language: 'go', isFullySupported: true };
    case 'php':
      return { language: 'php', isFullySupported: false };
    case 'cs':
      return { language: 'csharp', isFullySupported: false };
    case 'html':
      return { language: 'html', isFullySupported: false };
    case 'css':
      return { language: 'css', isFullySupported: false };
    case 'json':
      return { language: 'json', isFullySupported: false };
    default:
      return { language: 'unsupported', isFullySupported: false };
  }
}

function extractVariablesFromExpr(expr: string): string[] {
  const reserved = new Set([
    'if', 'else', 'elif', 'while', 'for', 'in', 'range', 'return', 'True', 'False',
    'true', 'false', 'None', 'null', 'undefined', 'and', 'or', 'not', 'let', 'const',
    'var', 'function', 'def', 'class', 'switch', 'case', 'default', 'new', 'throw',
    'raise', 'Exception', 'Error', 'ConnectionError', 'ValueError', 'int', 'str', 'len',
    'Math', 'console', 'log', 'print',
  ]);
  const matches = expr.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
  return Array.from(new Set(matches.filter((m) => !reserved.has(m))));
}

export function parseSourceFile(
  path: string,
  content: string,
  allFilePaths: string[] = []
): CodeFile {
  const parts = path.split('/');
  const name = parts[parts.length - 1] || path;
  const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '/';
  const { language, isFullySupported } = detectLanguage(name);
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const sizeBytes = new TextEncoder().encode(content).length;

  const imports: string[] = [];
  const classes: ClassDef[] = [];
  const functions: FunctionDef[] = [];
  const variablesSet = new Set<string>();

  // 1. Extract Imports
  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    // Python: from auth import login OR import database
    const pyFrom = line.match(/^from\s+([a-zA-Z0-9_.]+)\s+import\s+(.+)$/);
    if (pyFrom) {
      imports.push(pyFrom[1]);
      return;
    }
    const pyImp = line.match(/^import\s+([a-zA-Z0-9_.,\s]+)$/);
    if (pyImp && !line.includes('from ')) {
      pyImp[1].split(',').forEach((mod) => imports.push(mod.trim().split(' ')[0]));
      return;
    }
    // TS/JS: import ... from './auth'
    const jsImp = line.match(/from\s+['"]([^'"]+)['"]/);
    if (jsImp) {
      imports.push(jsImp[1]);
    }
  });

  // 2. Extract Classes
  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    const classMatch = line.match(/^class\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (classMatch) {
      classes.push({
        id: `${path}::class::${classMatch[1]}`,
        name: classMatch[1],
        file: path,
        startLine: idx + 1,
        endLine: Math.min(lines.length, idx + 25),
        methods: [],
        properties: [],
      });
    }
  });

  // 3. Extract Functions & build per-function Control-Flow Graph (CFG)
  interface RawFuncSpan {
    name: string;
    params: string[];
    startLine: number; // 1-indexed
    endLine: number;
    indent: number;
  }

  const rawFuncs: RawFuncSpan[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    const indent = raw.search(/\S|$/);

    // Python def
    const pyDef = trimmed.match(/^def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/);
    // TS/JS function or exported function or method
    const jsDef =
      trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/) ||
      trimmed.match(/^(?:export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*[^=]+)?=>/);
    // C/Java/Go/Rust fn
    const cDef =
      trimmed.match(/^(?:pub\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/) ||
      trimmed.match(/^func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/) ||
      trimmed.match(/^(?:public|private|protected|static|\s)+(?:void|int|string|String|boolean|bool|double|float)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/);

    const match = pyDef || jsDef || cDef;
    if (match) {
      const fnName = match[1];
      const paramStr = match[2] || '';
      const params = paramStr
        .split(',')
        .map((p) => p.trim().split(':')[0].split('=')[0].trim())
        .filter(Boolean);

      params.forEach((p) => variablesSet.add(p));

      // Determine endLine
      let endLine = lines.length;
      if (language === 'python') {
        for (let j = i + 1; j < lines.length; j++) {
          const nextRaw = lines[j];
          const nextTrim = nextRaw.trim();
          if (!nextTrim || nextTrim.startsWith('#')) continue;
          const nextIndent = nextRaw.search(/\S|$/);
          if (nextIndent <= indent && !nextTrim.startsWith(')') && !nextTrim.startsWith(']')) {
            endLine = j;
            break;
          }
        }
      } else {
        let braceDepth = 0;
        let seenBrace = false;
        for (let j = i; j < lines.length; j++) {
          for (const ch of lines[j]) {
            if (ch === '{') {
              braceDepth++;
              seenBrace = true;
            } else if (ch === '}') {
              braceDepth--;
            }
          }
          if (seenBrace && braceDepth <= 0) {
            endLine = j + 1;
            break;
          }
        }
      }

      rawFuncs.push({
        name: fnName,
        params,
        startLine: i + 1,
        endLine,
        indent,
      });
    }
  }

  // If file has no explicit function definitions but is supported, create a top-level module flow
  if (rawFuncs.length === 0 && isFullySupported && lines.some((l) => l.trim().length > 0)) {
    rawFuncs.push({
      name: 'module_entry',
      params: [],
      startLine: 1,
      endLine: lines.length,
      indent: 0,
    });
  }

  const fileNodes: ControlFlowNode[] = [];
  const fileEdges: ControlFlowEdge[] = [];

  // Build Control Flow Graph for each function
  for (const fnSpan of rawFuncs) {
    const fnId = `${path}::fn::${fnSpan.name}`;
    const nodes: ControlFlowNode[] = [];
    const edges: ControlFlowEdge[] = [];
    const calls: FunctionDef['calls'] = [];

    const entryNodeId = `${fnId}::start`;
    const entryNode: ControlFlowNode = {
      id: entryNodeId,
      label: `${fnSpan.name}(${fnSpan.params.join(', ')})`,
      sublabel: `Entry · Line ${fnSpan.startLine}`,
      kind: 'function',
      file: path,
      functionName: fnSpan.name,
      location: {
        file: path,
        startLine: fnSpan.startLine,
        endLine: fnSpan.endLine,
        codeSnippet: lines.slice(fnSpan.startLine - 1, Math.min(fnSpan.endLine, fnSpan.startLine + 8)).join('\n'),
      },
      variablesRead: fnSpan.params,
      variablesWritten: fnSpan.params,
      provenance: 'static_proven',
      staticExplanation: {
        whatItDoes: `Defines function ${fnSpan.name} taking (${fnSpan.params.join(', ') || 'no arguments'}).`,
        whyItExists: `Encapsulates core logic in ${name} starting at line ${fnSpan.startLine}.`,
        inputs: fnSpan.params.length ? fnSpan.params : ['None'],
        outputs: ['Return value or state mutation'],
        dependencies: imports,
        possiblePaths: ['Function body execution'],
        beginnerSummary: `When ${fnSpan.name} is called, execution enters here with ${fnSpan.params.length ? fnSpan.params.join(', ') : 'initial state'}.`,
      },
    };
    nodes.push(entryNode);

    let activePredecessors: Array<{ id: string; label?: string; branchType?: ControlFlowEdge['branchType'] }> = [
      { id: entryNodeId, branchType: 'normal' },
    ];

    // Stack to track indentation-based branches in Python/JS
    interface BranchContext {
      type: 'if' | 'elif' | 'else' | 'loop' | 'switch';
      indent: number;
      conditionNodeId: string;
      branchExitNodes: Array<{ id: string; label?: string; branchType?: ControlFlowEdge['branchType'] }>;
      lastBranchEnd?: string;
    }

    const branchStack: BranchContext[] = [];

    for (let lineIdx = fnSpan.startLine; lineIdx < fnSpan.endLine; lineIdx++) {
      const rawLine = lines[lineIdx];
      const trimmed = rawLine.trim();
      const lineNum = lineIdx + 1;

      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed === '{' || trimmed === '}') {
        continue;
      }
      if (lineNum === fnSpan.startLine && (trimmed.startsWith('def ') || trimmed.includes('function ') || trimmed.startsWith('export '))) {
        continue;
      }

      const indent = rawLine.search(/\S|$/);

      // Pop completed blocks when indentation decreases
      while (branchStack.length > 0 && indent <= branchStack[branchStack.length - 1].indent) {
        const top = branchStack.pop()!;
        // Check if current line is elif / else continuing the same if-chain
        const isElseContinuation =
          indent === top.indent &&
          (trimmed.startsWith('elif ') ||
            trimmed.startsWith('else:') ||
            trimmed.startsWith('else ') ||
            trimmed.startsWith('} else'));

        if (isElseContinuation && (top.type === 'if' || top.type === 'elif')) {
          // Keep context for connecting merges
          top.branchExitNodes.push(...activePredecessors);
          branchStack.push(top);
          break;
        } else {
          if (top.type === 'loop') {
            // Create cycle edge back to loop condition
            activePredecessors.forEach((pred) => {
              edges.push({
                id: `edge::${pred.id}::to::${top.conditionNodeId}::loopback`,
                source: pred.id,
                target: top.conditionNodeId,
                label: 'NEXT ITER',
                branchType: 'loop_back',
              });
            });
            // Continuing after loop is when loop condition is FALSE
            activePredecessors = [
              { id: top.conditionNodeId, label: 'FALSE (EXIT)', branchType: 'false' },
            ];
          } else if (top.type === 'if' || top.type === 'elif' || top.type === 'else') {
            const merged = [...top.branchExitNodes, ...activePredecessors];
            if (top.type === 'if' || top.type === 'elif') {
              // Also add FALSE edge from condition if no else block handled it
              merged.push({
                id: top.conditionNodeId,
                label: 'FALSE',
                branchType: 'false',
              });
            }
            activePredecessors = merged;
          }
        }
      }

      const nodeId = `${fnId}::line::${lineNum}`;

      // 1. Check IF / ELIF / ELSE
      const ifMatch =
        trimmed.match(/^if\s+(.+?)\s*[:{]?$/) ||
        trimmed.match(/^if\s*\((.+)\)\s*\{?$/);
      const elifMatch =
        trimmed.match(/^elif\s+(.+?)\s*[:{]?$/) ||
        trimmed.match(/^(?:\}\s*)?else\s+if\s*\((.+)\)\s*\{?$/);
      const elseMatch =
        trimmed.match(/^else\s*[:{]?$/) ||
        trimmed.match(/^(?:\}\s*)?else\s*\{?$/);

      if (ifMatch) {
        const condExpr = ifMatch[1].replace(/[:{]$/, '').trim();
        const vars = extractVariablesFromExpr(condExpr);
        vars.forEach((v) => variablesSet.add(v));

        const condNode: ControlFlowNode = {
          id: nodeId,
          label: `${condExpr} ?`,
          sublabel: `Condition · Line ${lineNum}`,
          kind: 'condition',
          file: path,
          functionName: fnSpan.name,
          location: {
            file: path,
            startLine: lineNum,
            endLine: lineNum,
            codeSnippet: rawLine,
          },
          expression: condExpr,
          variablesRead: vars,
          variablesWritten: [],
          provenance: 'static_proven',
          staticExplanation: {
            whatItDoes: `Evaluates whether "${condExpr}" is TRUE or FALSE.`,
            whyItExists: `Branches execution flow inside ${fnSpan.name}() based on ${vars.join(', ') || 'state'}.`,
            inputs: vars.length ? vars : [condExpr],
            outputs: ['Boolean branch (TRUE / FALSE)'],
            dependencies: [],
            possiblePaths: [`TRUE → Line ${lineNum + 1}`, `FALSE → Alternate branch`],
            beginnerSummary: `If ${condExpr} is true, the program enters the first branch; otherwise it takes the false path.`,
          },
        };
        nodes.push(condNode);

        activePredecessors.forEach((pred) => {
          edges.push({
            id: `edge::${pred.id}::to::${nodeId}`,
            source: pred.id,
            target: nodeId,
            label: pred.label,
            branchType: pred.branchType || 'normal',
          });
        });

        branchStack.push({
          type: 'if',
          indent,
          conditionNodeId: nodeId,
          branchExitNodes: [],
        });

        activePredecessors = [{ id: nodeId, label: 'TRUE', branchType: 'true' }];
        continue;
      }

      if (elifMatch) {
        const condExpr = elifMatch[1].replace(/[:{]$/, '').trim();
        const vars = extractVariablesFromExpr(condExpr);
        vars.forEach((v) => variablesSet.add(v));

        const top = branchStack[branchStack.length - 1];
        const prevCondId = top ? top.conditionNodeId : activePredecessors[0]?.id;

        const elifNode: ControlFlowNode = {
          id: nodeId,
          label: `${condExpr} ?`,
          sublabel: `Else-If · Line ${lineNum}`,
          kind: 'condition',
          file: path,
          functionName: fnSpan.name,
          location: {
            file: path,
            startLine: lineNum,
            endLine: lineNum,
            codeSnippet: rawLine,
          },
          expression: condExpr,
          variablesRead: vars,
          variablesWritten: [],
          provenance: 'static_proven',
          staticExplanation: {
            whatItDoes: `Secondary condition check "${condExpr}" when prior condition is FALSE.`,
            whyItExists: `Handles an alternative case in ${fnSpan.name}().`,
            inputs: vars,
            outputs: ['Boolean branch (TRUE / FALSE)'],
            dependencies: [],
            possiblePaths: ['TRUE → Else-if body', 'FALSE → Next branch'],
            beginnerSummary: `Checked only if the earlier if-condition was false. Tests whether ${condExpr} holds.`,
          },
        };
        nodes.push(elifNode);

        if (prevCondId) {
          edges.push({
            id: `edge::${prevCondId}::to::${nodeId}::false`,
            source: prevCondId,
            target: nodeId,
            label: 'FALSE',
            branchType: 'false',
          });
        }

        if (top) {
          top.type = 'elif';
          top.conditionNodeId = nodeId;
        }
        activePredecessors = [{ id: nodeId, label: 'TRUE', branchType: 'true' }];
        continue;
      }

      if (elseMatch) {
        const top = branchStack[branchStack.length - 1];
        if (top) {
          top.type = 'else';
          activePredecessors = [
            { id: top.conditionNodeId, label: 'FALSE', branchType: 'false' },
          ];
        }
        continue;
      }

      // 2. Check LOOPS (while / for)
      const loopMatch =
        trimmed.match(/^(?:while|for)\s+(.+?)\s*[:{]?$/) ||
        trimmed.match(/^(?:while|for)\s*\((.+)\)\s*\{?$/);
      if (loopMatch) {
        const loopExpr = loopMatch[1].replace(/[:{]$/, '').trim();
        const vars = extractVariablesFromExpr(loopExpr);
        vars.forEach((v) => variablesSet.add(v));

        const loopNode: ControlFlowNode = {
          id: nodeId,
          label: `Loop: ${loopExpr}`,
          sublabel: `Cycle · Line ${lineNum}`,
          kind: 'loop',
          file: path,
          functionName: fnSpan.name,
          location: {
            file: path,
            startLine: lineNum,
            endLine: lineNum,
            codeSnippet: rawLine,
          },
          expression: loopExpr,
          variablesRead: vars,
          variablesWritten: vars.slice(0, 1),
          provenance: 'static_proven',
          staticExplanation: {
            whatItDoes: `Iterates repeatedly while "${loopExpr}" remains active.`,
            whyItExists: `Processes collections or repeats state transitions in ${fnSpan.name}().`,
            inputs: vars,
            outputs: ['Loop body iteration or loop exit'],
            dependencies: [],
            possiblePaths: ['TRUE → Enter loop body', 'FALSE → Exit loop'],
            beginnerSummary: `A cyclic loop that runs its body on each iteration and loops back until ${loopExpr} finishes.`,
          },
        };
        nodes.push(loopNode);

        activePredecessors.forEach((pred) => {
          edges.push({
            id: `edge::${pred.id}::to::${nodeId}`,
            source: pred.id,
            target: nodeId,
            label: pred.label,
            branchType: pred.branchType || 'normal',
          });
        });

        branchStack.push({
          type: 'loop',
          indent,
          conditionNodeId: nodeId,
          branchExitNodes: [],
        });

        activePredecessors = [{ id: nodeId, label: 'TRUE (ITERATE)', branchType: 'true' }];
        continue;
      }

      // 3. Check SWITCH / MATCH
      const switchMatch =
        trimmed.match(/^(?:switch|match)\s*\(?([^:{)]+)\)?\s*[:{]?$/);
      if (switchMatch) {
        const switchExpr = switchMatch[1].trim();
        const vars = extractVariablesFromExpr(switchExpr);
        const switchNode: ControlFlowNode = {
          id: nodeId,
          label: `switch(${switchExpr})`,
          sublabel: `Multi-branch · Line ${lineNum}`,
          kind: 'switch',
          file: path,
          functionName: fnSpan.name,
          location: {
            file: path,
            startLine: lineNum,
            endLine: lineNum,
            codeSnippet: rawLine,
          },
          expression: switchExpr,
          variablesRead: vars,
          variablesWritten: [],
          provenance: 'static_proven',
          staticExplanation: {
            whatItDoes: `Dispatches execution based on value of "${switchExpr}".`,
            whyItExists: `Selects one matching case branch among multiple possibilities.`,
            inputs: vars,
            outputs: ['Selected case branch'],
            dependencies: [],
            possiblePaths: ['Case branches'],
            beginnerSummary: `Checks the value of ${switchExpr} and jumps directly to the matching case.`,
          },
        };
        nodes.push(switchNode);
        activePredecessors.forEach((pred) => {
          edges.push({
            id: `edge::${pred.id}::to::${nodeId}`,
            source: pred.id,
            target: nodeId,
            label: pred.label,
            branchType: pred.branchType || 'normal',
          });
        });
        activePredecessors = [{ id: nodeId, label: 'CASE', branchType: 'case' }];
        continue;
      }

      // 4. Check RAISE / THROW EXCEPTION
      const raiseMatch =
        trimmed.match(/^(?:raise|throw\s+new|throw)\s+([a-zA-Z0-9_]+)\s*\(?([^)]*)\)?/);
      if (raiseMatch) {
        const errType = raiseMatch[1];
        const errMsg = raiseMatch[2]?.replace(/['"]/g, '') || 'Runtime failure';
        const errNode: ControlFlowNode = {
          id: nodeId,
          label: `raise ${errType}`,
          sublabel: `Exception · Line ${lineNum}`,
          kind: 'exception',
          file: path,
          functionName: fnSpan.name,
          location: {
            file: path,
            startLine: lineNum,
            endLine: lineNum,
            codeSnippet: rawLine,
          },
          expression: `${errType}("${errMsg}")`,
          variablesRead: [],
          variablesWritten: [],
          provenance: 'static_proven',
          staticExplanation: {
            whatItDoes: `Raises a ${errType} exception: "${errMsg}".`,
            whyItExists: `Halts normal execution when an invalid state or connection error occurs.`,
            inputs: [errMsg],
            outputs: [`Exception: ${errType}`],
            dependencies: [],
            possiblePaths: ['Aborts current call path with error'],
            beginnerSummary: `Stops normal execution immediately and reports a ${errType} error.`,
          },
        };
        nodes.push(errNode);
        activePredecessors.forEach((pred) => {
          edges.push({
            id: `edge::${pred.id}::to::${nodeId}`,
            source: pred.id,
            target: nodeId,
            label: pred.label,
            branchType: 'exception',
          });
        });
        activePredecessors = [];
        continue;
      }

      // 5. Check RETURN
      const returnMatch = trimmed.match(/^return(?:\s+(.+))?$/);
      if (returnMatch) {
        const retExpr = (returnMatch[1] || 'void').replace(/;$/, '').trim();
        const vars = extractVariablesFromExpr(retExpr);
        const retNode: ControlFlowNode = {
          id: nodeId,
          label: `return ${retExpr}`,
          sublabel: `Return · Line ${lineNum}`,
          kind: 'return',
          file: path,
          functionName: fnSpan.name,
          location: {
            file: path,
            startLine: lineNum,
            endLine: lineNum,
            codeSnippet: rawLine,
          },
          expression: retExpr,
          variablesRead: vars,
          variablesWritten: [],
          provenance: 'static_proven',
          staticExplanation: {
            whatItDoes: `Returns ${retExpr} to the caller of ${fnSpan.name}().`,
            whyItExists: `Outputs the computed result and exits ${fnSpan.name}().`,
            inputs: vars.length ? vars : [retExpr],
            outputs: [retExpr],
            dependencies: [],
            possiblePaths: ['Returns control to calling function'],
            beginnerSummary: `Finishes ${fnSpan.name}() and sends back ${retExpr}.`,
          },
        };
        nodes.push(retNode);
        activePredecessors.forEach((pred) => {
          edges.push({
            id: `edge::${pred.id}::to::${nodeId}`,
            source: pred.id,
            target: nodeId,
            label: pred.label,
            branchType: pred.branchType || 'normal',
          });
        });
        activePredecessors = [];
        continue;
      }

      // 6. Check FUNCTION CALL or ASSIGNMENT
      const assignMatch = trimmed.match(/^(?:let\s+|const\s+|var\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
      const callMatches = Array.from(trimmed.matchAll(/([a-zA-Z_][a-zA-Z0-9_.]*)\s*\(([^)]*)\)/g));
      const primaryCall = callMatches.find(
        (m) => !['if', 'while', 'for', 'switch', 'print', 'console.log', 'len', 'range', 'int', 'str'].includes(m[1])
      );

      if (primaryCall) {
        const rawCallee = primaryCall[1];
        const calleeParts = rawCallee.split('.');
        const calleeFunc = calleeParts[calleeParts.length - 1];
        const modulePrefix = calleeParts.length > 1 ? calleeParts[0] : undefined;

        // Resolve target file if external
        let targetFile = path;
        let isExternal = false;
        if (modulePrefix) {
          const matchedFile = allFilePaths.find(
            (p) =>
              p.endsWith(`/${modulePrefix}.py`) ||
              p.endsWith(`/${modulePrefix}.ts`) ||
              p.endsWith(`/${modulePrefix}.js`) ||
              p === `${modulePrefix}.py` ||
              p === `${modulePrefix}.ts`
          );
          if (matchedFile && matchedFile !== path) {
            targetFile = matchedFile;
            isExternal = true;
          }
        } else {
          // Check if imported from another file
          const matchedFile = allFilePaths.find((p) => {
            if (p === path) return false;
            const base = p.split('/').pop()?.split('.')[0] || '';
            return imports.some((imp) => imp.includes(base));
          });
          if (matchedFile && !rawFuncs.some((f) => f.name === calleeFunc)) {
            targetFile = matchedFile;
            isExternal = true;
          }
        }

        calls.push({
          calleeName: calleeFunc,
          targetFile,
          line: lineNum,
        });

        const writtenVar = assignMatch ? [assignMatch[1]] : [];
        writtenVar.forEach((v) => variablesSet.add(v));
        const readVars = extractVariablesFromExpr(primaryCall[2] || '');

        const callNode: ControlFlowNode = {
          id: nodeId,
          label: assignMatch ? `${assignMatch[1]} = ${rawCallee}(...)` : `${rawCallee}(${primaryCall[2]})`,
          sublabel: isExternal ? `Cross-File Call → ${targetFile.split('/').pop()}` : `Call · Line ${lineNum}`,
          kind: 'call',
          file: path,
          functionName: fnSpan.name,
          location: {
            file: path,
            startLine: lineNum,
            endLine: lineNum,
            codeSnippet: rawLine,
          },
          expression: trimmed.replace(/;$/, ''),
          variablesRead: readVars,
          variablesWritten: writtenVar,
          callsTarget: {
            file: targetFile,
            functionName: calleeFunc,
            isExternalFile: isExternal,
          },
          provenance: 'static_proven',
          staticExplanation: {
            whatItDoes: `Invokes ${rawCallee}()${isExternal ? ` in ${targetFile}` : ''}${assignMatch ? ` and stores the result in "${assignMatch[1]}"` : ''}.`,
            whyItExists: `Delegates specialized processing to ${calleeFunc}().`,
            inputs: readVars.length ? readVars : ['None'],
            outputs: writtenVar.length ? writtenVar : [`Result of ${calleeFunc}()`],
            dependencies: [isExternal ? `${targetFile}::${calleeFunc}` : calleeFunc],
            possiblePaths: [`Enter ${calleeFunc}()`, `Continue to line ${lineNum + 1}`],
            beginnerSummary: `Calls the helper function ${calleeFunc}()${isExternal ? ` located in ${targetFile}` : ''} and waits for its result.`,
          },
        };
        nodes.push(callNode);
        activePredecessors.forEach((pred) => {
          edges.push({
            id: `edge::${pred.id}::to::${nodeId}`,
            source: pred.id,
            target: nodeId,
            label: pred.label,
            branchType:
              pred.branchType && pred.branchType !== 'normal'
                ? pred.branchType
                : isExternal
                ? 'cross_file'
                : 'normal',
          });
        });
        activePredecessors = [{ id: nodeId, branchType: 'normal' }];
        continue;
      }

      // 7. Standard Statement / Variable Mutation
      const writtenVars = assignMatch ? [assignMatch[1]] : [];
      writtenVars.forEach((v) => variablesSet.add(v));
      const readVars = extractVariablesFromExpr(assignMatch ? assignMatch[2] : trimmed);

      const stmtNode: ControlFlowNode = {
        id: nodeId,
        label: trimmed.length > 38 ? `${trimmed.slice(0, 35)}...` : trimmed,
        sublabel: assignMatch ? `State Mutation · Line ${lineNum}` : `Statement · Line ${lineNum}`,
        kind: 'statement',
        file: path,
        functionName: fnSpan.name,
        location: {
          file: path,
          startLine: lineNum,
          endLine: lineNum,
          codeSnippet: rawLine,
        },
        expression: trimmed.replace(/;$/, ''),
        variablesRead: readVars,
        variablesWritten: writtenVars,
        provenance: 'static_proven',
        staticExplanation: {
          whatItDoes: assignMatch
            ? `Updates variable "${assignMatch[1]}" with value from ${assignMatch[2]}.`
            : `Executes statement: ${trimmed}`,
          whyItExists: `Transforms local program state within ${fnSpan.name}().`,
          inputs: readVars,
          outputs: writtenVars,
          dependencies: [],
          possiblePaths: [`Next statement in ${fnSpan.name}()`],
          beginnerSummary: assignMatch
            ? `Sets the variable ${assignMatch[1]} to the result of ${assignMatch[2]}.`
            : `Runs line ${lineNum} and moves to the next step.`,
        },
      };
      nodes.push(stmtNode);
      activePredecessors.forEach((pred) => {
        edges.push({
          id: `edge::${pred.id}::to::${nodeId}`,
          source: pred.id,
          target: nodeId,
          label: pred.label,
          branchType: pred.branchType || 'normal',
        });
      });
      activePredecessors = [{ id: nodeId, branchType: 'normal' }];
    }

    // Pop remaining open branches at end of function
    while (branchStack.length > 0) {
      const top = branchStack.pop()!;
      if (top.type === 'loop') {
        activePredecessors.forEach((pred) => {
          edges.push({
            id: `edge::${pred.id}::to::${top.conditionNodeId}::loopback`,
            source: pred.id,
            target: top.conditionNodeId,
            label: 'NEXT ITER',
            branchType: 'loop_back',
          });
        });
        activePredecessors = [
          { id: top.conditionNodeId, label: 'FALSE (EXIT)', branchType: 'false' },
        ];
      } else {
        activePredecessors = [...top.branchExitNodes, ...activePredecessors];
      }
    }

    // Add END node for function and connect return nodes / remaining predecessors
    const endNodeId = `${fnId}::end`;
    const endNode: ControlFlowNode = {
      id: endNodeId,
      label: 'END',
      sublabel: `Exit ${fnSpan.name}()`,
      kind: 'end',
      file: path,
      functionName: fnSpan.name,
      location: {
        file: path,
        startLine: fnSpan.endLine,
        endLine: fnSpan.endLine,
        codeSnippet: lines[fnSpan.endLine - 1] || '',
      },
      variablesRead: [],
      variablesWritten: [],
      provenance: 'static_proven',
      staticExplanation: {
        whatItDoes: `Marks the completion of ${fnSpan.name}().`,
        whyItExists: `All execution paths through ${fnSpan.name}() converge or exit here.`,
        inputs: ['Return value'],
        outputs: ['Caller resumes execution'],
        dependencies: [],
        possiblePaths: ['Return to caller'],
        beginnerSummary: `Execution of ${fnSpan.name}() finishes here.`,
      },
    };
    nodes.push(endNode);

    nodes
      .filter((n) => n.kind === 'return')
      .forEach((retNode) => {
        edges.push({
          id: `edge::${retNode.id}::to::${endNodeId}`,
          source: retNode.id,
          target: endNodeId,
          label: 'RETURN',
          branchType: 'normal',
        });
      });

    activePredecessors.forEach((pred) => {
      if (pred.id !== endNodeId) {
        edges.push({
          id: `edge::${pred.id}::to::${endNodeId}`,
          source: pred.id,
          target: endNodeId,
          label: pred.label,
          branchType: pred.branchType || 'normal',
        });
      }
    });

    // Update entryNode metrics
    const branchCount = nodes.filter((n) => n.kind === 'condition' || n.kind === 'switch' || n.kind === 'loop').length;
    entryNode.metrics = {
      branches: branchCount,
      calls: calls.length,
    };

    functions.push({
      id: fnId,
      name: fnSpan.name,
      file: path,
      startLine: fnSpan.startLine,
      endLine: fnSpan.endLine,
      parameters: fnSpan.params,
      calls,
      calledBy: [],
      nodes,
      edges,
      summary: `${fnSpan.name}(${fnSpan.params.join(', ')}) — ${branchCount} branches, ${calls.length} calls`,
    });

    fileNodes.push(...nodes);
    fileEdges.push(...edges);
  }

  return {
    path,
    name,
    folder,
    language,
    isFullySupported,
    sizeBytes,
    content,
    lines,
    functions,
    classes,
    imports,
    variables: Array.from(variablesSet),
    analysisStatus: isFullySupported ? 'analyzed' : 'partial',
    fileNodes,
    fileEdges,
  };
}

export function buildProjectModel(
  id: string,
  name: string,
  description: string,
  rawFiles: Array<{ path: string; content: string }>,
  defaultInputs: Record<string, unknown> = { username: 'Adam', age: 17, score: 92 },
  presets: ProjectModel['presets'] = [],
  repoUrl?: string
): ProjectModel {
  const allPaths = rawFiles.map((f) => f.path);
  const files = rawFiles.map((f) => parseSourceFile(f.path, f.content, allPaths));

  // Cross-reference function calls & calledBy across all files
  const fnMap = new Map<string, FunctionDef>();
  files.forEach((file) => {
    file.functions.forEach((fn) => {
      fnMap.set(`${file.path}::${fn.name}`, fn);
      if (!fnMap.has(fn.name)) {
        fnMap.set(fn.name, fn);
      }
    });
  });

  files.forEach((file) => {
    file.functions.forEach((fn) => {
      fn.calls.forEach((call) => {
        const target =
          fnMap.get(`${call.targetFile}::${call.calleeName}`) ||
          fnMap.get(call.calleeName);
        if (target) {
          call.targetFile = target.file;
          target.calledBy.push({
            callerName: fn.name,
            callerFile: file.path,
            line: call.line,
          });
        }
      });

      // Also update call nodes with accurate targetFile
      fn.nodes.forEach((node) => {
        if (node.kind === 'call' && node.callsTarget) {
          const target =
            fnMap.get(`${node.callsTarget.file}::${node.callsTarget.functionName}`) ||
            fnMap.get(node.callsTarget.functionName);
          if (target) {
            node.callsTarget.file = target.file;
            node.callsTarget.isExternalFile = target.file !== file.path;
            node.sublabel =
              target.file !== file.path
                ? `Cross-File Call → ${target.file.split('/').pop()}::${target.name}()`
                : `Call → ${target.name}() · Line ${node.location.startLine}`;
          }
        }
      });
    });
  });

  // Build Dependency Edges between files
  const dependencies: DependencyEdge[] = [];
  files.forEach((file) => {
    file.imports.forEach((imp, idx) => {
      const cleanImp = imp.replace(/^[./]+/, '').replace(/\./g, '/');
      const targetFile = files.find(
        (candidate) =>
          candidate.path !== file.path &&
          (candidate.path.includes(cleanImp) ||
            candidate.name.split('.')[0] === cleanImp.split('/').pop())
      );
      if (targetFile) {
        const edgeId = `dep::${file.path}::to::${targetFile.path}`;
        if (!dependencies.some((d) => d.id === edgeId)) {
          dependencies.push({
            id: edgeId,
            sourceFile: file.path,
            targetFile: targetFile.path,
            importedSymbols: [imp],
            line: idx + 1,
          });
        }
      }
    });
  });

  // Detect Entry Points automatically
  const entryPoints: EntryPoint[] = [];
  files.forEach((file) => {
    file.lines.forEach((line, idx) => {
      if (line.includes('if __name__ == "__main__"') || line.includes("if __name__ == '__main__'")) {
        const mainFn = file.functions.find((f) => f.name === 'main') || file.functions[0];
        if (mainFn) {
          entryPoints.push({
            id: `ep::${file.path}::${mainFn.name}`,
            file: file.path,
            functionName: mainFn.name,
            line: idx + 1,
            reason: 'Python __main__ guard detected',
          });
        }
      }
      if (line.includes('public static void main')) {
        entryPoints.push({
          id: `ep::${file.path}::main`,
          file: file.path,
          functionName: 'main',
          line: idx + 1,
          reason: 'Java static main() entry point',
        });
      }
    });

    file.functions.forEach((fn) => {
      if (
        (fn.name === 'main' || fn.name === 'startServer' || fn.name === 'handleRequest' || fn.name === 'runPipeline') &&
        !entryPoints.some((e) => e.file === file.path && e.functionName === fn.name)
      ) {
        entryPoints.push({
          id: `ep::${file.path}::${fn.name}`,
          file: file.path,
          functionName: fn.name,
          line: fn.startLine,
          reason: `Primary entry function ${fn.name}()`,
        });
      }
    });
  });

  if (entryPoints.length === 0 && files.length > 0 && files[0].functions.length > 0) {
    const firstFn = files[0].functions[0];
    entryPoints.push({
      id: `ep::${files[0].path}::${firstFn.name}`,
      file: files[0].path,
      functionName: firstFn.name,
      line: firstFn.startLine,
      reason: 'Default module entry function',
    });
  }

  const languages = Array.from(new Set(files.map((f) => f.language)));

  return {
    id,
    name,
    description,
    repoUrl,
    languages,
    files,
    dependencies,
    entryPoints,
    defaultInputs,
    presets,
  };
}

export function searchProject(project: ProjectModel, query: string): SearchResultItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: SearchResultItem[] = [];

  for (const file of project.files) {
    if (file.path.toLowerCase().includes(q)) {
      results.push({
        id: `search::file::${file.path}`,
        symbolName: file.name,
        kind: 'file',
        file: file.path,
        line: 1,
        calledBy: project.dependencies
          .filter((d) => d.targetFile === file.path)
          .map((d) => d.sourceFile),
        calls: project.dependencies
          .filter((d) => d.sourceFile === file.path)
          .map((d) => d.targetFile),
        snippet: `${file.language.toUpperCase()} · ${file.functions.length} functions`,
      });
    }

    for (const fn of file.functions) {
      if (fn.name.toLowerCase().includes(q)) {
        results.push({
          id: `search::fn::${fn.id}`,
          symbolName: `${fn.name}()`,
          kind: 'function',
          file: file.path,
          line: fn.startLine,
          nodeId: fn.nodes[0]?.id,
          functionName: fn.name,
          calledBy: fn.calledBy.map((c) => `${c.callerFile.split('/').pop()}:${c.line}`),
          calls: fn.calls.map((c) => `${c.calleeName}()`),
          snippet: file.lines[fn.startLine - 1]?.trim() || fn.summary,
        });
      }

      for (const node of fn.nodes) {
        if (
          node.kind !== 'function' &&
          node.kind !== 'end' &&
          (node.label.toLowerCase().includes(q) ||
            (node.expression && node.expression.toLowerCase().includes(q)))
        ) {
          results.push({
            id: `search::node::${node.id}`,
            symbolName: node.label,
            kind: node.kind === 'condition' ? 'condition' : 'variable',
            file: file.path,
            line: node.location.startLine,
            nodeId: node.id,
            functionName: fn.name,
            calledBy: [`${fn.name}()`],
            calls: node.callsTarget ? [`${node.callsTarget.functionName}()`] : [],
            snippet: node.location.codeSnippet.trim(),
          });
        }
      }
    }
  }

  const rankOrder: Record<SearchResultItem['kind'], number> = {
    function: 1,
    file: 2,
    class: 3,
    condition: 4,
    variable: 5,
  };

  return results
    .sort((a, b) => rankOrder[a.kind] - rankOrder[b.kind])
    .slice(0, 25);
}
