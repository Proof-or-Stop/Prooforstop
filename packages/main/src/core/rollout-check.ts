import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { runManagedAssetCheck, type ManagedAssetCheckResult, type ManagedAssetStatus } from './managed-assets.js';
import { runRuntimeEnvironmentChecks, type RuntimeEnvironmentReport, type RuntimeFactStatus } from './runtime-environment-checks.js';
import {
  LATTICE_CLI_VERSION,
  LATTICE_PRODUCT_NAME,
  LATTICE_PRIMARY_BIN,
  KOALA_LEGACY_ALIAS,
  formatLatticeProductLine,
} from './lattice-brand.js';

export type RolloutFormat = 'text' | 'json';
export type RolloutStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface RolloutCheckOptions {
  root: string;
  projects?: string | string[];
  maxDepth?: number;
}

export interface RolloutProbe {
  id: string;
  label: string;
  status: RolloutStatus;
  command: string;
  executed: 'in-process' | 'filesystem-probe' | 'git-probe' | 'not-executed';
  readOnly: true;
  detail: string;
  nextAction?: string;
}

export interface RolloutProjectGit {
  isRepo: boolean;
  branch: string | null;
  dirty: boolean | null;
  dirtyCount: number;
}

export interface RolloutProjectStoryState {
  activeStoryCount: number;
  currentStoryId: string | null;
  currentPhase: string | null;
}

export interface RolloutProjectResult {
  path: string;
  name: string;
  exists: boolean;
  status: RolloutStatus;
  nextAction: string;
  git: RolloutProjectGit;
  story: RolloutProjectStoryState;
  runtimeMode: RuntimeEnvironmentReport['runtimeMode'] | null;
  probes: RolloutProbe[];
}

export interface RolloutCheckResult {
  schemaVersion: 'lattice.rollout_check.v1';
  product: {
    name: typeof LATTICE_PRODUCT_NAME;
    version: typeof LATTICE_CLI_VERSION;
    primaryBin: typeof LATTICE_PRIMARY_BIN;
    legacyAlias: typeof KOALA_LEGACY_ALIAS;
  };
  readOnly: true;
  macAppRequired: false;
  summary: {
    total: number;
    pass: number;
    warn: number;
    fail: number;
    skip: number;
  };
  scannedAt: string;
  root: string;
  projects: RolloutProjectResult[];
  safety: {
    forbiddenArgs: readonly string[];
    note: string;
  };
}

const SKIP_DIRS = new Set([
  '.git',
  '.worktrees',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
]);

const FORBIDDEN_ARGS = ['--apply', '--upgrade', '--repair', '--fix'] as const;

const PRODUCT = {
  name: LATTICE_PRODUCT_NAME,
  version: LATTICE_CLI_VERSION,
  primaryBin: LATTICE_PRIMARY_BIN,
  legacyAlias: KOALA_LEGACY_ALIAS,
} as const;

function statusRank(status: RolloutStatus): number {
  return status === 'fail' ? 3 : status === 'warn' ? 2 : status === 'skip' ? 1 : 0;
}

function worstStatus(statuses: RolloutStatus[]): RolloutStatus {
  return statuses.reduce<RolloutStatus>((worst, status) =>
    statusRank(status) > statusRank(worst) ? status : worst, 'pass');
}

function gitLines(root: string, args: string[]): string[] {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function gitText(root: string, args: string[]): string | null {
  const lines = gitLines(root, args);
  return lines.length > 0 ? lines.join('\n') : null;
}

function isGitRepo(root: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readPackageVersion(path: string): string | null {
  const parsed = readJsonFile(path);
  return typeof parsed?.version === 'string' ? parsed.version : null;
}

function readPackageName(path: string): string | null {
  const parsed = readJsonFile(path);
  return typeof parsed?.name === 'string' ? parsed.name : null;
}

function packageBinHasLattice(path: string): boolean {
  const parsed = readJsonFile(path);
  const bin = parsed?.bin;
  return !!bin && typeof bin === 'object' &&
    (bin as Record<string, unknown>).lattice === 'dist/cli.js' &&
    (bin as Record<string, unknown>).koala === 'dist/cli.js';
}

function parseProjectList(root: string, projects: string | string[] | undefined, maxDepth: number): string[] {
  if (projects !== undefined) {
    const parts = (Array.isArray(projects) ? projects : projects.split(','))
      .map(part => part.trim())
      .filter(part => part.length > 0);
    if (parts.length === 0) {
      throw new Error('rollout_check --projects was provided but did not include any project paths; omit --projects to discover from root or pass at least one path.');
    }
    return uniquePaths(parts.map(part => resolveProject(root, part)));
  }
  return discoverProjects(root, maxDepth);
}

function resolveProject(root: string, project: string): string {
  return isAbsolute(project) ? resolve(project) : resolve(root, project);
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

function discoverProjects(root: string, maxDepth: number): string[] {
  const start = resolve(root);
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    if (looksLikeProject(dir)) {
      found.push(dir);
      if (dir !== start) return;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) visit(full, depth + 1);
      } catch {
        // PROBE: unreadable entries are ignored during rollout discovery.
      }
    }
  };
  visit(start, 0);
  return uniquePaths(found.length > 0 ? found : [start]);
}

function looksLikeProject(dir: string): boolean {
  return existsSync(join(dir, 'koala.config.json')) ||
    existsSync(join(dir, '.koala')) ||
    existsSync(join(dir, 'package.json')) ||
    existsSync(join(dir, 'AGENTS.md')) ||
    existsSync(join(dir, 'CLAUDE.md')) ||
    existsSync(join(dir, 'KOALA.md'));
}

function buildGitProbe(projectRoot: string): RolloutProjectGit {
  const repo = isGitRepo(projectRoot);
  if (!repo) return { isRepo: false, branch: null, dirty: null, dirtyCount: 0 };
  const branch = gitText(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirtyLines = gitLines(projectRoot, ['status', '--porcelain=v1', '--untracked-files=normal']);
  return {
    isRepo: true,
    branch,
    dirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
  };
}

function buildStoryProbe(projectRoot: string, branch: string | null): RolloutProjectStoryState {
  const activeDir = join(projectRoot, '.koala', 'story', 'actives');
  let activeStoryCount = 0;
  try {
    activeStoryCount = readdirSync(activeDir).filter(entry => {
      try {
        return statSync(join(activeDir, entry)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    activeStoryCount = 0;
  }

  const currentStoryId = branch?.startsWith('story/') ? branch.slice('story/'.length) : null;
  let currentPhase: string | null = null;
  if (currentStoryId) {
    const story = readJsonFile(join(projectRoot, '.koala', 'story', 'actives', currentStoryId, 'index.json'));
    currentPhase = typeof story?.phase === 'string' ? story.phase : null;
  }
  return { activeStoryCount, currentStoryId, currentPhase };
}

function managedAssetStatus(result: ManagedAssetCheckResult): RolloutStatus {
  if (result.ok) return 'pass';
  const unsafe: ManagedAssetStatus[] = ['STALE_LOCAL_EDIT', 'INCOMPATIBLE', 'CASE_MISMATCH'];
  return result.items.some(item => unsafe.includes(item.status)) ? 'fail' : 'warn';
}

function runtimeStatus(result: RuntimeEnvironmentReport): RolloutStatus {
  const status: RuntimeFactStatus = result.summary.status;
  return status === 'fail' ? 'fail' : status === 'warn' ? 'warn' : 'pass';
}

function buildConfigProbe(projectRoot: string): RolloutProbe {
  const rootPackageVersion = readPackageVersion(join(projectRoot, 'package.json'));
  const mainPackagePath = join(projectRoot, 'packages', 'main', 'package.json');
  const mainPackageVersion = readPackageVersion(mainPackagePath);
  const mainPackageName = readPackageName(mainPackagePath);
  const hasLatticeWrapper = existsSync(join(projectRoot, 'bin', 'lattice.js'));
  const hasLegacyWrapper = existsSync(join(projectRoot, 'bin', 'koala.js'));
  const hasBinAliases = packageBinHasLattice(mainPackagePath);
  const isSelfLayout = mainPackageName === '@koala-agent/core' && hasBinAliases;
  const ok = isSelfLayout
    ? rootPackageVersion === LATTICE_CLI_VERSION && mainPackageVersion === LATTICE_CLI_VERSION && hasLatticeWrapper && hasLegacyWrapper && hasBinAliases
    : true;
  const status: RolloutStatus = ok ? 'pass' : 'warn';
  const detail = isSelfLayout
    ? `root=${rootPackageVersion ?? 'unreadable'}; main=${mainPackageVersion ?? 'unreadable'}; expected=${LATTICE_CLI_VERSION}; latticeWrapper=${hasLatticeWrapper}; legacyAlias=${hasLegacyWrapper}; binAliases=${hasBinAliases}`
    : `external project; global ${formatLatticeProductLine()} can be used without a project-local JS wrapper`;
  return {
    id: 'lattice_config_doctor',
    label: 'Lattice config doctor',
    status,
    command: 'lattice lattice_config_doctor --format=json',
    executed: 'filesystem-probe',
    readOnly: true,
    detail,
    ...(status === 'warn' ? { nextAction: 'Refresh the local CLI package/wrappers, then rerun lattice lattice_config_doctor.' } : {}),
  };
}

function buildRuntimeProbe(result: RuntimeEnvironmentReport): RolloutProbe {
  const status = runtimeStatus(result);
  return {
    id: 'runtime_footprint',
    label: 'Runtime footprint',
    status,
    command: 'lattice check --json',
    executed: 'in-process',
    readOnly: true,
    detail: `${result.runtimeMode.mode}/${result.runtimeMode.source}; projectLocalJS=${result.runtimeMode.requiresProjectJavaScriptRuntime}; facts=${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail`,
    ...(status !== 'pass' ? { nextAction: result.runtimeMode.message } : {}),
  };
}

function buildManagedAssetProbe(result: ManagedAssetCheckResult): RolloutProbe {
  const status = managedAssetStatus(result);
  return {
    id: 'managed_assets',
    label: 'Managed assets',
    status,
    command: 'lattice check --json',
    executed: 'in-process',
    readOnly: true,
    detail: `mode=${result.mode}; OK=${result.summary.OK ?? 0}; MISSING=${result.summary.MISSING ?? 0}; STALE_SAFE=${result.summary.STALE_SAFE ?? 0}; STALE_LOCAL_EDIT=${result.summary.STALE_LOCAL_EDIT ?? 0}; INCOMPATIBLE=${result.summary.INCOMPATIBLE ?? 0}`,
    ...(status !== 'pass' ? { nextAction: 'Run lattice check manually, review unsafe items, then use lattice check --apply or --upgrade only after operator approval.' } : {}),
  };
}

function buildDoctorProbe(runtime: RuntimeEnvironmentReport, git: RolloutProjectGit): RolloutProbe {
  const status = worstStatus([
    runtimeStatus(runtime),
    git.isRepo && git.dirty === true ? 'warn' : 'pass',
    git.isRepo ? 'pass' : 'warn',
  ]);
  const detail = [
    `git=${git.isRepo ? 'repo' : 'not-git'}`,
    git.dirty === null ? 'dirty=unknown' : `dirty=${git.dirty} (${git.dirtyCount})`,
    `runtime=${runtime.summary.status}`,
  ].join('; ');
  return {
    id: 'doctor_readonly_subset',
    label: 'Doctor readiness',
    status,
    command: 'lattice doctor --format=json',
    executed: 'in-process',
    readOnly: true,
    detail,
    ...(status !== 'pass' ? { nextAction: 'Run lattice doctor for full health details; use --repair only as an explicit maintenance action.' } : {}),
  };
}

function buildTranscriptScopeProbe(projectRoot: string, story: RolloutProjectStoryState): RolloutProbe {
  const hasAgentGuide = existsSync(join(projectRoot, 'AGENTS.md'));
  const hasKoalaGuide = existsSync(join(projectRoot, 'KOALA.md')) || existsSync(join(projectRoot, 'CLAUDE.md'));
  const hasStoryRoot = existsSync(join(projectRoot, '.koala', 'story'));
  const status: RolloutStatus = hasAgentGuide && hasKoalaGuide && hasStoryRoot ? 'pass' : 'warn';
  const parts = [
    `AGENTS.md=${hasAgentGuide}`,
    `KOALA/CLAUDE guide=${hasKoalaGuide}`,
    `.koala/story=${hasStoryRoot}`,
    `activeStories=${story.activeStoryCount}`,
  ];
  if (story.currentStoryId) parts.push(`current=${story.currentStoryId}:${story.currentPhase ?? 'unknown'}`);
  return {
    id: 'transcript_scope',
    label: 'Transcript and story scope',
    status,
    command: 'lattice session_brief',
    executed: 'filesystem-probe',
    readOnly: true,
    detail: parts.join('; '),
    ...(status !== 'pass' ? { nextAction: 'Initialize or refresh managed project guidance with lattice init/check so transcript and story evidence have a clear home.' } : {}),
  };
}

function nextActionFor(status: RolloutStatus, probes: RolloutProbe[]): string {
  if (status === 'pass') return 'Ready for Lattice CLI rollout.';
  const firstFail = probes.find(probe => probe.status === 'fail');
  if (firstFail?.nextAction) return firstFail.nextAction;
  const firstWarn = probes.find(probe => probe.status === 'warn');
  return firstWarn?.nextAction ?? 'Review warnings and rerun lattice rollout_check.';
}

function scanProject(projectRoot: string): RolloutProjectResult {
  const path = resolve(projectRoot);
  const exists = existsSync(path);
  if (!exists) {
    return {
      path,
      name: basename(path),
      exists: false,
      status: 'fail',
      nextAction: 'Project path does not exist; remove it from rollout scope or create it first.',
      git: { isRepo: false, branch: null, dirty: null, dirtyCount: 0 },
      story: { activeStoryCount: 0, currentStoryId: null, currentPhase: null },
      runtimeMode: null,
      probes: [{
        id: 'path_exists',
        label: 'Project path',
        status: 'fail',
        command: 'filesystem stat',
        executed: 'filesystem-probe',
        readOnly: true,
        detail: 'path does not exist',
      }],
    };
  }

  const git = buildGitProbe(path);
  const story = buildStoryProbe(path, git.branch);
  const runtime = runRuntimeEnvironmentChecks(path);
  const managedAssets = runManagedAssetCheck(path, {});
  const probes = [
    buildConfigProbe(path),
    buildRuntimeProbe(runtime),
    buildManagedAssetProbe(managedAssets),
    buildDoctorProbe(runtime, git),
    buildTranscriptScopeProbe(path, story),
  ];
  const status = worstStatus(probes.map(probe => probe.status));
  return {
    path,
    name: basename(path),
    exists: true,
    status,
    nextAction: nextActionFor(status, probes),
    git,
    story,
    runtimeMode: runtime.runtimeMode,
    probes,
  };
}

export function buildRolloutCheck(options: RolloutCheckOptions): RolloutCheckResult {
  const root = resolve(options.root);
  const projects = parseProjectList(root, options.projects, options.maxDepth ?? 1);
  const scanned = projects.map(scanProject);
  const summary = scanned.reduce((acc, project) => {
    acc[project.status] += 1;
    return acc;
  }, { total: scanned.length, pass: 0, warn: 0, fail: 0, skip: 0 });
  return {
    schemaVersion: 'lattice.rollout_check.v1',
    product: PRODUCT,
    readOnly: true,
    macAppRequired: false,
    summary,
    scannedAt: new Date().toISOString(),
    root,
    projects: scanned,
    safety: {
      forbiddenArgs: FORBIDDEN_ARGS,
      note: 'rollout_check uses filesystem, git, runtime, and managed-asset probes only; it never runs apply, upgrade, repair, fix, installer, evidence-submit, or receipt-verify paths.',
    },
  };
}

function statusIcon(status: RolloutStatus): string {
  return status === 'pass' ? 'pass' : status === 'warn' ? 'warn' : status === 'fail' ? 'fail' : 'skip';
}

export function renderRolloutCheckText(result: RolloutCheckResult): string {
  const lines: string[] = [];
  lines.push(`${formatLatticeProductLine()} rollout check (${result.schemaVersion})`);
  lines.push(`readOnly: ${result.readOnly}; macAppRequired: ${result.macAppRequired}`);
  lines.push(`summary: total=${result.summary.total}; pass=${result.summary.pass}; warn=${result.summary.warn}; fail=${result.summary.fail}; skip=${result.summary.skip}`);
  lines.push(`root: ${result.root}`);
  lines.push('');
  for (const project of result.projects) {
    lines.push(`- ${project.path}`);
    lines.push(`  status: ${statusIcon(project.status)}`);
    lines.push(`  next: ${project.nextAction}`);
    lines.push(`  git: ${project.git.isRepo ? `branch=${project.git.branch ?? 'unknown'}; dirty=${project.git.dirty} (${project.git.dirtyCount})` : 'not a git repository'}`);
    if (project.runtimeMode) {
      lines.push(`  runtime: ${project.runtimeMode.mode}/${project.runtimeMode.source}; projectLocalJS=${project.runtimeMode.requiresProjectJavaScriptRuntime}`);
    }
    for (const probe of project.probes) {
      lines.push(`  - ${probe.id}: ${statusIcon(probe.status)} — ${probe.detail}`);
      if (probe.nextAction) lines.push(`    next: ${probe.nextAction}`);
    }
  }
  lines.push('');
  lines.push(`safety: ${result.safety.note}`);
  return lines.join('\n');
}
