/** Canonical on-disk identities. Normal runtime resolution accepts no legacy spelling. */
export const PROOF_OR_STOP_STATE_DIR = '.proof-or-stop';
export const PROOF_OR_STOP_ADAPTER_DIR = '.proof-or-stop-codex';
export const PROOF_OR_STOP_CONFIG_FILENAME = 'proof-or-stop.config.json';
export const PROOF_OR_STOP_MANIFEST_FILENAME = 'proof-or-stop.json';

export const STATE_DIR_NAMES: readonly string[] = [PROOF_OR_STOP_STATE_DIR];
export const ADAPTER_DIR_NAMES: readonly string[] = [PROOF_OR_STOP_ADAPTER_DIR];
export const CONFIG_FILENAMES: readonly string[] = [PROOF_OR_STOP_CONFIG_FILENAME];
export const MANIFEST_FILENAMES: readonly string[] = [PROOF_OR_STOP_MANIFEST_FILENAME];

function normalizeForCompare(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function firstSegment(path: string): string {
  const normalized = normalizeForCompare(path);
  if (!normalized) return '';
  const slash = normalized.indexOf('/');
  return slash === -1 ? normalized : normalized.slice(0, slash);
}

export function isStateDirPath(path: string): boolean {
  return firstSegment(path) === PROOF_OR_STOP_STATE_DIR;
}

export function isAdapterDirPath(path: string): boolean {
  return firstSegment(path) === PROOF_OR_STOP_ADAPTER_DIR;
}

export function isConfigFilename(name: string): boolean {
  return normalizeForCompare(name) === PROOF_OR_STOP_CONFIG_FILENAME;
}

export function isManifestFilename(name: string): boolean {
  return normalizeForCompare(name) === PROOF_OR_STOP_MANIFEST_FILENAME;
}

export function stateDirCandidates(...segments: readonly string[]): readonly string[] {
  const tail = segments.filter(Boolean).join('/');
  return [tail ? `${PROOF_OR_STOP_STATE_DIR}/${tail}` : PROOF_OR_STOP_STATE_DIR];
}

export function adapterDirCandidates(...segments: readonly string[]): readonly string[] {
  const tail = segments.filter(Boolean).join('/');
  return [tail ? `${PROOF_OR_STOP_ADAPTER_DIR}/${tail}` : PROOF_OR_STOP_ADAPTER_DIR];
}

export function isConfigFilenameMentioned(text: string): boolean {
  return text.includes(PROOF_OR_STOP_CONFIG_FILENAME);
}

export function resolveConfigFilename(exists: (name: string) => boolean): string {
  return exists(PROOF_OR_STOP_CONFIG_FILENAME)
    ? PROOF_OR_STOP_CONFIG_FILENAME
    : PROOF_OR_STOP_CONFIG_FILENAME;
}

export function resolveManifestFilename(exists: (name: string) => boolean): string {
  return exists(PROOF_OR_STOP_MANIFEST_FILENAME)
    ? PROOF_OR_STOP_MANIFEST_FILENAME
    : PROOF_OR_STOP_MANIFEST_FILENAME;
}

export function adapterManifestCandidates(): readonly string[] {
  return [`${PROOF_OR_STOP_ADAPTER_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME}`];
}
