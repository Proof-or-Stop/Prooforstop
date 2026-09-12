import { LAB_MAINTENANCE_RUNTIME_REQUIREMENTS as labPolicy } from '../packages/main/src/core/runtime-fact-registry.ts';
import { basename } from 'node:path';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
export const BUILTIN_AUDIT_PROVIDERS = [
  { id: 'codex', vendor: labPolicy.auditBuiltinVendors.codex, command: 'codex', protocol: 'codex-jsonl' },
  { id: 'claude', vendor: labPolicy.auditBuiltinVendors.claude, command: 'claude', protocol: 'claude-jsonl' },
];
export function auditProviders(config = {}) {
  if (labPolicy.auditRequired !== true || labPolicy.auditIndependence !== 'different-vendor') throw new Error('Unsupported Lab audit independence policy.');
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => !['adapters','preferredAuditor'].includes(k))) throw new Error('Invalid Lab audit provider configuration.');
  const providers = BUILTIN_AUDIT_PROVIDERS.map(p => ({...p}));
  for (const adapter of config.adapters ?? []) {
    if (!adapter || !/^[a-z][a-z0-9-]*$/.test(adapter.id) || !/^[a-z][a-z0-9-]*$/.test(adapter.vendor)
      || typeof adapter.command !== 'string' || !adapter.command.trim() || adapter.protocol !== labPolicy.auditCustomProtocol
      || !Array.isArray(adapter.argv) || adapter.argv.some(x => typeof x !== 'string')
      || providers.some(p => p.id === adapter.id) || ['claude','codex'].includes(basename(adapter.command))) throw new Error('Invalid/custom-overridden Lab audit adapter.');
    providers.push({...adapter});
  }
  if (config.preferredAuditor && !providers.some(p => p.id === config.preferredAuditor)) throw new Error('Unknown preferred Lab auditor.');
  return providers;
}
export function selectAuditor(developer, config = {}, available = command => command.includes('/') ? existsSync(command) : (process.env.PATH ?? '').split(delimiter).some(dir => existsSync(join(dir, command)))) {
  const providers = auditProviders(config);
  const dev = providers.find(p => p.id === developer);
  if (!dev) throw new Error('Unknown Lab developer provider; register its vendor first.');
  const candidates = config.preferredAuditor ? providers.filter(p => p.id === config.preferredAuditor) : providers;
  const selected = candidates.find(p => p.vendor !== dev.vendor && available(p.command));
  if (!selected) throw new Error('At least one available auditor from a different vendor is required.');
  return { developer: dev, auditor: selected };
}
