import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { CoverageAdapterResultV1, CoverageDiscoveryMethodV1, PlannedCoveragePathV1 } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { PROCESS_FACT_REGISTRY, type ProcessFactRegistryEntry } from './process-fact-registry.js';
import { RUNTIME_FACT_REGISTRY } from './runtime-fact-registry.js';
import { loadConfig } from './config.js';

export const ACCEPTANCE_PLAN_DISCOVERY_PROFILE = {
  ref: 'profile:typescript-proof-gate:plan:v1',
  methods: ['scope_contract', 'process_fact_registry', 'handler_dispatch_inventory', 'static_call_graph', 'runtime_trace'] as CoverageDiscoveryMethodV1[],
} as const;

export interface AcceptanceDiscoveryInput {
  supported: boolean;
  workspaceRoot: string;
  storyId: string;
  plannedPathRecords: PlannedCoveragePathV1[];
  scopeRefs: string[];
  /** Test-only bounded runtime observations; production derives without caller-authored paths. */
  runtimeObservedPathRefs?: string[];
}

export interface RegisteredProcessFactClosure {
  pathRefs: string[];
  sourceInventoryRefs: string[];
  sourceFileRefs: string[];
  blindSpots: string[];
  entries: ProcessFactRegistryEntry[];
}

export interface AcceptanceDiscoveryDiagnostic {
  code: 'AT_REQUIRED_ADAPTER_RESULT_MISSING' | 'AT_ADAPTER_RESULT_DIGEST_MISMATCH' | 'AT_ADAPTER_RESULT_INVALID' | 'AT_DISCOVERY_DISAGREEMENT';
  message: string;
  adapterId?: string;
}

export interface AcceptanceDiscoveryReconciliation {
  adapterResults: CoverageAdapterResultV1[];
  enumeratedPathRefs: string[];
  blindSpots: string[];
  diagnostics: AcceptanceDiscoveryDiagnostic[];
  status: 'complete' | 'partial' | 'unsupported';
}

function stable(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim().length > 0))].sort();
}

function sourceFiles(entry: ProcessFactRegistryEntry): string[] {
  return stable([...(entry.producerSourceRefs ?? []), ...(entry.consumerSourceRefs ?? [])]);
}

function processFactPath(entry: ProcessFactRegistryEntry): string {
  return `path:process-fact:${entry.name}->consumer:${entry.consumerGate ?? '<audit-only>'}`;
}

interface FactoryInventory {
  factory: string;
  sourceFile: string;
  registered: boolean;
  commandKeys: string[];
}

interface BoundedSourceGraph {
  seedFiles: string[];
  sourceInventoryFiles: string[];
  closureFiles: string[];
  entries: ProcessFactRegistryEntry[];
  factories: FactoryInventory[];
  sourceScans: Map<string, LocalImportCallScan>;
  blindSpots: string[];
}

interface LocalImportCallScan {
  imports: Array<{ imported: string; local: string; sourceFile: string }>;
  calledImports: Array<{ imported: string; local: string; sourceFile: string }>;
  blindSpots: string[];
  unresolvedImports: string[];
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const SOURCE_INVENTORY_EXCLUDED_DIRECTORIES = new Set(['.git', '.lattice', '.worktrees', 'dist', 'node_modules']);
const DEFAULT_SOURCE_INVENTORY_BUDGET = {
  maxDirectories: 10_000,
  maxEntries: 100_000,
  maxFiles: 20_000,
  maxBytes: 100 * 1024 * 1024,
} as const;
const MAX_LEXICAL_SOURCE_BYTES = 2 * 1024 * 1024;

export interface SourceInventoryTraversalBudget {
  maxDirectories: number;
  maxEntries: number;
  maxFiles: number;
  maxBytes: number;
}

export interface SourceInventoryTraversalResult {
  files: string[];
  blindSpots: string[];
  stopped: boolean;
  stats: { directories: number; entries: number; files: number; bytes: number };
}

function relativeFile(root: string, absolute: string): string | null {
  const value = relative(root, absolute).replace(/\\/g, '/');
  return value.startsWith('../') || value === '..' ? null : value;
}

function resolveLocalImport(root: string, importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(root, dirname(importer), specifier);
  const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, resolve(base, 'index.ts')];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const rel = relativeFile(root, candidate);
    if (rel) return rel;
  }
  return null;
}

/** Deterministic, globally budgeted source-tree walk. Exported for bounded mutation tests. */
export function enumerateBoundedSourceTree(
  physicalWorkspace: string,
  physicalSourceRoot: string,
  budget: SourceInventoryTraversalBudget = DEFAULT_SOURCE_INVENTORY_BUDGET,
): SourceInventoryTraversalResult {
  const files: string[] = [];
  const blindSpots: string[] = [];
  const stats = { directories: 0, entries: 0, files: 0, bytes: 0 };
  const directories = [physicalSourceRoot];
  let stopped = false;
  const stop = (dimension: keyof SourceInventoryTraversalBudget): void => {
    if (!stopped) blindSpots.push(`configured source-root inventory exhausted ${dimension} budget`);
    stopped = true;
  };
  while (directories.length > 0 && !stopped) {
    if (stats.directories >= budget.maxDirectories) { stop('maxDirectories'); break; }
    const directory = directories.pop()!;
    stats.directories += 1;
    let rows;
    try { rows = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { blindSpots.push(`configured source directory is unreadable: ${relativeFile(physicalWorkspace, directory) ?? directory}`); continue; }
    const childDirectories: string[] = [];
    for (const row of rows) {
      if (stats.entries >= budget.maxEntries) { stop('maxEntries'); break; }
      stats.entries += 1;
      if (SOURCE_INVENTORY_EXCLUDED_DIRECTORIES.has(row.name)) continue;
      const absolute = resolve(directory, row.name);
      if (row.isSymbolicLink()) { blindSpots.push(`ambiguous source-root symlink excluded: ${relativeFile(physicalWorkspace, absolute) ?? absolute}`); continue; }
      if (row.isDirectory()) {
        if (stats.directories + directories.length + childDirectories.length >= budget.maxDirectories) { stop('maxDirectories'); break; }
        childDirectories.push(absolute);
        continue;
      }
      const dot = row.name.lastIndexOf('.');
      if (!row.isFile() || dot < 0 || !SOURCE_EXTENSIONS.has(row.name.slice(dot))) continue;
      if (stats.files >= budget.maxFiles) { stop('maxFiles'); break; }
      let size: number;
      try { size = lstatSync(absolute).size; }
      catch { blindSpots.push(`configured source file is unreadable: ${relativeFile(physicalWorkspace, absolute) ?? absolute}`); continue; }
      if (stats.bytes + size > budget.maxBytes) { stop('maxBytes'); break; }
      const file = relativeFile(physicalWorkspace, absolute);
      if (!file) { blindSpots.push(`configured source file physically escapes workspace: ${absolute}`); continue; }
      files.push(file);
      stats.files += 1;
      stats.bytes += size;
    }
    for (let index = childDirectories.length - 1; index >= 0 && !stopped; index -= 1) directories.push(childDirectories[index]);
  }
  return { files, blindSpots: stable(blindSpots), stopped, stats };
}

function configuredSourceInventory(workspaceRoot: string): { files: string[]; blindSpots: string[] } {
  const configPath = resolve(workspaceRoot, 'lattice.config.json');
  if (!existsSync(configPath)) return { files: [], blindSpots: ['canonical lattice.config.json is missing; source-root inventory is unavailable'] };
  let rawConfig: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('top-level value must be an object');
    rawConfig = parsed as Record<string, unknown>;
  } catch (error) {
    return { files: [], blindSpots: [`canonical source-root config is unreadable: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const configuredScanRoot = rawConfig.scanRoot;
  const configuredRootDir = rawConfig.rootDir;
  if (typeof configuredScanRoot !== 'string' || configuredScanRoot.trim().length === 0
    || isAbsolute(configuredScanRoot) || configuredScanRoot.split(/[\\/]/).includes('..')
    || (configuredRootDir !== undefined && (typeof configuredRootDir !== 'string' || configuredRootDir.trim().length === 0
      || isAbsolute(configuredRootDir) || configuredRootDir.split(/[\\/]/).includes('..')))) {
    return { files: [], blindSpots: ['canonical scanRoot/rootDir is missing or ambiguous'] };
  }
  let config;
  try { config = loadConfig(workspaceRoot); }
  catch (error) { return { files: [], blindSpots: [`canonical source-root config is unreadable: ${error instanceof Error ? error.message : String(error)}`] }; }
  const relativeRoot = config.rootDir ? join(config.scanRoot, config.rootDir) : config.scanRoot;
  let physicalWorkspace: string;
  try {
    physicalWorkspace = realpathSync(workspaceRoot);
  } catch {
    return { files: [], blindSpots: ['canonical workspace root is missing or unreadable'] };
  }
  let absoluteRoot = physicalWorkspace;
  for (const component of relativeRoot.split(/[\\/]/).filter(value => value.length > 0 && value !== '.')) {
    absoluteRoot = resolve(absoluteRoot, component);
    let componentStat;
    try { componentStat = lstatSync(absoluteRoot); }
    catch { return { files: [], blindSpots: [`configured source root is missing or unreadable: ${relativeRoot}`] }; }
    if (componentStat.isSymbolicLink()) return { files: [], blindSpots: [`configured source root traverses symlink component: ${relativeRoot}`] };
    if (!componentStat.isDirectory()) return { files: [], blindSpots: [`configured source root component is not a directory: ${relativeRoot}`] };
    if ((componentStat.mode & 0o444) === 0 || (componentStat.mode & 0o111) === 0) {
      return { files: [], blindSpots: [`configured source root is unreadable: ${relativeRoot}`] };
    }
  }
  let physicalSourceRoot: string;
  try { physicalSourceRoot = realpathSync(absoluteRoot); }
  catch { return { files: [], blindSpots: [`configured source root is missing or unreadable: ${relativeRoot}`] }; }
  const physicalRelative = relative(physicalWorkspace, physicalSourceRoot);
  if (physicalRelative.startsWith('..') || isAbsolute(physicalRelative)) {
    return { files: [], blindSpots: [`configured source root physically escapes workspace: ${relativeRoot}`] };
  }
  const canonicalRelativeRoot = relativeFile(physicalWorkspace, physicalSourceRoot);
  if (!canonicalRelativeRoot) return { files: [], blindSpots: [`configured source root physically escapes workspace: ${relativeRoot}`] };
  absoluteRoot = physicalSourceRoot;
  const traversal = enumerateBoundedSourceTree(physicalWorkspace, absoluteRoot);
  return { files: traversal.files, blindSpots: traversal.blindSpots };
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function analyzeLocalImportCalls(root: string, file: string): LocalImportCallScan {
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) return { imports: [], calledImports: [], blindSpots: [`uninspectable source file ${file}`], unresolvedImports: [] };
  const text = readFileSync(absolute, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_LEXICAL_SOURCE_BYTES) {
    return { imports: [], calledImports: [], blindSpots: [`source file exceeds lexical scan budget: ${file}`], unresolvedImports: [] };
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    return { imports: [], calledImports: [], blindSpots: [`typescript parse ambiguity in ${file}`], unresolvedImports: [] };
  }
  const imports: Array<{ imported: string; local: string; sourceFile: string }> = [];
  const unresolved: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')) continue;
    const sourceFile = resolveLocalImport(root, file, statement.moduleSpecifier.text);
    if (!sourceFile) { unresolved.push(`unresolved local import ${statement.moduleSpecifier.text} from ${file}`); continue; }
    const clause = statement.importClause;
    if (clause?.isTypeOnly) continue;
    if (clause?.name) imports.push({ imported: 'default', local: clause.name.text, sourceFile });
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) imports.push({ imported: element.propertyName?.text ?? element.name.text, local: element.name.text, sourceFile });
    }
  }
  const calledNames = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calledNames.add(node.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, calledImports: imports.filter(item => calledNames.has(item.local)), blindSpots: [], unresolvedImports: stable(unresolved) };
}

function returnedHandlerKeys(root: string, file: string): string[] {
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) return [];
  const text = executableText(readFileSync(absolute, 'utf8'));
  const returnIndex = text.indexOf('return {');
  if (returnIndex < 0) return [];
  const body = text.slice(returnIndex + 'return {'.length);
  return stable([...body.matchAll(/^\s+([a-z][a-z0-9_]*)\s*(?:\([^\n]*\)\s*(?::[^\n{]+)?\{|:\s*)/gm)].map(match => match[1]));
}

function commandNamesForEntry(entry: ProcessFactRegistryEntry): string[] {
  const producerCommands = (entry.artifact?.producerCommand ?? '').split('/').filter(value => /^[a-z][a-z0-9_]*$/.test(value));
  return stable([...producerCommands, ...(/^[a-z][a-z0-9_]*$/.test(entry.name) ? [entry.name] : [])]);
}

function sourceSeedFiles(input: AcceptanceDiscoveryInput): string[] {
  return stable([
    ...input.scopeRefs.filter(ref => ref.startsWith('scope:file:')).map(ref => ref.slice('scope:file:'.length)),
    ...input.plannedPathRecords.flatMap(record => [record.producer, ...record.consumers].map(endpoint => endpoint.expectedFileRef)),
  ]);
}

function buildBoundedSourceGraph(input: AcceptanceDiscoveryInput): BoundedSourceGraph {
  const root = input.workspaceRoot;
  const seedFiles = sourceSeedFiles(input);
  const sourceInventory = configuredSourceInventory(root);
  const blindSpots: string[] = [...sourceInventory.blindSpots];
  const registryFiles = stable(['packages/main/src/registry.ts', ...PROCESS_FACT_REGISTRY.flatMap(sourceFiles)
    .filter(file => existsSync(resolve(root, file)) && executableText(readFileSync(resolve(root, file), 'utf8')).includes('registerBatch('))]);
  const factories: FactoryInventory[] = [];
  for (const registryFile of registryFiles) {
    const absolute = resolve(root, registryFile);
    if (!existsSync(absolute)) continue;
    const text = executableText(readFileSync(absolute, 'utf8'));
    const registryScan = analyzeLocalImportCalls(root, registryFile);
    blindSpots.push(...registryScan.blindSpots, ...registryScan.unresolvedImports);
    const imports = registryScan.imports;
    const registrations = new Set([...text.matchAll(/registry\.registerBatch\(\s*([A-Za-z_$][\w$]*)\s*\(\s*ctx\s*\)\s*\)/g)].map(match => match[1]));
    for (const imported of imports.filter(item => /Handlers$/.test(item.imported) || /Handlers$/.test(item.local))) {
      if (!seedFiles.includes(imported.sourceFile)) continue;
      const registered = registrations.has(imported.local);
      const commandKeys = returnedHandlerKeys(root, imported.sourceFile);
      factories.push({ factory: imported.local, sourceFile: imported.sourceFile, registered, commandKeys });
      if (!registered) blindSpots.push(`handler factory ${imported.local} from ${imported.sourceFile} lacks exact registerBatch(factory(ctx))`);
      if (commandKeys.length === 0) blindSpots.push(`handler factory ${imported.local} from ${imported.sourceFile} has ambiguous or empty returned command object`);
    }
  }
  const handlerCommands = new Set(factories.flatMap(factory => factory.commandKeys));
  const inferredHandlerFiles = new Map<string, string>();
  for (const factory of factories) for (const command of factory.commandKeys) inferredHandlerFiles.set(command, factory.sourceFile);
  const entryFiles = (entry: ProcessFactRegistryEntry): string[] => stable([
    ...sourceFiles(entry),
    ...commandNamesForEntry(entry).map(command => inferredHandlerFiles.get(command) ?? '').filter(Boolean),
  ]);
  const closure = new Set(seedFiles);
  const reached = new Set<ProcessFactRegistryEntry>();
  const hubs = new Set(registryFiles);
  const boundedUniverse = sourceInventory.files;
  const sourceScans = new Map(boundedUniverse.map(file => [file, analyzeLocalImportCalls(root, file)]));
  blindSpots.push(...[...sourceScans.values()].flatMap(scan => scan.blindSpots));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of PROCESS_FACT_REGISTRY) {
      const files = entryFiles(entry).filter(file => !hubs.has(file));
      const commandMatch = commandNamesForEntry(entry).some(command => handlerCommands.has(command));
      if (!commandMatch && !files.some(file => closure.has(file))) continue;
      if (!reached.has(entry)) { reached.add(entry); changed = true; }
      for (const file of files) if (!closure.has(file)) { closure.add(file); changed = true; }
    }
    for (const file of boundedUniverse.filter(file => !hubs.has(file) && !closure.has(file))) {
      if ((sourceScans.get(file)?.calledImports ?? []).some(item => closure.has(item.sourceFile))) { closure.add(file); changed = true; }
    }
  }
  for (const entry of reached) {
    for (const file of entryFiles(entry)) if (!existsSync(resolve(root, file))) blindSpots.push(`uninspectable registered source ${file} for ${entry.name}`);
    if (entry.consumerGate) {
      const explicitConsumer = (entry.consumerSourceRefs ?? []).some(file => existsSync(resolve(root, file)));
      const producerFiles = stable([
        ...(entry.producerSourceRefs ?? []),
        ...commandNamesForEntry(entry).map(command => inferredHandlerFiles.get(command) ?? '').filter(Boolean),
      ]);
      const discoveredConsumer = sourceInventory.files.some(file => !hubs.has(file) && !producerFiles.includes(file)
        && (sourceScans.get(file)?.calledImports ?? []).some(item => producerFiles.includes(item.sourceFile)));
      if (!explicitConsumer && !discoveredConsumer) blindSpots.push(`process fact ${entry.name} has consumerGate but no resolvable consumer source`);
    }
  }
  return { seedFiles, sourceInventoryFiles: sourceInventory.files, closureFiles: stable([...closure]), entries: [...reached], factories, sourceScans, blindSpots: stable(blindSpots) };
}

/** Resolve canonical process-fact closure and its producer/consumer source files. */
export function deriveRegisteredProcessFactClosure(workspaceRoot: string, seedRefs: readonly string[]): RegisteredProcessFactClosure {
  const graph = buildBoundedSourceGraph({ supported: true, workspaceRoot, storyId: '<closure>', plannedPathRecords: [], scopeRefs: seedRefs.map(ref => ref.startsWith('scope:file:') ? ref : `scope:file:${ref}`) });
  const reached = graph.entries;
  return {
    pathRefs: stable(reached.map(processFactPath)),
    sourceInventoryRefs: stable(reached.flatMap(entry => [
      `process-fact:${entry.name}:${digestCanonicalJson(entry)}`,
      ...((entry.producerSourceRefs ?? []).map(file => `source-file:producer:${encodeURIComponent(entry.name)}:${file}`)),
      ...((entry.consumerSourceRefs ?? []).map(file => `source-file:consumer:${encodeURIComponent(entry.name)}:${file}`)),
      ...(entry.artifact ? [`artifact:${entry.artifact.path}`] : []),
    ]).concat(graph.closureFiles.map(file => `source-file:closure:${file}`))),
    sourceFileRefs: graph.closureFiles,
    blindSpots: graph.blindSpots,
    entries: reached,
  };
}

function unsignedResult(result: CoverageAdapterResultV1): Omit<CoverageAdapterResultV1, 'resultDigest'> {
  const { resultDigest: _resultDigest, ...unsigned } = result;
  return unsigned;
}

export function digestCoverageAdapterResult(result: Omit<CoverageAdapterResultV1, 'resultDigest'>): string {
  return `sha256:${digestCanonicalJson(result)}`;
}

function adapterId(method: CoverageDiscoveryMethodV1): string {
  return `${method.replace(/_/g, '-')}:plan:v1`;
}

function sourceProvenance(root: string, file: string): string {
  const absolute = resolve(root, file);
  return existsSync(absolute)
    ? `source-file:${file}:sha256:${digestCanonicalJson(readFileSync(absolute, 'utf8'))}`
    : `source-file:${file}:uninspectable`;
}

function executableText(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import\b.*$/gm, '');
}

function catalogCommands(root: string): Set<string> {
  const file = resolve(root, 'packages/main/src/cli/command-catalog.ts');
  if (!existsSync(file)) return new Set();
  return new Set([...executableText(readFileSync(file, 'utf8')).matchAll(/^\s*\{?\s*name:\s*['"]([a-z][a-z0-9_]*)['"]/gm)].map(match => match[1]));
}

function staticCallPaths(root: string, graph: BoundedSourceGraph): { paths: string[]; blindSpots: string[] } {
  const paths: string[] = [];
  const blindSpots: string[] = [];
  for (const file of graph.closureFiles.filter(value => !value.endsWith('/registry.ts'))) {
    const absolute = resolve(root, file);
    if (!existsSync(absolute)) continue;
    const scan = graph.sourceScans.get(file) ?? analyzeLocalImportCalls(root, file);
    blindSpots.push(...scan.blindSpots, ...scan.unresolvedImports);
    for (const imported of scan.calledImports) {
      if (!graph.closureFiles.includes(imported.sourceFile) || /Handlers$/.test(imported.imported)) continue;
      paths.push(`path:static-call:${imported.sourceFile}#${imported.imported}->consumer:${file}#${imported.local}`);
    }
  }
  return { paths: stable(paths), blindSpots: stable(blindSpots) };
}

function buildResult(
  input: AcceptanceDiscoveryInput,
  method: CoverageDiscoveryMethodV1,
  prebuiltGraph?: BoundedSourceGraph,
): CoverageAdapterResultV1 {
  const unsupported = !input.supported;
  const boundedRuntime = method === 'runtime_trace';
  let pathRefs: string[] = [];
  let blindSpots: string[] = [];
  let provenanceRefs: string[] = [];
  if (!unsupported) {
    const graph = prebuiltGraph ?? buildBoundedSourceGraph(input);
    if (method === 'scope_contract') {
      pathRefs = input.plannedPathRecords.map(record => record.plannedPathRef);
      provenanceRefs = stable([
        ...input.scopeRefs,
        ...input.plannedPathRecords.flatMap(record => [record.producer, ...record.consumers])
          .map(endpoint => sourceProvenance(input.workspaceRoot, endpoint.expectedFileRef)),
      ]);
    } else if (method === 'process_fact_registry') {
      pathRefs = graph.entries.map(processFactPath);
      blindSpots = graph.blindSpots;
      provenanceRefs = stable(graph.entries.flatMap(entry => [`process-fact:${entry.name}:${digestCanonicalJson(entry)}`, ...sourceFiles(entry).map(file => sourceProvenance(input.workspaceRoot, file))]));
    } else if (method === 'handler_dispatch_inventory') {
      const commands = catalogCommands(input.workspaceRoot);
      const registeredKeys = new Set(graph.factories.filter(factory => factory.registered).flatMap(factory => factory.commandKeys));
      const inspectableEntries = graph.entries.filter(entry => commandNamesForEntry(entry).some(command => registeredKeys.has(command) && commands.has(command)));
      pathRefs = inspectableEntries.map(processFactPath);
      blindSpots = stable([
        ...graph.blindSpots,
        ...graph.factories.filter(factory => !factory.registered).map(factory => `unregistered handler factory ${factory.factory}`),
        ...[...registeredKeys].filter(command => !commands.has(command)).map(command => `registered handler command ${command} has no exact command catalog binding`),
        ...graph.entries.filter(entry => commandNamesForEntry(entry).length > 0 && !inspectableEntries.includes(entry)).map(entry => `registered process fact ${entry.name} has no exact registered handler/catalog dispatch`),
      ]);
      provenanceRefs = stable(['packages/main/src/cli/command-catalog.ts', 'packages/main/src/registry.ts', ...graph.factories.map(factory => factory.sourceFile)]
        .map(file => sourceProvenance(input.workspaceRoot, file)));
    } else if (method === 'static_call_graph') {
      const inspectableEntries = graph.entries.filter(entry => sourceFiles(entry).every(file => existsSync(resolve(input.workspaceRoot, file))));
      const staticCalls = staticCallPaths(input.workspaceRoot, graph);
      pathRefs = inspectableEntries.map(processFactPath);
      pathRefs.push(...staticCalls.paths);
      blindSpots = stable([...graph.blindSpots, ...staticCalls.blindSpots, ...graph.entries.filter(entry => !inspectableEntries.includes(entry)).map(entry => `static registered source graph is incomplete for ${entry.name}`)]);
      provenanceRefs = stable(graph.closureFiles.map(file => sourceProvenance(input.workspaceRoot, file)));
    } else {
      pathRefs = stable(input.runtimeObservedPathRefs ?? []);
      provenanceRefs = [
        `runtime-fact-registry:sha256:${digestCanonicalJson(RUNTIME_FACT_REGISTRY)}`,
        `runtime-trace:story:${input.storyId}:bounded`,
      ];
    }
  }
  const unsigned: Omit<CoverageAdapterResultV1, 'resultDigest'> = {
    schemaVersion: 'proofstory.coverage_adapter_result.v1',
    adapterId: adapterId(method),
    method,
    pathRefs: stable(pathRefs),
    coverageClaim: unsupported ? 'unsupported' : blindSpots.length > 0 ? 'partial' : 'complete_for_scope',
    blindSpots: unsupported ? [`unsupported discovery profile for ${method}`] : stable(blindSpots),
    provenanceRefs: stable(provenanceRefs.length > 0 ? provenanceRefs : [`registered:${method}:v1`]),
    asymmetryPolicy: {
      kind: unsupported ? 'unsupported' : boundedRuntime ? 'bounded_non_exhaustive' : 'exhaustive',
      policyRef: unsupported ? 'policy:unsupported:v1' : boundedRuntime ? 'policy:bounded-runtime:v1' : `policy:${method}:v1`,
      scopeRefs: stable(input.scopeRefs),
    },
  };
  return { ...unsigned, resultDigest: digestCoverageAdapterResult(unsigned) };
}

/** Run the immutable PLAN profile from canonical repository and registry inputs. */
export function runAcceptanceDiscoveryAdapters(input: AcceptanceDiscoveryInput): CoverageAdapterResultV1[] {
  const graph = input.supported ? buildBoundedSourceGraph(input) : undefined;
  return ACCEPTANCE_PLAN_DISCOVERY_PROFILE.methods.map(method => buildResult(input, method, graph));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function reconcileAcceptanceDiscoveryResults(results: readonly CoverageAdapterResultV1[]): AcceptanceDiscoveryReconciliation {
  const diagnostics: AcceptanceDiscoveryDiagnostic[] = [];
  const byMethod = new Map<CoverageDiscoveryMethodV1, CoverageAdapterResultV1[]>();
  for (const result of results) {
    const rows = byMethod.get(result.method) ?? [];
    rows.push(result);
    byMethod.set(result.method, rows);
    if (result.schemaVersion !== 'proofstory.coverage_adapter_result.v1' || !result.adapterId || !Array.isArray(result.provenanceRefs) || result.provenanceRefs.length === 0
      || !['complete_for_scope', 'partial', 'unsupported'].includes(result.coverageClaim)
      || !['exhaustive', 'bounded_non_exhaustive', 'unsupported'].includes(result.asymmetryPolicy?.kind)
      || typeof result.asymmetryPolicy?.policyRef !== 'string' || result.asymmetryPolicy.policyRef.trim().length === 0
      || !Array.isArray(result.asymmetryPolicy?.scopeRefs) || result.asymmetryPolicy.scopeRefs.length === 0) {
      diagnostics.push({ code: 'AT_ADAPTER_RESULT_INVALID', adapterId: result.adapterId, message: `invalid adapter result ${result.adapterId || '<missing>'}` });
    }
    if (digestCoverageAdapterResult(unsignedResult(result)) !== result.resultDigest) diagnostics.push({ code: 'AT_ADAPTER_RESULT_DIGEST_MISMATCH', adapterId: result.adapterId, message: `adapter result digest mismatch: ${result.adapterId}` });
  }
  for (const method of ACCEPTANCE_PLAN_DISCOVERY_PROFILE.methods) {
    const rows = byMethod.get(method) ?? [];
    if (rows.length !== 1) diagnostics.push({ code: 'AT_REQUIRED_ADAPTER_RESULT_MISSING', message: `registered profile requires exactly one ${method} result; observed ${rows.length}`, adapterId: adapterId(method) });
  }
  const staticResult = byMethod.get('static_call_graph')?.[0];
  const runtimeResult = byMethod.get('runtime_trace')?.[0];
  if (staticResult && runtimeResult && !sameSet(staticResult.pathRefs, runtimeResult.pathRefs) && runtimeResult.asymmetryPolicy.kind !== 'bounded_non_exhaustive') {
    diagnostics.push({ code: 'AT_DISCOVERY_DISAGREEMENT', message: 'static/runtime path disagreement lacks bounded runtime asymmetry policy' });
  }
  const registryResult = byMethod.get('process_fact_registry')?.[0];
  const dispatchResult = byMethod.get('handler_dispatch_inventory')?.[0];
  const registryProcessPaths = registryResult?.pathRefs.filter(path => path.startsWith('path:process-fact:')) ?? [];
  const dispatchProcessPaths = dispatchResult?.pathRefs.filter(path => path.startsWith('path:process-fact:')) ?? [];
  if (registryResult && dispatchResult && !sameSet(registryProcessPaths, dispatchProcessPaths)) diagnostics.push({ code: 'AT_DISCOVERY_DISAGREEMENT', message: 'process-fact and handler/dispatch discovery disagree' });
  const enumeratedPathRefs = stable(results.flatMap(result => result.pathRefs));
  const blindSpots = stable(results.flatMap(result => result.blindSpots));
  const unsupported = results.some(result => result.coverageClaim === 'unsupported' || result.asymmetryPolicy.kind === 'unsupported');
  const partial = diagnostics.length > 0 || blindSpots.length > 0 || results.some(result => result.coverageClaim === 'partial');
  return { adapterResults: [...results].sort((a, b) => a.adapterId.localeCompare(b.adapterId)), enumeratedPathRefs, blindSpots,
    diagnostics: diagnostics.sort((a, b) => `${a.code}:${a.adapterId ?? ''}:${a.message}`.localeCompare(`${b.code}:${b.adapterId ?? ''}:${b.message}`)),
    status: unsupported ? 'unsupported' : partial ? 'partial' : 'complete' };
}

export function discoveryProfileDigest(): string {
  return `sha256:${digestCanonicalJson(ACCEPTANCE_PLAN_DISCOVERY_PROFILE)}`;
}
