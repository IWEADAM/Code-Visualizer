/* ==========================================================================
   Code Visualizer — Standalone Frontend JavaScript (Pure Vanilla JS)
   No bundler, no TypeScript, no React required.
   Connects to the Python SQLite backend (app.py -> repos.db) on /api/*
   ========================================================================== */

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // 1. MULTI-LANGUAGE STATIC AST & CONTROL-FLOW GRAPH PARSER
  // --------------------------------------------------------------------------

  function detectLanguage(filePath) {
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    switch (ext) {
      case 'py':
        return { language: 'python', isFullySupported: true };
      case 'js':
      case 'jsx':
      case 'mjs':
        return { language: 'javascript', isFullySupported: true };
      case 'ts':
      case 'tsx':
        return { language: 'typescript', isFullySupported: true };
      case 'java':
        return { language: 'java', isFullySupported: true };
      case 'c':
        return { language: 'c', isFullySupported: true };
      case 'cpp':
      case 'cc':
      case 'hpp':
      case 'h':
        return { language: 'cpp', isFullySupported: true };
      case 'rs':
        return { language: 'rust', isFullySupported: true };
      case 'go':
        return { language: 'go', isFullySupported: true };
      case 'php':
        return { language: 'php', isFullySupported: true };
      case 'cs':
        return { language: 'csharp', isFullySupported: true };
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

  function extractIdentifiers(expr) {
    const keywords = new Set([
      'if', 'else', 'elif', 'for', 'while', 'in', 'range', 'return', 'def',
      'function', 'const', 'let', 'var', 'true', 'false', 'True', 'False',
      'None', 'null', 'undefined', 'and', 'or', 'not', 'print', 'console',
      'log', 'new', 'throw', 'raise', 'try', 'catch', 'except', 'class',
      'int', 'str', 'float', 'bool', 'void', 'pub', 'fn', 'func', 'len',
      'ConnectionError', 'ValueError', 'Error'
    ]);
    const matches = String(expr || '').match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
    return Array.from(new Set(matches.filter((m) => !keywords.has(m))));
  }

  function buildFunctionControlFlow(filePath, fnName, params, startLine, endLine, allLines, language, allProjectFiles) {
    const nodes = [];
    const edges = [];

    const startNodeId = `${filePath}::${fnName}::start`;
    const endNodeId = `${filePath}::${fnName}::end`;

    nodes.push({
      id: startNodeId,
      label: `${fnName}(${params.join(', ')})`,
      kind: 'function',
      file: filePath,
      functionName: fnName,
      location: { file: filePath, startLine, endLine: startLine },
      codeSnippet: (allLines[startLine - 1] || '').trim(),
      description: `Entry of function ${fnName} accepting (${params.join(', ') || 'no args'})`,
      variablesRead: [],
      variablesWritten: params.slice(),
      provenance: 'static_proven',
    });

    let activePredecessors = [{ id: startNodeId, indent: -1, branchType: 'normal' }];
    const conditionStack = [];
    const loopStack = [];

    for (let lineIdx = startLine; lineIdx < endLine; lineIdx++) {
      const rawLine = allLines[lineIdx] || '';
      const trimmed = rawLine.trim();
      const lineNum = lineIdx + 1;

      if (
        !trimmed ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*') ||
        trimmed === '{' ||
        trimmed === '}' ||
        trimmed.startsWith('"""') ||
        trimmed.startsWith("'''")
      ) {
        continue;
      }

      const indent = rawLine.search(/\S|$/);

      while (loopStack.length > 0 && indent <= loopStack[loopStack.length - 1].indent) {
        const finishedLoop = loopStack.pop();
        activePredecessors.forEach((pred) => {
          edges.push({
            id: `e_${pred.id}_to_${finishedLoop.id}_back`,
            source: pred.id,
            target: finishedLoop.id,
            label: 'next iter',
            branchType: 'loop_back',
          });
        });
        activePredecessors = [
          { id: finishedLoop.id, indent: finishedLoop.indent, branchType: 'normal', label: 'loop done' },
        ];
      }

      const isElseOrElif = /^(else\b|elif\b|\}\s*else\b)/.test(trimmed);
      if (!isElseOrElif) {
        while (conditionStack.length > 0 && indent <= conditionStack[conditionStack.length - 1].indent) {
          const closedCond = conditionStack.pop();
          if (!closedCond.hasElse) {
            activePredecessors.push({
              id: closedCond.id,
              indent: closedCond.indent,
              branchType: 'false',
              label: 'FALSE',
            });
          }
        }
      }

      if (/^else\s*:?$|^\}\s*else\s*\{?$/.test(trimmed)) {
        const topCond = conditionStack[conditionStack.length - 1];
        if (topCond) {
          topCond.hasElse = true;
          topCond.trueBranchExitIds.push(...activePredecessors.map((p) => p.id));
          activePredecessors = [
            { id: topCond.id, indent: topCond.indent, branchType: 'false', label: 'FALSE' },
          ];
        }
        continue;
      }

      const nodeId = `${filePath}::${fnName}::L${lineNum}`;
      let node = null;

      const ifMatch =
        trimmed.match(/^(?:if|elif|else\s+if)\s*\(?(.+?)\)?\s*[:{]?$/) ||
        trimmed.match(/^if\s+(.+?)\s*\{$/);
      const loopMatch = trimmed.match(/^(?:for|while)\s*\(?(.+?)\)?\s*[:{]?$/);
      const returnMatch = trimmed.match(/^return\b\s*(.*)$/);
      const throwMatch = trimmed.match(/^(?:raise|throw)\s+(?:new\s+)?([A-Za-z0-9_]+)\s*\((.*)\)/);

      if (ifMatch) {
        const condExpr = ifMatch[1].replace(/[:{]\s*$/, '').trim();
        node = {
          id: nodeId,
          label: `${condExpr} ?`,
          kind: 'condition',
          file: filePath,
          functionName: fnName,
          location: { file: filePath, startLine: lineNum, endLine: lineNum },
          codeSnippet: trimmed,
          description: `Evaluates condition (${condExpr}) and branches to TRUE or FALSE path`,
          expression: condExpr,
          variablesRead: extractIdentifiers(condExpr),
          variablesWritten: [],
          provenance: 'static_proven',
        };
      } else if (loopMatch) {
        const loopExpr = loopMatch[1].replace(/[:{]\s*$/, '').trim();
        node = {
          id: nodeId,
          label: `Loop: ${loopExpr}`,
          kind: 'loop',
          file: filePath,
          functionName: fnName,
          location: { file: filePath, startLine: lineNum, endLine: lineNum },
          codeSnippet: trimmed,
          description: `Repeats loop body while (${loopExpr}) holds`,
          expression: loopExpr,
          variablesRead: extractIdentifiers(loopExpr),
          variablesWritten: [loopExpr.split(/\s+/)[0] || 'i'],
          provenance: 'static_proven',
        };
      } else if (throwMatch) {
        const errType = throwMatch[1];
        const errMsg = throwMatch[2].replace(/['"]/g, '');
        node = {
          id: nodeId,
          label: `Raise ${errType}`,
          kind: 'exception',
          file: filePath,
          functionName: fnName,
          location: { file: filePath, startLine: lineNum, endLine: lineNum },
          codeSnippet: trimmed,
          description: `Raises ${errType}: ${errMsg}`,
          expression: errMsg,
          variablesRead: extractIdentifiers(errMsg),
          variablesWritten: [],
          provenance: 'static_proven',
        };
      } else if (returnMatch) {
        const retExpr = returnMatch[1].replace(/;$/, '').trim();
        const callInsideRet = retExpr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*)\)$/);
        let callTarget;
        if (callInsideRet) {
          const calledFn = callInsideRet[1];
          const argsList = callInsideRet[2].split(',').map((a) => a.trim()).filter(Boolean);
          const targetFile = allProjectFiles.find((p) => p !== filePath && p.includes(calledFn.split('_')[0]));
          callTarget = { functionName: calledFn, targetFile, arguments: argsList };
        }
        node = {
          id: nodeId,
          label: retExpr ? `return ${retExpr}` : 'return',
          kind: 'return',
          file: filePath,
          functionName: fnName,
          location: { file: filePath, startLine: lineNum, endLine: lineNum },
          codeSnippet: trimmed,
          description: `Returns ${retExpr || 'void'} to caller`,
          expression: retExpr,
          variablesRead: extractIdentifiers(retExpr),
          variablesWritten: [],
          callTarget,
          provenance: 'static_proven',
        };
      } else {
        const assignMatch = trimmed.match(/^(?:const|let|var|int|float|auto)?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*([+\-*/]?=)\s*(.+?);?$/);
        const callMatch = trimmed.match(/(?:=\s*)?([a-zA-Z_][a-zA-Z0-9_.]*)\s*\((.*)\)\s*;?$/);
        const isPrintOrOutput = /^(print|console\.log|fmt\.Println|System\.out\.println)\s*\(/.test(trimmed);

        if (isPrintOrOutput) {
          const inner = trimmed.replace(/^[^(]+\(|\)\s*;?$/g, '');
          node = {
            id: nodeId,
            label: `Output: ${trimmed.replace(/;$/, '')}`,
            kind: 'output',
            file: filePath,
            functionName: fnName,
            location: { file: filePath, startLine: lineNum, endLine: lineNum },
            codeSnippet: trimmed,
            description: `Outputs value of (${inner})`,
            expression: inner,
            variablesRead: extractIdentifiers(inner),
            variablesWritten: [],
            provenance: 'static_proven',
          };
        } else if (
          callMatch &&
          !['if', 'for', 'while', 'switch', 'return', 'range'].includes(callMatch[1])
        ) {
          const calleeFull = callMatch[1];
          const calleeSimple = calleeFull.split('.').pop() || calleeFull;
          const rawArgs = callMatch[2]
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean);
          const writtenVar = assignMatch ? [assignMatch[1]] : [];

          node = {
            id: nodeId,
            label: assignMatch
              ? `${assignMatch[1]} = ${calleeSimple}(${rawArgs.join(', ')})`
              : `${calleeSimple}(${rawArgs.join(', ')})`,
            kind: 'call',
            file: filePath,
            functionName: fnName,
            location: { file: filePath, startLine: lineNum, endLine: lineNum },
            codeSnippet: trimmed,
            description: `Calls function ${calleeSimple}(${rawArgs.join(', ')})`,
            expression: assignMatch ? assignMatch[3] : trimmed,
            variablesRead: extractIdentifiers(callMatch[2]),
            variablesWritten: writtenVar,
            callTarget: {
              functionName: calleeSimple,
              arguments: rawArgs,
            },
            provenance: 'static_proven',
          };
        } else if (assignMatch) {
          const lhs = assignMatch[1];
          const op = assignMatch[2];
          const rhs = assignMatch[3];
          node = {
            id: nodeId,
            label: `${lhs} ${op} ${rhs}`,
            kind: 'variable',
            file: filePath,
            functionName: fnName,
            location: { file: filePath, startLine: lineNum, endLine: lineNum },
            codeSnippet: trimmed,
            description: `Updates variable ${lhs} (${op} ${rhs})`,
            expression: op === '+=' ? `${lhs} + (${rhs})` : rhs,
            variablesRead: extractIdentifiers(rhs).concat(op !== '=' ? [lhs] : []),
            variablesWritten: [lhs],
            provenance: 'static_proven',
          };
        } else {
          node = {
            id: nodeId,
            label: trimmed.slice(0, 42),
            kind: 'statement',
            file: filePath,
            functionName: fnName,
            location: { file: filePath, startLine: lineNum, endLine: lineNum },
            codeSnippet: trimmed,
            description: `Executes statement on line ${lineNum}`,
            expression: trimmed,
            variablesRead: extractIdentifiers(trimmed),
            variablesWritten: [],
            provenance: 'static_proven',
          };
        }
      }

      nodes.push(node);

      activePredecessors.forEach((pred, idx) => {
        const edgeBranchType =
          pred.branchType !== 'normal'
            ? pred.branchType
            : node.kind === 'call'
              ? 'cross_file'
              : 'normal';
        edges.push({
          id: `e_${pred.id}_to_${node.id}_${idx}`,
          source: pred.id,
          target: node.id,
          label: pred.label,
          branchType: edgeBranchType,
        });
      });

      if (node.kind === 'condition') {
        conditionStack.push({
          id: node.id,
          indent,
          trueBranchExitIds: [],
          hasElse: false,
        });
        activePredecessors = [{ id: node.id, indent, branchType: 'true', label: 'TRUE' }];
      } else if (node.kind === 'loop') {
        loopStack.push({ id: node.id, indent });
        activePredecessors = [{ id: node.id, indent, branchType: 'loop_body', label: 'iter' }];
      } else if (node.kind === 'return' || node.kind === 'exception') {
        edges.push({
          id: `e_${node.id}_to_${endNodeId}`,
          source: node.id,
          target: endNodeId,
          label: node.kind === 'exception' ? 'raises' : 'returns',
          branchType: node.kind === 'exception' ? 'exception' : 'normal',
        });
        const activeCond = conditionStack[conditionStack.length - 1];
        if (activeCond && !activeCond.hasElse) {
          activePredecessors = [];
        } else {
          activePredecessors = [];
        }
      } else {
        activePredecessors = [{ id: node.id, indent, branchType: 'normal' }];
      }
    }

    while (loopStack.length > 0) {
      const finishedLoop = loopStack.pop();
      activePredecessors.forEach((pred) => {
        edges.push({
          id: `e_${pred.id}_to_${finishedLoop.id}_back`,
          source: pred.id,
          target: finishedLoop.id,
          label: 'next iter',
          branchType: 'loop_back',
        });
      });
      activePredecessors = [{ id: finishedLoop.id, indent: finishedLoop.indent, branchType: 'normal' }];
    }

    while (conditionStack.length > 0) {
      const closedCond = conditionStack.pop();
      closedCond.trueBranchExitIds.forEach((exitId) => {
        const exitNode = nodes.find((n) => n.id === exitId);
        if (exitNode && exitNode.kind !== 'return' && exitNode.kind !== 'exception') {
          activePredecessors.push({ id: exitId, indent: closedCond.indent, branchType: 'normal' });
        }
      });
      if (!closedCond.hasElse) {
        activePredecessors.push({
          id: closedCond.id,
          indent: closedCond.indent,
          branchType: 'false',
          label: 'FALSE',
        });
      }
    }

    nodes.push({
      id: endNodeId,
      label: 'END',
      kind: 'end',
      file: filePath,
      functionName: fnName,
      location: { file: filePath, startLine: endLine, endLine },
      codeSnippet: '',
      description: `Completion of ${fnName}()`,
      variablesRead: [],
      variablesWritten: [],
      provenance: 'static_proven',
    });

    activePredecessors.forEach((pred, idx) => {
      const alreadyConnected = edges.some((e) => e.source === pred.id && e.target === endNodeId);
      if (!alreadyConnected) {
        edges.push({
          id: `e_${pred.id}_to_${endNodeId}_${idx}`,
          source: pred.id,
          target: endNodeId,
          label: pred.label,
          branchType: pred.branchType,
        });
      }
    });

    return { nodes, edges };
  }

  function parseSourceFile(filePath, content, allProjectFiles) {
    const { language, isFullySupported } = detectLanguage(filePath);
    const parts = filePath.split('/');
    const fileName = parts[parts.length - 1] || filePath;
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '/';
    const lines = content.split(/\r?\n/);

    const imports = [];
    const exportsList = [];
    const classes = [];
    const rawFunctions = [];

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      const lineNum = idx + 1;
      const indent = line.search(/\S|$/);

      const pyFromImport = trimmed.match(/^from\s+([a-zA-Z0-9_.]+)\s+import\s+(.+)$/);
      const pyImport = trimmed.match(/^import\s+([a-zA-Z0-9_.,\s]+)$/);
      const jsImport = trimmed.match(/^import\s+.*?\s+from\s+['"](.+?)['"]/);

      if (pyFromImport) {
        imports.push(pyFromImport[1]);
      } else if (pyImport) {
        imports.push(pyImport[1].trim());
      } else if (jsImport) {
        imports.push(jsImport[1]);
      }

      const classMatch = trimmed.match(/^(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (classMatch) {
        classes.push({
          id: `${filePath}::class::${classMatch[1]}`,
          name: classMatch[1],
          file: filePath,
          startLine: lineNum,
          endLine: Math.min(lines.length, lineNum + 25),
          methods: [],
        });
      }

      const pyDef = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*[^:]+)?:/);
      const jsFn = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/);
      const arrowFn = trimmed.match(/^(?:export\s+)?(?:const|let)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*[^=]+)?=>/);
      const cStyleFn =
        !trimmed.startsWith('if') &&
        !trimmed.startsWith('for') &&
        !trimmed.startsWith('while') &&
        trimmed.match(/^(?:public\s+|private\s+|static\s+|fn\s+|func\s+)*(?:[a-zA-Z0-9_<>[\]]+\s+)+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)\s*\{?$/);

      const matched = pyDef || jsFn || arrowFn || cStyleFn;
      if (matched) {
        const fnName = matched[1];
        const paramStr = matched[2] || '';
        const params = paramStr
          .split(',')
          .map((p) => p.trim().split(/[:=]/)[0].trim().split(/\s+/).pop() || '')
          .filter(Boolean);
        rawFunctions.push({ name: fnName, params, startLine: lineNum, indent });
        exportsList.push(fnName);
      }
    });

    const functions = [];

    if (rawFunctions.length === 0 && isFullySupported && lines.length > 0) {
      const cfg = buildFunctionControlFlow(filePath, 'module_entry', [], 1, lines.length, lines, language, allProjectFiles);
      functions.push({
        id: `${filePath}::module_entry`,
        name: 'module_entry',
        file: filePath,
        parameters: [],
        startLine: 1,
        endLine: lines.length,
        summary: `Top-level script execution in ${fileName}`,
        nodes: cfg.nodes,
        edges: cfg.edges,
        calls: [],
        calledBy: [],
      });
    } else {
      rawFunctions.forEach((fnMeta, idx) => {
        const nextFn = rawFunctions[idx + 1];
        const endLine = nextFn ? nextFn.startLine - 1 : lines.length;
        const cfg = buildFunctionControlFlow(
          filePath,
          fnMeta.name,
          fnMeta.params,
          fnMeta.startLine,
          endLine,
          lines,
          language,
          allProjectFiles
        );

        const calls = cfg.nodes
          .filter((n) => n.callTarget)
          .map((n) => n.callTarget.functionName);

        functions.push({
          id: `${filePath}::${fnMeta.name}`,
          name: fnMeta.name,
          file: filePath,
          parameters: fnMeta.params,
          startLine: fnMeta.startLine,
          endLine,
          summary: `Function ${fnMeta.name}(${fnMeta.params.join(', ')}) spanning lines ${fnMeta.startLine}–${endLine}`,
          nodes: cfg.nodes,
          edges: cfg.edges,
          calls,
          calledBy: [],
        });
      });
    }

    return {
      path: filePath,
      name: fileName,
      folder,
      language,
      isFullySupported,
      content,
      summary: `${fileName} (${language.toUpperCase()}) — ${functions.length} function(s), ${imports.length} import(s)`,
      imports,
      exports: exportsList,
      functions,
      classes,
    };
  }

  function buildProjectModel(id, name, description, rawFiles, defaultInputs, presets, repoUrl) {
    const filePaths = rawFiles.map((f) => f.path);
    const parsedFiles = rawFiles.map((f) => parseSourceFile(f.path, f.content, filePaths));

    const functionMap = new Map();
    parsedFiles.forEach((file) => {
      file.functions.forEach((fn) => {
        functionMap.set(fn.name, { file: file.path, fn });
      });
    });

    const dependencies = [];

    parsedFiles.forEach((file) => {
      file.imports.forEach((imp) => {
        const normalized = imp.replace(/^[./]+/, '').replace(/\./g, '/');
        const target = parsedFiles.find(
          (cand) =>
            cand.path !== file.path &&
            (cand.path.includes(normalized) ||
              cand.name.replace(/\.\w+$/, '') === normalized.split('/').pop())
        );
        if (target) {
          dependencies.push({
            id: `dep_${file.path}_to_${target.path}`,
            sourceFile: file.path,
            targetFile: target.path,
            symbols: [imp],
            type: 'import',
          });
        }
      });

      file.functions.forEach((fn) => {
        fn.nodes.forEach((node) => {
          if (node.callTarget) {
            const targetEntry = functionMap.get(node.callTarget.functionName);
            if (targetEntry) {
              node.callTarget.targetFile = targetEntry.file;
              node.callTarget.targetNodeId = targetEntry.fn.nodes[0]?.id;
              if (!targetEntry.fn.calledBy.includes(`${file.path}:${fn.name}`)) {
                targetEntry.fn.calledBy.push(`${file.path}:${fn.name}`);
              }
              if (targetEntry.file !== file.path) {
                const existingDep = dependencies.find(
                  (d) => d.sourceFile === file.path && d.targetFile === targetEntry.file
                );
                if (existingDep) {
                  if (!existingDep.symbols.includes(node.callTarget.functionName)) {
                    existingDep.symbols.push(node.callTarget.functionName);
                  }
                } else {
                  dependencies.push({
                    id: `call_${file.path}_to_${targetEntry.file}`,
                    sourceFile: file.path,
                    targetFile: targetEntry.file,
                    symbols: [node.callTarget.functionName],
                    type: 'call',
                  });
                }
              }
            }
          }
        });
      });
    });

    const entryPoints = [];
    parsedFiles.forEach((file) => {
      file.functions.forEach((fn) => {
        if (
          ['main', 'app', 'start', 'index', 'handler', 'run', 'process_request'].includes(
            fn.name.toLowerCase()
          ) ||
          file.name.startsWith('main.') ||
          file.name.startsWith('index.') ||
          file.name.startsWith('app.')
        ) {
          entryPoints.push({
            id: `${file.path}::${fn.name}`,
            label: `${file.path} → ${fn.name}()`,
            file: file.path,
            functionName: fn.name,
            reason:
              fn.name.toLowerCase() === 'main'
                ? 'Primary main() entry point function'
                : `Entry module ${file.name} (${fn.name})`,
          });
        }
      });
    });

    if (entryPoints.length === 0 && parsedFiles[0]?.functions[0]) {
      const f0 = parsedFiles[0];
      const fn0 = f0.functions[0];
      entryPoints.push({
        id: `${f0.path}::${fn0.name}`,
        label: `${f0.path} → ${fn0.name}()`,
        file: f0.path,
        functionName: fn0.name,
        reason: 'Default first discovered function',
      });
    }

    return {
      id,
      name,
      description,
      repoUrl,
      files: parsedFiles,
      entryPoints,
      dependencies,
      defaultInputs: defaultInputs || { x: 15 },
      presets: presets || [],
    };
  }

  function searchProject(project, queryStr) {
    const q = String(queryStr || '').trim().toLowerCase();
    if (!q) return [];

    const results = [];

    project.files.forEach((file) => {
      if (file.path.toLowerCase().includes(q)) {
        results.push({
          id: `file::${file.path}`,
          symbolName: file.name,
          kind: 'file',
          file: file.path,
          line: 1,
          calledBy: file.functions.flatMap((f) => f.calledBy),
          calls: file.functions.flatMap((f) => f.calls),
        });
      }

      file.functions.forEach((fn) => {
        if (fn.name.toLowerCase().includes(q)) {
          results.push({
            id: fn.id,
            symbolName: `${fn.name}()`,
            kind: 'function',
            file: file.path,
            functionName: fn.name,
            line: fn.startLine,
            nodeId: fn.nodes[0]?.id,
            calledBy: fn.calledBy,
            calls: fn.calls,
          });
        }

        fn.nodes.forEach((node) => {
          if (
            node.kind !== 'function' &&
            node.kind !== 'start' &&
            node.kind !== 'end' &&
            node.label.toLowerCase().includes(q)
          ) {
            results.push({
              id: node.id,
              symbolName: node.label,
              kind: node.kind,
              file: file.path,
              functionName: fn.name,
              line: node.location.startLine,
              nodeId: node.id,
              calledBy: fn.calledBy,
              calls: node.callTarget ? [node.callTarget.functionName] : [],
            });
          }
        });
      });
    });

    return results.slice(0, 25);
  }

  // --------------------------------------------------------------------------
  // 2. DETERMINISTIC SANDBOXED EXECUTION TRACER
  // --------------------------------------------------------------------------

  function evaluateSandboxExpression(expr, env) {
    const cleaned = String(expr || '').trim();
    if (!cleaned) return undefined;

    if (cleaned === 'True' || cleaned === 'true') return true;
    if (cleaned === 'False' || cleaned === 'false') return false;
    if (cleaned === 'None' || cleaned === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(cleaned)) return Number(cleaned);
    if (/^['"](.*)['"]$/.test(cleaned)) return cleaned.slice(1, -1);

    if (Object.prototype.hasOwnProperty.call(env, cleaned)) {
      return env[cleaned];
    }

    try {
      const jsExpr = cleaned
        .replace(/\bTrue\b/g, 'true')
        .replace(/\bFalse\b/g, 'false')
        .replace(/\bNone\b/g, 'null')
        .replace(/\band\b/g, '&&')
        .replace(/\bor\b/g, '||')
        .replace(/\bnot\s+/g, '!');

      const keys = Object.keys(env);
      const values = keys.map((k) => env[k]);
      const fn = new Function(...keys, `return (${jsExpr});`);
      return fn(...values);
    } catch {
      return undefined;
    }
  }

  function traceProgramExecution(project, customInputs, entryPointId) {
    const entry =
      project.entryPoints.find((e) => e.id === entryPointId) || project.entryPoints[0];

    const inputs = { ...(project.defaultInputs || {}), ...(customInputs || {}) };
    const env = { ...inputs };
    const steps = [];
    const visitedNodeIds = [];
    const visitedEdgeIds = [];
    const loopCounts = {};
    let finalOutput;
    let runtimeError;

    if (!entry) {
      return {
        entryPointId: '',
        inputs,
        steps,
        visitedNodeIds,
        visitedEdgeIds,
        loopCounts,
        executionMode: 'sandboxed_interpreter',
      };
    }

    let stepCounter = 0;
    const MAX_STEPS = 80;

    function executeFunction(filePath, fnName, callArgs) {
      if (stepCounter >= MAX_STEPS || runtimeError) return undefined;

      const file = project.files.find((f) => f.path === filePath);
      const fn = file?.functions.find((item) => item.name === fnName) || file?.functions[0];
      if (!file || !fn) return undefined;

      if (callArgs) {
        Object.assign(env, callArgs);
      }

      let currentNode = fn.nodes[0];
      let returnVal;

      while (currentNode && stepCounter < MAX_STEPS && !runtimeError) {
        const activeNode = currentNode;
        visitedNodeIds.push(activeNode.id);

        let branchDecision;
        let stepExplanation = activeNode.description;

        if (activeNode.kind === 'function') {
          fn.parameters.forEach((param) => {
            if (env[param] === undefined && inputs[param] !== undefined) {
              env[param] = inputs[param];
            }
          });
          stepExplanation = `Entered ${fn.name}() in ${file.path} with ${
            fn.parameters.map((p) => `${p}=${JSON.stringify(env[p])}`).join(', ') || 'current scope'
          }`;
        } else if (activeNode.kind === 'condition' && activeNode.expression) {
          const condResult = Boolean(evaluateSandboxExpression(activeNode.expression, env));
          branchDecision = condResult ? 'TRUE' : 'FALSE';
          stepExplanation = `Condition (${activeNode.expression}) evaluated to ${branchDecision}`;
        } else if (activeNode.kind === 'loop' && activeNode.expression) {
          loopCounts[activeNode.id] = (loopCounts[activeNode.id] || 0) + 1;
          const iter = loopCounts[activeNode.id];
          const rangeMatch = activeNode.expression.match(/([a-zA-Z_]\w*)\s+in\s+range\((\d+)\)/);
          const maxIter = rangeMatch ? Math.min(Number(rangeMatch[2]), 5) : 3;
          if (rangeMatch) {
            env[rangeMatch[1]] = iter - 1;
          }
          branchDecision = iter <= maxIter ? 'TRUE' : 'FALSE';
          stepExplanation =
            branchDecision === 'TRUE'
              ? `Loop iteration #${iter} of (${activeNode.expression})`
              : `Loop (${activeNode.expression}) completed after ${iter - 1} iterations`;
        } else if (activeNode.kind === 'variable' && activeNode.variablesWritten[0]) {
          const targetVar = activeNode.variablesWritten[0];
          const val = evaluateSandboxExpression(activeNode.expression || '', env);
          if (val !== undefined) {
            env[targetVar] = val;
          }
          stepExplanation = `Assigned ${targetVar} = ${JSON.stringify(env[targetVar])}`;
        } else if (activeNode.kind === 'call' && activeNode.callTarget) {
          const calleeName = activeNode.callTarget.functionName;
          const targetFile = activeNode.callTarget.targetFile || file.path;

          steps.push({
            stepIndex: stepCounter++,
            nodeId: activeNode.id,
            file: file.path,
            functionName: fn.name,
            line: activeNode.location.startLine,
            label: activeNode.label,
            kind: activeNode.kind,
            variables: { ...env },
            explanation: `Invoking ${calleeName}() ${
              targetFile !== file.path ? `across file boundary → ${targetFile}` : ''
            }`,
            provenance: 'runtime_observed',
          });

          const targetFileObj = project.files.find((f) => f.path === targetFile);
          const targetFnObj = targetFileObj?.functions.find((fItem) => fItem.name === calleeName);
          const boundArgs = {};
          if (targetFnObj && activeNode.callTarget.arguments.length > 0) {
            targetFnObj.parameters.forEach((paramName, pIdx) => {
              const rawArgExpr = activeNode.callTarget?.arguments[pIdx];
              if (rawArgExpr) {
                const evaluatedArg = evaluateSandboxExpression(rawArgExpr, env);
                if (evaluatedArg !== undefined) {
                  boundArgs[paramName] = evaluatedArg;
                }
              }
            });
          }

          const callResult = executeFunction(targetFile, calleeName, boundArgs);
          if (activeNode.variablesWritten[0] && callResult !== undefined) {
            env[activeNode.variablesWritten[0]] = callResult;
          }
          stepExplanation = `Returned from ${calleeName}() with ${JSON.stringify(callResult)}`;
        } else if (activeNode.kind === 'exception') {
          const errType = activeNode.label.replace(/^Raise\s+/, '');
          const errMsg = activeNode.expression || 'Runtime exception triggered';
          runtimeError = {
            type: errType,
            message: errMsg,
            file: file.path,
            line: activeNode.location.startLine,
            nodeId: activeNode.id,
          };
          steps.push({
            stepIndex: stepCounter++,
            nodeId: activeNode.id,
            file: file.path,
            functionName: fn.name,
            line: activeNode.location.startLine,
            label: activeNode.label,
            kind: activeNode.kind,
            variables: { ...env },
            explanation: `Exception Thrown: ${errType} — ${errMsg}`,
            error: `${errType}: ${errMsg}`,
            provenance: 'runtime_observed',
          });
          break;
        } else if (activeNode.kind === 'return') {
          if (activeNode.callTarget) {
            const targetFileObj = project.files.find(
              (f) => f.path === (activeNode.callTarget?.targetFile || file.path)
            );
            const targetFnObj = targetFileObj?.functions.find(
              (fItem) => fItem.name === activeNode.callTarget?.functionName
            );
            const boundArgs = {};
            if (targetFnObj && activeNode.callTarget.arguments.length > 0) {
              targetFnObj.parameters.forEach((paramName, pIdx) => {
                const rawArgExpr = activeNode.callTarget?.arguments[pIdx];
                if (rawArgExpr) {
                  const evaluatedArg = evaluateSandboxExpression(rawArgExpr, env);
                  if (evaluatedArg !== undefined) {
                    boundArgs[paramName] = evaluatedArg;
                  }
                }
              });
            }
            returnVal = executeFunction(
              activeNode.callTarget.targetFile || file.path,
              activeNode.callTarget.functionName,
              boundArgs
            );
          } else if (activeNode.expression) {
            returnVal = evaluateSandboxExpression(activeNode.expression, env);
          }
          finalOutput = returnVal;
          stepExplanation = `Returning ${JSON.stringify(returnVal)} from ${fn.name}()`;
        } else if (activeNode.kind === 'output' && activeNode.expression) {
          const outVal = evaluateSandboxExpression(activeNode.expression, env);
          if (outVal !== undefined) {
            finalOutput = outVal;
          }
          stepExplanation = `Program output: ${JSON.stringify(outVal ?? activeNode.expression)}`;
        }

        steps.push({
          stepIndex: stepCounter++,
          nodeId: activeNode.id,
          file: file.path,
          functionName: fn.name,
          line: activeNode.location.startLine,
          label: activeNode.label,
          kind: activeNode.kind,
          variables: { ...env },
          branchDecision,
          returnValue: returnVal,
          explanation: stepExplanation,
          provenance: 'runtime_observed',
        });

        if (activeNode.kind === 'end' || activeNode.kind === 'return') {
          break;
        }

        const outgoing = fn.edges.filter((e) => e.source === activeNode.id);
        let chosenEdge;

        if (activeNode.kind === 'condition') {
          chosenEdge = outgoing.find(
            (e) => e.branchType === (branchDecision === 'TRUE' ? 'true' : 'false')
          );
        } else if (activeNode.kind === 'loop') {
          chosenEdge = outgoing.find(
            (e) => e.branchType === (branchDecision === 'TRUE' ? 'loop_body' : 'normal')
          );
        } else {
          chosenEdge =
            outgoing.find((e) => e.branchType === 'loop_back') ||
            outgoing.find((e) => e.branchType === 'normal' || e.branchType === 'cross_file') ||
            outgoing[0];
        }

        if (!chosenEdge) break;
        visitedEdgeIds.push(chosenEdge.id);
        currentNode = fn.nodes.find((n) => n.id === chosenEdge.target);
      }

      return returnVal;
    }

    executeFunction(entry.file, entry.functionName);

    return {
      entryPointId: entry.id,
      inputs,
      steps,
      visitedNodeIds,
      visitedEdgeIds,
      loopCounts,
      finalOutput,
      error: runtimeError,
      executionMode: 'sandboxed_interpreter',
    };
  }

  // Export pure logic if running under Node.js unit test runner
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      detectLanguage,
      parseSourceFile,
      buildProjectModel,
      searchProject,
      evaluateSandboxExpression,
      traceProgramExecution,
    };
  }

  // Stop here if not in a browser DOM environment
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  // --------------------------------------------------------------------------
  // 3. BROWSER UI & DATABASE HISTORY CONTROLLER
  // --------------------------------------------------------------------------

  const LOCAL_STORAGE_KEY = 'code_visualizer_repo_history_v1';

  const state = {
    project: null,
    activeFilePath: '',
    activeFunctionName: '',
    selectedNode: null,
    viewMode: 'flow', // 'flow' | 'architecture' | 'dependencies' | 'trace' | 'history'
    selectedEntryPointId: '',
    customInputs: {},
    currentStepIndex: 0,
    isPlaying: false,
    playTimer: null,
    searchQuery: '',
    isImportModalOpen: true,
    expandedFolders: { src: true, config: true, tests: true, '/': true },
    collapsedNodes: new Set(),
    kindFilter: 'all',
    zoom: 0.88,
    pan: { x: 20, y: 16 },
    isDraggingCanvas: false,
    dragOrigin: { x: 0, y: 0 },
    rightTab: 'code', // 'code' | 'inspector' | 'simulator' | 'chat'
    aiExplanations: {},
    isGeneratingAI: false,
    aiError: null,
    chatMessages: [
      {
        role: 'assistant',
        text: 'Ask me anything about this repository — e.g. "Where does authentication happen?", "What happens when x <= 10?", or "Which functions call calculate()?"',
      },
    ],
    isChatLoading: false,
    savedRepos: [],
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function readLocalHistoryFallback() {
    try {
      const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeLocalHistoryFallback(repos) {
    try {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(repos.slice(0, 50)));
    } catch {
      // Ignore quota errors
    }
  }

  async function fetchSavedHistory() {
    try {
      const res = await fetch('/api/history');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.repos)) {
          state.savedRepos = data.repos;
          writeLocalHistoryFallback(state.savedRepos);
          renderHistoryUI();
          return;
        }
      }
    } catch {
      // Fallback to localStorage if opened directly via file:// without Python server
    }
    state.savedRepos = readLocalHistoryFallback();
    renderHistoryUI();
  }

  async function persistProjectToDatabase(recordInput) {
    try {
      const res = await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recordInput),
      });
      if (res.ok) {
        await fetchSavedHistory();
        return;
      }
    } catch {
      // Offline / file:// fallback
    }
    const existing = readLocalHistoryFallback();
    const nowIso = new Date().toISOString();
    const newEntry = {
      id: recordInput.id || `repo-${Date.now()}`,
      name: recordInput.name || 'saved-repo',
      description: recordInput.description || '',
      repoUrl: recordInput.repoUrl || '',
      language: detectLanguage((recordInput.files?.[0]?.path) || 'main.py').language,
      fileCount: (recordInput.files || []).length,
      files: recordInput.files || [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const filtered = existing.filter(
      (r) => r.id !== newEntry.id && r.name.toLowerCase() !== newEntry.name.toLowerCase()
    );
    filtered.unshift(newEntry);
    state.savedRepos = filtered;
    writeLocalHistoryFallback(filtered);
    renderHistoryUI();
  }

  async function deleteRepoFromHistory(repoId) {
    try {
      await fetch(`/api/history/${encodeURIComponent(repoId)}`, { method: 'DELETE' });
    } catch {
      // Offline fallback
    }
    state.savedRepos = state.savedRepos.filter((r) => r.id !== repoId);
    writeLocalHistoryFallback(state.savedRepos);
    await fetchSavedHistory();
  }

  function getActiveFile() {
    if (!state.project || !state.project.files.length) return null;
    return (
      state.project.files.find((f) => f.path === state.activeFilePath) || state.project.files[0]
    );
  }

  function getActiveFunction() {
    const file = getActiveFile();
    if (!file) return null;
    return (
      file.functions.find((fn) => fn.name === state.activeFunctionName) ||
      file.functions[0] ||
      null
    );
  }

  function getTraceResult() {
    if (!state.project) {
      return {
        entryPointId: '',
        inputs: {},
        steps: [],
        visitedNodeIds: [],
        visitedEdgeIds: [],
        loopCounts: {},
        executionMode: 'sandboxed_interpreter',
      };
    }
    return traceProgramExecution(state.project, state.customInputs, state.selectedEntryPointId);
  }

  function loadSavedRecordIntoVisualizer(record) {
    if (!record || !Array.isArray(record.files) || record.files.length === 0) return;
    const built = buildProjectModel(
      record.id || `saved-${Date.now()}`,
      record.name || 'saved-repo',
      record.description || 'Loaded from saved repository history.',
      record.files,
      {},
      [],
      record.repoUrl || undefined
    );
    selectProject(built, false);
    closeImportModal();
    if (state.viewMode === 'history') {
      setViewMode('flow');
    } else {
      renderAll();
    }
  }

  function selectProject(nextProj, shouldSaveToDb = true, rawFilesForDb = null) {
    stopPlayTimer();
    state.project = nextProj;
    const firstFile = nextProj.files[0];
    state.activeFilePath = firstFile ? firstFile.path : '';
    const firstFn = firstFile && firstFile.functions[0];
    state.activeFunctionName = firstFn ? firstFn.name : '';
    state.selectedNode = firstFn && firstFn.nodes[0] ? firstFn.nodes[0] : null;
    state.selectedEntryPointId = nextProj.entryPoints[0] ? nextProj.entryPoints[0].id : '';
    state.customInputs = { ...(nextProj.defaultInputs || {}) };
    state.currentStepIndex = 0;
    state.collapsedNodes.clear();

    if (shouldSaveToDb) {
      const filesToSave =
        rawFilesForDb ||
        nextProj.files.map((f) => ({
          path: f.path,
          content: f.content,
        }));
      persistProjectToDatabase({
        id: nextProj.id,
        name: nextProj.name,
        description: nextProj.description,
        repoUrl: nextProj.repoUrl || '',
        files: filesToSave,
      });
    }

    renderAll();
  }

  function openImportModalWithFade() {
    state.isImportModalOpen = true;
    const modal = document.getElementById('import-modal');
    const card = document.getElementById('import-modal-card');
    if (modal && card) {
      modal.classList.remove('hidden');
      card.classList.remove('animate-fade-in');
      void card.offsetWidth;
      card.classList.add('animate-fade-in');
    }
    renderImportModalState();
    renderHistoryUI();
  }

  function closeImportModal() {
    state.isImportModalOpen = false;
    const modal = document.getElementById('import-modal');
    if (modal) {
      modal.classList.add('hidden');
    }
    renderImportModalState();
  }

  function setViewMode(mode) {
    state.viewMode = mode;
    renderAll();
  }

  function stopPlayTimer() {
    state.isPlaying = false;
    if (state.playTimer) {
      window.clearInterval(state.playTimer);
      state.playTimer = null;
    }
  }

  function togglePlayTrace() {
    if (!state.project) return;
    if (state.isPlaying) {
      stopPlayTimer();
      renderDebuggerBar();
      return;
    }
    const trace = getTraceResult();
    if (state.currentStepIndex >= trace.steps.length - 1) {
      state.currentStepIndex = 0;
    }
    state.isPlaying = true;
    renderDebuggerBar();
    state.playTimer = window.setInterval(() => {
      const currentTrace = getTraceResult();
      if (state.currentStepIndex >= currentTrace.steps.length - 1) {
        stopPlayTimer();
        renderAll();
        return;
      }
      stepToIndex(state.currentStepIndex + 1, false);
    }, 650);
  }

  function stepToIndex(stepIdx, stopPlaying = true) {
    if (!state.project) return;
    if (stopPlaying) stopPlayTimer();
    const trace = getTraceResult();
    const clamped = Math.max(0, Math.min(trace.steps.length - 1, stepIdx));
    state.currentStepIndex = clamped;
    const step = trace.steps[clamped];
    if (step) {
      state.activeFilePath = step.file;
      state.activeFunctionName = step.functionName;
      const fileObj = state.project.files.find((f) => f.path === step.file);
      const fnObj = fileObj && fileObj.functions.find((fn) => fn.name === step.functionName);
      const nodeObj = fnObj && fnObj.nodes.find((n) => n.id === step.nodeId);
      if (nodeObj) state.selectedNode = nodeObj;
    }
    renderAll();
  }

  function navigateToFileFunction(filePath, functionName) {
    if (!state.project) return;
    const targetFile = state.project.files.find((f) => f.path === filePath);
    if (!targetFile) return;
    state.activeFilePath = targetFile.path;
    const targetFn =
      (functionName && targetFile.functions.find((fn) => fn.name === functionName)) ||
      targetFile.functions[0];
    if (targetFn) {
      state.activeFunctionName = targetFn.name;
      state.selectedNode = targetFn.nodes[0] || null;
    }
    renderAll();
  }

  function selectNodeByLine(line) {
    const file = getActiveFile();
    if (!file) return;
    const activeFn = getActiveFunction();
    const fnForLine =
      file.functions.find((fn) => line >= fn.startLine && line <= fn.endLine) || activeFn;
    if (!fnForLine) return;

    state.activeFunctionName = fnForLine.name;
    const matchedNode =
      fnForLine.nodes.find(
        (n) =>
          n.kind !== 'function' &&
          line >= n.location.startLine &&
          line <= n.location.endLine
      ) || fnForLine.nodes[0];

    if (matchedNode) {
      state.selectedNode = matchedNode;
    }
    renderAll();
  }

  function renderWorkspaceVisibility() {
    const emptyEl = document.getElementById('empty-workspace');
    const historyEl = document.getElementById('history-workspace');
    const activeEl = document.getElementById('active-workspace');

    document.querySelectorAll('.nav-view-btn').forEach((btn) => {
      const view = btn.getAttribute('data-nav-view');
      if (view === state.viewMode) {
        btn.classList.add('text-white', 'underline', 'underline-offset-4');
      } else {
        btn.classList.remove('text-white', 'underline', 'underline-offset-4');
      }
    });

    if (state.viewMode === 'history') {
      emptyEl?.classList.add('hidden');
      activeEl?.classList.add('hidden');
      historyEl?.classList.remove('hidden');
      return;
    }

    historyEl?.classList.add('hidden');
    if (state.project && getActiveFile()) {
      emptyEl?.classList.add('hidden');
      activeEl?.classList.remove('hidden');
    } else {
      activeEl?.classList.add('hidden');
      emptyEl?.classList.remove('hidden');
    }
  }

  function renderImportModalState() {
    const closeBtn = document.getElementById('close-import-modal-btn');
    if (closeBtn) {
      if (state.project !== null || state.savedRepos.length > 0) {
        closeBtn.classList.remove('hidden');
      } else {
        closeBtn.classList.add('hidden');
      }
    }
  }

  function renderHistoryUI() {
    const repos = state.savedRepos || [];
    const topCount = document.getElementById('top-history-count');
    if (topCount) topCount.textContent = String(repos.length);

    const modalCount = document.getElementById('modal-history-count');
    if (modalCount) modalCount.textContent = `${repos.length} saved`;

    const modalList = document.getElementById('modal-history-list');
    if (modalList) {
      if (repos.length === 0) {
        modalList.innerHTML = `
          <div class="col-span-2 p-3 rounded-xl bg-[#14171f]/70 border border-white/[0.06] text-xs text-zinc-500 text-center">
            No repositories fetched yet. Import a GitHub URL, upload files, or paste code above to save it automatically.
          </div>
        `;
      } else {
        modalList.innerHTML = repos
          .map(
            (repo) => `
            <div class="p-3 rounded-xl bg-[#14171f] border border-blue-500/20 hover:border-blue-400/45 transition-colors flex items-center justify-between gap-2">
              <div class="min-w-0">
                <div class="text-xs font-semibold text-white truncate font-mono">${escapeHtml(repo.name)}</div>
                <div class="text-[11px] text-zinc-400 truncate mt-0.5">
                  ${escapeHtml(repo.language || 'Code')} · ${Number(repo.fileCount || repo.files?.length || 1)} file(s)
                </div>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  data-load-repo-id="${escapeHtml(repo.id)}"
                  class="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-[11px] font-semibold text-white transition-colors"
                >
                  Load Map
                </button>
                <button
                  type="button"
                  data-delete-repo-id="${escapeHtml(repo.id)}"
                  aria-label="Delete ${escapeHtml(repo.name)}"
                  class="px-2 py-1 rounded-lg bg-white/[0.05] hover:bg-rose-500/20 text-[11px] text-zinc-400 hover:text-rose-300 transition-colors"
                >
                  ✕
                </button>
              </div>
            </div>
          `
          )
          .join('');
      }
    }

    const historyContainer = document.getElementById('history-list-container');
    if (historyContainer) {
      if (repos.length === 0) {
        historyContainer.innerHTML = `
          <div class="col-span-2 p-8 rounded-2xl bg-[#14171f] border border-white/[0.08] text-center space-y-3">
            <div class="text-sm font-semibold text-white">No Saved Repositories Yet</div>
            <p class="text-xs text-zinc-400 max-w-md mx-auto">
              Whenever you fetch a GitHub repository, upload source files, or analyze a snippet, it is automatically stored in the SQLite database (repos.db) and listed here.
            </p>
          </div>
        `;
      } else {
        historyContainer.innerHTML = repos
          .map((repo) => {
            const formattedDate = repo.updatedAt
              ? new Date(repo.updatedAt).toLocaleString()
              : 'Recently saved';
            const fileNames = (repo.files || [])
              .slice(0, 4)
              .map((f) => f.path)
              .join(', ');
            return `
              <div class="p-4 rounded-2xl bg-[#14171f] border border-blue-500/25 hover:border-blue-400/50 transition-all flex flex-col justify-between gap-4">
                <div class="space-y-2">
                  <div class="flex items-start justify-between gap-2">
                    <div>
                      <h2 class="text-sm font-bold text-white font-mono">${escapeHtml(repo.name)}</h2>
                      <p class="text-xs text-zinc-400 mt-0.5">${escapeHtml(repo.description || 'Saved repository snapshot')}</p>
                    </div>
                    <span class="px-2 py-0.5 rounded-md text-[10px] font-mono uppercase bg-blue-500/15 text-blue-300 border border-blue-400/30 shrink-0">
                      ${escapeHtml(repo.language || 'Code')}
                    </span>
                  </div>
                  ${
                    repo.repoUrl
                      ? `<div class="text-[11px] font-mono text-blue-300/80 truncate">${escapeHtml(repo.repoUrl)}</div>`
                      : ''
                  }
                  <div class="text-[11px] font-mono text-zinc-400 truncate">
                    Files (${Number(repo.fileCount || repo.files?.length || 1)}): <span class="text-zinc-300">${escapeHtml(fileNames)}</span>
                  </div>
                </div>

                <div class="flex items-center justify-between pt-3 border-t border-white/[0.06]">
                  <span class="text-[10px] font-mono text-zinc-500">${escapeHtml(formattedDate)}</span>
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      data-delete-repo-id="${escapeHtml(repo.id)}"
                      class="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-rose-500/20 border border-white/10 text-xs text-zinc-300 hover:text-rose-300 transition-colors"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      data-load-repo-id="${escapeHtml(repo.id)}"
                      class="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white transition-colors"
                    >
                      Open Visual Map →
                    </button>
                  </div>
                </div>
              </div>
            `;
          })
          .join('');
      }
    }

    document.querySelectorAll('[data-load-repo-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-load-repo-id');
        const target = repos.find((r) => r.id === id);
        if (target) loadSavedRecordIntoVisualizer(target);
      });
    });

    document.querySelectorAll('[data-delete-repo-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-delete-repo-id');
        if (id) deleteRepoFromHistory(id);
      });
    });

    renderImportModalState();
  }

  function renderSidebar() {
    const project = state.project;
    const activeFile = getActiveFile();
    const activeFunction = getActiveFunction();
    if (!project || !activeFile) return;

    const summaryName = document.getElementById('project-summary-name');
    if (summaryName) summaryName.textContent = project.name;

    const totalFunctions = project.files.reduce((acc, f) => acc + f.functions.length, 0);
    const totalClasses = project.files.reduce((acc, f) => acc + f.classes.length, 0);

    const summaryStats = document.getElementById('project-summary-stats');
    if (summaryStats) {
      summaryStats.innerHTML = `
        <span>${project.files.length} files</span>
        <span>·</span>
        <span>${totalFunctions} funcs</span>
        <span>·</span>
        <span>${totalClasses} classes</span>
        <span>·</span>
        <span>${project.dependencies.length} deps</span>
      `;
    }

    const epSelect = document.getElementById('entry-point-select');
    if (epSelect) {
      epSelect.innerHTML = project.entryPoints
        .map(
          (ep) => `
          <option value="${escapeHtml(ep.id)}" ${ep.id === state.selectedEntryPointId ? 'selected' : ''}>
            ${escapeHtml(ep.file)} :: ${escapeHtml(ep.functionName)}()
          </option>
        `
        )
        .join('');
    }

    const explorerHeading = document.getElementById('file-explorer-heading');
    if (explorerHeading) {
      explorerHeading.textContent = `File Explorer (${project.files.length})`;
    }

    const folderGroups = {};
    project.files.forEach((f) => {
      const key = f.folder || '/';
      if (!folderGroups[key]) folderGroups[key] = [];
      folderGroups[key].push(f);
    });

    const treeContainer = document.getElementById('file-explorer-tree');
    if (treeContainer) {
      treeContainer.innerHTML = Object.entries(folderGroups)
        .map(([folder, files]) => {
          const isExpanded = state.expandedFolders[folder] ?? true;
          const filesHtml = isExpanded
            ? `<div class="pl-3 space-y-1">
                ${files
                  .map((file) => {
                    const isSelected = file.path === activeFile.path;
                    const nestedFns =
                      isSelected && file.functions.length > 0
                        ? `<div class="pl-5 py-0.5 space-y-0.5">
                            ${file.functions
                              .map(
                                (fn) => `
                                <button
                                  type="button"
                                  data-tree-fn="${escapeHtml(fn.name)}"
                                  data-tree-fn-file="${escapeHtml(file.path)}"
                                  class="w-full text-left px-2 py-1 rounded-md font-mono text-[11px] flex items-center justify-between transition-colors ${
                                    activeFunction && activeFunction.name === fn.name
                                      ? 'text-blue-300 bg-blue-500/15 font-medium'
                                      : 'text-zinc-400 hover:text-zinc-200'
                                  }"
                                >
                                  <span class="truncate">↳ ${escapeHtml(fn.name)}()</span>
                                </button>
                              `
                              )
                              .join('')}
                          </div>`
                        : '';
                    return `
                      <div class="space-y-0.5">
                        <button
                          type="button"
                          data-tree-file="${escapeHtml(file.path)}"
                          class="w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between text-xs transition-colors ${
                            isSelected
                              ? 'bg-[#25272f] text-white font-medium'
                              : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]'
                          }"
                        >
                          <span class="font-mono truncate">${escapeHtml(file.name)}</span>
                          <span class="text-[10px] font-mono text-zinc-500 shrink-0 tabular-nums">${file.functions.length}fn</span>
                        </button>
                        ${nestedFns}
                      </div>
                    `;
                  })
                  .join('')}
              </div>`
            : '';

          return `
            <div class="space-y-1">
              <button
                type="button"
                data-toggle-folder="${escapeHtml(folder)}"
                class="w-full flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-400 hover:text-white rounded-lg transition-colors"
              >
                <span class="font-mono text-[10px]">${isExpanded ? '▼' : '▶'}</span>
                <span class="font-mono truncate">${escapeHtml(folder)}</span>
              </button>
              ${filesHtml}
            </div>
          `;
        })
        .join('');

      treeContainer.querySelectorAll('[data-toggle-folder]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const folder = btn.getAttribute('data-toggle-folder');
          if (folder) {
            state.expandedFolders[folder] = !(state.expandedFolders[folder] ?? true);
            renderSidebar();
          }
        });
      });

      treeContainer.querySelectorAll('[data-tree-file]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const filePath = btn.getAttribute('data-tree-file');
          if (filePath) {
            state.viewMode = 'flow';
            navigateToFileFunction(filePath);
          }
        });
      });

      treeContainer.querySelectorAll('[data-tree-fn]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const fnName = btn.getAttribute('data-tree-fn');
          const filePath = btn.getAttribute('data-tree-fn-file');
          if (filePath && fnName) {
            state.viewMode = 'flow';
            navigateToFileFunction(filePath, fnName);
          }
        });
      });
    }
  }

  function renderSearchResults() {
    const dropdown = document.getElementById('global-search-results');
    if (!dropdown || !state.project) return;
    const q = state.searchQuery.trim();
    if (!q) {
      dropdown.classList.add('hidden');
      dropdown.innerHTML = '';
      return;
    }

    const results = searchProject(state.project, q);
    dropdown.classList.remove('hidden');
    if (results.length === 0) {
      dropdown.innerHTML = `<div class="p-3 text-xs text-zinc-500">No matching symbols found.</div>`;
      return;
    }

    dropdown.innerHTML = results
      .map(
        (res, idx) => `
        <button
          type="button"
          data-search-idx="${idx}"
          class="w-full text-left p-2.5 hover:bg-white/[0.06] transition-colors text-xs border-b border-white/[0.06]"
        >
          <div class="flex items-center justify-between font-mono">
            <span class="font-semibold text-blue-300">${escapeHtml(res.symbolName)}</span>
            <span class="text-[10px] text-zinc-400">${escapeHtml(res.file)}:${res.line}</span>
          </div>
          ${
            res.calledBy.length > 0
              ? `<div class="text-[10px] text-zinc-400 mt-1">Called by: <span class="font-mono text-zinc-300">${escapeHtml(res.calledBy.join(', '))}</span></div>`
              : ''
          }
          ${
            res.calls.length > 0
              ? `<div class="text-[10px] text-zinc-400">Calls: <span class="font-mono text-emerald-300">${escapeHtml(res.calls.join(', '))}</span></div>`
              : ''
          }
        </button>
      `
      )
      .join('');

    dropdown.querySelectorAll('[data-search-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-search-idx'));
        const res = results[idx];
        if (!res) return;
        state.viewMode = 'flow';
        navigateToFileFunction(res.file, res.functionName);
        if (res.nodeId) {
          const f = state.project.files.find((fl) => fl.path === res.file);
          const fn = f && f.functions.find((fnItem) => fnItem.name === res.functionName);
          const n = fn && fn.nodes.find((nd) => nd.id === res.nodeId);
          if (n) state.selectedNode = n;
        }
        state.searchQuery = '';
        const input = document.getElementById('global-search-input');
        if (input) input.value = '';
        renderAll();
      });
    });
  }

  function computeFlowLayout(fn, collapsedNodes, kindFilter) {
    if (!fn) {
      return { positions: {}, visibleNodes: [], visibleEdges: [] };
    }

    const hiddenIds = new Set();
    fn.edges.forEach((edge) => {
      if (
        collapsedNodes.has(edge.source) &&
        (edge.branchType === 'true' ||
          edge.branchType === 'false' ||
          edge.branchType === 'loop_body')
      ) {
        hiddenIds.add(edge.target);
      }
    });

    const visibleNodes = fn.nodes.filter((n) => {
      if (hiddenIds.has(n.id)) return false;
      if (kindFilter === 'all') return true;
      if (kindFilter === 'call') {
        return n.kind === 'call' || n.kind === 'start' || n.kind === 'end' || n.kind === 'function';
      }
      if (kindFilter === 'condition') {
        return (
          n.kind === 'condition' ||
          n.kind === 'branch_true' ||
          n.kind === 'branch_false' ||
          n.kind === 'start' ||
          n.kind === 'end'
        );
      }
      if (kindFilter === 'loop') {
        return n.kind === 'loop' || n.kind === 'start' || n.kind === 'end';
      }
      return true;
    });

    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = fn.edges.filter(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target)
    );

    const positions = {};
    const centerX = 430;
    let currentY = 48;
    const verticalGap = 104;

    const nodeBranchSide = {};

    fn.edges.forEach((edge) => {
      if (edge.branchType === 'true') {
        nodeBranchSide[edge.target] = 'true';
      } else if (edge.branchType === 'false') {
        nodeBranchSide[edge.target] = 'false';
      }
    });

    let changed = true;
    let pass = 0;
    while (changed && pass < 8) {
      changed = false;
      pass++;
      fn.edges.forEach((edge) => {
        if (edge.branchType === 'normal' || edge.branchType === 'cross_file') {
          const srcSide = nodeBranchSide[edge.source];
          const targetNode = fn.nodes.find((n) => n.id === edge.target);
          if (srcSide && targetNode && targetNode.kind !== 'end' && !nodeBranchSide[edge.target]) {
            nodeBranchSide[edge.target] = srcSide;
            changed = true;
          }
        }
      });
    }

    let lastConditionY = null;
    let trueBranchCursorY = 0;
    let falseBranchCursorY = 0;
    let maxBranchY = 0;

    visibleNodes.forEach((node) => {
      const side = nodeBranchSide[node.id];
      if (node.kind === 'condition') {
        if (maxBranchY > 0) {
          currentY = Math.max(currentY, maxBranchY + verticalGap);
        }
        positions[node.id] = { x: centerX, y: currentY };
        lastConditionY = currentY;
        trueBranchCursorY = currentY + verticalGap;
        falseBranchCursorY = currentY + verticalGap;
        currentY += verticalGap;
      } else if (side === 'true' && lastConditionY !== null) {
        positions[node.id] = { x: centerX - 210, y: trueBranchCursorY };
        maxBranchY = Math.max(maxBranchY, trueBranchCursorY);
        trueBranchCursorY += verticalGap;
      } else if (side === 'false' && lastConditionY !== null) {
        positions[node.id] = { x: centerX + 210, y: falseBranchCursorY };
        maxBranchY = Math.max(maxBranchY, falseBranchCursorY);
        falseBranchCursorY += verticalGap;
      } else {
        if (maxBranchY > 0) {
          currentY = Math.max(currentY, maxBranchY + verticalGap);
          maxBranchY = 0;
          lastConditionY = null;
        }
        positions[node.id] = { x: centerX, y: currentY };
        currentY += verticalGap;
      }
    });

    return { positions, visibleNodes, visibleEdges };
  }

  function getNodePalette(kind, isSelected, isActiveStep, isVisited) {
    if (isActiveStep) {
      return {
        bg: '#102a24',
        border: '#34d399',
        badgeBg: '#059669',
        badgeText: '#ecfdf5',
        text: '#ffffff',
      };
    }
    if (isSelected) {
      return {
        bg: '#1e1b4b',
        border: '#818cf8',
        badgeBg: '#4f46e5',
        badgeText: '#e0e7ff',
        text: '#ffffff',
      };
    }
    switch (kind) {
      case 'start':
      case 'end':
        return {
          bg: '#16181d',
          border: isVisited ? '#34d399' : '#3f3f46',
          badgeBg: '#27272a',
          badgeText: '#d4d4d8',
          text: '#e4e4e7',
        };
      case 'condition':
        return {
          bg: '#231c12',
          border: isVisited ? '#fbbf24' : '#b45309',
          badgeBg: '#d97706',
          badgeText: '#fffbeb',
          text: '#fef3c7',
        };
      case 'loop':
        return {
          bg: '#1d162b',
          border: isVisited ? '#a78bfa' : '#6d28d9',
          badgeBg: '#7c3aed',
          badgeText: '#f5f3ff',
          text: '#ede9fe',
        };
      case 'call':
        return {
          bg: '#112229',
          border: isVisited ? '#22d3ee' : '#0e7490',
          badgeBg: '#0891b2',
          badgeText: '#ecfeff',
          text: '#cffafe',
        };
      case 'return':
        return {
          bg: '#0f241d',
          border: isVisited ? '#34d399' : '#047857',
          badgeBg: '#059669',
          badgeText: '#ecfdf5',
          text: '#d1fae5',
        };
      case 'exception':
        return {
          bg: '#2a1218',
          border: '#f43f5e',
          badgeBg: '#e11d48',
          badgeText: '#fff1f2',
          text: '#ffe4e6',
        };
      default:
        return {
          bg: '#18191e',
          border: isVisited ? '#60a5fa' : '#2e3039',
          badgeBg: '#272932',
          badgeText: '#a1a1aa',
          text: '#e4e4e7',
        };
    }
  }

  function renderCenterPane() {
    const project = state.project;
    const activeFile = getActiveFile();
    const activeFunction = getActiveFunction();
    if (!project || !activeFile) return;

    const crumbs = [
      { label: project.name, mode: 'architecture' },
      { label: activeFile.path, file: activeFile.path },
    ];
    if (activeFunction) {
      crumbs.push({
        label: `${activeFunction.name}()`,
        file: activeFile.path,
        functionName: activeFunction.name,
      });
    }
    if (state.selectedNode && state.selectedNode.kind !== 'function') {
      crumbs.push({
        label: state.selectedNode.label,
        file: activeFile.path,
        functionName: activeFunction?.name,
      });
    }

    const breadBar = document.getElementById('breadcrumbs-bar');
    if (breadBar) {
      breadBar.innerHTML = crumbs
        .map(
          (c, idx) => `
          <span class="flex items-center gap-1 shrink-0">
            ${idx > 0 ? '<span class="text-zinc-600">/</span>' : ''}
            <button
              type="button"
              data-crumb-idx="${idx}"
              class="px-2 py-0.5 rounded-md font-mono transition-colors ${
                idx === crumbs.length - 1
                  ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30 font-medium'
                  : 'text-zinc-400 hover:text-white hover:bg-white/[0.06]'
              }"
            >
              ${escapeHtml(c.label)}
            </button>
          </span>
        `
        )
        .join('');

      breadBar.querySelectorAll('[data-crumb-idx]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-crumb-idx'));
          const crumb = crumbs[idx];
          if (!crumb) return;
          if (idx === 0) {
            setViewMode('architecture');
          } else if (crumb.file) {
            state.viewMode = 'flow';
            navigateToFileFunction(crumb.file, crumb.functionName);
          }
        });
      });
    }

    document.querySelectorAll('.sub-view-btn').forEach((btn) => {
      const mode = btn.getAttribute('data-sub-view');
      if (mode === state.viewMode) {
        btn.className =
          'sub-view-btn px-2.5 py-1 rounded-md text-xs font-medium bg-blue-500/20 text-blue-300 border border-blue-500/40';
      } else {
        btn.className =
          'sub-view-btn px-2.5 py-1 rounded-md text-xs font-medium text-zinc-400 hover:text-zinc-200';
      }
    });

    document.querySelectorAll('.kind-filter-btn').forEach((btn) => {
      const filter = btn.getAttribute('data-kind-filter');
      if (filter === state.kindFilter) {
        btn.className =
          'kind-filter-btn px-2 py-1 rounded text-[11px] font-medium bg-white/10 text-white';
      } else {
        btn.className =
          'kind-filter-btn px-2 py-1 rounded text-[11px] font-medium text-zinc-400 hover:text-zinc-200';
      }
    });

    const svgWrapper = document.getElementById('flow-svg-wrapper');
    const altView = document.getElementById('alt-map-view');
    const camControls = document.getElementById('camera-controls');
    const zoomLabel = document.getElementById('zoom-label');
    if (zoomLabel) zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;

    if (state.viewMode === 'flow') {
      svgWrapper?.classList.remove('hidden');
      camControls?.classList.remove('hidden');
      altView?.classList.add('hidden');
      renderFlowSvg();
    } else {
      svgWrapper?.classList.add('hidden');
      camControls?.classList.add('hidden');
      altView?.classList.remove('hidden');
      renderAltMapView();
    }

    renderDebuggerBar();
  }

  function renderFlowSvg() {
    const svg = document.getElementById('map-svg');
    const activeFunction = getActiveFunction();
    if (!svg || !activeFunction) return;

    const trace = getTraceResult();
    const activeStep = trace.steps[state.currentStepIndex] || null;
    const visitedNodeSet = new Set(
      trace.steps.slice(0, state.currentStepIndex + 1).map((s) => s.nodeId)
    );
    const visitedEdgeSet = new Set(trace.visitedEdgeIds);

    const { positions, visibleNodes, visibleEdges } = computeFlowLayout(
      activeFunction,
      state.collapsedNodes,
      state.kindFilter
    );

    const edgesSvg = visibleEdges
      .map((edge) => {
        const src = positions[edge.source];
        const tgt = positions[edge.target];
        if (!src || !tgt) return '';

        const isBackEdge = edge.branchType === 'loop_back' || tgt.y < src.y;
        const isVisited =
          visitedEdgeSet.has(edge.id) &&
          visitedNodeSet.has(edge.source) &&
          visitedNodeSet.has(edge.target);

        let strokeColor = '#3f3f46';
        let markerUrl = 'url(#arrow-default)';

        if (edge.branchType === 'true') {
          strokeColor = isVisited ? '#34d399' : '#059669';
          markerUrl = 'url(#arrow-true)';
        } else if (edge.branchType === 'false') {
          strokeColor = isVisited ? '#fbbf24' : '#b45309';
          markerUrl = 'url(#arrow-false)';
        } else if (edge.branchType === 'loop_back') {
          strokeColor = '#a78bfa';
          markerUrl = 'url(#arrow-loop)';
        } else if (edge.branchType === 'cross_file') {
          strokeColor = '#22d3ee';
          markerUrl = 'url(#arrow-call)';
        } else if (edge.branchType === 'exception') {
          strokeColor = '#f43f5e';
          markerUrl = 'url(#arrow-exception)';
        } else if (isVisited) {
          strokeColor = '#34d399';
          markerUrl = 'url(#arrow-true)';
        }

        let pathD = '';
        let labelX = (src.x + tgt.x) / 2;
        let labelY = (src.y + tgt.y) / 2;

        if (isBackEdge) {
          const rightCurveX = Math.max(src.x, tgt.x) + 190;
          pathD = `M ${src.x + 120} ${src.y} C ${rightCurveX} ${src.y}, ${rightCurveX} ${tgt.y}, ${tgt.x + 120} ${tgt.y}`;
          labelX = rightCurveX - 24;
          labelY = (src.y + tgt.y) / 2;
        } else {
          const startY = src.y + 32;
          const endY = tgt.y - 32;
          const midY = (startY + endY) / 2;
          pathD = `M ${src.x} ${startY} C ${src.x} ${midY}, ${tgt.x} ${midY}, ${tgt.x} ${endY}`;
        }

        return `
          <g>
            <path
              d="${pathD}"
              fill="none"
              stroke="${strokeColor}"
              stroke-width="${isVisited ? 2.5 : 1.75}"
              class="${isVisited ? 'animate-flow-edge' : ''}"
              marker-end="${markerUrl}"
            />
            ${
              edge.label
                ? `<g transform="translate(${labelX}, ${labelY})">
                    <rect x="-36" y="-10" width="72" height="20" rx="5" fill="#121317" stroke="${strokeColor}" stroke-width="1"></rect>
                    <text text-anchor="middle" dy="4" fill="${strokeColor}" font-size="10" font-family="JetBrains Mono, monospace" font-weight="600">
                      ${escapeHtml(edge.label)}
                    </text>
                  </g>`
                : ''
            }
          </g>
        `;
      })
      .join('');

    const nodesSvg = visibleNodes
      .map((node) => {
        const pos = positions[node.id];
        if (!pos) return '';

        const isSelected = state.selectedNode && state.selectedNode.id === node.id;
        const isActiveStep = activeStep && activeStep.nodeId === node.id;
        const isVisited = visitedNodeSet.has(node.id);
        const palette = getNodePalette(node.kind, isSelected, isActiveStep, isVisited);
        const isCollapsible = node.kind === 'condition' || node.kind === 'loop';
        const isCollapsed = state.collapsedNodes.has(node.id);
        const loopIterations = trace.loopCounts[node.id] || 0;

        const labelStr =
          node.label.length > 30 ? `${node.label.slice(0, 28)}...` : node.label;

        return `
          <g
            transform="translate(${pos.x - 130}, ${pos.y - 30})"
            data-node-id="${escapeHtml(node.id)}"
            class="cursor-pointer"
          >
            <rect
              width="260"
              height="60"
              rx="${node.kind === 'start' || node.kind === 'end' ? 30 : 12}"
              fill="${palette.bg}"
              stroke="${palette.border}"
              stroke-width="${isSelected || isActiveStep ? 2.5 : 1.5}"
            />
            <rect
              x="12"
              y="10"
              width="68"
              height="16"
              rx="4"
              fill="${palette.badgeBg}"
            />
            <text
              x="46"
              y="21"
              text-anchor="middle"
              fill="${palette.badgeText}"
              font-size="9"
              font-family="JetBrains Mono, monospace"
              font-weight="600"
            >
              ${escapeHtml(node.kind.toUpperCase())}
            </text>
            <text
              x="246"
              y="21"
              text-anchor="end"
              fill="#71717a"
              font-size="10"
              font-family="JetBrains Mono, monospace"
            >
              L${node.location.startLine}
            </text>
            <text
              x="14"
              y="43"
              fill="${palette.text}"
              font-size="12"
              font-family="JetBrains Mono, monospace"
              font-weight="500"
            >
              ${escapeHtml(labelStr)}
            </text>
            ${
              loopIterations > 0
                ? `<g transform="translate(190, -10)">
                    <rect width="66" height="18" rx="9" fill="#6d28d9" stroke="#a78bfa" />
                    <text x="33" y="12" text-anchor="middle" fill="#ffffff" font-size="9" font-family="JetBrains Mono, monospace" font-weight="700">
                      ${loopIterations}x iter
                    </text>
                  </g>`
                : ''
            }
            ${
              node.callTarget && node.callTarget.targetFile
                ? `<g transform="translate(175, 32)" data-call-portal="${escapeHtml(node.id)}">
                    <rect width="74" height="20" rx="5" fill="#083344" stroke="#06b6d4" stroke-width="1" />
                    <text x="37" y="13" text-anchor="middle" fill="#67e8f9" font-size="9.5" font-family="JetBrains Mono, monospace" font-weight="600">
                      Jump ↗
                    </text>
                  </g>`
                : ''
            }
            ${
              isCollapsible
                ? `<g transform="translate(234, 34)" data-collapse-node="${escapeHtml(node.id)}">
                    <rect width="18" height="18" rx="4" fill="#27272a" stroke="#52525b" />
                    <text x="9" y="13" text-anchor="middle" fill="#e4e4e7" font-size="11" font-family="JetBrains Mono, monospace">
                      ${isCollapsed ? '+' : '−'}
                    </text>
                  </g>`
                : ''
            }
          </g>
        `;
      })
      .join('');

    svg.innerHTML = `
      <defs>
        <marker id="arrow-default" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#52525b" />
        </marker>
        <marker id="arrow-true" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#34d399" />
        </marker>
        <marker id="arrow-false" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#fbbf24" />
        </marker>
        <marker id="arrow-loop" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#a78bfa" />
        </marker>
        <marker id="arrow-call" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#22d3ee" />
        </marker>
        <marker id="arrow-exception" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#f43f5e" />
        </marker>
      </defs>
      <g transform="translate(${state.pan.x}, ${state.pan.y}) scale(${state.zoom})">
        ${edgesSvg}
        ${nodesSvg}
      </g>
    `;

    svg.querySelectorAll('[data-node-id]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const nodeId = el.getAttribute('data-node-id');
        const node = activeFunction.nodes.find((n) => n.id === nodeId);
        if (node) {
          state.selectedNode = node;
          renderCenterPane();
          renderRightPane();
        }
      });
    });

    svg.querySelectorAll('[data-call-portal]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const nodeId = el.getAttribute('data-call-portal');
        const node = activeFunction.nodes.find((n) => n.id === nodeId);
        if (node && node.callTarget && node.callTarget.targetFile) {
          navigateToFileFunction(node.callTarget.targetFile, node.callTarget.functionName);
        }
      });
    });

    svg.querySelectorAll('[data-collapse-node]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const nodeId = el.getAttribute('data-collapse-node');
        if (!nodeId) return;
        if (state.collapsedNodes.has(nodeId)) {
          state.collapsedNodes.delete(nodeId);
        } else {
          state.collapsedNodes.add(nodeId);
        }
        renderFlowSvg();
      });
    });
  }

  function renderAltMapView() {
    const container = document.getElementById('alt-map-view');
    const project = state.project;
    const activeFile = getActiveFile();
    if (!container || !project || !activeFile) return;

    if (state.viewMode === 'architecture') {
      container.innerHTML = `
        <div class="max-w-5xl mx-auto space-y-6">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-base font-semibold text-white">High-Level Repository Architecture Map</h2>
              <p class="text-xs text-zinc-400">Click any file or function card to drill down into its interactive Control-Flow Graph.</p>
            </div>
            <span class="px-2.5 py-1 rounded-md text-xs font-mono bg-blue-500/10 text-blue-300 border border-blue-500/20">
              ${project.files.length} Files · ${project.dependencies.length} Cross-File Links
            </span>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            ${project.files
              .map((file) => {
                const isEntry = project.entryPoints.some((ep) => ep.file === file.path);
                return `
                  <div class="p-4 rounded-xl border bg-[#15161b] ${
                    file.path === activeFile.path
                      ? 'border-blue-500/60'
                      : 'border-white/[0.08] hover:border-white/20'
                  } transition-all flex flex-col justify-between">
                    <div>
                      <div class="flex items-center justify-between gap-2 mb-2">
                        <span class="font-mono text-xs font-semibold text-white truncate">${escapeHtml(file.path)}</span>
                        <div class="flex items-center gap-1.5">
                          ${
                            isEntry
                              ? '<span class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">ENTRY</span>'
                              : ''
                          }
                          <span class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-white/[0.06] text-zinc-300 uppercase">${escapeHtml(file.language)}</span>
                        </div>
                      </div>
                      <p class="text-xs text-zinc-400 mb-3">${escapeHtml(file.summary)}</p>
                      <div class="space-y-1.5">
                        <div class="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Functions (${file.functions.length})</div>
                        <div class="flex flex-wrap gap-1.5">
                          ${file.functions
                            .map(
                              (fn) => `
                              <button
                                type="button"
                                data-arch-file="${escapeHtml(file.path)}"
                                data-arch-fn="${escapeHtml(fn.name)}"
                                class="px-2 py-1 rounded-md text-xs font-mono bg-[#1e2028] hover:bg-blue-500/20 text-zinc-200 hover:text-blue-300 border border-white/[0.06] transition-colors"
                              >
                                ${escapeHtml(fn.name)}()
                              </button>
                            `
                            )
                            .join('')}
                        </div>
                      </div>
                    </div>
                    <div class="mt-4 pt-2.5 border-t border-white/[0.06] flex items-center justify-between text-[11px] text-zinc-500 font-mono">
                      <span>${file.imports.length} imports</span>
                      <button
                        type="button"
                        data-arch-file="${escapeHtml(file.path)}"
                        class="text-blue-400 hover:text-blue-300"
                      >
                        Open Flow →
                      </button>
                    </div>
                  </div>
                `;
              })
              .join('')}
          </div>
        </div>
      `;

      container.querySelectorAll('[data-arch-file]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const f = btn.getAttribute('data-arch-file');
          const fn = btn.getAttribute('data-arch-fn') || undefined;
          if (f) {
            state.viewMode = 'flow';
            navigateToFileFunction(f, fn);
          }
        });
      });
      return;
    }

    if (state.viewMode === 'dependencies') {
      container.innerHTML = `
        <div class="max-w-4xl mx-auto space-y-5">
          <div>
            <h2 class="text-base font-semibold text-white">Cross-File Call & Dependency Graph</h2>
            <p class="text-xs text-zinc-400">Direct module imports and cross-file function invocations detected via static analysis.</p>
          </div>
          <div class="space-y-2.5">
            ${
              project.dependencies.length > 0
                ? project.dependencies
                    .map(
                      (dep) => `
                      <div class="p-3.5 rounded-xl bg-[#15161b] border border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
                        <div class="flex items-center gap-3 font-mono text-xs">
                          <button
                            type="button"
                            data-dep-file="${escapeHtml(dep.sourceFile)}"
                            class="px-2.5 py-1 rounded-md bg-white/[0.05] hover:bg-white/10 text-zinc-200"
                          >
                            ${escapeHtml(dep.sourceFile)}
                          </button>
                          <span class="text-cyan-400 font-semibold">─── ${escapeHtml(dep.symbols.join(', '))} ──▶</span>
                          <button
                            type="button"
                            data-dep-file="${escapeHtml(dep.targetFile)}"
                            class="px-2.5 py-1 rounded-md bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30"
                          >
                            ${escapeHtml(dep.targetFile)}
                          </button>
                        </div>
                        <span class="text-[11px] font-mono text-zinc-400 uppercase px-2 py-0.5 rounded bg-white/[0.04]">
                          ${escapeHtml(dep.type)}
                        </span>
                      </div>
                    `
                    )
                    .join('')
                : `<div class="p-4 rounded-xl bg-[#15161b] border border-white/[0.08] text-xs text-zinc-400">No cross-file dependencies detected in this project.</div>`
            }
          </div>
        </div>
      `;

      container.querySelectorAll('[data-dep-file]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const f = btn.getAttribute('data-dep-file');
          if (f) {
            state.viewMode = 'flow';
            navigateToFileFunction(f);
          }
        });
      });
      return;
    }

    if (state.viewMode === 'trace') {
      const trace = getTraceResult();
      container.innerHTML = `
        <div class="max-w-4xl mx-auto space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-base font-semibold text-white">Complete Execution Trace Sequence</h2>
              <p class="text-xs text-zinc-400">Deterministic sandboxed trace across files, branches, loops, and variable mutations.</p>
            </div>
            <span class="px-2.5 py-1 rounded-md text-xs font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
              ${trace.steps.length} Executed Steps
            </span>
          </div>
          <div class="space-y-2">
            ${trace.steps
              .map((step, idx) => {
                const isCurrent = idx === state.currentStepIndex;
                return `
                  <button
                    type="button"
                    data-trace-step="${idx}"
                    class="w-full text-left p-3 rounded-xl border transition-all flex items-center justify-between gap-4 ${
                      isCurrent
                        ? 'bg-emerald-950/30 border-emerald-500/60 text-white'
                        : 'bg-[#15161b] border-white/[0.07] text-zinc-300 hover:border-white/20'
                    }"
                  >
                    <div class="flex items-center gap-3 min-w-0">
                      <span class="px-2 py-0.5 rounded text-xs font-mono bg-white/[0.07] text-zinc-300">
                        #${step.stepIndex + 1}
                      </span>
                      <span class="font-mono text-xs text-blue-300 shrink-0">
                        ${escapeHtml(step.file)}:${step.line}
                      </span>
                      <span class="font-mono text-xs font-semibold truncate">
                        ${escapeHtml(step.label)}
                      </span>
                    </div>
                    <div class="text-xs text-zinc-400 font-mono truncate max-w-md">
                      ${escapeHtml(step.explanation)}
                    </div>
                  </button>
                `;
              })
              .join('')}
          </div>
        </div>
      `;

      container.querySelectorAll('[data-trace-step]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-trace-step'));
          stepToIndex(idx);
        });
      });
    }
  }

  function renderDebuggerBar() {
    const trace = getTraceResult();
    const activeStep = trace.steps[state.currentStepIndex] || null;

    const playBtn = document.getElementById('trace-play-btn');
    if (playBtn) {
      playBtn.textContent = state.isPlaying ? 'Pause' : 'Play Trace';
    }

    const stepLabel = document.getElementById('trace-step-label');
    if (stepLabel) {
      stepLabel.textContent = `Step ${Math.min(state.currentStepIndex + 1, Math.max(trace.steps.length, 1))} / ${Math.max(trace.steps.length, 1)}`;
    }

    const slider = document.getElementById('trace-slider');
    if (slider) {
      slider.max = String(Math.max(trace.steps.length - 1, 0));
      slider.value = String(state.currentStepIndex);
    }

    const summary = document.getElementById('trace-status-summary');
    if (summary) {
      let html = '';
      if (activeStep && activeStep.branchDecision) {
        html += `
          <span class="px-2 py-0.5 rounded ${
            activeStep.branchDecision === 'TRUE'
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
              : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
          }">
            Branch: ${escapeHtml(activeStep.branchDecision)}
          </span>
        `;
      }
      if (trace.error) {
        html += `
          <span class="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
            ${escapeHtml(trace.error.type)} @ L${trace.error.line}
          </span>
        `;
      } else if (trace.finalOutput !== undefined) {
        html += `
          <span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            Output: ${escapeHtml(JSON.stringify(trace.finalOutput))}
          </span>
        `;
      }
      summary.innerHTML = html;
    }
  }

  function buildStaticNodeExplanation(node, activeFile, activeStep) {
    if (!node) return null;
    return {
      nodeId: node.id,
      provenance: activeStep ? 'runtime_observed' : 'static_proven',
      whatItDoes: node.description || `Executes ${node.kind} statement "${node.label}".`,
      whyItExists:
        node.kind === 'condition'
          ? `Controls program branching based on whether "${node.expression}" evaluates to TRUE or FALSE.`
          : node.kind === 'loop'
            ? `Repeatedly iterates over "${node.expression}" and updates accumulator state on each cycle.`
            : node.kind === 'call'
              ? `Delegates logic to ${node.callTarget?.functionName || node.label}${
                  node.callTarget?.targetFile ? ` in ${node.callTarget.targetFile}` : ''
                }.`
              : node.kind === 'return'
                ? `Terminates the current function path and returns ${node.expression || 'a value'} to the caller.`
                : `Performs a sequential step inside ${node.functionName || activeFile.name}.`,
      inputs:
        node.variablesRead.length > 0
          ? node.variablesRead
          : ['Current function scope parameters'],
      outputs:
        node.variablesWritten.length > 0
          ? node.variablesWritten.map((v) => `Mutates variable "${v}"`)
          : node.kind === 'condition'
            ? ['Selects TRUE or FALSE execution branch']
            : ['Advances control flow to next node'],
      dependencies: node.callTarget
        ? [
            `${node.callTarget.functionName}() ${
              node.callTarget.targetFile ? `(${node.callTarget.targetFile})` : '(same file)'
            }`,
          ]
        : activeFile.imports.length > 0
          ? activeFile.imports
          : ['No external module dependencies'],
      possiblePaths:
        node.kind === 'condition'
          ? [
              `If (${node.expression}) is TRUE → executes True branch`,
              `If (${node.expression}) is FALSE → executes False / Else branch`,
            ]
          : ['Sequential flow to next statement in control-flow graph'],
      beginnerExplanation:
        node.kind === 'condition'
          ? `Think of this as a fork in the road: the program checks if "${node.expression}" is true. Depending on the answer, it takes one of two paths.`
          : node.kind === 'call'
            ? `Here the program pauses this file and jumps into another helper function (${node.label}) to do a specific job, then brings the answer back.`
            : `This step runs line ${node.location.startLine} of ${activeFile.name} and updates the program's working variables.`,
      confidenceNote: activeStep
        ? '100% Proven by Static AST Analysis + Observed in Sandboxed Execution Trace'
        : '100% Proven by Static AST & Control-Flow Graph Analysis',
    };
  }

  async function requestDeepGeminiNodeExplanation() {
    const node = state.selectedNode;
    const activeFile = getActiveFile();
    const project = state.project;
    if (!node || !activeFile || !project) return;

    const trace = getTraceResult();
    const activeStep = trace.steps[state.currentStepIndex] || null;

    state.isGeneratingAI = true;
    state.aiError = null;
    renderRightPane();

    try {
      const response = await fetch('/api/ai/explain-node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node,
          fileContent: activeFile.content,
          projectSummary: `${project.name}: ${project.description}`,
          runtimeObserved: activeStep ? activeStep.variables : null,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        state.aiError = data.error || 'Gemini API explanation unavailable.';
      } else {
        state.aiExplanations[node.id] = data;
      }
    } catch (err) {
      state.aiError = err instanceof Error ? err.message : 'Network error calling Gemini API';
    } finally {
      state.isGeneratingAI = false;
      renderRightPane();
    }
  }

  async function sendRepoChatMessage(question) {
    const project = state.project;
    const activeFile = getActiveFile();
    if (!project || !question.trim()) return;

    state.chatMessages.push({ role: 'user', text: question.trim() });
    state.isChatLoading = true;
    renderRightPane();

    const trace = getTraceResult();
    try {
      const projectContext = project.files
        .map(
          (f) =>
            `File ${f.path} (${f.language}):\nFunctions: ${f.functions
              .map((fn) => `${fn.name}(${fn.parameters.join(', ')}) [L${fn.startLine}-L${fn.endLine}]`)
              .join(', ')}\nContent:\n${f.content}`
        )
        .join('\n\n---\n\n');

      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.trim(),
          projectContext,
          activeFile: activeFile?.path,
          activeNode: state.selectedNode
            ? `${state.selectedNode.label} (L${state.selectedNode.location.startLine})`
            : null,
          traceSummary: `Executed ${trace.steps.length} steps. Final output: ${JSON.stringify(
            trace.finalOutput
          )}. Error: ${trace.error ? trace.error.message : 'None'}`,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        const qLower = question.toLowerCase();
        const matchedFiles = project.files.filter(
          (f) =>
            f.path.toLowerCase().includes(qLower) || f.content.toLowerCase().includes(qLower)
        );
        const fallbackReply =
          matchedFiles.length > 0
            ? `[Proven by Static Analysis] Found relevant logic in ${matchedFiles
                .map((f) => `${f.path}`)
                .join(', ')}. (${data.error || 'Live AI key not set'})`
            : `[Proven by Static Analysis] Entry point starts at ${
                project.entryPoints[0]?.file || project.files[0]?.path
              } in ${
                project.entryPoints[0]?.functionName || 'main'
              }(). It connects across ${project.dependencies.length} module dependencies.`;
        state.chatMessages.push({ role: 'assistant', text: fallbackReply });
      } else {
        state.chatMessages.push({ role: 'assistant', text: data.answer });
      }
    } catch {
      state.chatMessages.push({
        role: 'assistant',
        text: '[Proven by Static Analysis] Use the symbol search or click any node to inspect its static control flow.',
      });
    } finally {
      state.isChatLoading = false;
      renderRightPane();
    }
  }

  function renderRightPane() {
    const container = document.getElementById('right-panel-body');
    const project = state.project;
    const activeFile = getActiveFile();
    if (!container || !project || !activeFile) return;

    document.querySelectorAll('.right-tab-btn').forEach((btn) => {
      const tab = btn.getAttribute('data-right-tab');
      if (tab === state.rightTab) {
        btn.className =
          'right-tab-btn px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 border-blue-400 text-white bg-[#1b1c22]';
      } else {
        btn.className =
          'right-tab-btn px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 border-transparent text-zinc-400 hover:text-zinc-200';
      }
    });

    const trace = getTraceResult();
    const activeStep = trace.steps[state.currentStepIndex] || null;

    if (state.rightTab === 'code') {
      const codeLines = activeFile.content.split('\n');
      container.innerHTML = `
        <div class="p-3">
          <div class="flex items-center justify-between mb-2 px-1">
            <div class="flex items-center gap-2">
              <span class="font-mono text-xs font-semibold text-white">${escapeHtml(activeFile.path)}</span>
              <span class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-white/[0.06] text-zinc-400 uppercase">
                ${escapeHtml(activeFile.language)}
              </span>
            </div>
            <span class="text-[11px] text-zinc-500">Click any line to highlight node</span>
          </div>
          <div class="rounded-xl bg-[#0c0d10] border border-white/[0.07] overflow-hidden font-mono text-xs">
            ${codeLines
              .map((lineText, idx) => {
                const lineNumber = idx + 1;
                const isSelectedNodeLine =
                  state.selectedNode &&
                  state.selectedNode.file === activeFile.path &&
                  lineNumber >= state.selectedNode.location.startLine &&
                  lineNumber <= state.selectedNode.location.endLine;
                const isActiveTraceLine =
                  activeStep &&
                  activeStep.file === activeFile.path &&
                  activeStep.line === lineNumber;

                return `
                  <button
                    type="button"
                    data-code-line="${lineNumber}"
                    class="w-full text-left flex items-start px-3 py-1 transition-colors border-l-2 ${
                      isActiveTraceLine
                        ? 'bg-emerald-500/20 border-emerald-400 text-emerald-100'
                        : isSelectedNodeLine
                          ? 'bg-blue-500/20 border-blue-400 text-white'
                          : 'border-transparent text-zinc-300 hover:bg-white/[0.04]'
                    }"
                  >
                    <span class="w-8 shrink-0 text-right pr-3 text-zinc-600 select-none tabular-nums">
                      ${lineNumber}
                    </span>
                    <span class="whitespace-pre overflow-x-auto">${escapeHtml(lineText || ' ')}</span>
                  </button>
                `;
              })
              .join('')}
          </div>
        </div>
      `;

      container.querySelectorAll('[data-code-line]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const line = Number(btn.getAttribute('data-code-line'));
          selectNodeByLine(line);
        });
      });
      return;
    }

    if (state.rightTab === 'inspector') {
      const node = state.selectedNode;
      const explanation =
        (node && state.aiExplanations[node.id]) ||
        buildStaticNodeExplanation(node, activeFile, activeStep);

      if (!node || !explanation) {
        container.innerHTML = `<div class="p-4 text-xs text-zinc-500">Select any node on the visual map to inspect its execution details.</div>`;
        return;
      }

      const provBadge =
        explanation.provenance === 'static_proven'
          ? '<span class="px-2 py-0.5 rounded text-[10px] font-mono bg-blue-500/15 text-blue-300 border border-blue-500/30">Proven by Static Analysis</span>'
          : explanation.provenance === 'runtime_observed'
            ? '<span class="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Observed During Execution</span>'
            : '<span class="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30">AI Inference</span>';

      container.innerHTML = `
        <div class="p-4 space-y-4">
          <div class="p-3.5 rounded-xl bg-[#17181f] border border-white/[0.08] space-y-2">
            <div class="flex items-center justify-between gap-2">
              <span class="px-2 py-0.5 rounded text-[10px] font-mono uppercase font-semibold bg-blue-500/20 text-blue-300 border border-blue-500/30">
                ${escapeHtml(node.kind)}
              </span>
              ${provBadge}
            </div>
            <div class="font-mono text-sm font-semibold text-white break-all">
              ${escapeHtml(node.label)}
            </div>
            <div class="text-xs text-zinc-400 font-mono">
              ${escapeHtml(node.file)} · Line ${node.location.startLine} · ${escapeHtml(node.functionName || 'module')}()
            </div>
            <div class="pt-2 flex items-center gap-2">
              <button
                type="button"
                id="ask-gemini-node-btn"
                class="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors"
              >
                ${state.isGeneratingAI ? 'Analyzing with Gemini...' : 'Ask Gemini (Deep Explain)'}
              </button>
            </div>
            ${
              state.aiError
                ? `<p class="text-[11px] text-amber-300 bg-amber-950/40 border border-amber-500/30 rounded-lg p-2 mt-2">${escapeHtml(state.aiError)}</p>`
                : ''
            }
          </div>

          <div class="space-y-3 text-xs">
            <div class="p-3 rounded-xl bg-[#15161c] border border-white/[0.06]">
              <div class="text-[11px] font-mono uppercase text-zinc-400 mb-1">What It Does</div>
              <p class="text-zinc-200 leading-relaxed">${escapeHtml(explanation.whatItDoes)}</p>
            </div>

            <div class="p-3 rounded-xl bg-[#15161c] border border-white/[0.06]">
              <div class="text-[11px] font-mono uppercase text-zinc-400 mb-1">Why It Exists</div>
              <p class="text-zinc-200 leading-relaxed">${escapeHtml(explanation.whyItExists)}</p>
            </div>

            <div class="grid grid-cols-2 gap-2.5">
              <div class="p-3 rounded-xl bg-[#15161c] border border-white/[0.06]">
                <div class="text-[11px] font-mono uppercase text-zinc-400 mb-1.5">Inputs / Reads</div>
                <ul class="space-y-1 font-mono text-[11px] text-cyan-300">
                  ${(explanation.inputs || []).map((inp) => `<li>• ${escapeHtml(inp)}</li>`).join('')}
                </ul>
              </div>
              <div class="p-3 rounded-xl bg-[#15161c] border border-white/[0.06]">
                <div class="text-[11px] font-mono uppercase text-zinc-400 mb-1.5">Outputs / Writes</div>
                <ul class="space-y-1 font-mono text-[11px] text-emerald-300">
                  ${(explanation.outputs || []).map((out) => `<li>• ${escapeHtml(out)}</li>`).join('')}
                </ul>
              </div>
            </div>

            <div class="p-3 rounded-xl bg-[#15161c] border border-white/[0.06]">
              <div class="text-[11px] font-mono uppercase text-zinc-400 mb-1.5">Possible Execution Paths</div>
              <ul class="space-y-1 text-zinc-300 font-mono text-[11px]">
                ${(explanation.possiblePaths || []).map((p) => `<li>→ ${escapeHtml(p)}</li>`).join('')}
              </ul>
            </div>

            ${
              activeStep
                ? `<div class="p-3 rounded-xl bg-[#15161c] border border-emerald-500/25">
                    <div class="text-[11px] font-mono uppercase text-emerald-400 mb-2">
                      Live Variable State (Step #${activeStep.stepIndex + 1})
                    </div>
                    <div class="grid grid-cols-2 gap-1.5 font-mono text-[11px]">
                      ${Object.entries(activeStep.variables || {})
                        .map(
                          ([k, v]) => `
                          <div class="px-2 py-1 rounded bg-black/40 border border-white/[0.05] flex items-center justify-between">
                            <span class="text-zinc-400">${escapeHtml(k)}:</span>
                            <span class="text-emerald-300 font-semibold truncate ml-1">${escapeHtml(JSON.stringify(v))}</span>
                          </div>
                        `
                        )
                        .join('')}
                    </div>
                  </div>`
                : ''
            }
          </div>
        </div>
      `;

      document.getElementById('ask-gemini-node-btn')?.addEventListener('click', () => {
        requestDeepGeminiNodeExplanation();
      });
      return;
    }

    if (state.rightTab === 'simulator') {
      const inputEntries = Object.entries(state.customInputs || {});
      container.innerHTML = `
        <div class="p-4 space-y-4 text-xs">
          <div class="p-3.5 rounded-xl bg-[#16171d] border border-white/[0.08] space-y-3">
            <div class="flex items-center justify-between">
              <div>
                <h3 class="font-semibold text-white text-sm">Input & Branch Simulator</h3>
                <p class="text-zinc-400 text-[11px]">Modify input parameters to test TRUE/FALSE branches, loops, and runtime exceptions.</p>
              </div>
              <button
                type="button"
                id="run-trace-sim-btn"
                class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition-colors"
              >
                Run Trace
              </button>
            </div>

            <div class="space-y-2 pt-2 border-t border-white/[0.06]">
              ${
                inputEntries.length > 0
                  ? inputEntries
                      .map(
                        ([key, val]) => `
                        <div class="flex items-center justify-between gap-2">
                          <label for="sim-input-${escapeHtml(key)}" class="font-mono text-zinc-300">${escapeHtml(key)}</label>
                          <input
                            id="sim-input-${escapeHtml(key)}"
                            data-sim-key="${escapeHtml(key)}"
                            type="text"
                            value="${escapeHtml(typeof val === 'string' ? val : JSON.stringify(val))}"
                            class="w-44 px-2.5 py-1 rounded-lg bg-[#0e0f13] border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-blue-400"
                          />
                        </div>
                      `
                      )
                      .join('')
                  : `<div class="flex items-center justify-between gap-2">
                      <label for="sim-input-x" class="font-mono text-zinc-300">x</label>
                      <input
                        id="sim-input-x"
                        data-sim-key="x"
                        type="text"
                        value="15"
                        class="w-44 px-2.5 py-1 rounded-lg bg-[#0e0f13] border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-blue-400"
                      />
                    </div>`
              }
            </div>
          </div>

          <div class="p-3.5 rounded-xl bg-[#15161c] border border-white/[0.07] space-y-2">
            <div class="text-[11px] font-mono uppercase text-zinc-400">Trace Outcome Summary</div>
            <div class="font-mono text-xs space-y-1">
              <div>Steps Executed: <span class="text-white">${trace.steps.length}</span></div>
              <div>Return / Output: <span class="text-emerald-400 font-semibold">${escapeHtml(JSON.stringify(trace.finalOutput ?? 'None'))}</span></div>
            </div>
          </div>
        </div>
      `;

      container.querySelectorAll('[data-sim-key]').forEach((inputEl) => {
        inputEl.addEventListener('input', () => {
          const key = inputEl.getAttribute('data-sim-key');
          if (!key) return;
          const raw = inputEl.value;
          let parsed = raw;
          if (raw === 'true') parsed = true;
          else if (raw === 'false') parsed = false;
          else if (raw.trim() !== '' && !Number.isNaN(Number(raw))) parsed = Number(raw);
          state.customInputs[key] = parsed;
        });
      });

      document.getElementById('run-trace-sim-btn')?.addEventListener('click', () => {
        state.currentStepIndex = 0;
        renderAll();
      });
      return;
    }

    if (state.rightTab === 'chat') {
      container.innerHTML = `
        <div class="p-4 flex flex-col h-full justify-between space-y-3">
          <div class="space-y-2.5 overflow-y-auto pr-1 max-h-[460px]">
            ${state.chatMessages
              .map(
                (m) => `
                <div class="p-3 rounded-xl text-xs leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-blue-600/20 border border-blue-500/30 text-blue-100 ml-6'
                    : 'bg-[#17181f] border border-white/[0.07] text-zinc-200 mr-4'
                }">
                  <div class="text-[10px] font-mono uppercase text-zinc-400 mb-1">
                    ${m.role === 'user' ? 'You' : 'Code Visualizer AI'}
                  </div>
                  <div class="whitespace-pre-wrap">${escapeHtml(m.text)}</div>
                </div>
              `
              )
              .join('')}
          </div>

          <form id="repo-chat-form" class="flex items-center gap-2 pt-2 border-t border-white/[0.08]">
            <input
              type="text"
              id="repo-chat-input"
              placeholder="Ask about functions, branches, or files..."
              aria-label="Ask AI about this repository"
              class="flex-1 bg-[#0e0f13] border border-white/15 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-400"
            />
            <button
              type="submit"
              class="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold"
            >
              ${state.isChatLoading ? '...' : 'Ask'}
            </button>
          </form>
        </div>
      `;

      const chatForm = document.getElementById('repo-chat-form');
      const chatInput = document.getElementById('repo-chat-input');
      if (chatForm && chatInput) {
        chatForm.addEventListener('submit', (e) => {
          e.preventDefault();
          const val = chatInput.value;
          if (!val.trim()) return;
          chatInput.value = '';
          sendRepoChatMessage(val);
        });
      }
    }
  }

  function renderAll() {
    renderWorkspaceVisibility();
    renderHistoryUI();
    if (state.project && getActiveFile()) {
      renderSidebar();
      renderSearchResults();
      renderCenterPane();
      renderRightPane();
    }
  }

  function initApp() {
    fetchSavedHistory();

    document.getElementById('brand-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      if (state.project) {
        setViewMode('flow');
      } else {
        openImportModalWithFade();
      }
    });

    document.querySelectorAll('.nav-view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-nav-view');
        if (!mode) return;
        if (mode === 'history') {
          closeImportModal();
          setViewMode('history');
          return;
        }
        if (!state.project) {
          openImportModalWithFade();
          return;
        }
        setViewMode(mode);
      });
    });

    document.querySelectorAll('.sub-view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-sub-view');
        if (mode) setViewMode(mode);
      });
    });

    document.querySelectorAll('.kind-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const f = btn.getAttribute('data-kind-filter');
        if (f) {
          state.kindFilter = f;
          renderCenterPane();
        }
      });
    });

    document.querySelectorAll('.right-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-right-tab');
        if (tab) {
          state.rightTab = tab;
          renderRightPane();
        }
      });
    });

    document.getElementById('header-import-btn')?.addEventListener('click', openImportModalWithFade);
    document.getElementById('empty-import-btn')?.addEventListener('click', openImportModalWithFade);
    document.getElementById('sidebar-import-btn')?.addEventListener('click', openImportModalWithFade);
    document.getElementById('history-new-import-btn')?.addEventListener('click', openImportModalWithFade);

    const goToHistoryTab = () => {
      closeImportModal();
      setViewMode('history');
    };
    document.getElementById('empty-history-btn')?.addEventListener('click', goToHistoryTab);
    document.getElementById('sidebar-history-btn')?.addEventListener('click', goToHistoryTab);
    document.getElementById('modal-open-full-history-btn')?.addEventListener('click', goToHistoryTab);

    document.getElementById('close-import-modal-btn')?.addEventListener('click', closeImportModal);

    const searchInput = document.getElementById('global-search-input');
    searchInput?.addEventListener('input', (e) => {
      state.searchQuery = e.target.value || '';
      renderSearchResults();
    });

    const epSelect = document.getElementById('entry-point-select');
    epSelect?.addEventListener('change', (e) => {
      const val = e.target.value;
      state.selectedEntryPointId = val;
      if (state.project) {
        const ep = state.project.entryPoints.find((item) => item.id === val);
        if (ep) {
          navigateToFileFunction(ep.file, ep.functionName);
        }
      }
    });

    const svgWrapper = document.getElementById('flow-svg-wrapper');
    svgWrapper?.addEventListener('mousedown', (e) => {
      if (e.target.closest('[data-node-id]')) return;
      state.isDraggingCanvas = true;
      state.dragOrigin = { x: e.clientX - state.pan.x, y: e.clientY - state.pan.y };
    });
    window.addEventListener('mousemove', (e) => {
      if (!state.isDraggingCanvas) return;
      state.pan = { x: e.clientX - state.dragOrigin.x, y: e.clientY - state.dragOrigin.y };
      renderFlowSvg();
    });
    window.addEventListener('mouseup', () => {
      state.isDraggingCanvas = false;
    });
    svgWrapper?.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.08 : -0.08;
        state.zoom = Number(Math.min(1.8, Math.max(0.45, state.zoom + delta)).toFixed(2));
        renderCenterPane();
      },
      { passive: false }
    );

    document.getElementById('zoom-in-btn')?.addEventListener('click', () => {
      state.zoom = Math.min(1.8, Number((state.zoom + 0.12).toFixed(2)));
      renderCenterPane();
    });
    document.getElementById('zoom-out-btn')?.addEventListener('click', () => {
      state.zoom = Math.max(0.45, Number((state.zoom - 0.12).toFixed(2)));
      renderCenterPane();
    });
    document.getElementById('zoom-reset-btn')?.addEventListener('click', () => {
      state.zoom = 0.88;
      state.pan = { x: 20, y: 16 };
      renderCenterPane();
    });

    document.getElementById('trace-restart-btn')?.addEventListener('click', () => stepToIndex(0));
    document.getElementById('trace-prev-btn')?.addEventListener('click', () =>
      stepToIndex(Math.max(0, state.currentStepIndex - 1))
    );
    document.getElementById('trace-next-btn')?.addEventListener('click', () => {
      const trace = getTraceResult();
      stepToIndex(Math.min(trace.steps.length - 1, state.currentStepIndex + 1));
    });
    document.getElementById('trace-play-btn')?.addEventListener('click', togglePlayTrace);
    document.getElementById('trace-slider')?.addEventListener('input', (e) => {
      stepToIndex(Number(e.target.value));
    });

    const gitForm = document.getElementById('github-import-form');
    const pasteForm = document.getElementById('paste-code-form');
    const errEl = document.getElementById('import-error-msg');

    const showImportError = (msg) => {
      if (!errEl) return;
      if (!msg) {
        errEl.classList.add('hidden');
        errEl.textContent = '';
      } else {
        errEl.textContent = msg;
        errEl.classList.remove('hidden');
      }
    };

    document.getElementById('switch-paste-mode-btn')?.addEventListener('click', () => {
      showImportError(null);
      gitForm?.classList.add('hidden');
      pasteForm?.classList.remove('hidden');
    });

    document.getElementById('back-to-git-btn')?.addEventListener('click', () => {
      showImportError(null);
      pasteForm?.classList.add('hidden');
      gitForm?.classList.remove('hidden');
    });

    gitForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const urlInput = document.getElementById('repo-url-input');
      const submitBtn = document.getElementById('submit-github-btn');
      const trimmed = (urlInput?.value || '').trim();
      if (!trimmed) {
        showImportError('Please enter a GitHub repository URL or upload your project files.');
        return;
      }

      showImportError(null);
      if (submitBtn) submitBtn.textContent = 'Analyzing Repo...';
      try {
        const response = await fetch('/api/repo/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoUrl: trimmed }),
        });
        const data = await response.json();
        if (!response.ok) {
          showImportError(data.error || 'Could not import repository.');
        } else {
          const built = buildProjectModel(
            data.id || `git-${Date.now()}`,
            data.name,
            data.description,
            data.files,
            {},
            [],
            trimmed
          );
          await fetchSavedHistory();
          selectProject(built, false);
          closeImportModal();
          setViewMode('flow');
        }
      } catch (err) {
        showImportError(
          err instanceof Error
            ? err.message
            : 'Failed to import Git URL. Make sure python app.py is running.'
        );
      } finally {
        if (submitBtn) submitBtn.textContent = 'Import Repository';
      }
    });

    const fileUploadInput = document.getElementById('file-upload-input');
    const folderUploadInput = document.getElementById('folder-upload-input');
    document.getElementById('upload-files-btn')?.addEventListener('click', () => {
      fileUploadInput?.click();
    });
    document.getElementById('upload-folder-btn')?.addEventListener('click', () => {
      folderUploadInput?.click();
    });

    const handleFilesSelected = async (e) => {
      const fileList = e.target.files;
      if (!fileList || fileList.length === 0) return;
      showImportError(null);

      try {
        const rawFiles = [];
        for (let i = 0; i < fileList.length; i++) {
          const file = fileList[i];
          if (!file.name.endsWith('.zip')) {
            const text = await file.text();
            const relPath = file.webkitRelativePath || `src/${file.name}`;
            rawFiles.push({ path: relPath, content: text });
          }
        }

        if (rawFiles.length === 0) {
          showImportError('No readable source files found in selection.');
          return;
        }

        const projName = rawFiles[0].path.split('/')[0] || 'uploaded-project';
        const built = buildProjectModel(
          `upload-${Date.now()}`,
          projName,
          `Uploaded ${rawFiles.length} source file(s) for interactive visualization.`,
          rawFiles,
          {}
        );
        selectProject(built, true, rawFiles);
        closeImportModal();
        setViewMode('flow');
      } catch (err) {
        showImportError(err instanceof Error ? err.message : 'Error reading uploaded files');
      }
    };

    fileUploadInput?.addEventListener('change', handleFilesSelected);
    folderUploadInput?.addEventListener('change', handleFilesSelected);

    document.getElementById('build-pasted-map-btn')?.addEventListener('click', () => {
      const filenameInput = document.getElementById('pasted-filename-input');
      const codeTextarea = document.getElementById('pasted-code-textarea');
      const filePath = (filenameInput?.value || 'src/main.py').trim() || 'src/main.py';
      const code = codeTextarea?.value || '';

      if (!code.trim()) {
        showImportError('Please paste or type source code before analyzing.');
        return;
      }

      showImportError(null);
      const rawFiles = [{ path: filePath, content: code }];
      const built = buildProjectModel(
        `snippet-${Date.now()}`,
        filePath.split('/').pop() || 'custom-code',
        'Custom source code analyzed into AST, Control-Flow Graph, and Execution Model.',
        rawFiles,
        {}
      );
      selectProject(built, true, rawFiles);
      closeImportModal();
      setViewMode('flow');
    });

    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
