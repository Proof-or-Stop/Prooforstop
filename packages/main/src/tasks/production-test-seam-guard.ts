#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const PRODUCTION_TEST_SEAM_REASON = 'production_test_seam_side_effect_flow' as const;

export interface ProductionTestSeamIssue {
  reason: typeof PRODUCTION_TEST_SEAM_REASON;
  file: string;
  line: number;
  column: number;
  envKeys: string[];
  sink: string;
}

type Sources = Set<string>;

const FS_SINK_ARGUMENTS: Readonly<Record<string, readonly number[]>> = {
  mkdir: [0],
  mkdirSync: [0],
  write: [0],
  writeFile: [0],
  writeFileSync: [0],
  rm: [0],
  rmSync: [0],
  rename: [0, 1],
  renameSync: [0, 1],
};

const PROCESS_SINK_ARGUMENTS: Readonly<Record<string, readonly number[]>> = {
  exec: [0, 1],
  execSync: [0, 1],
  execFile: [0, 1, 2],
  execFileSync: [0, 1, 2],
  spawn: [0, 1, 2],
  spawnSync: [0, 1, 2],
};

function union(...sets: Sources[]): Sources {
  return new Set(sets.flatMap(set => [...set]));
}

function isTestControlKey(key: string): boolean {
  return /(?:^|_)(?:SMOKE|TEST)(?:_|$)/i.test(key) || /(?:SMOKE|TEST)/i.test(key);
}

function propertyName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

function isProcessEnv(expression: ts.Expression, processObjects: ReadonlySet<string>): boolean {
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return false;
  const base = expression.expression;
  return ts.isIdentifier(base) && processObjects.has(base.text) && propertyName(expression) === 'env';
}

function collectSanitizerFunctions(sourceFile: ts.SourceFile): Map<string, readonly number[]> {
  // Value = parameter indexes whose values may survive sanitization (for the
  // positive-integer fallback branch). Enum sanitizers expose no input value.
  const sanitizers = new Map<string, readonly number[]>();
  const unwrap = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
    return current;
  };
  const isLiteral = (expression: ts.Expression): boolean => {
    const value = unwrap(expression);
    return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)
      || value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.TrueKeyword;
  };
  const inspect = (name: string | undefined, parameters: ts.NodeArray<ts.ParameterDeclaration>, body: ts.ConciseBody | undefined): void => {
    if (!name || !body) return;
    const returns: ts.Expression[] = [];
    const visitReturn = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
      ts.forEachChild(node, visitReturn);
    };
    if (ts.isBlock(body)) visitReturn(body);
    else returns.push(body);

    const parameterNames = new Set(parameters.flatMap(parameter => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
    const parsedNames = new Set<string>();
    const collectParsed = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isCallExpression(node.initializer) && propertyName(node.initializer.expression) === undefined
        && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'Number'
        && node.initializer.arguments[0] && ts.isIdentifier(node.initializer.arguments[0])
        && parameterNames.has(node.initializer.arguments[0].text)) parsedNames.add(node.name.text);
      ts.forEachChild(node, collectParsed);
    };
    collectParsed(body);
    const conjunctionTerms = (expression: ts.Expression): ts.Expression[] => {
      const value = unwrap(expression);
      if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        return [...conjunctionTerms(value.left), ...conjunctionTerms(value.right)];
      }
      return [value];
    };
    const fallbackIndexes = new Set<number>();
    const positiveInt = returns.length > 0 && parsedNames.size > 0 && returns.every(expression => {
      const value = unwrap(expression);
      if (!ts.isConditionalExpression(value)) return false;
      const trueValue = unwrap(value.whenTrue);
      const falseValue = unwrap(value.whenFalse);
      const terms = conjunctionTerms(value.condition);
      const parsed = [...parsedNames].find(candidate => {
        const finiteRequired = terms.some(term => ts.isCallExpression(term)
          && propertyName(term.expression) === 'isFinite'
          && ts.isPropertyAccessExpression(term.expression)
          && ts.isIdentifier(term.expression.expression) && term.expression.expression.text === 'Number'
          && term.arguments.length === 1
          && ts.isIdentifier(term.arguments[0]) && term.arguments[0].text === candidate);
        const positiveRequired = terms.some(term => ts.isBinaryExpression(term)
          && ((term.operatorToken.kind === ts.SyntaxKind.GreaterThanToken
            && ts.isIdentifier(term.left) && term.left.text === candidate
            && ts.isNumericLiteral(term.right) && Number(term.right.text) === 0)
          || (term.operatorToken.kind === ts.SyntaxKind.LessThanToken
            && ts.isNumericLiteral(term.left) && Number(term.left.text) === 0
            && ts.isIdentifier(term.right) && term.right.text === candidate)));
        return finiteRequired && positiveRequired;
      });
      const fallbackIndex = ts.isIdentifier(falseValue)
        ? parameters.findIndex(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === falseValue.text)
        : -1;
      if (fallbackIndex >= 0) fallbackIndexes.add(fallbackIndex);
      return Boolean(parsed)
        && ts.isCallExpression(trueValue)
        && propertyName(trueValue.expression) === 'floor'
        && trueValue.expression.getText(sourceFile).startsWith('Math.')
        && ts.isIdentifier(trueValue.arguments[0]) && trueValue.arguments[0].text === parsed
        && (isLiteral(falseValue) || fallbackIndex > 0);
    });
    const finiteEnum = returns.length >= 2 && returns.every(isLiteral);
    if (positiveInt) sanitizers.set(name, [...fallbackIndexes]);
    else if (finiteEnum) sanitizers.set(name, []);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) inspect(node.name?.text, node.parameters, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      inspect(node.name.text, node.initializer.parameters, node.initializer.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sanitizers;
}

function functionParameters(sourceFile: ts.SourceFile): Map<string, string[]> {
  const functions = new Map<string, string[]>();
  const record = (name: string | undefined, parameters: ts.NodeArray<ts.ParameterDeclaration>): void => {
    if (!name) return;
    functions.set(name, parameters.map(parameter => ts.isIdentifier(parameter.name) ? parameter.name.text : '').filter(Boolean));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) record(node.name?.text, node.parameters);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      record(node.name.text, node.initializer.parameters);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions;
}

function functionReturns(sourceFile: ts.SourceFile): Map<string, ts.Expression[]> {
  const functions = new Map<string, ts.Expression[]>();
  const record = (name: string | undefined, body: ts.ConciseBody | undefined): void => {
    if (!name || !body) return;
    const values: ts.Expression[] = [];
    if (!ts.isBlock(body)) values.push(body);
    else {
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node) && node !== body.parent) return;
        if (ts.isReturnStatement(node) && node.expression) values.push(node.expression);
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(body, visit);
    }
    functions.set(name, values);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) record(node.name?.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      record(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions;
}

function collectSinkAliases(sourceFile: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  const isSink = (name: string): boolean => Object.hasOwn(FS_SINK_ARGUMENTS, name) || Object.hasOwn(PROCESS_SINK_ARGUMENTS, name);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        const canonical = element.propertyName?.text ?? element.name.text;
        if (isSink(canonical)) aliases.set(element.name.text, canonical);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const canonical = propertyName(node.initializer) ?? (ts.isIdentifier(node.initializer) ? node.initializer.text : undefined);
      if (canonical && isSink(canonical)) aliases.set(node.name.text, canonical);
      else if (canonical && aliases.has(canonical)) aliases.set(node.name.text, aliases.get(canonical)!);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

export function analyzeProductionTestSeams(sourceText: string, file = 'inline.ts'): ProductionTestSeamIssue[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const taint = new Map<string, Sources>();
  const envObjects = new Set<string>();
  const processObjects = new Set<string>(['process']);
  const sanitizers = collectSanitizerFunctions(sourceFile);
  const functions = functionParameters(sourceFile);
  const returns = functionReturns(sourceFile);
  const sinkAliases = collectSinkAliases(sourceFile);

  const add = (name: string, sources: Sources): boolean => {
    if (sources.size === 0) return false;
    const existing = taint.get(name) ?? new Set<string>();
    const before = existing.size;
    for (const source of sources) existing.add(source);
    taint.set(name, existing);
    return existing.size !== before;
  };

  const expressionKey = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const base = expressionKey(expression.expression);
      const property = propertyName(expression);
      return base && property ? `${base}.${property}` : undefined;
    }
    return undefined;
  };

  const sourceFromEnvironment = (expression: ts.Expression): Sources => {
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const key = propertyName(expression);
      const base = expression.expression;
      const envBase = isProcessEnv(base, processObjects) || (ts.isIdentifier(base) && envObjects.has(base.text));
      if (envBase && key && isTestControlKey(key)) return new Set([key]);
    }
    return new Set();
  };

  const expressionSources = (expression: ts.Expression | undefined): Sources => {
    if (!expression) return new Set();
    const direct = sourceFromEnvironment(expression);
    if (direct.size > 0) return direct;
    if (ts.isIdentifier(expression)) {
      const prefix = `${expression.text}.`;
      return union(
        new Set(taint.get(expression.text) ?? []),
        ...[...taint.entries()].filter(([key]) => key.startsWith(prefix)).map(([, sources]) => sources),
      );
    }
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression) || ts.isAwaitExpression(expression)) {
      return expressionSources(expression.expression);
    }
    if (ts.isConditionalExpression(expression)) {
      // Tainted control choosing only fixed, untainted constants is a finite
      // enum selection; the condition itself does not become a sink target.
      return union(expressionSources(expression.whenTrue), expressionSources(expression.whenFalse));
    }
    if (ts.isCallExpression(expression)) {
      const callee = ts.isIdentifier(expression.expression) ? expression.expression.text : undefined;
      if (callee && sanitizers.has(callee)) {
        return union(...(sanitizers.get(callee) ?? []).map(index => expressionSources(expression.arguments[index])));
      }
      return union(
        ...expression.arguments.map(argument => expressionSources(argument)),
        ...(callee ? (returns.get(callee) ?? []).map(value => expressionSources(value)) : []),
      );
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      return union(
        new Set(taint.get(expressionKey(expression) ?? '') ?? []),
        expressionSources(expression.expression),
        ts.isElementAccessExpression(expression) ? expressionSources(expression.argumentExpression) : new Set(),
      );
    }
    if (ts.isBinaryExpression(expression)) return union(expressionSources(expression.left), expressionSources(expression.right));
    if (ts.isTemplateExpression(expression)) return union(...expression.templateSpans.map(span => expressionSources(span.expression)));
    if (ts.isArrayLiteralExpression(expression)) return union(...expression.elements.map(element => expressionSources(element as ts.Expression)));
    if (ts.isObjectLiteralExpression(expression)) {
      return union(...expression.properties.map(property => {
        if (ts.isPropertyAssignment(property)) return expressionSources(property.initializer);
        if (ts.isShorthandPropertyAssignment(property)) return expressionSources(property.name);
        if (ts.isSpreadAssignment(property)) return expressionSources(property.expression);
        return new Set<string>();
      }));
    }
    return new Set();
  };

  // Bounded fixed point: simple aliases plus local argument forwarding.
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          if (isProcessEnv(node.initializer, processObjects)) {
            const before = envObjects.size;
            envObjects.add(node.name.text);
            changed ||= envObjects.size !== before;
          } else if (ts.isIdentifier(node.initializer) && envObjects.has(node.initializer.text)) {
            const before = envObjects.size;
            envObjects.add(node.name.text);
            changed ||= envObjects.size !== before;
          }
          if (ts.isIdentifier(node.initializer) && processObjects.has(node.initializer.text)) {
            const before = processObjects.size;
            processObjects.add(node.name.text);
            changed ||= processObjects.size !== before;
          }
          changed ||= add(node.name.text, expressionSources(node.initializer));
        } else if (ts.isObjectBindingPattern(node.name)) {
          const fromProcess = ts.isIdentifier(node.initializer) && processObjects.has(node.initializer.text);
          const fromEnv = isProcessEnv(node.initializer, processObjects)
            || (ts.isIdentifier(node.initializer) && envObjects.has(node.initializer.text));
          for (const element of node.name.elements) {
            const key = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName))
              ? element.propertyName.text
              : ts.isIdentifier(element.name) ? element.name.text : undefined;
            if (!key) continue;
            if (fromProcess && key === 'env') {
              if (ts.isIdentifier(element.name)) {
                const before = envObjects.size;
                envObjects.add(element.name.text);
                changed ||= envObjects.size !== before;
              } else if (ts.isObjectBindingPattern(element.name)) {
                for (const nested of element.name.elements) {
                  if (!ts.isIdentifier(nested.name)) continue;
                  const nestedKey = nested.propertyName && (ts.isIdentifier(nested.propertyName) || ts.isStringLiteralLike(nested.propertyName))
                    ? nested.propertyName.text
                    : nested.name.text;
                  if (isTestControlKey(nestedKey)) changed ||= add(nested.name.text, new Set([nestedKey]));
                }
              }
            } else if (fromEnv && ts.isIdentifier(element.name) && isTestControlKey(key)) {
              changed ||= add(element.name.text, new Set([key]));
            }
          }
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        changed ||= add(node.left.text, expressionSources(node.right));
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
        const key = expressionKey(node.left);
        if (key) changed ||= add(key, expressionSources(node.right));
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const params = functions.get(node.expression.text);
        if (params) {
          params.forEach((parameter, index) => {
            if (node.arguments[index]) changed ||= add(parameter, expressionSources(node.arguments[index]));
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (!changed) break;
  }

  const issues: ProductionTestSeamIssue[] = [];
  const seen = new Set<string>();
  const visitSink = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const rawSink = propertyName(node.expression) ?? (ts.isIdentifier(node.expression) ? node.expression.text : undefined);
      const sink = rawSink ? (sinkAliases.get(rawSink) ?? rawSink) : undefined;
      const indexes = sink && Object.hasOwn(FS_SINK_ARGUMENTS, sink)
        ? FS_SINK_ARGUMENTS[sink]
        : sink && Object.hasOwn(PROCESS_SINK_ARGUMENTS, sink)
          ? PROCESS_SINK_ARGUMENTS[sink]
          : undefined;
      if (sink && indexes) {
        for (const index of indexes) {
          const argument = node.arguments[index];
          if (!argument) continue;
          const sources = expressionSources(argument);
          if (sources.size === 0) continue;
          const position = sourceFile.getLineAndCharacterOfPosition(argument.getStart(sourceFile));
          const key = `${file}:${position.line}:${position.character}:${sink}:${[...sources].sort().join(',')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          issues.push({
            reason: PRODUCTION_TEST_SEAM_REASON,
            file,
            line: position.line + 1,
            column: position.character + 1,
            envKeys: [...sources].sort(),
            sink,
          });
        }
      }
    }
    ts.forEachChild(node, visitSink);
  };
  visitSink(sourceFile);
  return issues;
}

function listTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

function selfTest(): void {
  const filesystemCases: Array<[string, string]> = [
    ['mkdirSync', `mkdirSync(process.env.TEST_TARGET)`],
    ['writeFileSync', `const readyFile = process.env.LATTICE_SMOKE_READY; const alias = readyFile; writeFileSync(alias, 'x')`],
    ['rmSync', `const { TEST_REMOVE: target } = process.env; rmSync(target)`],
    ['renameSync', `const from = process.env.SMOKE_FROM; const to = process.env.SMOKE_TO; renameSync(from, to)`],
    ['writeFile forwarded', `function persist(target: string) { writeFile(target, 'x', () => {}) } const selected = process.env.TEST_FILE; persist(selected)`],
    ['aliased write sink', `import { writeFileSync as persist } from 'node:fs'; const selected = process.env.TEST_FILE; persist(selected, 'x')`],
    ['destructured process env', `const { env } = process; const selected = env.TEST_FILE; writeFileSync(selected, 'x')`],
    ['nested destructured process env', `const { env: { TEST_FILE: selected } } = process; writeFileSync(selected, 'x')`],
  ];
  const processCases: Array<[string, string]> = [
    ['exec command', `exec(process.env.TEST_COMMAND)`],
    ['execFile argv', `const argv = [process.env.SMOKE_ARG]; execFile('/fixed/bin', argv)`],
    ['spawn executable', `const selected = process.env.TEST_EXECUTABLE; spawn(selected, [])`],
    ['spawn cwd', `const cwd = process.env.SMOKE_CWD; spawn('/fixed/bin', [], { cwd })`],
    ['spawn shell', `const shell = process.env.TEST_SHELL; spawn('/fixed/bin', [], { shell })`],
    ['helper-return source', `function selected() { return process.env.TEST_COMMAND } exec(selected())`],
    ['object property assignment', `const options = {}; options.cwd = process.env.SMOKE_CWD; spawn('/fixed/bin', [], options)`],
    ['element process env', `const selected = process['env']['TEST_EXECUTABLE']; spawn(selected, [])`],
    ['aliased process env', `const proc = process; const selected = proc.env.SMOKE_EXECUTABLE; spawn(selected, [])`],
    ['aliased destructured process env', `const proc = process; const { env: runtimeEnv } = proc; exec(runtimeEnv.SMOKE_COMMAND)`],
  ];
  for (const [name, source] of [...filesystemCases, ...processCases]) {
    const issues = analyzeProductionTestSeams(source, `${name}.ts`);
    assert.ok(issues.length > 0, `${name} must reach a modeled sink`);
    assert.equal(issues[0]?.reason, PRODUCTION_TEST_SEAM_REASON);
  }

  const positive = `
    const pathValue = process.env.PATH;
    const rawLimit = process.env.TEST_LIMIT;
    function envPositiveInt(raw: unknown, fallback: number): number {
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
    }
    function fixedMode(raw: unknown): string {
      switch (raw) {
        case 'a': return '/fixed/a';
        case 'b': return '/fixed/b';
        default: return '/fixed/default';
      }
    }
    const limit = envPositiveInt(rawLimit, 2);
    const fixedTarget = fixedMode(process.env.SMOKE_MODE);
    writeFileSync(fixedTarget, String(limit));
    spawn('/fixed/bin', ['--limit', String(limit)], { cwd: '/fixed', env: { PATH: pathValue } });
  `;
  assert.deepEqual(analyzeProductionTestSeams(positive, 'positive.ts'), [], 'bounded numeric/enum sanitizers and PATH reads stay allowed');

  const sanitizerDecoys: Array<[string, string]> = [
    ['numeric tokens plus raw return', `function fake(raw: unknown) { Number(raw); Number.isFinite(Number(raw)); Math.floor(Number(raw)); if (Number(raw) > 0) return raw; return raw; } writeFileSync(fake(process.env.TEST_FILE), 'x')`],
    ['enum literals plus raw return', `function fake(raw: unknown) { if (raw === 'a') return '/fixed/a'; if (raw === 'b') return '/fixed/b'; return raw; } writeFileSync(fake(process.env.SMOKE_FILE), 'x')`],
    ['OR permits Infinity and raw sink value', `function fake(raw: unknown, fallback: string) { const parsed = Number(raw); return Number.isFinite(parsed) || parsed > 0 ? Math.floor(parsed) : fallback; } writeFileSync(String(fake(process.env.TEST_FILE, '/fixed')), 'x')`],
    ['negated finite check is not a safe bound', `function fake(raw: unknown, fallback: string) { const parsed = Number(raw); return !Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback; } exec(String(fake(process.env.TEST_COMMAND, '/fixed')))`],
    ['positive check hidden under alternate OR', `function fake(raw: unknown, fallback: string) { const parsed = Number(raw); return Number.isFinite(parsed) && (parsed > 0 || raw === 'force') ? Math.floor(parsed) : fallback; } spawn(String(fake(process.env.SMOKE_EXECUTABLE, '/fixed')), [])`],
  ];
  for (const [name, source] of sanitizerDecoys) {
    assert.ok(analyzeProductionTestSeams(source, `${name}.ts`).length > 0, `${name} must not be trusted as a sanitizer`);
  }
}

function main(): void {
  selfTest();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert.equal(
    packageJson.scripts?.['test:production-test-seam-guard'],
    'node packages/main/dist/tasks/production-test-seam-guard.js',
    'root package must expose the focused production test seam guard script',
  );
  assert.match(packageJson.scripts?.test ?? '', /npm run test:production-test-seam-guard/, 'root npm test must run the production seam guard');
  const latticeConfig = readFileSync(join(repoRoot, 'lattice.config.json'), 'utf8');
  assert.match(latticeConfig, /packages\/main\/dist\/tasks\/production-test-seam-guard\.js/, 'routine validate must run the production seam guard');
  const scanRoots = [join(repoRoot, 'packages/main/src/core'), join(repoRoot, 'packages/main/src/handlers')];
  const files = scanRoots.flatMap(listTypeScriptFiles);
  assert.ok(files.length > 0, 'production seam guard must scan core and handlers');
  assert.ok(files.every(file => !file.includes(`${join('src', 'tasks')}`)), 'task-only sources must remain outside production scan');
  const issues = files.flatMap(file => analyzeProductionTestSeams(readFileSync(file, 'utf8'), relative(repoRoot, file)));
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`Blocked [${issue.reason}] ${issue.file}:${issue.line}:${issue.column} env=${issue.envKeys.join(',')} -> ${issue.sink}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log('Production test seam guard: PASS — no unsafe SMOKE/TEST control reaches a filesystem or process sink.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
