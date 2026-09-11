// Copy the runtime source closure so isolated Lab fixtures track real dependencies.
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, appendFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import ts from 'typescript';
import { createRequire } from 'node:module';
export function copyLabFixtureSources(root, target, entries) {
  const deps = resolve(dirname(createRequire(import.meta.url).resolve('typescript')), '../..');
  if (!existsSync(resolve(target, 'node_modules'))) {
    symlinkSync(deps, resolve(target, 'node_modules'), 'dir');
    appendFileSync(resolve(target, '.git/info/exclude'), '\nnode_modules/\n');
  }
  const seen = new Set();
  function copy(path) {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(path, 'utf8');
    const dest = resolve(target, relative(root, path));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, source);
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const match of js.matchAll(/(?:from\s*|import\s*\() ['"]([^'"]+)['"]/g)) {
      if (!match[1].startsWith('.')) continue;
      const dependency = resolve(dirname(path), match[1].replace(/\.js$/, '.ts'));
      if (existsSync(dependency)) copy(dependency);
    }
  }
  for (const entry of entries) copy(resolve(root, `packages/main/src/core/${entry}.ts`));
}
