import {
  ControlFlowNode,
  ExecutionStep,
  ExecutionTraceResult,
  FunctionDef,
  ProjectModel,
} from '../types/codeMap';

/**
 * Safe sandboxed expression evaluator for control-flow conditions and variable assignments.
 * Never executes arbitrary host code or eval(); parses comparative, boolean, and arithmetic expressions
 * against the isolated sandbox variable environment.
 */
export function evaluateSandboxExpression(
   rawExpr: string,
  env: Record<string, unknown>
): unknown {
  const expr = rawExpr
    .trim()
    .replace(/\band\b/g, '&&')
    .replace(/\bor\b/g, '||')
    .replace(/\bnot\s+/g, '!')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null');

  // Handle logical AND / OR
  if (expr.includes('&&')) {
    const parts = expr.split('&&');
    return parts.every((p) => Boolean(evaluateSandboxExpression(p, env)));
  }
  if (expr.includes('||')) {
    const parts = expr.split('||');
    return parts.some((p) => Boolean(evaluateSandboxExpression(p, env)));
  }

  // Handle negation
  if (expr.startsWith('!')) {
    return !evaluateSandboxExpression(expr.slice(1), env);
  }

  // Handle comparisons: >=, <=, ==, ===, !=, !==, >, <
  const compMatch = expr.match(/^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/);
  if (compMatch) {
    const left = resolveValue(compMatch[1].trim(), env);
    const op = compMatch[2];
    const right = resolveValue(compMatch[3].trim(), env);

    switch (op) {
      case '==':
      case '===':
        return left === right;
      case '!=':
      case '!==':
        return left !== right;
      case '>=':
        return Number(left) >= Number(right);
      case '<=':
        return Number(left) <= Number(right);
      case '>':
        return Number(left) > Number(right);
      case '<':
        return Number(left) < Number(right);
    }
  }

  // Handle Python range loop: e.g. "i in range(3)" or "attempt in range(max_retries)"
  const rangeMatch = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+range\(([^)]+)\)$/);
  if (rangeMatch) {
    const loopVar = rangeMatch[1];
    const limitVal = Number(resolveValue(rangeMatch[2].trim(), env)) || 3;
    const currentIter = typeof env[loopVar] === 'number' ? (env[loopVar] as number) : 0;
    return currentIter < Math.min(limitVal, 6);
  }

  // Handle arithmetic: +, -, *, /
  const mathMatch = expr.match(/^(.+?)\s*(\+|\-|\*|\/)\s*(.+)$/);
  if (mathMatch) {
    const left = resolveValue(mathMatch[1].trim(), env);
    const op = mathMatch[2];
    const right = resolveValue(mathMatch[3].trim(), env);
    if (op === '+') {
      if (typeof left === 'string' || typeof right === 'string') {
        return `${left}${right}`;
      }
      return Number(left) + Number(right);
    }
    if (op === '-') return Number(left) - Number(right);
    if (op === '*') return Number(left) * Number(right);
    if (op === '/') return Number(right) !== 0 ? Number(left) / Number(right) : 0;
  }

  return resolveValue(expr, env);
}

function resolveValue(token: string, env: Record<string, unknown>): unknown {
  const clean = token.trim();
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    return clean.slice(1, -1);
  }
  if (clean === 'true' || clean === 'True') return true;
  if (clean === 'false' || clean === 'False') return false;
  if (clean === 'null' || clean === 'None') return null;
  if (!Number.isNaN(Number(clean)) && clean !== '') return Number(clean);

  // Check object property e.g. user.age
  if (clean.includes('.')) {
    const [objName, prop] = clean.split('.');
    const obj = env[objName];
    if (obj && typeof obj === 'object' && prop in (obj as Record<string, unknown>)) {
      return (obj as Record<string, unknown>)[prop];
    }
  }

  if (clean in env) {
    return env[clean];
  }
  return true;
}

export function traceProgramExecution(
  project: ProjectModel,
  userInputs: Record<string, unknown>,
  entryPointId?: string
): ExecutionTraceResult {
  const entry =
    project.entryPoints.find((e) => e.id === entryPointId) ||
    project.entryPoints[0];

  const env: Record<string, unknown> = { ...project.defaultInputs, ...userInputs };
  const steps: ExecutionStep[] = [];
  const visitedNodeIds: string[] = [];
  const visitedEdgeIds: string[] = [];
  const loopCounts: Record<string, number> = {};
  const callStack: string[] = [];
  let runtimeError: ExecutionTraceResult['error'] | undefined;
  let finalOutput: unknown = undefined;

  const findFunction = (file: string, fnName: string): FunctionDef | undefined => {
    const targetFile = project.files.find((f) => f.path === file);
    const inTarget = targetFile?.functions.find((fn) => fn.name === fnName);
    if (inTarget) return inTarget;
    for (const f of project.files) {
      const found = f.functions.find((fn) => fn.name === fnName);
      if (found) return found;
    }
    return undefined;
  };

  const MAX_STEPS = 80;

  const executeFunction = (fn: FunctionDef, callerArgs?: Record<string, unknown>): unknown => {
    if (steps.length >= MAX_STEPS || runtimeError) return undefined;

    if (callerArgs) {
      Object.assign(env, callerArgs);
    }

    callStack.push(`${fn.name}()`);
    let currentNode: ControlFlowNode | undefined = fn.nodes[0];

    while (currentNode && steps.length < MAX_STEPS && !runtimeError) {
      const activeNode: ControlFlowNode = currentNode;
      visitedNodeIds.push(activeNode.id);

      let stepDescription = activeNode.staticExplanation.whatItDoes;
      let branchDecision: ExecutionStep['branchDecision'] | undefined;
      let variableDiff: ExecutionStep['variableDiff'] | undefined;
      let loopIter: number | undefined;

      if (activeNode.kind === 'condition' || activeNode.kind === 'switch') {
        const expr: string = activeNode.expression || 'true';
        const result: boolean = Boolean(evaluateSandboxExpression(expr, env));
        branchDecision = {
          expression: expr,
          evaluatedTo: result,
        };
        stepDescription = `Condition "${expr}" evaluated to ${result ? 'TRUE' : 'FALSE'}`;

        steps.push({
          stepIndex: steps.length + 1,
          nodeId: activeNode.id,
          file: fn.file,
          functionName: fn.name,
          line: activeNode.location.startLine,
          label: activeNode.label,
          description: stepDescription,
          branchDecision,
          variables: structuredClone(env),
        });

        const outgoing = fn.edges.filter((e) => e.source === activeNode.id);
        const chosenEdge =
          outgoing.find((e) => (result ? e.branchType === 'true' : e.branchType === 'false')) ||
          outgoing[0];

        if (chosenEdge) {
          visitedEdgeIds.push(chosenEdge.id);
          currentNode = fn.nodes.find((n) => n.id === chosenEdge.target);
        } else {
          break;
        }
        continue;
      }

      if (activeNode.kind === 'loop') {
        const count = (loopCounts[activeNode.id] || 0) + 1;
        loopCounts[activeNode.id] = count;
        loopIter = count;

        const expr: string = activeNode.expression || '';
        const rangeMatch = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+range\(([^)]+)\)$/);
        let shouldContinueLoop = false;

        if (rangeMatch) {
          const loopVar = rangeMatch[1];
          const maxIter = Math.min(Number(resolveValue(rangeMatch[2].trim(), env)) || 2, 3);
          const idxVal = count - 1;
          if (idxVal < maxIter) {
            env[loopVar] = idxVal;
            shouldContinueLoop = true;
          } else {
            shouldContinueLoop = false;
          }
        } else {
          shouldContinueLoop = count <= 2 && Boolean(evaluateSandboxExpression(expr, env));
        }

        branchDecision = {
          expression: expr,
          evaluatedTo: shouldContinueLoop,
        };

        steps.push({
          stepIndex: steps.length + 1,
          nodeId: activeNode.id,
          file: fn.file,
          functionName: fn.name,
          line: activeNode.location.startLine,
          label: activeNode.label,
          description: shouldContinueLoop
            ? `Loop iteration #${count} active (${expr})`
            : `Loop condition exited after ${count - 1} iteration(s)`,
          branchDecision,
          loopIteration: count,
          variables: structuredClone(env),
        });

        const outgoing = fn.edges.filter((e) => e.source === activeNode.id);
        const chosenEdge =
          outgoing.find((e) => (shouldContinueLoop ? e.branchType === 'true' : e.branchType === 'false')) ||
          outgoing[0];

        if (chosenEdge) {
          visitedEdgeIds.push(chosenEdge.id);
          currentNode = fn.nodes.find((n) => n.id === chosenEdge.target);
        } else {
          break;
        }
        continue;
      }

      if (activeNode.kind === 'exception') {
        const errExpr = activeNode.expression || 'ConnectionError("Database connection failed")';
        const errType = errExpr.split('(')[0] || 'RuntimeError';
        const errMsg = errExpr.match(/\(([^)]*)\)/)?.[1]?.replace(/['"]/g, '') || 'Unhandled runtime error';

        runtimeError = {
          type: errType,
          message: errMsg,
          file: fn.file,
          line: activeNode.location.startLine,
          path: [...callStack],
          explanation: `Execution halted at ${fn.file}:${activeNode.location.startLine} inside ${fn.name}() because ${errType} was raised (${errMsg}).`,
        };

        steps.push({
          stepIndex: steps.length + 1,
          nodeId: activeNode.id,
          file: fn.file,
          functionName: fn.name,
          line: activeNode.location.startLine,
          label: activeNode.label,
          description: `Runtime Error: ${errType} — ${errMsg}`,
          variables: structuredClone(env),
          isError: true,
          errorDetails: {
            type: errType,
            message: errMsg,
            file: fn.file,
            line: activeNode.location.startLine,
            callStack: [...callStack],
          },
        });
        break;
      }

      if (activeNode.kind === 'call' && activeNode.callsTarget) {
        const assignMatch = activeNode.expression?.match(/^(?:let\s+|const\s+|var\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
        const targetFn = findFunction(
          activeNode.callsTarget.file,
          activeNode.callsTarget.functionName
        );

        steps.push({
          stepIndex: steps.length + 1,
          nodeId: activeNode.id,
          file: fn.file,
          functionName: fn.name,
          line: activeNode.location.startLine,
          label: activeNode.label,
          description: targetFn
            ? `Calling ${targetFn.name}() in ${targetFn.file}`
            : `Executing call ${activeNode.label}`,
          variables: structuredClone(env),
        });

        if (targetFn && !callStack.includes(`${targetFn.name}()`)) {
          const boundArgs: Record<string, unknown> = {};
          const argListMatch = activeNode.expression?.match(/\(([^)]*)\)/);
          if (argListMatch && argListMatch[1].trim()) {
            const rawArgs = argListMatch[1].split(',').map((a) => a.trim());
            targetFn.parameters.forEach((paramName, idx) => {
              if (rawArgs[idx] !== undefined) {
                boundArgs[paramName] = evaluateSandboxExpression(rawArgs[idx], env);
              }
            });
          }
          const callReturn = executeFunction(targetFn, boundArgs);
          if (assignMatch && callReturn !== undefined) {
            const varName = assignMatch[1];
            const prevVal = env[varName];
            env[varName] = callReturn;
            variableDiff = {
              variable: varName,
              previousValue: prevVal,
              newValue: callReturn,
            };
          }
        }

        if (runtimeError) break;
      } else if (activeNode.kind === 'statement') {
        const assignMatch = activeNode.expression?.match(/^(?:let\s+|const\s+|var\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
        if (assignMatch) {
          const varName = assignMatch[1];
          const rhs = assignMatch[2].trim();
          const prevVal = env[varName];
          const computed = evaluateSandboxExpression(rhs, env);
          env[varName] = computed;
          variableDiff = {
            variable: varName,
            previousValue: prevVal,
            newValue: computed,
          };
          stepDescription = `Updated ${varName} = ${JSON.stringify(computed)}`;
        }

        steps.push({
          stepIndex: steps.length + 1,
          nodeId: activeNode.id,
          file: fn.file,
          functionName: fn.name,
          line: activeNode.location.startLine,
          label: activeNode.label,
          description: stepDescription,
          variables: structuredClone(env),
          variableDiff,
        });
      } else if (activeNode.kind === 'return') {
        const retVal = evaluateSandboxExpression(activeNode.expression || 'null', env);
        finalOutput = retVal;
        steps.push({
          stepIndex: steps.length + 1,
          nodeId: activeNode.id,
          file: fn.file,
          functionName: fn.name,
          line: activeNode.location.startLine,
          label: activeNode.label,
          description: `Return ${JSON.stringify(retVal)} from ${fn.name}()`,
          variables: structuredClone(env),
        });

        const nextEdge = fn.edges.find((e) => e.source === activeNode.id);
        if (nextEdge) {
          visitedEdgeIds.push(nextEdge.id);
          const endN = fn.nodes.find((n) => n.id === nextEdge.target);
          if (endN) {
            visitedNodeIds.push(endN.id);
            steps.push({
              stepIndex: steps.length + 1,
              nodeId: endN.id,
              file: fn.file,
              functionName: fn.name,
              line: endN.location.startLine,
              label: endN.label,
              description: `Completed ${fn.name}()`,
              variables: structuredClone(env),
            });
          }
        }
        callStack.pop();
        return retVal;
      } else {
        // start or end node
        steps.push({
          stepIndex: steps.length + 1,
          nodeId: activeNode.id,
          file: fn.file,
          functionName: fn.name,
          line: activeNode.location.startLine,
          label: activeNode.label,
          description: stepDescription,
          variables: structuredClone(env),
        });
      }

      // Advance to next node
      const outgoing = fn.edges.filter((e) => e.source === activeNode.id);
      const nextEdge =
        outgoing.find((e) => e.branchType === 'loop_back') ||
        outgoing.find((e) => e.branchType === 'normal' || e.branchType === 'cross_file') ||
        outgoing[0];

      if (nextEdge) {
        visitedEdgeIds.push(nextEdge.id);
        currentNode = fn.nodes.find((n) => n.id === nextEdge.target);
      } else {
        currentNode = undefined;
      }
    }

    callStack.pop();
    return finalOutput;
  };

  if (entry) {
    const startFn = findFunction(entry.file, entry.functionName);
    if (startFn) {
      executeFunction(startFn);
    }
  }

  return {
    entryPointId: entry?.id || '',
    inputs: userInputs,
    steps,
    visitedNodeIds: Array.from(new Set(visitedNodeIds)),
    visitedEdgeIds: Array.from(new Set(visitedEdgeIds)),
    loopCounts,
    finalOutput,
    error: runtimeError,
    executionMode: 'sandboxed_interpreter',
  };
}
