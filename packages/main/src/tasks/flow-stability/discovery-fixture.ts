import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { PROCESS_FACT_REGISTRY } from '../../core/process-fact-registry.js';

/**
 * This fixture tests acceptance command discovery, not the registered modules'
 * runtime correctness. Supply inert snapshots for declared source references;
 * preserve its hand-written producers/consumers and all real gate assertions.
 */
export function writeRegisteredDiscoverySnapshots(root: string): void {
  const refs = new Set(PROCESS_FACT_REGISTRY.flatMap(entry => [
    ...(entry.producerSourceRefs ?? []), ...(entry.consumerSourceRefs ?? []),
  ]));
  for (const path of refs) {
    assert.ok(!isAbsolute(path) && !path.split(/[\\/]/).includes('..'), 'fixture source ref must stay in fixture');
    const target = join(root, path);
    if (existsSync(target)) continue;
    if (/\.(?:[cm]?[jt]sx?|json|md)$/.test(path)) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, path.endsWith('.json') ? '{}\n' : 'export {};\n');
    } else mkdirSync(target, { recursive: true });
  }
}
