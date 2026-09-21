import assert from 'node:assert/strict';


import { existsSync } from 'node:fs';


import { join } from 'node:path';

import ts from 'typescript';


import { assertDynamicCodeGenerationPositiveControls } from "./execution-controls.js";
import { assertLoaderArgumentProvenance } from "./loader-controls.js";
import { Violation, activeTextFiles, activeTextDirs, ACTIVE_SCAN_EXTENSIONS, SHIPPED_EXECUTABLE_SOURCE_DIRS, EXECUTABLE_SOURCE_EXTENSIONS, SHIPPED_EXECUTABLE_ENTRYPOINTS, repoRoot, isExecutableSourceFile, PINNED_EXECUTABLE_SOURCE_FINGERPRINTS, retiredFutureBacklogPlanFiles, retiredFutureBacklogRules } from "./rule-data.js";
import { assertPositiveControls, assertImportSpecifierPositiveControls, assertHermeticTraversalPositiveControls, assertShippedExecutableRootPositiveControls, assertNormalizedSpecifierPositiveControls } from "./positive-controls.js";
import { assertLegacyDeliveryCompatibilityPositiveControls } from "./compatibility-controls.js";
import { assertContract, assertCommandCatalog, assertGeneratedHelp } from "./public-contract.js";
import { listFiles, readRel } from "./file-scan.js";
import { assertProjectTypeProgramContract, assertTypeProgramInstrumentation, typeProgramInstrumentation } from "./type-analysis.js";
import { scanLegacyDeliveryCompatibilityUsage, scanDynamicCodeGeneration, scanText, scanImportSpecifiers, scanLegacyDeliveryCompatibilityGraph } from "./dynamic-scan.js";
export function runRetiredComplete(): void {

if (process.argv.includes('--lab-graph-loader-proof')) {
  assert.deepEqual(process.argv.slice(2), ['--lab-graph-loader-proof'], 'Lab proof does not accept combined or ambiguous selection');
  assertDynamicCodeGenerationPositiveControls();
  const coverage = assertLoaderArgumentProvenance('packages/main/src/handlers/graph.ts');
  assert.deepEqual(coverage, { filesChecked: 1, mutantsChecked: 14 }, 'Graph proof retains every current provenance mutant');
  process.stdout.write(`LAB_GRAPH_LOADER_PROOF_GREEN ${JSON.stringify(coverage)}\n`);
  process.exit(0);
}

const violations: Violation[] = [];

assertPositiveControls();

assertImportSpecifierPositiveControls();

assertHermeticTraversalPositiveControls();

assertShippedExecutableRootPositiveControls();

assertNormalizedSpecifierPositiveControls();

assertDynamicCodeGenerationPositiveControls();

assertLoaderArgumentProvenance();

assertLegacyDeliveryCompatibilityPositiveControls();

assertContract();

violations.push(...assertCommandCatalog());

const activeFiles = [
  ...activeTextFiles,
  ...activeTextDirs.flatMap(dir => listFiles(dir, ACTIVE_SCAN_EXTENSIONS)),
  ...SHIPPED_EXECUTABLE_SOURCE_DIRS.flatMap(dir => listFiles(dir, EXECUTABLE_SOURCE_EXTENSIONS)),
  ...SHIPPED_EXECUTABLE_ENTRYPOINTS,
].filter((file, index, all) => all.indexOf(file) === index);

assertProjectTypeProgramContract(activeFiles.filter(file => existsSync(join(repoRoot, file))));

const activeFileTexts = new Map<string, string>();

const checkedPinnedPaths = new Map<string, number>();

for (const file of activeFiles) {
  if (!existsSync(join(repoRoot, file))) continue;
  const text = readRel(file);
  activeFileTexts.set(file, text);
  // Pinned fingerprints are validated before compatibility-module early return
  // and before loader, vocabulary, import, or quarantine-specific scanning.
  violations.push(...scanLegacyDeliveryCompatibilityUsage(file, text, checkedPinnedPaths));
  if (isExecutableSourceFile(file)) violations.push(...scanDynamicCodeGeneration(file, text));
  violations.push(...scanText(file, text));
  violations.push(...scanImportSpecifiers(file, text));
}

assert.deepEqual(
  [...checkedPinnedPaths.entries()].sort(([left], [right]) => left.localeCompare(right)),
  [...PINNED_EXECUTABLE_SOURCE_FINGERPRINTS.keys()].sort().map(file => [file, 1]),
  'all eight pinned canonical executable paths must be checked exactly once by the canonical scan',
);

violations.push(...scanLegacyDeliveryCompatibilityGraph(activeFileTexts));

for (const file of retiredFutureBacklogPlanFiles) {
  if (!existsSync(join(repoRoot, file))) continue;
  violations.push(...scanText(file, readRel(file), retiredFutureBacklogRules));
}

violations.push(...assertGeneratedHelp());

assertTypeProgramInstrumentation();

if (violations.length > 0) {
  const rendered = violations
    .slice(0, 100)
    .map(v => `${v.file}:${v.line}: ${v.label}: ${v.text}`)
    .join('\n');
  throw new Error(`retired authority vocabulary guard found ${violations.length} violation(s):\n${rendered}`);
}

process.stdout.write(`retired authority vocabulary guard PASS builds=${typeProgramInstrumentation.dynamicBindingBuilds} cacheHits=${typeProgramInstrumentation.dynamicBindingCacheHits} fullAnalysis=${typeProgramInstrumentation.dynamicFullAnalysisScans} astCandidates=${typeProgramInstrumentation.dynamicAstCandidateScans} reachability=${typeProgramInstrumentation.dynamicReachabilityAssertions}\n`);
}
