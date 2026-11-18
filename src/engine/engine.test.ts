import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, parseSourceFile, searchProject } from './parser';
import { evaluateSandboxExpression, traceProgramExecution } from './tracer';
import { SAMPLE_PROJECTS } from './sampleProjects';

test('detectLanguage identifies supported and partial languages accurately', () => {
  assert.deepEqual(detectLanguage('main.py'), { language: 'python', isFullySupported: true });
  assert.deepEqual(detectLanguage('app.tsx'), { language: 'typescript', isFullySupported: true });
  assert.deepEqual(detectLanguage('styles.css'), { language: 'css', isFullySupported: false });
  assert.deepEqual(detectLanguage('README.md'), { language: 'unsupported', isFullySupported: false });
});

test('parseSourceFile builds control flow graph for calculate(x) with TRUE and FALSE branches', () => {
  const code = `def calculate(x):
    if x > 10:
        return x * 2
    else:
        return x + 5`;
  const parsed = parseSourceFile('src/utils.py', code, ['src/utils.py']);
  assert.equal(parsed.functions.length, 1);
  const fn = parsed.functions[0];
  assert.equal(fn.name, 'calculate');
  const condNode = fn.nodes.find((n) => n.kind === 'condition');
  assert.ok(condNode, 'Condition node x > 10 should exist');
  assert.equal(condNode.expression, 'x > 10');

  const trueEdge = fn.edges.find((e) => e.source === condNode.id && e.branchType === 'true');
  const falseEdge = fn.edges.find((e) => e.source === condNode.id && e.branchType === 'false');
  assert.ok(trueEdge, 'TRUE branch edge should exist');
  assert.ok(falseEdge, 'FALSE branch edge should exist');
});

test('evaluateSandboxExpression evaluates comparisons and math deterministically', () => {
  const env = { username: 'Adam', age: 17, score: 92, x: 15 };
  assert.equal(evaluateSandboxExpression('age >= 18', env), false);
  assert.equal(evaluateSandboxExpression('x > 10', env), true);
  assert.equal(evaluateSandboxExpression('x * 2', env), 30);
  assert.equal(evaluateSandboxExpression('x + 5', env), 20);
});

test('traceProgramExecution traces minor_user vs adult_user and ConnectionError accurately', () => {
  const project = SAMPLE_PROJECTS[0];

  // 1. Minor user (age = 17)
  const minorTrace = traceProgramExecution(project, {
    username: 'Adam',
    age: 17,
    score: 92,
    db_offline: false,
  });
  assert.equal(minorTrace.error, undefined);
  assert.ok(
    minorTrace.steps.some((s) => s.functionName === 'minor_user'),
    'Should trace into minor_user() when age = 17'
  );
  assert.equal(minorTrace.finalOutput, 0);

  // 2. Adult user (age = 20)
  const adultTrace = traceProgramExecution(project, {
    username: 'Adam',
    age: 20,
    score: 92,
    db_offline: false,
  });
  assert.equal(adultTrace.error, undefined);
  assert.ok(
    adultTrace.steps.some((s) => s.functionName === 'adult_user'),
    'Should trace into adult_user() when age = 20'
  );
  assert.ok(
    adultTrace.steps.some((s) => s.functionName === 'calculate'),
    'Should trace into calculate() when user is authenticated'
  );
  assert.equal(adultTrace.finalOutput, 194);

  // 3. Database runtime error (db_offline = true)
  const errorTrace = traceProgramExecution(project, {
    username: 'Adam',
    age: 20,
    score: 92,
    db_offline: true,
  });
  assert.ok(errorTrace.error, 'Should capture ConnectionError when db_offline is true');
  assert.equal(errorTrace.error?.type, 'ConnectionError');
  assert.equal(errorTrace.error?.file, 'src/database.py');
});

test('searchProject finds functions, files, and cross-file call metadata', () => {
  const project = SAMPLE_PROJECTS[0];
  const results = searchProject(project, 'authenticate_user');
  assert.ok(results.length > 0);
  assert.equal(results[0].symbolName, 'authenticate_user()');
  assert.equal(results[0].file, 'src/auth.py');
});
