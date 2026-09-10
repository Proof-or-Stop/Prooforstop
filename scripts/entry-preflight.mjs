#!/usr/bin/env node
/** Read-only entry diagnostics. This script must load with no installed packages. */
import { existsSync, readFileSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
const self = fileURLToPath(import.meta.url);
const runtimeRoot = dirname(dirname(self));
const coreRoot = join(runtimeRoot, 'packages/main');
const row = (id, status, detail, fix) => ({ id, status, detail, ...(fix ? { fix } : {}) });
const errorText = error => error instanceof Error ? error.message : String(error);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function probe(rows, id, read) {
  try { const result = read(); rows.push(...(Array.isArray(result) ? result : [result])); }
  catch (error) { rows.push(row(id, 'BLOCKED', errorText(error))); }
}
function readObject(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!isObject(value)) throw new Error(`${path}: expected a JSON object`);
  return value;
}
function dependencyRows(packageRoot, optional = false) {
  const path = join(packageRoot, 'package.json');
  if (!existsSync(path) && optional) return [row('project-dependencies', 'WARNING', 'No package.json; no project JavaScript dependency requirement inferred.')];
  const manifest = readObject(path);
  const require = createRequire(path);
  const declarations = { ...manifest.devDependencies, ...manifest.dependencies };
  return Object.keys(declarations).sort().map(name => {
    if (name.split('/').some(part => ['.', '..'].includes(part)) || !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(name)) return row(`dependency:${packageRoot}:${name}`, 'BLOCKED', 'Invalid dependency package name');
    // Inspect installation, not a package's root export. ESM-only and subpath-only
    // packages are legitimate; resolving with require conditions misclassifies them.
    const candidates = (require.resolve.paths(name) ?? []).map(base => join(base, name, 'package.json'));
    const candidate = candidates.find(path => existsSync(path));
    const optionalDependency = Object.hasOwn(manifest.optionalDependencies ?? {}, name);
    if (!candidate) return row(`dependency:${packageRoot}:${name}`, optionalDependency ? 'WARNING' : 'BLOCKED',
      `Declared package ${name} is not installed in this package or an inherited parent node_modules.`, `Restore dependencies for ${packageRoot}.`);
    try { readObject(candidate); return row(`dependency:${packageRoot}:${name}`, 'PASS', `Installed package manifest: ${realpathSync(candidate)}; package code was not executed.`); }
    catch (error) { return row(`dependency:${packageRoot}:${name}`, 'BLOCKED', errorText(error)); }
  });
}
function bootstrap(root) {
  const rows = [];
  probe(rows, 'project-realpath', () => row('project-realpath', 'PASS', realpathSync(root)));
  probe(rows, 'runtime-realpath', () => row('runtime-realpath', 'PASS', realpathSync(coreRoot)));
  rows.push(row('node-runtime', 'PASS', `${process.execPath} ${process.version}; version suitability is checked by the runtime registry.`));
  probe(rows, 'config-syntax', () => {
    const path = join(root, 'proof-or-stop.config.json');
    if (!existsSync(path)) return row('config-syntax', 'WARNING', 'No project configuration file; configured runtime defaults apply.');
    const config = readObject(path);
    const errors = ['scanRoot', 'rootDir', 'storyDir', 'requirementsDir', 'testsDir', 'fixturesDir', 'outDir']
      .filter(key => config[key] !== undefined && (typeof config[key] !== 'string' || !config[key].trim()));
    return row('config-syntax', errors.length ? 'BLOCKED' : 'PASS', errors.length
      ? `Expected nonempty path strings: ${errors.join(', ')}` : `Parsed ${path}; this is syntax/path-shape validation, not full policy acceptance.`);
  });
  probe(rows, 'git-pointer', () => {
    const path = join(root, '.git');
    if (!existsSync(path)) return row('git-pointer', 'WARNING', 'No Git metadata in this root; no linked worktree inferred.');
    let gitDir;
    if (statSync(path).isDirectory()) gitDir = realpathSync(path);
    else {
      const match = readFileSync(path, 'utf8').trim().match(/^gitdir: (.+)$/);
      if (!match) throw new Error('Invalid .git worktree pointer');
      gitDir = realpathSync(resolve(root, match[1]));
    }
    if (!statSync(gitDir).isDirectory()) throw new Error('Worktree Git pointer does not name a directory');
    if (!/^(?:ref: refs\/[^\s]+|[a-f0-9]{40}|[a-f0-9]{64})$/.test(readFileSync(join(gitDir, 'HEAD'), 'utf8').trim())) throw new Error('Git metadata has no usable HEAD');
    const commonFile = join(gitDir, 'commondir');
    const common = existsSync(commonFile) ? realpathSync(resolve(gitDir, readFileSync(commonFile, 'utf8').trim())) : gitDir;
    if (!statSync(join(common, 'objects')).isDirectory()) throw new Error('Git common directory has no object store');
    const backlink = join(gitDir, 'gitdir');
    if (existsSync(backlink) && realpathSync(resolve(gitDir, readFileSync(backlink, 'utf8').trim())) !== realpathSync(path)) throw new Error('Git worktree backlink names a different entry');
    return row('git-pointer', 'PASS', gitDir);
  });
  probe(rows, 'runtime-dependencies', () => dependencyRows(coreRoot));
  if (resolve(root) !== resolve(coreRoot)) probe(rows, 'project-dependencies', () => dependencyRows(root, true));
  for (const name of ['core/runtime-environment-checks.js', 'core/store.js', 'core/plan-touchpoint-coverage.js', 'handlers/init-preflight.js']) {
    const path = join(coreRoot, 'dist', name);
    probe(rows, `build:${name}`, () => {
      if (!statSync(path).isFile()) throw new Error(`Missing built module: ${path}`);
      return row(`build:${name}`, 'PASS', path);
    });
  }
  return rows;
}
async function runtimeProbe(root) {
  const { runRuntimeEnvironmentChecks } = await import(pathToFileURL(join(coreRoot, 'dist/core/runtime-environment-checks.js')).href);
  const report = runRuntimeEnvironmentChecks(root, { corePackageRoot: coreRoot });
  return Object.values(report).filter(value => isObject(value) && typeof value.id === 'string' && 'status' in value)
    .map(value => row(`runtime:${value.id}`, value.status === 'pass' ? 'PASS' : value.severity === 'hard' ? 'BLOCKED' : 'WARNING',
      value.status === 'pass' ? value.rationale : `${value.driftMessage} ${(value.details ?? []).join('; ')}`, value.repairHint));
}
async function storyProbe(root, storyId) {
  const rows = [];
  const { StoryStore } = await import(pathToFileURL(join(coreRoot, 'dist/core/store.js')).href);
  const { loadConfig } = await import(pathToFileURL(join(coreRoot, 'dist/core/config.js')).href);
  const { isCanonicalStoryId, CWD_GATED_LIFECYCLE_PHASES, LIFECYCLE_PHASES } = await import(pathToFileURL(join(coreRoot, 'dist/core/lifecycle-registry.js')).href);
  if (!isCanonicalStoryId(storyId)) throw new Error('A canonical Story ID is required');
  const store = new StoryStore(root);
  let story, checklist, understanding, originalItems;
  let checklistIncomplete = false;
  let understandingIncomplete = false;
  probe(rows, 'story-shape', () => {
    const value = store.readStory(storyId);
    if (!isObject(value) || value.storyId !== storyId || !LIFECYCLE_PHASES.includes(value.phase)) throw new Error('Invalid Story identity or phase');
    story = value;
    return row('story-shape', 'PASS', `${storyId}: ${story.phase}`);
  });
  probe(rows, 'checklist-shape', () => {
    const value = store.readChecklist(storyId);
    if (!Array.isArray(value?.items)) throw new Error('Checklist requires an array of items');
    const issues = [];
    originalItems = value.items.filter(isObject);
    // Diagnostic projection only: retain independently readable paths without
    // changing stored declarations or treating malformed input as admissible.
    checklist = {...value, items: value.items.flatMap((item, index) => {
      if (!isObject(item)) { issues.push(`item ${index}: requires an object`); return []; }
      if (item.files === undefined) return [item];
      if (item.files !== undefined && !isObject(item.files)) {
        issues.push(`${item.id}: files requires an object`);
        return [{...item, files:{}}];
      }
      const files = {...item.files};
      for (const key of ['modify', 'create', 'test']) {
        const paths = files[key];
        if (paths === undefined) continue;
        if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
          issues.push(`${item.id}: files.${key} requires strings`);
          files[key] = Array.isArray(paths) ? paths.filter(path => typeof path === 'string') : [];
        }
      }
      return [{...item, files}];
    })};
    checklistIncomplete = issues.length > 0;
    if (checklistIncomplete) throw new Error(issues.join('; '));
    return row('checklist-shape', 'PASS', 'Checklist path declarations are structurally readable.');
  });
  probe(rows, 'understanding-shape', () => {
    const path = store.storyFilePath(storyId, 'understanding.json');
    if (!existsSync(path)) return row('understanding-shape', 'WARNING', 'Understanding snapshot is absent.');
    const value = readObject(path);
    if (!Array.isArray(value.touchpoints)) throw new Error('Understanding touchpoints require strings');
    understandingIncomplete = value.touchpoints.some(path => typeof path !== 'string');
    understanding = {...value,touchpoints:value.touchpoints.filter(path => typeof path === 'string')};
    if (understandingIncomplete) throw new Error('Understanding touchpoints require strings');
    return row('understanding-shape', 'PASS', 'Understanding touchpoints are structurally readable.');
  });
  let coverage;
  try { ({ assessPlanTouchpointCoverage: coverage } = await import(pathToFileURL(join(coreRoot, 'dist/core/plan-touchpoint-coverage.js')).href)); }
  catch (error) { rows.push(row('touchpoint-coverage', 'UNAVAILABLE', errorText(error))); }
  if (coverage && checklist?.items && understanding?.touchpoints) probe(rows, 'touchpoint-coverage', () => {
    const issues = coverage(understanding.touchpoints, checklist.items);
    return issues.length ? issues.map(issue => row(issue.type, issue.severity === 'blocker' ? 'BLOCKED' : 'WARNING', issue.message))
      : checklistIncomplete || understandingIncomplete ? row('touchpoint-coverage', 'WARNING', 'Readable declarations cover the touchpoints, but malformed input prevents complete coverage validation.')
        : row('touchpoint-coverage', 'PASS', 'Every declared touchpoint is covered by the checklist file declarations.');
  });
  if (checklist?.items) {
    for (const item of checklist.items) for (const key of ['modify', 'create', 'test']) for (const path of item.files?.[key] ?? []) {
      const id = `path:${item.id}:${key}:${path}`;
      probe(rows, id, () => {
        const absolute = resolve(root, path), local = relative(root, absolute);
        if (!path.trim() || /[\x00-\x1f\x7f]/.test(path) || isAbsolute(path) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) {
          return row(id, 'BLOCKED', 'Declared path escapes the project root or is not a usable file path.');
        }
        if (/[*?{}\[]/.test(path)) return row(id, 'WARNING', 'Glob declaration: file existence is not inferred from a pattern.');
        let parent = absolute;
        while (true) {
          try { lstatSync(parent); break; }
          catch (error) { if (error.code !== 'ENOENT' || parent === dirname(parent)) throw error; parent = dirname(parent); }
        }
        const resolvedLocal = relative(realpathSync(root), realpathSync(parent));
        if (isAbsolute(resolvedLocal) || resolvedLocal === '..' || resolvedLocal.startsWith('../') || resolvedLocal.startsWith('..\\')) {
          return row(id, 'BLOCKED', 'Declared path resolves outside the project through a symlink.');
        }
        if (existsSync(absolute) && !statSync(absolute).isFile()) return row(id, 'BLOCKED', 'A concrete file declaration names a directory or another non-file object.');
        return row(id, key === 'modify' && !existsSync(absolute) ? 'BLOCKED' : 'PASS',
          key === 'modify' && !existsSync(absolute) ? 'A file declared for modification is missing.' : 'Declared path stays inside the project; new create/test files may be absent.');
      });
    }
    try {
      const { validatePlannedPathDeclarationsForChecklistItem } = await import(pathToFileURL(join(coreRoot, 'dist/core/acceptance-topology.js')).href);
      for (const item of originalItems) if (item.verificationIntent) probe(rows, `planned-path-schema:${item.id}`, () => {
        validatePlannedPathDeclarationsForChecklistItem(item, item.verificationIntent);
        return row(`planned-path-schema:${item.id}`, 'PASS', 'Planned path declarations match the existing acceptance topology contract.');
      });
    } catch (error) { rows.push(row('planned-path-schema', 'UNAVAILABLE', errorText(error))); }
  }
  if (story?.phase === 'INIT') {
    try {
      const { buildInitPreflightReport } = await import(pathToFileURL(join(coreRoot, 'dist/handlers/init-preflight.js')).href);
      probe(rows, 'init-prerequisites', () => {
        const report = buildInitPreflightReport({ root, store, scanRoot: join(root, loadConfig(root).scanRoot) }, storyId);
        return [ ...report.prerequisites.map(value => row(`init:${value.id}`, value.status === 'PASS' ? 'PASS' : 'BLOCKED', value.detail ?? value.status, value.fix)),
          row('init-authoritative-gate', report.gate.ready ? 'PASS' : 'BLOCKED', report.gate.blockedBy ?? 'The existing INIT_CHECK gate reports ready; this report grants no transition authority.') ];
      });
    } catch (error) { rows.push(row('init-prerequisites', 'UNAVAILABLE', errorText(error))); }
  }
  if (story) {
    try {
      const { getStoryWorktreeRuntime } = await import(pathToFileURL(join(coreRoot, 'dist/core/worktree-runtime.js')).href);
      probe(rows, 'story-worktree', () => {
        const runtime = getStoryWorktreeRuntime(storyId, store, root);
        const result = [row('story-worktree', runtime.hasWorktreeRecord ? (runtime.status === 'ok' ? 'PASS' : 'BLOCKED') : 'WARNING', runtime.summary, runtime.recoveryHint)];
        if (CWD_GATED_LIFECYCLE_PHASES.includes(story.phase) && runtime.linkedPath) {
          const local = relative(realpathSync(runtime.linkedPath), realpathSync(root));
          const inside = !isAbsolute(local) && local !== '..' && !local.startsWith('../') && !local.startsWith('..\\');
          result.push(row('story-worktree-cwd', inside ? 'PASS' : 'BLOCKED', inside
            ? 'The entry root is inside the Story worktree.' : `This phase requires the Story worktree: ${runtime.linkedPath}`));
        }
        return result;
      });
    } catch (error) { rows.push(row('story-worktree', 'UNAVAILABLE', errorText(error))); }
  }
  return rows;
}
function childProbe(root, storyId, kind) {
  return new Promise(resolveResult => execFile(process.execPath, [self, '--root', root, '--probe', kind, ...(storyId ? ['--storyId', storyId] : [])],
    { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return resolveResult([row(`${kind}-checks`, 'UNAVAILABLE', `${errorText(error)} ${stderr.trim()}`.slice(0, 2000))]);
      try { const result = JSON.parse(stdout); if (!Array.isArray(result)) throw new Error('Invalid diagnostic probe response'); resolveResult(result); }
      catch (error) { resolveResult([row(`${kind}-checks`, 'UNAVAILABLE', errorText(error))]); }
    }));
}
export async function collectEntryPreflight({ root, storyId }) {
  root = resolve(root);
  const started = performance.now();
  const rows = bootstrap(root);
  const results = await Promise.all([childProbe(root, storyId, 'runtime'), ...(storyId ? [childProbe(root, storyId, 'story')] : [])]);
  rows.push(...results.flat());
  return { schemaVersion: 'proof-or-stop.entry-preflight.v1', root, storyId: storyId ?? null,
    diagnosticOnly: true, writesEvidence: false, advancesPhase: false,
    elapsedMs: Math.round(performance.now() - started),
    diagnosticsReady: !rows.some(value => ['BLOCKED', 'UNAVAILABLE'].includes(value.status)), rows };
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(self)) {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string', default: process.cwd() }, storyId: { type: 'string' },
      json: { type: 'boolean' }, probe: { type: 'string' } }, strict: true, allowPositionals: false });
    if (values.probe) {
      if (!['runtime', 'story'].includes(values.probe)) throw new Error('Unknown diagnostic probe');
      console.log(JSON.stringify(await (values.probe === 'runtime' ? runtimeProbe(resolve(values.root)) : storyProbe(resolve(values.root), values.storyId))));
    } else {
      const report = await collectEntryPreflight(values);
      console.log(values.json ? JSON.stringify(report) : ['Entry preflight (diagnostic only; no evidence or phase changes)',
        ...report.rows.map(value => `[${value.status}] ${value.id}: ${value.detail}${value.fix ? ` Fix: ${value.fix}` : ''}`),
        `Elapsed: ${report.elapsedMs}ms; diagnostic readiness: ${report.diagnosticsReady}`].join('\n'));
      if (!report.diagnosticsReady) process.exitCode = 1;
    }
  } catch (error) { console.error(errorText(error)); process.exitCode = 1; }
}
