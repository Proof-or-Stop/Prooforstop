import { canonicalReviewHostCommand } from './host-execution-readiness.js';
import { readFileSync, realpathSync, accessSync, constants, statSync } from 'node:fs';
import { join, resolve, delimiter } from 'node:path';
import { pickProjectConfigPath, type ManagedReviewIsolationConfig } from './config.js';
import { MANAGED_REVIEW_READONLY_RUNTIME_POLICY } from './runtime-fact-registry.js';
/** Registered adapters cannot be replaced by caller commands or environment variables. */
export function resolveManagedReviewIsolation(root: string): ManagedReviewIsolationConfig | null {
  const selected=pickProjectConfigPath(root);
  if(!selected)return null;
  let config: Record<string,unknown>;
  try {config=JSON.parse(readFileSync(selected.path,'utf8'));}catch{throw new Error('managed review configuration is malformed; readonly policy cannot be resolved');}
  if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('managed review configuration must be an object');
  const value: unknown = config.managedReviewIsolation;
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('managedReviewIsolation must be an explicit registered adapter config');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'adapter,mode'
    || record.mode !== 'readonly-build' || record.adapter !== MANAGED_REVIEW_READONLY_RUNTIME_POLICY.adapter) {
    throw new Error('unsupported managedReviewIsolation mode or adapter; expected readonly-build / prooforstop-main-v1');
  }
  if (process.platform !== MANAGED_REVIEW_READONLY_RUNTIME_POLICY.platform) throw new Error('requested managed readonly build is unsupported on this platform');
  const canonical=realpathSync(root);
  const rootPackage=JSON.parse(readFileSync(join(canonical,'package.json'),'utf8')) as {name?:unknown};
  const mainPackage=JSON.parse(readFileSync(join(canonical,'packages/main/package.json'),'utf8')) as {name?:unknown};

  if(rootPackage.name!=='proof-or-stop'||mainPackage.name!=='@proof-or-stop/core'
    ||config.scanRoot!=='packages/main'||config.rootDir!=='src'||config.outDir!=='packages/main/dist') {
    throw new Error('requested prooforstop-main-v1 adapter does not support this project layout');
  }
  return {mode:'readonly-build',adapter:'prooforstop-main-v1'};
}
/** Local capability check only; existence is not a claim of provider login readiness. */
export function preflightManagedReadonlyHost(host: string, cwd: string, env: NodeJS.ProcessEnv): void {
  if (host !== 'codex' && host !== 'claude') throw new Error('requested readonly reviewer host lacks protected prompt transport');
  const command=canonicalReviewHostCommand(host);
  for(const item of (env.PATH ?? process.env.PATH ?? '').split(delimiter)) {
    const candidate=resolve(cwd,item||'.',command);
    try {accessSync(candidate,constants.X_OK);if(statSync(candidate).isFile())return;}catch { /* Continue exact PATH resolution; no child has started. */ }
  }
  throw new Error(`managed readonly provider executable unavailable before lane build: ${command}`);
}
