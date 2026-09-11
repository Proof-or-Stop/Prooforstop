// Copy the runtime source closure so isolated Lab fixtures track real dependencies.
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, appendFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import ts from 'typescript';
import { createRequire } from 'node:module';
export function copyLabFixtureSources(root, target, entries) {
  const deps = resolve(dirname(createRequire(import.meta.url).resolve('typescript')), '../..');
  if (!existsSync(resolve(target, 'node_modules'))) {
    symlinkSync(deps, resolve(target, 'node_modules'), 'dir');
    appendFileSync(resolve(target, '.git/info/exclude'), '\n/node_modules\n');
  }
  const seen = new Set();
  function copy(path) {
    if (seen.has(path)) return;
    seen.add(path);
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Fixture dependency escapes source root');
    const source = readFileSync(path, 'utf8');
    const dest = resolve(target, relative(root, path));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, source);
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const parsed = ts.createSourceFile(path + '.js', js, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const imports = [];
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    for (const specifier of imports) {
      if (!specifier.startsWith('.')) continue;
      const mapped = resolve(dirname(path), specifier.replace(/\.js$/, '.ts'));
      const dependency = existsSync(mapped) ? mapped : resolve(dirname(path), specifier);
      if (!existsSync(dependency)) throw new Error(`Unresolved fixture dependency: ${specifier} from ${path}`);
      copy(dependency);
    }
  }
  for (const entry of entries) copy(resolve(root, `packages/main/src/core/${entry}.ts`));
}
