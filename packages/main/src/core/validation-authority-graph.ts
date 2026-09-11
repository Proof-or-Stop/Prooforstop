import ts from 'typescript';
import { posix } from 'node:path';
import { builtinModules } from 'node:module';
import { PROCESS_FACT_REGISTRY } from './process-fact-registry.js';

/** Explicit authority registrations, not filename guesses or owner prose. */
export function validationAuthoritySources(): string[] {
  const semantics = new Set(['gate-evidence', 'blocker-state', 'freshness-policy', 'verification-policy', 'signed-artifact', 'schema-contract']);
  return [...new Set([
    'packages/main/src/core/process-fact-registry.ts',
    'packages/main/src/core/runtime-fact-registry.ts',
    'packages/main/src/core/command-policy.ts',
    ...PROCESS_FACT_REGISTRY.filter(row => row.gateEvidence || row.semantics.some(value => semantics.has(value)))
      .flatMap(row => [...(row.producerSourceRefs ?? []), ...(row.consumerSourceRefs ?? [])])
      .map(path => path.split('#')[0]!),
  ])].sort();
}

/** Only parses the actual registered authority closure; unrelated core stays selective. */
export function authorityRevisionClosure(tree: ReadonlyMap<string, string> | undefined) {
  const roots = validationAuthoritySources();
  const members = new Set<string>();
  const unknown = new Set<string>();
  if (!tree) return { members, unknown: ['authority-tree-unavailable'] };
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  const visit = (path: string) => {
    if (members.has(path)) return;
    members.add(path);
    const text = tree.get(path);
    if (text === undefined) { unknown.add(`authority-source-unavailable:${path}`); return; }
    if (path.endsWith('.json')) { try { JSON.parse(text); } catch { unknown.add(`authority-json-invalid:${path}`); } return; }
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    // Parser diagnostics are not exported on SourceFile's public declaration.
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics?.length) unknown.add(`authority-parse-invalid:${path}`);
    const dependency = (value: string) => {
      if (builtins.has(value)) return;
      if (!value.startsWith('.')) { unknown.add(`authority-import-unresolved:${path}`); return; }
      const candidate = posix.normalize(posix.join(posix.dirname(path), value));
      const stem = candidate.replace(/\.(?:[cm]?js|tsx?)$/, '');
      const possibilities = [candidate, ...['.ts','.tsx','.mts','.cts','.js','.mjs','.cjs','/index.ts','/index.js','.json'].map(ext => stem + ext)];
      const found = possibilities.find(name => tree.has(name));
      if (found) visit(found); else unknown.add(`authority-import-unresolved:${path}`);
    };
    const walk = (node: ts.Node) => {
      // Importing loader authority is opaque even when its local name changes
      // or it is passed elsewhere before invocation. Namespace/default module
      // objects can expose that factory through computed property access.
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
        && ['node:module','module'].includes(node.moduleSpecifier.text)) {
        const clause = node.importClause, bindings = clause?.namedBindings;
        if (clause?.name || (bindings && (ts.isNamespaceImport(bindings)
          || bindings.elements.some(item => (item.propertyName ?? item.name).text === 'createRequire')))) {
          unknown.add(`authority-loader-opaque:${path}`);
        }
      }
      if (ts.isImportTypeNode(node)) {
        const value = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
        if (value && ts.isStringLiteralLike(value)) dependency(value.text);
        else unknown.add(`authority-import-opaque:${path}`);
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (ts.isStringLiteralLike(node.moduleSpecifier)) dependency(node.moduleSpecifier.text);
        else unknown.add(`authority-import-opaque:${path}`);
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const value = node.moduleReference.expression;
        if (value && ts.isStringLiteralLike(value)) { dependency(value.text); if (['node:module','module'].includes(value.text)) unknown.add(`authority-loader-opaque:${path}`); } else unknown.add(`authority-import-opaque:${path}`);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && ['require','eval','createRequire'].includes(node.expression.text)))) {
        const value = node.arguments[0];
        if (node.expression.kind !== ts.SyntaxKind.ImportKeyword && ts.isIdentifier(node.expression) && node.expression.text !== 'require') unknown.add(`authority-loader-opaque:${path}`);
        else if (value && ts.isStringLiteralLike(value)) { dependency(value.text); if (['node:module','module'].includes(value.text)) unknown.add(`authority-loader-opaque:${path}`); }
        else unknown.add(`authority-import-opaque:${path}`);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  // Absent tool-specific roots do not force external projects to emulate this repository.
  for (const root of roots) if (tree.has(root)) visit(root);
  return { members, unknown: [...unknown].sort() };
}
