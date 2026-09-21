import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';


import { dirname, join, resolve } from 'node:path';

import ts from 'typescript';


import { parsedSourceCache, listFiles, SourceTypeAnalysis } from "./file-scan.js";
import { Violation, PINNED_EXECUTABLE_SOURCE_FINGERPRINTS, CANONICAL_AST_FINGERPRINT_ALGORITHM, repoRoot, SHIPPED_EXECUTABLE_SOURCE_DIRS, EXECUTABLE_SOURCE_EXTENSIONS, SHIPPED_EXECUTABLE_ENTRYPOINTS, isExecutableSourceFile, DYNAMIC_PROVENANCE_REACHABILITY_LABELS } from "./rule-data.js";
import { collectDynamicExecutionBindings } from "./dynamic-bindings.js";

export const TYPE_RESOLUTION_DIAGNOSTIC_CODES = new Set([2307, 2688, 2792, 7016]);

export let sharedProjectTypeAnalysis: { program: ts.Program; roots: readonly string[] } | undefined;

export const syntheticTypeFiles = new Map<string, { text: string; version: number }>();

export let syntheticTypeLanguageService: ts.LanguageService | undefined;

export const typeProgramInstrumentation = {
  baselineProgramBuilds: 0,
  overlayProgramBuilds: 0,
  languageServiceBuilds: 0,
  languageServiceProgramRequests: 0,
  distinctLanguageServicePrograms: new Set<ts.Program>(),
  dynamicBindingBuilds: 0,
  dynamicBindingBuildFiles: new Map<string, number>(),
  dynamicBindingCacheHits: 0,
  dynamicFullAnalysisScans: 0,
  dynamicAstCandidateScans: 0,
  dynamicPrefilterSkips: 0,
  dynamicReachabilityAssertions: 0,
  dynamicFullAnalysisByFile: new Map<string, number>(),
};

export const DYNAMIC_BINDING_BUILD_CEILING = 853;

export const MAX_DYNAMIC_BINDING_BUILD_CEILING = 860;

export function assertDynamicBindingBuildBudget(actualBuilds: number, ceiling: number): void {
  assert.ok(
    Number.isInteger(ceiling) && ceiling > 0 && ceiling <= MAX_DYNAMIC_BINDING_BUILD_CEILING,
    `dynamic binding graph build ceiling must be a finite integer between 1 and ${MAX_DYNAMIC_BINDING_BUILD_CEILING}, got ${ceiling}`,
  );
  assert.ok(
    actualBuilds <= ceiling,
    `dynamic binding graph builds must remain bounded at ${ceiling}, got ${actualBuilds}`,
  );
}

export function parseSource(file: string, text: string): ts.SourceFile {
  const cached = parsedSourceCache.get(file);
  if (cached?.text === text) return cached.source;
  const scriptKind = file.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : file.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : /\.(?:js|mjs|cjs)$/.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
  parsedSourceCache.set(file, { text, source });
  return source;
}

export function canonicalAstFingerprint(file: string, text: string): string {
  const canonical = ts.createPrinter({
    removeComments: true,
    newLine: ts.NewLineKind.LineFeed,
  }).printFile(parseSource(file, text));
  return createHash('sha256').update(canonical).digest('hex');
}

export function validatePinnedExecutableSourceFingerprint(
  file: string,
  text: string,
  checkedPinnedPaths?: Map<string, number>,
): Violation[] {
  const expected = PINNED_EXECUTABLE_SOURCE_FINGERPRINTS.get(file);
  if (!expected) return [];
  if (checkedPinnedPaths) checkedPinnedPaths.set(file, (checkedPinnedPaths.get(file) ?? 0) + 1);
  const actual = canonicalAstFingerprint(file, text);
  return actual === expected ? [] : [{
    file,
    line: 1,
    label: 'pinned executable source structural fingerprint drift',
    text: `${CANONICAL_AST_FINGERPRINT_ALGORITHM}: expected ${expected}, got ${actual}; review executable structure before updating the pinned fingerprint`,
  }];
}

export function projectTypeProgramRoots(): string[] {
  const configPath = join(repoRoot, 'packages/main/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined, `project type program must parse ${configPath}`);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
  assert.equal(parsed.errors.length, 0, `project type program config diagnostics: ${parsed.errors.map(error => error.code).join(',')}`);
  return [...new Set([
    ...parsed.fileNames,
    ...SHIPPED_EXECUTABLE_SOURCE_DIRS.flatMap(dir => listFiles(dir, EXECUTABLE_SOURCE_EXTENSIONS).map(file => join(repoRoot, file))),
    ...SHIPPED_EXECUTABLE_ENTRYPOINTS.map(file => join(repoRoot, file)),
  ].map(file => resolve(file)).filter(existsSync))].sort();
}

export function projectTypeProgramOptions(): ts.CompilerOptions {
  const configPath = join(repoRoot, 'packages/main/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    allowJs: true,
    checkJs: true,
    noEmit: true,
  };
  delete options.rootDir;
  delete options.outDir;
  return options;
}

export function createProjectTypeProgram(
  overlays: ReadonlyMap<string, string> = new Map(),
  includeProjectRoots = true,
  oldProgram?: ts.Program,
): ts.Program {
  if (includeProjectRoots) typeProgramInstrumentation.baselineProgramBuilds += 1;
  else typeProgramInstrumentation.overlayProgramBuilds += 1;
  const normalizedOverlays = new Map(
    [...overlays].map(([file, text]) => [resolve(repoRoot, file), text] as const),
  );
  const options = projectTypeProgramOptions();
  const host = ts.createCompilerHost(options, true);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  host.getCurrentDirectory = () => repoRoot;
  host.fileExists = file => normalizedOverlays.has(resolve(file)) || defaultFileExists(file);
  host.readFile = file => normalizedOverlays.get(resolve(file)) ?? defaultReadFile(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const overlay = normalizedOverlays.get(resolve(file));
    if (overlay === undefined) return defaultGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
    const scriptKind = file.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : file.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : /\.(?:js|mjs|cjs)$/.test(file)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
    return ts.createSourceFile(file, overlay, languageVersion, true, scriptKind);
  };
  return ts.createProgram({
    rootNames: [...new Set([...(includeProjectRoots ? projectTypeProgramRoots() : []), ...normalizedOverlays.keys()])],
    options,
    host,
    oldProgram,
  });
}

export function sharedProjectProgram(): ts.Program {
  if (!sharedProjectTypeAnalysis) {
    const roots = projectTypeProgramRoots();
    sharedProjectTypeAnalysis = { program: createProjectTypeProgram(), roots };
  }
  return sharedProjectTypeAnalysis.program;
}

export function syntheticTypeService(): ts.LanguageService {
  if (syntheticTypeLanguageService) return syntheticTypeLanguageService;
  typeProgramInstrumentation.languageServiceBuilds += 1;
  const options = projectTypeProgramOptions();
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...syntheticTypeFiles.keys()],
    getScriptVersion: file => String(syntheticTypeFiles.get(resolve(file))?.version ?? 0),
    getScriptSnapshot: file => {
      const overlay = syntheticTypeFiles.get(resolve(file));
      if (overlay) return ts.ScriptSnapshot.fromString(overlay.text);
      const text = ts.sys.readFile(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => repoRoot,
    getDefaultLibFileName: compilerOptions => ts.getDefaultLibFilePath(compilerOptions),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
  };
  syntheticTypeLanguageService = ts.createLanguageService(host, ts.createDocumentRegistry());
  return syntheticTypeLanguageService;
}

export function syntheticTypeAnalysisFor(file: string, text: string): SourceTypeAnalysis {
  const absoluteFile = resolve(repoRoot, file);
  const current = syntheticTypeFiles.get(absoluteFile);
  if (!current || current.text !== text) {
    syntheticTypeFiles.set(absoluteFile, { text, version: (current?.version ?? 0) + 1 });
  }
  typeProgramInstrumentation.languageServiceProgramRequests += 1;
  const program = syntheticTypeService().getProgram();
  const source = program?.getSourceFile(absoluteFile);
  assert(program && source, `synthetic type program root missing: ${file}`);
  typeProgramInstrumentation.distinctLanguageServicePrograms.add(program);
  return { program, source, checker: program.getTypeChecker() };
}

export function typeAnalysisFor(file: string, text: string, program?: ts.Program): SourceTypeAnalysis {
  const absoluteFile = resolve(repoRoot, file);
  const shared = program ?? sharedProjectProgram();
  let source = shared.getSourceFile(absoluteFile);
  let selectedProgram = shared;
  if (!source || source.text !== text) {
    if (!program) return syntheticTypeAnalysisFor(file, text);
    selectedProgram = createProjectTypeProgram(new Map([[file, text]]), false, shared);
    source = selectedProgram.getSourceFile(absoluteFile);
  }
  assert(source, `project type program root missing: ${file}`);
  return { program: selectedProgram, source, checker: selectedProgram.getTypeChecker() };
}

export function typeAnalysisViolations(file: string, analysis: SourceTypeAnalysis): Violation[] {
  const diagnostics = [
    ...analysis.program.getSyntacticDiagnostics(analysis.source),
    ...analysis.program.getSemanticDiagnostics(analysis.source)
      .filter(diagnostic => TYPE_RESOLUTION_DIAGNOSTIC_CODES.has(diagnostic.code)),
  ];
  return diagnostics.map(diagnostic => ({
    file,
    line: diagnostic.start === undefined ? 1 : analysis.source.getLineAndCharacterOfPosition(diagnostic.start).line + 1,
    label: 'malformed or unresolved executable type analysis',
    text: `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
  }));
}

export function assertProjectTypeProgramContract(executableFiles: readonly string[]): void {
  const program = sharedProjectProgram();
  const roots = new Set(program.getRootFileNames().map(file => resolve(file)));
  for (const file of executableFiles.filter(isExecutableSourceFile)) {
    const absolute = resolve(repoRoot, file);
    assert.ok(roots.has(absolute), `project type program root inventory must include ${file}`);
    assert.ok(program.getSourceFile(absolute), `project type program must resolve source ${file}`);
  }
  assert.ok(
    program.getSourceFiles().some(source => source.isDeclarationFile && /lib\.(?:es|d)/.test(source.fileName)),
    'project type program must load TypeScript default libraries',
  );
  assert.notEqual(program.getCompilerOptions().noResolve, true, 'project type program must enable module resolution');
  assert.equal(program.getCompilerOptions().moduleResolution, ts.ModuleResolutionKind.Node16, 'project type program must preserve packages/main Node16 module resolution');
}

export function assertTypeProgramInstrumentation(): void {
  const unchangedProgramFirst = syntheticTypeService().getProgram();
  const unchangedProgramSecond = syntheticTypeService().getProgram();
  assert.strictEqual(unchangedProgramSecond, unchangedProgramFirst, 'LanguageService getProgram must preserve object identity without a version change');
  assert.equal(typeProgramInstrumentation.baselineProgramBuilds, 1, 'baseline project Program must construct exactly once per guard scan');
  assert.ok(typeProgramInstrumentation.overlayProgramBuilds <= 1, `overlay Program builds must remain bounded at one, got ${typeProgramInstrumentation.overlayProgramBuilds}`);
  assert.equal(typeProgramInstrumentation.languageServiceBuilds, 1, 'synthetic LanguageService must construct exactly once per guard scan');
  // The canonical role registry adds a small, intentional source-root fanout to
  // the guard's synthetic program. Keep the inventory bounded while accounting
  // for that migration-owned root rather than pinning the pre-migration count.
  assert.ok(syntheticTypeFiles.size <= 36, `synthetic LanguageService roots must remain bounded at 36, got ${syntheticTypeFiles.size}`);
  assert.ok(typeProgramInstrumentation.languageServiceProgramRequests <= 320, `synthetic LanguageService Program requests must remain bounded at 320, got ${typeProgramInstrumentation.languageServiceProgramRequests}`);
  assert.ok(typeProgramInstrumentation.distinctLanguageServicePrograms.size <= 128, `distinct LanguageService Program identities across controlled version changes must remain bounded at 128, got ${typeProgramInstrumentation.distinctLanguageServicePrograms.size}`);
  assert.ok(typeProgramInstrumentation.dynamicBindingCacheHits >= 2, `dynamic binding cache must be exercised by repeated scans, got ${typeProgramInstrumentation.dynamicBindingCacheHits} hit(s)`);
  const syntheticBindingBuilds = [...typeProgramInstrumentation.dynamicBindingBuildFiles]
    .filter(([file]) => file.includes('dynamic-code-control-'))
    .reduce((total, [, count]) => total + count, 0);
  // Fixed mutation corpus remains bounded independently of growing repository inputs.
  assert.ok(syntheticBindingBuilds <= 419, `synthetic dynamic binding builds exceed the fixed corpus bound: ${syntheticBindingBuilds}`);
  const warmProgram = sharedProjectProgram();
  const warmSource = warmProgram.getSourceFile(resolve(repoRoot, 'packages/main/src/cli-engine.ts'))!;
  const coldOrCached = collectDynamicExecutionBindings(warmSource, warmProgram.getTypeChecker(), warmProgram);
  const buildsBeforeWarm = typeProgramInstrumentation.dynamicBindingBuilds;
  const hitsBeforeWarm = typeProgramInstrumentation.dynamicBindingCacheHits;
  assert.strictEqual(collectDynamicExecutionBindings(warmSource, warmProgram.getTypeChecker(), warmProgram), coldOrCached, 'warm binding graph preserves identity');
  assert.equal(typeProgramInstrumentation.dynamicBindingBuilds, buildsBeforeWarm, 'warm binding graph does not rebuild');
  assert.equal(typeProgramInstrumentation.dynamicBindingCacheHits, hitsBeforeWarm + 1, 'warm binding graph uses the cache');
  assert.ok(typeProgramInstrumentation.dynamicAstCandidateScans >= 1, 'decoded AST candidates missed by the raw token hint must reach full analysis');
  assert.ok(typeProgramInstrumentation.dynamicPrefilterSkips >= 1, 'call-free sources must retain the cheap AST skip path');
  assert.equal(typeProgramInstrumentation.dynamicReachabilityAssertions, DYNAMIC_PROVENANCE_REACHABILITY_LABELS.size, 'critical safe provenance reachability count must remain exact');
}
