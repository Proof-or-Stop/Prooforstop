#!/usr/bin/env node
/**
 * Architecture check: static runtime import cycles of the production graph.
 *
 * The CLI can run as one esbuild bundle (scripts/build-cli-bundle.mjs). In a
 * bundle, module-level `const`s become lazily initialized `var`s, so a module
 * that reads a binding of a module still initializing along a cycle gets
 * `undefined` instead of a TDZ ReferenceError: a silent divergence from the
 * per-file build. This smoke parses the EMITTED per-file JavaScript under dist/
 * (exactly the runtime edges tsc kept and esbuild sees; type-only imports are
 * already elided), finds strongly connected components over static `import` /
 * `export … from` edges (dynamic `import()` is lazy and excluded), and fails when
 *   1. an edge that was deliberately cut comes back (CUT_EDGES);
 *   2. the cycle surface grows past the committed ratchet (CYCLE_RATCHET); or
 *   3. any module evaluates, at module load, a binding imported from a module
 *      in its own cycle (INIT-TIME cyclic read). Referencing a hoisted
 *      `export function` without calling it is safe in both runtimes; calling
 *      it, or reading any other binding, depends on evaluation order.
 * `--report` prints every component and its internal edges instead.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Edges removed on purpose (dist-relative, no extension). Each closed a cycle
 * through modules every CLI call evaluates. [from, to, where the symbols live now]
 */
export const CUT_EDGES: ReadonlyArray<readonly [string, string, string]> = [
  ['core/evidence-freshness', 'core/story-aware-validation', 'core/story-change-manifest'],
  ['core/managed-host-run', 'core/delivery-check-hash', 'core/delivery-check-signature'],
  ['core/causal-evidence', 'core/validation-execution-lock', 'core/shared-lock-root'],
  ['core/story-owner-lease', 'core/validation-execution-lock', 'core/shared-lock-root'],
  ['core/dirty-gate-policy', 'core/validation-execution-lock', 'core/shared-lock-root'],
  ['core/story-owner-lease', 'core/convergence-breaker', 'core/convergence-state-files'],
  ['core/validation-evidence-reuse', 'core/validation-executor', 'core/validation-timeouts'],
  ['core/validation-command-identity', 'core/validation-executor', 'core/validation-timeouts'],
];

/**
 * Upper bounds for the cycles that remain, measured when the cuts above landed:
 * the 54-module core component shrank to 26, then certification-window's
 * createRequire sibling lookup (broken inside the bundle) became a static
 * namespace import read only at call time, joining it (27). Lower these when a
 * cycle is cut; never raise them to admit a new cycle.
 */
export const CYCLE_RATCHET = {
  largestComponent: 27,
  componentCount: 10,
  filesInCycles: 52,
};

function listProductionModules(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (relative(root, path).split(sep).join('/') === 'tasks') continue;
        walk(path);
      } else if (name.endsWith('.js')) {
        out.push(relative(root, path).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

interface ModuleInfo {
  source: ts.SourceFile;
  /** local import name -> [target module, imported name] for relative static imports. */
  imports: Map<string, readonly [string, string]>;
  targets: Set<string>;
  /** names of top-level `export function` declarations (hoisted). */
  hoistedExports: Set<string>;
}

export interface ImportGraph {
  modules: string[];
  info: Map<string, ModuleInfo>;
}

export function buildImportGraph(root = distRoot): ImportGraph {
  const modules = listProductionModules(root);
  const known = new Set(modules);
  const info = new Map<string, ModuleInfo>();
  for (const module of modules) {
    const source = ts.createSourceFile(module, readFileSync(join(root, module), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports = new Map<string, readonly [string, string]>();
    const targets = new Set<string>();
    const hoistedExports = new Set<string>();
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name
        && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        hoistedExports.add(statement.name.text);
      }
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
      const target = relative(root, resolve(root, dirname(module), specifier.text)).split(sep).join('/');
      if (!known.has(target)) continue;
      targets.add(target);
      const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
      if (clause?.name) imports.set(clause.name.text, [target, 'default']);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, [target, '*']);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) imports.set(element.name.text, [target, (element.propertyName ?? element.name).text]);
      }
    }
    info.set(module, { source, imports, targets, hoistedExports });
  }
  return { modules, info };
}

/** Tarjan's SCC algorithm (iterative); only components that form a cycle. */
export function cyclicComponents(graph: ImportGraph): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  for (const start of graph.modules) {
    if (indices.has(start)) continue;
    const work: Array<{ node: string; iterator: Iterator<string> }> = [];
    const visit = (node: string): void => {
      indices.set(node, index); lowlink.set(node, index); index++;
      stack.push(node); onStack.add(node);
      work.push({ node, iterator: (graph.info.get(node)?.targets ?? new Set<string>()).values() });
    };
    visit(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const next = frame.iterator.next();
      if (!next.done) {
        const target = next.value;
        if (!indices.has(target)) visit(target);
        else if (onStack.has(target)) lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, indices.get(target)!));
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.node;
        lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(frame.node)!));
      }
      if (lowlink.get(frame.node) === indices.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do { member = stack.pop()!; onStack.delete(member); component.push(member); } while (member !== frame.node);
        if (component.length > 1 || graph.info.get(frame.node)?.targets.has(frame.node)) components.push(component.sort());
      }
    }
  }
  return components.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
}

const isFunctionLike = (node: ts.Node): boolean => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
  || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
  || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node);

const unwrap = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);

/** Identifiers read and called while `node` evaluates (function bodies only when invoked). */
function evaluationRefs(node: ts.Node, reads: Set<string>, calls: Set<string>): void {
  const visit = (current: ts.Node): void => {
    if (current !== node && isFunctionLike(current)) return;
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      // Only heritage, computed keys, decorators and static members run at definition.
      for (const clause of current.heritageClauses ?? []) visit(clause);
      for (const member of current.members) {
        if (member.name && ts.isComputedPropertyName(member.name)) visit(member.name);
        const isStatic = ts.canHaveModifiers(member) && ts.getModifiers(member)?.some(m => m.kind === ts.SyntaxKind.StaticKeyword);
        if (ts.isPropertyDeclaration(member) && isStatic && member.initializer) visit(member.initializer);
        if (ts.isClassStaticBlockDeclaration(member)) visit(member.body);
      }
      return;
    }
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      const callee = unwrap(current.expression);
      if (ts.isIdentifier(callee)) calls.add(callee.text);
      if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) evaluationRefs(callee.body, reads, calls);
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) calls.add(callee.expression.text);
    }
    if (ts.isTaggedTemplateExpression(current) && ts.isIdentifier(current.tag)) calls.add(current.tag.text);
    if (ts.isIdentifier(current)) {
      const parent = current.parent;
      const isPropertyName = parent && ((ts.isPropertyAccessExpression(parent) && parent.name === current)
        || (ts.isPropertyAssignment(parent) && parent.name === current));
      if (!isPropertyName) reads.add(current.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
}

export function initTimeCyclicReads(graph: ImportGraph, components: string[][]): string[] {
  const findings: string[] = [];
  for (const component of components) {
    const members = new Set(component);
    for (const module of component) {
      const { source, imports } = graph.info.get(module)!;
      const cyclic = new Map([...imports].filter(([, [target]]) => members.has(target)));
      if (cyclic.size === 0) continue;
      const localFunctions = new Map<string, ts.Node>();
      for (const statement of source.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) localFunctions.set(statement.name.text, statement.body);
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            const init = declaration.initializer && unwrap(declaration.initializer);
            if (ts.isIdentifier(declaration.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
              localFunctions.set(declaration.name.text, init.body);
            }
          }
        }
      }
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) || ts.isFunctionDeclaration(statement)
          || (ts.isExportDeclaration(statement) && statement.moduleSpecifier)) continue;
        const reads = new Set<string>();
        const calls = new Set<string>();
        evaluationRefs(statement, reads, calls);
        // Local functions invoked while this statement evaluates run now too.
        const pending = [...calls].filter(name => localFunctions.has(name));
        const expanded = new Set<string>();
        while (pending.length > 0) {
          const name = pending.pop()!;
          if (expanded.has(name)) continue;
          expanded.add(name);
          const nestedCalls = new Set<string>();
          evaluationRefs(localFunctions.get(name)!, reads, nestedCalls);
          for (const call of nestedCalls) { calls.add(call); if (localFunctions.has(call)) pending.push(call); }
        }
        for (const name of reads) {
          const binding = cyclic.get(name);
          if (!binding) continue;
          const [target, imported] = binding;
          const hoisted = graph.info.get(target)!.hoistedExports.has(imported);
          if (hoisted && !calls.has(name)) continue;
          const line = source.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
          findings.push(`${module}:${line} evaluates ${imported} from ${target} at module load (same import cycle)`);
        }
      }
    }
  }
  return findings;
}

const strip = (module: string): string => module.replace(/\.js$/, '');

/** The detector must flag order-dependent reads and accept hoisted references. */
function selfTest(): void {
  const dir = mkdtempSync(join(tmpdir(), 'import-cycles-selftest-'));
  try {
    writeFileSync(join(dir, 'a.js'), [
      "import { hoisted, value, make } from './b.js';",
      'export const alias = hoisted;',            // reference only: safe
      'export const copy = value;',               // const read: order-dependent
      'const built = make();',                    // call: order-dependent
      'function later() { return value; }',       // runs only when called: safe
      'export function fromA() { return 1; }',
    ].join('\n'));
    writeFileSync(join(dir, 'b.js'), [
      "import { fromA } from './a.js';",
      'export function hoisted() { return fromA(); }',
      'export const value = 1;',
      'export function make() { return value; }',
    ].join('\n'));
    const graph = buildImportGraph(dir);
    const components = cyclicComponents(graph);
    assert.deepEqual(components, [['a.js', 'b.js']]);
    const findings = initTimeCyclicReads(graph, components).map(finding => finding.replace(/ from .*/, ''));
    assert.deepEqual(findings.sort(), ['a.js:3 evaluates value', 'a.js:4 evaluates make'].sort(), findings.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  selfTest();
  if (!existsSync(join(distRoot, 'cli.js'))) throw new Error(`no emitted CLI under ${distRoot}; build first`);
  const graph = buildImportGraph();
  const components = cyclicComponents(graph);
  const filesInCycles = components.reduce((sum, component) => sum + component.length, 0);
  const initReads = initTimeCyclicReads(graph, components);
  if (process.argv.includes('--report')) {
    for (const component of components) {
      console.log(`SCC (${component.length}): ${component.map(strip).join(', ')}`);
      const members = new Set(component);
      for (const module of component) {
        for (const target of graph.info.get(module)!.targets) if (members.has(target)) console.log(`  ${strip(module)} -> ${strip(target)}`);
      }
    }
    for (const finding of initReads) console.log(`INIT-TIME: ${finding}`);
    console.log(`import-cycles: ${components.length} components, ${filesInCycles} files, largest ${components[0]?.length ?? 0}, ${initReads.length} init-time cyclic reads`);
    return;
  }
  const failures: string[] = [];
  for (const [from, to, now] of CUT_EDGES) {
    if (graph.info.get(`${from}.js`)?.targets.has(`${to}.js`)) failures.push(`cut edge returned: ${from} -> ${to} (import from ${now} instead)`);
  }
  const largest = components[0]?.length ?? 0;
  if (largest > CYCLE_RATCHET.largestComponent) failures.push(`largest cycle grew to ${largest} > ${CYCLE_RATCHET.largestComponent}: ${components[0]!.map(strip).join(', ')}`);
  if (components.length > CYCLE_RATCHET.componentCount) failures.push(`cycle count grew to ${components.length} > ${CYCLE_RATCHET.componentCount}`);
  if (filesInCycles > CYCLE_RATCHET.filesInCycles) failures.push(`files in cycles grew to ${filesInCycles} > ${CYCLE_RATCHET.filesInCycles}`);
  failures.push(...initReads.map(finding => `init-time cyclic read: ${finding}`));
  assert.deepEqual(failures, [], `import cycle regression (run with --report for the components):\n${failures.join('\n')}`);
  console.log(`import-cycles-smoke: PASS (${graph.modules.length} modules; ${components.length} cycles, ${filesInCycles} files, largest ${largest}; ${CUT_EDGES.length} cut edges held; 0 init-time cyclic reads)`);
}

main();
