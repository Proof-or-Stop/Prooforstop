import { MANAGED_REVIEW_LANE_ARTIFACT, REVIEWER_BATCH_ADMISSION_ARTIFACT, resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { MANAGED_REVIEW_READONLY_RUNTIME_POLICY } from './runtime-fact-registry.js';
/** Bounded macOS write isolation for registered managed reviewer lanes. */
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { isAbsolute, relative, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ManagedReadonlyLayout {
  source: string;
  deniedSharedDist?: string[];
  probeRoot: string; // trusted synthetic immutable probe, outside reviewed material
  buildSource: string; // immutable independent checkout/copy, NOT an allowed write root
  originalWorktree: string;
  gitCommonDir: string;
  outputs: string[]; // Exact registered, untracked scratch runtime output subtree.
  temporary: string;
  cache: string;
}
export interface ManagedReadonlyLaunch { command: string; argv: string[]; cwd: string }
const within = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
};
function directory(path: string): string {
  const real = realpathSync(path);
  if (real !== path || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`managed readonly requires a real canonical directory: ${path}`);
  }
  return real;
}
function validated(layout: ManagedReadonlyLayout): { protectedRoots: string[]; writableRoots: string[] } {
  const protectedRoots = [layout.source, layout.buildSource, layout.originalWorktree, layout.gitCommonDir, layout.probeRoot].map(directory);
  const writableRoots = [...layout.outputs, layout.temporary, layout.cache].map(directory);
  if (!layout.outputs.length) throw new Error('managed readonly requires a declared independent build output');
  const expectedOutput=join(layout.source,MANAGED_REVIEW_LANE_ARTIFACT.sourceOutput);
  if(layout.outputs.length!==1||layout.outputs[0]!==expectedOutput)throw new Error('managed readonly output is not registered scratch runtime');
  const tracked=execFileSync('git',['ls-files','-z'],{cwd:layout.source,encoding:'utf8',maxBuffer:64*1024*1024}).split('\0').filter(Boolean);
  if(tracked.some(file=>within(expectedOutput,join(layout.source,file))||within(join(layout.source,file),expectedOutput)))throw new Error('managed readonly output overlaps tracked source');
  for (const write of writableRoots) {
    if (protectedRoots.some(read => (within(write, read) || within(read, write)) && !(read===layout.source && write===expectedOutput))) {
      throw new Error(`managed readonly output overlaps protected material: ${write}`);
    }
  }
  for (let i = 0; i < writableRoots.length; i++) for (let j = i + 1; j < writableRoots.length; j++) {
    if (within(writableRoots[i]!, writableRoots[j]!) || within(writableRoots[j]!, writableRoots[i]!)) {
      throw new Error('managed readonly writable directories must be distinct');
    }
  }
  return { protectedRoots, writableRoots };
}
export function managedReadonlyPolicy(layout: ManagedReadonlyLayout): string {
  const { writableRoots } = validated(layout);
  // Controller-only admission keys, seeds and records are never provider inputs.
  // Derive from the trusted original worktree; no optional caller deny-list.
  const admissionRoot = join(realpathSync(resolveCanonicalRuntimeProjectRoot(layout.originalWorktree)), PROOF_OR_STOP_DIR, 'runtime', REVIEWER_BATCH_ADMISSION_ARTIFACT.directoryName);
  return ['(version 1)', '(allow default)', '(deny file-write*)','(allow file-write* (literal "/dev/null"))',
    `(deny file-read* (subpath ${JSON.stringify(admissionRoot)}))`,
    ...writableRoots.map(root => `(allow file-write* (subpath ${JSON.stringify(root)}))`),
    ...(layout.deniedSharedDist ?? []).map(root => {if(!isAbsolute(root))throw new Error('shared dist deny path must be absolute');return `(deny file-read* (subpath ${JSON.stringify(root)}))`;})].join('\n');
}
/** Must run before invoking any provider. Does not provide login capability proof. */
export function prepareManagedReadonlyLaunch(layout: ManagedReadonlyLayout, launch: ManagedReadonlyLaunch): ManagedReadonlyLaunch {
  if (process.platform !== MANAGED_REVIEW_READONLY_RUNTIME_POLICY.platform) throw new Error('managed readonly platform capability unavailable');
  const sandbox = '/usr/bin/sandbox-exec';
  if (!existsSync(sandbox)) throw new Error('managed readonly sandbox unavailable');
  const policy = managedReadonlyPolicy(layout);
  const cwd = directory(launch.cwd);
  if (cwd !== layout.source && cwd !== layout.buildSource) throw new Error('managed readonly cwd is not a bound source directory');
  // Dedicated immutable probe input was prepared by the trusted caller; do not
  // mutate source merely to exercise capability. The parent path is not writable.
  const token = randomUUID();
  const probeRead = join(layout.probeRoot, '.managed-readonly-capability');
  if (!existsSync(probeRead)) throw new Error('trusted readonly capability input missing');
  const before = readFileSync(probeRead);
  const probes = validated(layout).writableRoots.map(root => join(root, `.capability-${token}`));
  const script = `const fs=require('node:fs');let denied=false;try{const fd=fs.openSync(${JSON.stringify(probeRead)},'r+');fs.closeSync(fd);}catch(e){denied=e.code==='EPERM'||e.code==='EACCES';}if(!denied)process.exit(41);for(const p of ${JSON.stringify(probes)})fs.writeFileSync(p,'ok');`;
  try {
    const result = spawnSync(sandbox, ['-p', policy, process.execPath, '-e', script], {
      cwd, encoding: 'utf8', timeout: MANAGED_REVIEW_READONLY_RUNTIME_POLICY.capabilityTimeoutMs, maxBuffer: 64 * 1024,
    });
    if (result.status !== 0 || result.error || !readFileSync(probeRead).equals(before)) {
      throw new Error('managed readonly write-isolation capability failed before provider launch');
    }
  } finally { for (const probe of probes) if (existsSync(probe)) unlinkSync(probe); }
  // Revalidate after the probe. The caller owns lifetime/cleanup; never permit
  // untrusted code to replace the lane parent while this launch is active.
  validated(layout);
  return { command: sandbox, argv: ['-p', policy, launch.command, ...launch.argv], cwd };
}
