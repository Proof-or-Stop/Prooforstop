import {instrumentChildProcesses} from './u17-attempt-capture.mjs';
import cp from 'node:child_process';
import { registerHooks, syncBuiltinESMExports, stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
const originalFile = cp.execFileSync, originalSync = cp.execSync;
const state = globalThis.__u17MemoAB = {
  mode: process.env.U17_MEMO_MODE ?? 'on',
  resetters: new Map(), baselineModules: [], attempts: [],
  counts: { lsTree: 0, showTopLevel: 0, gitTotal: 0, diff: 0, mergeBase: 0, revParse: 0, checkAttr: 0, config: 0, nodeLaunches: 0, otherLaunches: 0 },
  reset() { for (const reset of this.resetters.values()) reset(); },
  snapshot() { return { ...this.counts }; },
};
function count(args) {
  state.counts.gitTotal++;
  for (const [command, key] of [['ls-tree', 'lsTree'], ['diff', 'diff'], ['merge-base', 'mergeBase'], ['rev-parse', 'revParse'], ['check-attr', 'checkAttr'], ['config', 'config']]) if (args?.[0] === command) state.counts[key]++;
  if (args?.[0] === 'rev-parse' && args.includes('--show-toplevel')) state.counts.showTopLevel++;
}
state.countGit=count;
instrumentChildProcesses(cp,state);
syncBuiltinESMExports();
const baseline = process.env.U17_BASELINE;
if (!/^[0-9a-f]{40}$/.test(baseline ?? '')) throw new Error('full historical baseline SHA required');
const replaceOnce = (source, anchor, replacement) => {
  if (source.split(anchor).length !== 2) throw new Error('instrumentation anchor changed: ' + anchor);
  return source.replace(anchor, replacement);
};
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (context.parentURL?.endsWith('?u17-historical') && /\/(evidence-freshness|story-aware-validation)\.js$/.test(result.url)) return { ...result, url: result.url + '?u17-historical' };
    return result;
  },
  load(url, context, next) {
    const historical = url.endsWith('?u17-historical');
    const cleanUrl = historical ? url.slice(0, -'?u17-historical'.length) : url;
    const name = ['evidence-freshness', 'git-probe', 'story-aware-validation', 'story-git-bytes'].find(name => cleanUrl.endsWith(`/core/${name}.js`));
    if (!name) return next(url, context);
    let source;
    if (historical) {
      if (!['evidence-freshness', 'story-aware-validation'].includes(name)) throw new Error('unexpected historical module');
      const path = `packages/main/src/core/${name}.ts`;
      const raw = originalFile('git', ['show', `${baseline}:${path}`], { cwd: process.env.U17_REPO, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      state.baselineModules.push({ path, baseline, sha256: createHash('sha256').update(raw).digest('hex') });
      source = stripTypeScriptTypes(raw, { mode: 'strip', sourceUrl: url });
    } else source = readFileSync(new URL(url), 'utf8');
    let reset;
    if (name === 'evidence-freshness') {
      const hit = 'if (previous?.sha === sha)';
      source = replaceOnce(source, hit, 'if (globalThis.__u17MemoAB.mode !== "off" && previous?.sha === sha)');
      if (!historical) {
        const fn = 'export function currentStoryFilesHash(gitCwd, ref = \'HEAD\', metadataRoot = gitCwd) {';
        source = replaceOnce(source, fn, fn + '\n if (globalThis.__u17MemoAB.mode === "off") return globalThis.__u17HistoricalStory.currentStoryFilesHash(gitCwd, ref, metadataRoot);');
      }
      reset = 'treeMemo.clear(); treeMemoBytes = 0;';
    } else if (name === 'git-probe') {
      source = replaceOnce(source, 'if (prior?.identity === identity && prior)', 'if (globalThis.__u17MemoAB.mode !== "off" && prior?.identity === identity && prior)');
      reset = 'rootProbes.clear();';
    } else if (name === 'story-aware-validation') {
      if (!historical) {
        const fn = "export function resolveStoryChangedFiles(gitCwd, ref = 'HEAD', metadataRoot = gitCwd, explicitBaseHead) {";
        source = replaceOnce(source, fn, fn + '\n if (globalThis.__u17MemoAB.mode === "off") return globalThis.__u17HistoricalStoryAware.resolveStoryChangedFiles(gitCwd, ref, metadataRoot, explicitBaseHead);');
      }
      reset = 'graphTreeCache.clear();';
    }
    else reset = 'clear(); authorities.clear();';
    source += `\nglobalThis.__u17MemoAB.resetters.set(${JSON.stringify((historical ? 'historical:' : 'current:') + name)}, () => { ${reset} });\n`;
    return { format: 'module', source, shortCircuit: true };
  },
});
// Both modes initialize historical modules before timing, so transpilation and
// fixture-independent historical Git reads are not asymmetric target work.
globalThis.__u17HistoricalStory = await import(pathToFileURL(join(process.env.U17_REPO, 'packages/main/dist/core/evidence-freshness.js')).href + '?u17-historical');
globalThis.__u17HistoricalStoryAware = await import(pathToFileURL(join(process.env.U17_REPO, 'packages/main/dist/core/story-aware-validation.js')).href + '?u17-historical');
process.once('exit', () => {
  if (process.env.U17_AB_CHILD_METRICS) writeFileSync(process.env.U17_AB_CHILD_METRICS + '.' + process.pid + '.json', JSON.stringify({ pid: process.pid, mode: state.mode, counts: state.snapshot(), baselineModules: state.baselineModules }));
});
