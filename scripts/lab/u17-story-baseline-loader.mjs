import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

globalThis.__u17BaselineModules = [];
registerHooks({
  load(url, context, next) {
    if (process.env.U17_MODE !== 'old') return next(url, context);
    const name = ['evidence-freshness', 'story-aware-validation'].find(name => url.endsWith(`/core/${name}.js`));
    if (!name) return next(url, context);
    const baseline = process.env.U17_BASELINE;
    if (!/^[0-9a-f]{40}$/.test(baseline ?? '')) throw new Error('fully resolved baseline SHA required');
    const path = `packages/main/src/core/${name}.ts`;
    const source = execFileSync('git', ['show', `${baseline}:${path}`], {
      cwd: process.env.U17_REPO, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    globalThis.__u17BaselineModules.push({ path, baseline, sha256: createHash('sha256').update(source).digest('hex') });
    return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url }), shortCircuit: true };
  },
});
