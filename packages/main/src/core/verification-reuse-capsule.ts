import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative, resolve as resolvePath } from 'node:path';
import {
  closedVerificationReuseCapsuleEnvironment,
  VERIFICATION_REUSE_CAPSULE_ENVIRONMENT_KEYS,
} from './validation-command-environment.js';

export const VERIFICATION_REUSE_CAPSULE_PROFILE = 'proof-or-stop.verification-reuse-capsule.v1' as const;
export const VERIFICATION_DEPENDENCY_MANIFEST_V2 = 'proof-or-stop.verifier-dependency-manifest.v2' as const;
export const VERIFICATION_DEPENDENCY_MANIFEST_BINDING_V2 = 'proof-or-stop.verifier-dependency-manifest-binding.v2' as const;

const REQUIRED_PERMISSION_FLAGS = [
  '--permission', '--allow-fs-read', '--allow-fs-write', '--allow-child-process',
  '--allow-worker', '--allow-net', '--allow-ffi', '--allow-wasi',
] as const;

/**
 * Fixed, whitespace-free program run by the capsule. It validates that argv is
 * exactly the manifest's resolved file list and that Node granted only the
 * individual read capabilities. It never evaluates manifest-supplied code.
 */
export const VERIFICATION_REUSE_CAPSULE_SOURCE = [
  "const f=require('node:fs'),p=require('node:path'),m=process.argv[1],a=process.argv.slice(2),v=JSON.parse(f.readFileSync(m,'utf8')),e=v.files.map(x=>p.resolve(process.cwd(),x)),k=Object.keys(v).sort().join(',');",
  `const d=[v.schemaVersion!==${JSON.stringify(VERIFICATION_DEPENDENCY_MANIFEST_V2)},v.capsuleProfile!==${JSON.stringify(VERIFICATION_REUSE_CAPSULE_PROFILE)},k!=='capsuleProfile,files,schemaVersion',JSON.stringify(a)!==JSON.stringify(e),!process.permission,!a.every(x=>process.permission.has('fs.read',x)),process.permission.has('fs.read',process.cwd()),['fs.write','child','worker','addons','wasi','inspector','net','ffi'].some(x=>process.permission.has(x,process.cwd()))];if(d.some(Boolean)){process.stderr.write('verification reuse capsule policy denied:'+d.map(Number).join('')+'\\n');process.exit(70);}`,
  "for(const x of a)process.stdout.write(f.readFileSync(x));",
].join('');

function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export const VERIFICATION_REUSE_CAPSULE_POLICY_DIGEST = canonicalDigest({
  profile: VERIFICATION_REUSE_CAPSULE_PROFILE,
  source: VERIFICATION_REUSE_CAPSULE_SOURCE,
  permissionFlags: REQUIRED_PERMISSION_FLAGS,
  environmentKeys: VERIFICATION_REUSE_CAPSULE_ENVIRONMENT_KEYS,
  deniedCapabilities: ['ambient-environment', 'undeclared-read', 'write', 'child', 'worker', 'network', 'ffi', 'wasi', 'inspector', 'loader', 'preload', 'dynamic-code'],
});

export function verificationReuseCapsuleEnforcementSupported(): boolean {
  if (process.platform === 'win32') return false;
  const flags = process.allowedNodeEnvironmentFlags;
  return Boolean(flags && REQUIRED_PERMISSION_FLAGS.every(flag => flags.has(flag)));
}

/** The exact environment used by both the identity calculation and spawn. */
export function verificationReuseCapsuleEnvironment(cwd: string): Record<string, string> {
  return closedVerificationReuseCapsuleEnvironment(cwd);
}

function quoteToken(value: string): string {
  if (/^[A-Za-z0-9_./:=+,-]+$/u.test(value)) return value;
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

export interface VerificationReuseCapsuleInvocation {
  command: string;
  executable: 'node';
  argv: string[];
  manifestAbsolutePath: string;
  inputAbsolutePaths: string[];
  environment: Record<string, string>;
  policyDigest: string;
}

export function buildVerificationReuseCapsuleInvocation(input: {
  cwd: string;
  manifestPath: string;
  files: readonly string[];
}): VerificationReuseCapsuleInvocation {
  if (!verificationReuseCapsuleEnforcementSupported()) {
    throw new Error('verification reuse capsule enforcement is unavailable [unsupported_capsule_enforcement]');
  }
  const canonicalCwd = realpathSync(input.cwd);
  const manifestAbsolutePath = resolvePath(canonicalCwd, input.manifestPath);
  const inputAbsolutePaths = input.files.map(path => resolvePath(canonicalCwd, path));
  const argv = [
    '--permission',
    `--allow-fs-read=${manifestAbsolutePath}`,
    ...inputAbsolutePaths.map(path => `--allow-fs-read=${path}`),
    '-e',
    VERIFICATION_REUSE_CAPSULE_SOURCE,
    '--',
    manifestAbsolutePath,
    ...inputAbsolutePaths,
  ];
  return {
    command: ['node', ...argv].map(quoteToken).join(' '),
    executable: 'node',
    argv,
    manifestAbsolutePath,
    inputAbsolutePaths,
    environment: verificationReuseCapsuleEnvironment(canonicalCwd),
    policyDigest: VERIFICATION_REUSE_CAPSULE_POLICY_DIGEST,
  };
}

export function isExactVerificationReuseCapsuleInvocation(input: {
  executable: string;
  argv: readonly string[];
  expected: VerificationReuseCapsuleInvocation;
}): boolean {
  return input.executable === input.expected.executable
    && input.argv.length === input.expected.argv.length
    && input.argv.every((value, index) => value === input.expected.argv[index]);
}

/**
 * Recognize the fixed capsule at the executor boundary and return its closed
 * environment. Recognition is argv-exact; appended loader/preload/permission
 * flags or substituted source code fall back to the ordinary non-reusable path.
 */
export function closedEnvironmentForVerificationReuseCapsuleInvocation(input: {
  executable: string;
  argv: readonly string[];
  cwd: string;
}): Record<string, string> | null {
  try {
    const separator = input.argv.indexOf('--');
    if (separator < 0 || input.argv[separator + 1] === undefined) return null;
    const manifestAbsolutePath = input.argv[separator + 1]!;
    const inputAbsolutePaths = input.argv.slice(separator + 2);
    const canonicalCwd = realpathSync(input.cwd);
    const expected = buildVerificationReuseCapsuleInvocation({
      cwd: canonicalCwd,
      manifestPath: relative(canonicalCwd, manifestAbsolutePath),
      files: inputAbsolutePaths.map(path => relative(canonicalCwd, path)),
    });
    return isExactVerificationReuseCapsuleInvocation({
      executable: input.executable,
      argv: input.argv,
      expected,
    }) ? expected.environment : null;
  } catch {
    return null;
  }
}
