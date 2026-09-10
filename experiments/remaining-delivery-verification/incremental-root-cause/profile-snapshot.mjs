import fs from 'node:fs';
import child from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { performance } from 'node:perf_hooks';

const [rootArg, outputArg] = process.argv.slice(2);
if (!rootArg || !outputArg) throw new Error('Usage: profile-snapshot.mjs ROOT NEW_OUTPUT');
const root = fs.realpathSync(rootArg);
const output = path.resolve(outputArg);
const sourcePath = path.resolve('packages/main/tests/canonical-new-story-artifacts.test.mjs');
const text = fs.readFileSync(sourcePath, 'utf8');
const ast = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ['git', 'snapshotTree', 'snapshotGitMaterial', 'snapshotPublicOperationState'];
const source = names.map(name => {
  const fn = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (!fn) throw new Error(`Missing exact function ${name}`);
  return fn.getText(ast);
}).join('\n');
const stats = {}, reads = new Map();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function measured(name, fn) {
  return (...args) => {
    const start = performance.now(); let result;
    try { result = fn(...args); return result; }
    finally {
      const ms = performance.now() - start;
      const row = stats[name] ??= { calls: 0, ms: 0, bytes: 0 };
      row.calls++; row.ms += ms;
      if (name === 'read') {
        const bytes = typeof result === 'string' ? Buffer.byteLength(result) : result?.byteLength ?? 0;
        row.bytes += bytes;
        const key = path.relative(root, args[0]);
        const file = reads.get(key) ?? { path: key, calls: 0, bytes: 0, ms: 0 };
        file.calls++; file.bytes += bytes; file.ms += ms; reads.set(key, file);
      }
    }
  };
}
const imports = {
  existsSync: fs.existsSync, readdirSync: measured('readdir', fs.readdirSync),
  statSync: measured('stat', fs.statSync), lstatSync: measured('lstat', fs.lstatSync),
  readFileSync: measured('read', fs.readFileSync), readlinkSync: fs.readlinkSync,
  join: path.join, createHash: crypto.createHash, execFileSync: measured('git', child.execFileSync),
};
const snapshot = new Function(...Object.keys(imports), source + '\nreturn snapshotPublicOperationState;')(...Object.values(imports));
const start = performance.now(); const result = snapshot(root, []); const elapsedMs = performance.now() - start;
const files = [...reads.values()].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
const groups = new Map();
for (const file of files) {
  const parts = file.path.split('/');
  const key = parts.slice(0, parts[0] === '.proof-or-stop' ? 4 : 2).join('/');
  const group = groups.get(key) ?? { prefix: key, files: 0, calls: 0, bytes: 0, ms: 0 };
  group.files++; group.calls += file.calls; group.bytes += file.bytes; group.ms += file.ms; groups.set(key, group);
}
const report = {
  scope: 'One read-only invocation of the exact current snapshot functions; bytes are logical readFileSync return bytes, not physical disk IO or resident memory.',
  root, sourcePath, sourceSha256: sha(source), testFileSha256: sha(text),
  head: child.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  rootHead: child.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  elapsedMs, stats, uniqueReadPaths: files.length,
  materialRows: result.gitMaterial.split('\n').length, materialDigest: sha(result.gitMaterial),
  snapshotDigest: sha(JSON.stringify(result)),
  groups: [...groups.values()].sort((a, b) => b.bytes - a.bytes), files,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, elapsedMs, stats, uniqueReadPaths: files.length, topGroups: report.groups.slice(0, 8), topFiles: files.slice(0, 5) }, null, 2));
