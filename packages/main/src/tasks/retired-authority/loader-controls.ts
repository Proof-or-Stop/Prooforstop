import assert from 'node:assert/strict';







import ts from 'typescript';


import { APPROVED_LOADER_ARGUMENT_PROVENANCE, scanConcealedCompatibilityLoads } from "./module-loaders.js";
import { readRel } from "./file-scan.js";
import { canonicalAstFingerprint } from "./type-analysis.js";

export function assertLoaderArgumentProvenance(onlyFile?: string): { filesChecked: number; mutantsChecked: number } {
  if (onlyFile !== undefined) assert.ok(APPROVED_LOADER_ARGUMENT_PROVENANCE.has(onlyFile), 'selected loader proof must exist');
  let filesChecked = 0;
  let mutantsChecked = 0;
  for (const [file, pin] of APPROVED_LOADER_ARGUMENT_PROVENANCE) {
    if (onlyFile !== undefined && file !== onlyFile) continue;
    filesChecked += 1;
    const original = readRel(file);
    assert.ok(original.includes(pin.argument), `provenance pin argument must exist verbatim in ${file}`);
    assert.deepEqual(
      scanConcealedCompatibilityLoads(file, original),
      [],
      `the exact approved loader call site must remain allowed: ${file}`,
    );

    if (file === 'packages/main/src/tasks/prompt-full-context-envelope-smoke.ts') {
      assert.ok(
        scanConcealedCompatibilityLoads(file, `${original}\nvoid 0;\n`)
          .some(violation => violation.label === 'unapproved non-literal dynamic module load'),
        'any executable drift revokes the envelope mutation loader fingerprint',
      );
      for (const [label, mutated, expectedDiagnostic] of [
        ['different loader anchor', original.replace('async function importEnvelopeMutant(', 'async function otherEnvelopeLoader('), 'approved loader argument provenance drift'],
        ['different loader argument', original.replace('pathToFileURL(mutantPath).href', 'pathToFileURL(process.env.B8A40_MUTANT_PATH!).href'), 'unapproved non-literal dynamic module load'],
      ]) {
        assert.notEqual(mutated, original, `${label} must change the envelope loader`);
        assert.ok(
          scanConcealedCompatibilityLoads(file, mutated, canonicalAstFingerprint(file, mutated))
            .some(violation => violation.label === expectedDiagnostic),
          `${label} must fail even after a fingerprint refresh`,
        );
      }
    }

    const mutants: Array<[string, string]> = file === 'packages/main/src/tasks/prompt-full-context-envelope-smoke.ts' ? [
      ['mutant path rebound to external input', original.replace(
        'const mutantPath = writeEnvelopeMutant(label);',
        'const mutantPath = process.env.B8A40_MUTANT_PATH!;',
      )],
      ['indirect mutant producer alias', original.replace(
        'const mutantPath = writeEnvelopeMutant(label);',
        'const indirectProducer = writeEnvelopeMutant; const mutantPath = indirectProducer(label);',
      )],
      ['mutable mutant path binding', original.replace(
        'const mutantPath = writeEnvelopeMutant(label);',
        'let mutantPath = writeEnvelopeMutant(label);',
      )],
      ['mutant producer type widened', original.replace(
        "function writeEnvelopeMutant(label: 'no-safe-narrowing' | 'broad-deletion'): string {",
        'function writeEnvelopeMutant(label: string): string {',
      )],
      ['mutant producer override parameter', original.replace(
        "function writeEnvelopeMutant(label: 'no-safe-narrowing' | 'broad-deletion'): string {",
        "function writeEnvelopeMutant(label: 'no-safe-narrowing' | 'broad-deletion', pathOverride?: string): string {",
      )],
      ['mutant producer default parameter', original.replace(
        "function writeEnvelopeMutant(label: 'no-safe-narrowing' | 'broad-deletion'): string {",
        "function writeEnvelopeMutant(label: 'no-safe-narrowing' | 'broad-deletion' = 'no-safe-narrowing'): string {",
      )],
      ['mutant producer nested shadow', original.replace(
        'const mutantPath = writeEnvelopeMutant(label);',
        "function writeEnvelopeMutant(label: 'no-safe-narrowing' | 'broad-deletion'): string { return process.env.B8A40_MUTANT_PATH!; }\n  const mutantPath = writeEnvelopeMutant(label);",
      )],
      ['mutant URL helper shadow', original.replace(
        'const mutantPath = writeEnvelopeMutant(label);',
        'function pathToFileURL(path: string) { return { href: process.env.B8A40_MUTANT_URL! }; }\n  const mutantPath = writeEnvelopeMutant(label);',
      )],
    ] : [
      // Rebound to a caller-influenced value: anchor and argument text unchanged, but
      // `location` no longer comes from the pinned producer at all.
      ['caller-influenced rebinding', original.replace(
        `const location = ${pin.producer}(ctx.root);`,
        'const location = (args as unknown as { location: GraphPackageLocation }).location;',
      )],
      // Producer kept by name but reached indirectly, so the pinned call shape is gone.
      ['indirect producer alias', original.replace(
        `const location = ${pin.producer}(ctx.root);`,
        `const resolveLocation = ${pin.producer};\n      const location = resolveLocation(ctx.root);`,
      )],
      // Signature widened with an override: a caller can now name the imported file
      // outright rather than only influencing the root the producer resolves from.
      ['producer signature widened with override', original.replace(
        `export function ${pin.producer}(projectRoot: string): GraphPackageLocation {`,
        `export function ${pin.producer}(projectRoot: string, entryOverride?: string): GraphPackageLocation {\n  if (entryOverride) return describeLocation(dirname(dirname(entryOverride)), entryOverride);`,
      )],
      // PROBE (codex round 3a): an attacker-supplied helper of the same name replaces the
      // node:url import, keeping the pinned argument text byte-identical.
      ['attacker-supplied url helper', original
        .replace("import { pathToFileURL } from 'node:url';", '')
        .replace(
          `export function ${pin.producer}(projectRoot: string): GraphPackageLocation {`,
          'function pathToFileURL(p: string): { href: string } {\n'
          + '  return { href: String((globalThis as { __evil?: string }).__evil ?? p) };\n'
          + '}\n'
          + `export function ${pin.producer}(projectRoot: string): GraphPackageLocation {`,
        )],
      /* PROBES (codex round 4): the independent review host wrote these four while
         attempting further bypasses. It labelled them review-only, but the fourth found a
         REAL hole (a different node:url export aliased to the pinned helper name), so all
         four are kept permanently -- they are exactly the mutation classes a future editor
         of this pin would need to stay honest about. */
      ['aliased node:url import followed by local helper shadow', original.replace(
        "import { pathToFileURL } from 'node:url';",
        "import { pathToFileURL as p } from 'node:url';\n"
        + 'function pathToFileURL(value: string): { href: string } {\n'
        + '  return { href: String((globalThis as { __evil?: string }).__evil ?? p(value).href) };\n'
        + '}',
      )],
      ['namespace node:url import followed by destructuring', original.replace(
        "import { pathToFileURL } from 'node:url';",
        "import * as url from 'node:url';\nconst { pathToFileURL } = url;",
      )],
      ['url helper shadowed inside anchor', original.replace(
        'export function createGraphHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {',
        'export function createGraphHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {\n'
        + '  function pathToFileURL(value: string): { href: string } {\n'
        + '    return { href: String((globalThis as { __evil?: string }).__evil ?? value) };\n'
        + '  }',
      )],
      ['different node:url export aliased as pinned helper', original.replace(
        "import { pathToFileURL } from 'node:url';",
        "import { parse as pathToFileURL } from 'node:url';",
      )],
      // PROBE (claude round 6): the parameter TYPE widened to accept an entry object, so a
      // caller can name the loaded file outright. Arity, names and markers all unchanged.
      ['producer parameter type widened', original.replace(
        `export function ${pin.producer}(projectRoot: string): GraphPackageLocation {`,
        `export function ${pin.producer}(projectRoot: string | { entry: string }): GraphPackageLocation {\n`
        + `  if (typeof projectRoot !== 'string') return describeLocation(dirname(dirname(projectRoot.entry)), projectRoot.entry);`,
      )],
      // PROBE (claude round 5): a DEFAULT INITIALIZER on the pinned parameter. The name list
      // stays exactly ['projectRoot'], so the arity/name check alone was satisfied while the
      // producer gained a globally-influenced default.
      ['producer parameter default initializer', original.replace(
        `export function ${pin.producer}(projectRoot: string): GraphPackageLocation {`,
        `export function ${pin.producer}(projectRoot: string = String((globalThis as { __evil?: string }).__evil ?? '')): GraphPackageLocation {`,
      )],
      // PROBE (codex round 3b): a bodyless ambient producer declaration, which Node ESM can
      // resolve from an attacker-installed globalThis property.
      ['ambient bodyless producer', original.replace(
        `export function ${pin.producer}(projectRoot: string): GraphPackageLocation {`,
        `declare function ${pin.producer}(projectRoot: string): GraphPackageLocation;\n`
        + `function __unusedRealProducer(projectRoot: string): GraphPackageLocation {`,
      )],
      // PROBE (codex, 2nd finding): an exact-matching OVERLOAD signature hiding a widened
      // implementation. `.find(isFunctionDeclaration)` used to select the overload and pass.
      ['overload hides widened implementation', original.replace(
        `export function ${pin.producer}(projectRoot: string): GraphPackageLocation {`,
        `export function ${pin.producer}(projectRoot: string): GraphPackageLocation;\n`
        + `export function ${pin.producer}(projectRoot: string, entryOverride?: string): GraphPackageLocation {\n`
        + `  if (entryOverride) return describeLocation(dirname(dirname(entryOverride)), entryOverride);`,
      )],
      // PROBE (codex F-019): a NESTED producer with the same name AND the same signature,
      // shadowing the module-level export. The pinned line and the import argument text are
      // byte-identical, so only real declaration-identity checking can catch it.
      ['nested producer shadow', original.replace(
        `      const location = ${pin.producer}(ctx.root);`,
        `      function ${pin.producer}(projectRoot: string): GraphPackageLocation {\n`
        + `        const injected = String((args as { root?: string }).root ?? projectRoot);\n`
        + `        return { packageRoot: injected, entry: injected + '/evil.js', assetDir: injected, vendorDir: injected };\n`
        + `      }\n      const location = ${pin.producer}(ctx.root);`,
      )],
      // Hoisted out of the approved scope, widening the binding's lifetime/visibility.
      // Hoisted to module scope while KEEPING the pinned producer call verbatim, so the
      // scope half of the pin is what has to reject it (a module-scope const resolved once
      // at import time is a different trust story from a per-invocation binding).
      ['binding hoisted out of the approved scope', original.replace(
        `      const location = ${pin.producer}(ctx.root);\n`,
        '',
      ).replace(
        `export function createGraphHandlers(ctx: HandlerContext)`,
        `const location = ${pin.producer}(process.cwd());\nexport function createGraphHandlers(ctx: HandlerContext)`,
      )],
    ];

    for (const [label, mutated] of mutants) {
      mutantsChecked += 1;
      assert.notEqual(mutated, original, `${label} control must actually mutate ${file}`);
      assert.ok(mutated.includes(pin.argument), `${label} control must keep the pinned argument text byte-identical`);
      const mutantFingerprint = canonicalAstFingerprint(file, mutated);
      assert.notEqual(mutantFingerprint, canonicalAstFingerprint(file, original), `${label} control must be a real code change`);
      const violations = scanConcealedCompatibilityLoads(file, mutated, mutantFingerprint);
      assert.ok(
        violations.some(violation => violation.label === 'approved loader argument provenance drift'),
        `${label} must break the loader argument provenance pin even when the fingerprint is re-pinned to the mutant: ${file}`,
      );
    }
  }
  return { filesChecked, mutantsChecked };
}
