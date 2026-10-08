/**
 * N7 (old-PoS v4.1 cost plan): the Codex fixed prefix a managed worker does not use.
 *
 * Every managed Codex request (review lanes, inventory critic, implementers,
 * finding repair, scope-plan / INIT / delivery reviewers) re-sent, besides the
 * base instructions and the tools the role uses:
 *   - the skills listing (`<skills_instructions>`, ~2.5 KB at the bench), and
 *   - the multi-agent block: the "You are `/root` ... spawn_agent" developer
 *     text, the `<multi_agent_mode>` text and the `collaboration` tool
 *     (~6.8 KB together).
 * No managed role uses skills or sub-agents (a reviewer must not dispatch
 * another reviewer; a worker never delegates), so PoS, which owns the Codex
 * invocation of these workers, turns them off:
 *   - `skills.include_instructions=false` drops the skills listing;
 *   - `features.multi_agent=false` / `features.multi_agent_v2=false` turn the
 *     multi-agent feature off where the feature decides it;
 *   - a model catalog (`model_catalog_json`) whose models declare
 *     `multi_agent_version` forces the multi-agent block regardless of the
 *     feature switches (measured on Codex 0.154 against a recording Responses
 *     endpoint), so the worker gets a derived copy that differs only in
 *     `multi_agent_version: null`. The source catalog is never modified.
 * Ordinary host_run launches are untouched.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export const MANAGED_WORKER_CODEX_CONFIG = [
  'skills.include_instructions=false',
  'features.multi_agent=false',
  'features.multi_agent_v2=false',
] as const;

/** The configured model catalog path of this provider home, or null. */
function configuredModelCatalog(env: NodeJS.ProcessEnv): string | null {
  const codexHome = env.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const configPath = join(codexHome, 'config.toml');
  if (!existsSync(configPath)) return null;
  try {
    const value = (parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>).model_catalog_json;
    if (typeof value !== 'string' || !value.trim()) return null;
    return isAbsolute(value) ? value : resolve(codexHome, value);
  } catch { return null; }
}

/**
 * The derived catalog (multi_agent_version null on every model) for a catalog
 * that declares it, written once per source content; null when none is needed
 * or it cannot be derived (the launch then keeps the source catalog).
 */
export function managedWorkerModelCatalog(env: NodeJS.ProcessEnv): string | null {
  const source = configuredModelCatalog(env);
  if (!source || !existsSync(source)) return null;
  try {
    const text = readFileSync(source, 'utf8');
    const catalog = JSON.parse(text) as { models?: Array<Record<string, unknown>> };
    if (!Array.isArray(catalog.models) || !catalog.models.some(model => model && model.multi_agent_version != null)) return null;
    const derived = { ...catalog, models: catalog.models.map(model => ({ ...model, multi_agent_version: null })) };
    const dir = join(tmpdir(), 'proof-or-stop-codex-worker-catalog');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${createHash('sha256').update(text).digest('hex').slice(0, 32)}.json`);
    if (!existsSync(path)) writeFileSync(path, `${JSON.stringify(derived, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch { return null; }
}

/** `--config` arguments every managed Codex worker launch carries (before the stdin marker). */
export function managedWorkerCodexConfigArgs(env: NodeJS.ProcessEnv): string[] {
  const catalog = managedWorkerModelCatalog(env);
  return [
    ...MANAGED_WORKER_CODEX_CONFIG.flatMap(value => ['--config', value]),
    ...(catalog ? ['--config', `model_catalog_json=${JSON.stringify(catalog)}`] : []),
  ];
}
