import { SCANNER_SOURCE_PATHS } from './scanner-contexts.mjs';



import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';



import { IDENTITY_CERTIFICATION_RUNTIME_POLICY as identityCertificationBudget } from "../../packages/main/dist/core/runtime-fact-registry.js";





import { repoRoot, trackedFiles, readTrackedText, validateExactRows } from "./repository.mjs";
import { isProtectedExperimentPath, deriveExperimentProvenanceRow, verifyConceptProvenance, verifyExperimentProvenance } from "./memory-provenance.mjs";
import { runSelfTest } from "./self-test.mjs";
import { scanRootGroups, schemaRows, schemaBaselineDigest } from "./schema-scan.mjs";
import { verifyReviewedContextReaders, verifyBothFamilyContexts, verifyScannerRetiredContexts, verifyReviewedNegativeSourceIntegrity, verifyImportedHistoryContexts, verifyIntegrationRootHistoryContext, verifySchemaInventory } from "./source-integrity.mjs";
import { SCRIPT_PATH } from "./rules.mjs";
import { verifyImportedReleaseProvenance, verifyFrozenFiles } from "./release-history.mjs";
import { verifyCurrentGuidance, verifyCurrentLegacyContextManifest } from "./guidance.mjs";
import { EXACT_ALLOWLIST, CURRENT_LEGACY_CONTEXT_ROWS } from "./base-contexts.mjs";
import { verifyOrdering } from "./ordering.mjs";
import { scanActiveResidue } from "./active-scan.mjs";
import { ACTIVE_CLASSES, NEGATIVE_SCHEMA_WITNESSES } from "./schema-data.mjs";
import { CLOSED_ROLE_RUNTIME_WITNESSES } from "./reviewed-contexts.mjs";
import { FROZEN_SALTS, FROZEN_FILE_BASELINES, CONCEPT_PROVENANCE_ROWS } from "./provenance-data.mjs";

export function main(flags = process.argv.slice(2)) {
  const supported = ['--boundary-only', '--self-test', '--print-experiment-baseline', '--print-schema-baseline', '--print-residue'];
  if (flags.length > 1 || flags.some(flag => !supported.includes(flag))) {
    throw new Error('identity scanner expects no arguments or exactly one supported inspection mode');
  }
  const root = repoRoot();
  const files = trackedFiles(root);
  if (flags.includes('--print-experiment-baseline')) {
    console.log(JSON.stringify(files.filter(isProtectedExperimentPath).map((path) => deriveExperimentProvenanceRow(root, path)), null, 2));
    return;
  }
  if (flags.includes('--self-test')) {
    runSelfTest(root, files);
    return;
  }

  const groups = scanRootGroups(files);
  const emptyRoots = Object.entries(groups).filter(([, paths]) => paths.length === 0).map(([name]) => name);
  if (emptyRoots.length > 0) {
    console.error(`FAIL identity-cutover infrastructure: empty tracked scan roots: ${emptyRoots.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const schemas = schemaRows(root, files);
  if (flags.includes('--print-schema-baseline')) {
    console.log(JSON.stringify({ count: schemas.length, sha256: schemaBaselineDigest(schemas) }));
    return;
  }

  const structuralErrors = [
    ...verifyReviewedContextReaders(root),
    ...verifyBothFamilyContexts(root),
    ...SCANNER_SOURCE_PATHS.flatMap(path => verifyScannerRetiredContexts(readTrackedText(root, path), path)),
    ...verifyReviewedNegativeSourceIntegrity(root),
    ...verifyImportedHistoryContexts(root),
    ...verifyIntegrationRootHistoryContext(root),
    ...verifySchemaInventory(root, schemas),
    ...verifyImportedReleaseProvenance(root),
    ...verifyCurrentGuidance(root),
    ...verifyCurrentLegacyContextManifest(root),
    ...validateExactRows(EXACT_ALLOWLIST, new Set(files), root),
    ...verifyFrozenFiles(root, new Set(files)),
    ...verifyConceptProvenance(root, new Set(files)),
    ...verifyExperimentProvenance(root, files),
    ...verifyOrdering(root),
  ];

  if (structuralErrors.length > 0) {
    console.error('FAIL identity-cutover: frozen boundary or lineage invalid');
    for (const error of structuralErrors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  const hits = scanActiveResidue(root, files);
  if (flags.includes('--print-residue')) {
    console.log(JSON.stringify(hits, null, 2));
    return;
  }
  if (hits.length > 0) {
    console.error('FAIL identity-cutover: active legacy identities remain');
    for (const className of ACTIVE_CLASSES) {
      const classHits = hits.filter((hit) => hit.class === className);
      if (classHits.length === 0) continue;
      console.error(`  [${className}] ${classHits.length} occurrence(s)`);
      for (const hit of classHits.slice(0, 8)) console.error(`    ${hit.path}:${hit.line || 'path'} ${hit.token}`);
      if (classHits.length > 8) console.error(`    ... ${classHits.length - 8} more`);
    }
    process.exitCode = 1;
    return;
  }

  // The inexpensive independent AST/JSON and import-use totality checks are a
  // standing obligation. Full public-operation mutation coverage remains the
  // separately registered identity-cutover validation command, not a recursive
  // scanner invocation or an integrity-hash substitute for behavioral proof.
  const identitySitesCheck = execFileSync(process.execPath, [resolve(root, 'packages/main/tests/canonical-new-story-artifacts.test.mjs'), '--group=identity-sites'], { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (!identitySitesCheck.includes('GREEN B-49df: identity-sites group pass.')) throw new Error('independent owned identity totality verification did not produce its required selector');
  process.stdout.write(identitySitesCheck);

  // Disposable immutable-boundary controls require the same structural scan
  // and independent source/emitted identity totality, but do not certify the
  // runtime or package witnesses. Only the default invocation does that.
  if (flags.includes('--boundary-only')) {
    console.log('PASS identity-boundary-scan');
    return;
  }

  // Historical memory may be scanner-visible only while production selection,
  // rendering, cache reads, and writes keep the canonical-only boundary green.
  const memoryCheck = execFileSync(process.execPath, [resolve(root, 'packages/main/tests/canonical-new-story-artifacts.test.mjs'), '--group=memory-identity'], { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (!memoryCheck.includes('GREEN B-49df: memory-identity group pass.')) throw new Error('memory runtime quarantine verification did not produce its required selector');

  // The runtime group executes both full registered verifiers before its public
  // operation and installed-package witnesses. Its parent must cover their
  // combined budgets; the former 300-second parent truncated that real work.
  const runtimeCheck = execFileSync(process.execPath, [resolve(root, 'packages/main/tests/canonical-new-story-artifacts.test.mjs'), '--group=runtime'], { cwd: root, encoding: 'utf8', timeout: identityCertificationBudget.runtimeGroupMs });
  if (!runtimeCheck.includes('GREEN B-49df: runtime group pass.')) throw new Error('runtime deny-only verification did not produce its required selector');
  process.stdout.write(runtimeCheck);
  const markerCheck = execFileSync(process.execPath, [resolve(root, 'packages/main/tests/managed-marker-migration.test.mjs')], { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (!markerCheck.includes('managed-marker migration test passed')) throw new Error('managed-marker migration verification did not produce its required selector');

  for (const witness of [...NEGATIVE_SCHEMA_WITNESSES, ...CLOSED_ROLE_RUNTIME_WITNESSES]) {
    const output = execFileSync(process.execPath, [resolve(root, witness.command)], { cwd: root, encoding: 'utf8', timeout: 60000 });
    if (!output.includes(witness.selector)) throw new Error(`negative schema runtime witness missing selector: ${witness.path}`);
  }

  console.log('PASS identity-cutover');
  console.log('PASS identity-cutover policy: every active legacy identity is classified; frozen evidence allowlist is exact and current');
  console.log('PASS active prose/assets: Proof-or-Stop only');
  console.log('PASS active experience-ablation schemas: proof-or-stop.* only');
  console.log('PASS frozen history: unchanged');
  console.log(`PASS unchanged: ${FROZEN_SALTS.length} signature salts at ${EXACT_ALLOWLIST.length} exact source rows`);
  console.log(`PASS unchanged: ${CURRENT_LEGACY_CONTEXT_ROWS.length} exact current-doc legacy token/context rows`);
  console.log(`PASS unchanged: ${FROZEN_FILE_BASELINES.length} named historical/provenance byte baselines`);
  console.log(`PASS unchanged: ${CONCEPT_PROVENANCE_ROWS.length} exact concept-cleanup provenance/fixture rows`);
  console.log(`PASS unchanged: ${schemas.length} exact persisted-schema rows`);
  console.log('PASS canonical identities');
  execFileSync(process.execPath, [resolve(root, 'scripts/verify-proof-or-stop-pack-boundary.mjs'), '--quiet'], {
    cwd: root,
    stdio: 'inherit',
  });
}
