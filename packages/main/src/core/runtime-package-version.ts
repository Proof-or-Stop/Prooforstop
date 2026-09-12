import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROOF_OR_STOP_CLI_VERSION } from './proof-or-stop-brand.js';

/** Check this installation, never the caller's project or its package version. */
export function assertRuntimePackageVersion(): void {
  const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url));
  let installed: unknown;
  try {
    installed = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  } catch {
    throw new Error(`CLI_RUNTIME_VERSION_METADATA_INVALID: cannot read runtime package version at ${packagePath}. Repair this installation before retrying.`);
  }
  if (typeof installed !== 'string' || installed.trim().length === 0) {
    throw new Error(`CLI_RUNTIME_VERSION_METADATA_INVALID: missing runtime package version at ${packagePath}. Repair this installation before retrying.`);
  }
  if (installed === PROOF_OR_STOP_CLI_VERSION) return;
  const buildScript = resolve(dirname(packagePath), '../../scripts/ensure-dist.mjs');
  const sourcePath = resolve(dirname(packagePath), 'src/core/proof-or-stop-brand.ts');
  let sourceVersion: string | undefined;
  try {
    sourceVersion = readFileSync(sourcePath, 'utf8').match(/^export const PROOF_OR_STOP_CLI_VERSION\s*=\s*['"]([^'"]+)['"]/m)?.[1];
  } catch { /* Published installations need not include source. */ }
  const recovery = sourceVersion && sourceVersion !== installed
    ? `SOURCE_VERSION_DESYNC: source ${sourceVersion} at ${sourcePath} disagrees with package ${installed}. Reconcile the source constant and both package manifests through the version workflow before building; rebuilding alone cannot repair this mismatch.`
    : sourceVersion === installed && existsSync(buildScript)
    ? `Rebuild this checkout with node ${JSON.stringify(buildScript)}, then retry the same entrypoint.`
    : 'Source version could not be verified. Reinstall the intended @proof-or-stop/core package version or inspect its source and manifest versions before building, then retry the same entrypoint.';
  throw new Error(`CLI_RUNTIME_VERSION_MISMATCH: compiled CLI ${PROOF_OR_STOP_CLI_VERSION} differs from package ${installed} at ${packagePath}. ${recovery}`);
}
