/** Shared read-only validation entry construction and identity policy. */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HandlerContext } from './context.js';
import type { ChecklistData } from '../core/types.js';
import type { ValidationCommand, RoutineValidationSourceKind } from '../core/validation-types.js';
import { loadConfig } from '../core/config.js';
import { CONFIG_FILENAMES } from '../core/brand-paths.js';
import { validateResourceClaims, type ResourceClaim } from '../core/keyed-scheduler.js';
import { assertDeclaredValidationCommandId, parseLegacyValidationCommandString } from '../core/validation-command-identity.js';
import { resolveVerificationIntentPolicy, resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { isMaterialExcludedPath } from '../core/evidence-freshness.js';
import { findValidateFile, validateFileDefaultTimeoutMs } from '../core/validation-file-entry.js';
import { buildRoutineValidationIdentity } from '../core/validation-evidence-reuse.js';

export function commandFromString(label: string, value: string): ValidationCommand | null {
  const parsed = parseLegacyValidationCommandString(value);
  if (!parsed) return null;
  return parsed.shell
    ? { label, command: parsed.command, args: [], shell: true }
    : { label, command: parsed.command, args: parsed.args };
}

/**
 * Parse `validate.commands[].resources` from config into resource claims.
 *
 * Malformed or unrecognised claims THROW here, at declaration time, so a typo'd
 * class fails the whole validate run loudly instead of being dropped and
 * quietly turning into a command with no declared claim. (The fail-closed
 * default in resolveValidationCommandResources would still schedule such a
 * command alone, but a silently ignored declaration is a lie the operator
 * cannot see.)
 */
function parseConfiguredResourceClaims(value: unknown, owner: string): ResourceClaim[] {
  if (!Array.isArray(value)) {
    throw new Error(`${owner}: resources must be an array of resource claims`);
  }
  const claims = value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${owner}: every resource claim must be an object with class, key and access`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.class !== 'string' || typeof entry.key !== 'string' || typeof entry.access !== 'string') {
      throw new Error(`${owner}: every resource claim must be an object with class, key and access`);
    }
    return {
      class: entry.class as ResourceClaim['class'],
      key: entry.key,
      access: entry.access as ResourceClaim['access'],
      ...(entry.ownership !== undefined ? { ownership: entry.ownership as ResourceClaim['ownership'] } : {}),
    };
  });
  validateResourceClaims(claims, owner);
  return claims;
}

function normalizeValidateFocus(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const focus = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
  return focus.length > 0 ? focus : undefined;
}

export function filterFocusedConfiguredCommands(commands: ValidationCommand[], focus: string): ValidationCommand[] {
  const selected = commands.filter((cmd) => cmd.focus?.includes(focus));
  if (selected.length === 0) {
    throw new Error(
      `validate --focus=${focus}: no configured validate.commands are tagged with focus "${focus}"; ` +
      `tag one or more commands with focus: ["${focus}"] or run proof-or-stop validate --json for full validation.`,
    );
  }
  return selected;
}

export function configuredValidationCommands(projectRoot: string): ValidationCommand[] {
  const cfg = loadConfig(projectRoot) as any;
  const validate = cfg.validate || cfg.validation;
  const commands: ValidationCommand[] = [];
  if (!validate || typeof validate !== 'object') return commands;
  const dynamicDefaults = validate.dynamic?.policyDefaults && typeof validate.dynamic.policyDefaults === 'object'
    ? validate.dynamic.policyDefaults : {};
  const applyDynamicDefaults = (command: ValidationCommand): ValidationCommand => ({
    ...command,
    ...(command.assurance !== undefined ? {} : typeof dynamicDefaults.assurance === 'string' ? { assurance: dynamicDefaults.assurance } : {}),
    ...(command.riskTier !== undefined ? {} : typeof dynamicDefaults.riskTier === 'string' ? { riskTier: dynamicDefaults.riskTier } : {}),
    ...(command.closurePolicy !== undefined ? {} : typeof dynamicDefaults.closurePolicy === 'string' ? { closurePolicy: dynamicDefaults.closurePolicy } : {}),
    ...(command.fullBaselineReusePolicy !== undefined ? {} : typeof dynamicDefaults.fullBaselineReusePolicy === 'string' ? { fullBaselineReusePolicy: dynamicDefaults.fullBaselineReusePolicy } : {}),
    ...(command.cpuWeight !== undefined ? {} : typeof dynamicDefaults.cpuWeight === 'number' ? { cpuWeight: dynamicDefaults.cpuWeight } : {}),
    ...(command.expectedP50Ms !== undefined ? {} : typeof dynamicDefaults.expectedP50Ms === 'number' ? { expectedP50Ms: dynamicDefaults.expectedP50Ms } : {}),
  });

  if (typeof validate.command === 'string') {
    const cmd = commandFromString('configured validate.command', validate.command);
    if (cmd) commands.push(applyDynamicDefaults(cmd));
  }
  if (Array.isArray(validate.commands)) {
    for (let i = 0; i < validate.commands.length; i++) {
      const entry = validate.commands[i];
      if (typeof entry === 'string') {
        const cmd = commandFromString(`configured validate.commands[${i}]`, entry);
        if (cmd) commands.push(applyDynamicDefaults(cmd));
      } else if (entry && typeof entry === 'object' && typeof entry.command === 'string') {
        const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
        const focus = normalizeValidateFocus(entry.focus);
        commands.push({
          label: typeof entry.label === 'string' ? entry.label : `configured validate.commands[${i}]`,
          command: entry.command,
          args,
          ...(entry.shell === true ? { shell: true } : {}),
          ...(entry.executionReuse === 'exact-inputs' ? {executionReuse:'exact-inputs' as const} : {}),
          ...(Array.isArray(entry.executionInputs) ? {executionInputs:entry.executionInputs} : {}),
          ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
          ...(entry.env && typeof entry.env === 'object' ? { env: Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)])) } : {}),
          ...(Array.isArray(entry.declaredEnvironmentKeys) ? { declaredEnvironmentKeys: entry.declaredEnvironmentKeys.filter((item: unknown): item is string => typeof item === 'string') } : {}),
          ...(typeof entry.caseRegistryPath === 'string' ? { caseRegistryPath: entry.caseRegistryPath } : {}),
          ...(typeof entry.runnerSourcePath === 'string' ? { runnerSourcePath: entry.runnerSourcePath } : {}),
          ...(typeof entry.assurance === 'string' ? { assurance: entry.assurance } : typeof dynamicDefaults.assurance === 'string' ? { assurance: dynamicDefaults.assurance } : {}),
          ...(typeof entry.riskTier === 'string' ? { riskTier: entry.riskTier } : typeof dynamicDefaults.riskTier === 'string' ? { riskTier: dynamicDefaults.riskTier } : {}),
          ...(typeof entry.closurePolicy === 'string' ? { closurePolicy: entry.closurePolicy } : typeof dynamicDefaults.closurePolicy === 'string' ? { closurePolicy: dynamicDefaults.closurePolicy } : {}),
          ...(typeof entry.fullBaselineReusePolicy === 'string' ? { fullBaselineReusePolicy: entry.fullBaselineReusePolicy } : typeof dynamicDefaults.fullBaselineReusePolicy === 'string' ? { fullBaselineReusePolicy: dynamicDefaults.fullBaselineReusePolicy } : {}),
          ...(typeof entry.cpuWeight === 'number' ? { cpuWeight: entry.cpuWeight } : typeof dynamicDefaults.cpuWeight === 'number' ? { cpuWeight: dynamicDefaults.cpuWeight } : {}),
          ...(typeof entry.expectedP50Ms === 'number' ? { expectedP50Ms: entry.expectedP50Ms } : typeof dynamicDefaults.expectedP50Ms === 'number' ? { expectedP50Ms: dynamicDefaults.expectedP50Ms } : {}),
          ...(typeof entry.timeoutMs === 'number' ? { timeoutMs: entry.timeoutMs } : {}),
          ...(typeof entry.optional === 'boolean' ? { optional: entry.optional } : {}),
          ...(focus ? { focus } : {}),
          ...(entry.resources !== undefined
            ? { resources: parseConfiguredResourceClaims(entry.resources, `configured validate.commands[${i}]`) }
            : {}),
          // B-a745 CHK-001: an optional declared planner id. Malformed or
          // reserved-namespace values THROW here, at declaration time, for the
          // same reason parseConfiguredResourceClaims does: a silently dropped
          // declaration is a lie the operator cannot see, and a forged `prov-`
          // id would also corrupt the provisional-migration count.
          ...(entry.id !== undefined
            ? { id: assertDeclaredValidationCommandId(entry.id, `configured validate.commands[${i}]`) }
            : {}),
        });
      }
    }
  }
  return commands;
}

function requiredVerificationIntentDefinitions(checklist: ChecklistData): unknown {
  return checklist.items.map((item) => ({
    itemId: item.id,
    verificationIntent: Object.fromEntries(
      Object.entries(item.verificationIntent ?? {}).map(([lane, intents]) => [
        lane,
        (intents ?? []).filter((intent) => (intent.priority ?? 'must') === 'must').map((intent) => ({
          desc: intent.desc,
          type: intent.type,
          requiredIn: intent.requiredIn,
          priority: intent.priority ?? 'must',
        })),
      ]),
    ),
  }));
}

export function sourceInputSnapshot(projectRoot: string, sourceKind: RoutineValidationSourceKind): unknown {
  const names = sourceKind === 'configured'
    // B-cc10 CHK-004: snapshot BOTH config spellings. The absent one records a
    // `null` entry, which is exactly the signal this identity snapshot wants —
    // pinning the deprecated literal alone would make the identity blind to the
    // canonical file's contents, so editing the canonical config would not
    // invalidate the routine-validation identity it is supposed to bind.
    ? [...CONFIG_FILENAMES]
    : sourceKind === 'fallback'
      ? ['package.json', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']
      : [];
  return Object.fromEntries(names.map((name) => {
    const path = join(projectRoot, name);
    try { return [name, existsSync(path) ? readFileSync(path, 'utf8') : null]; }
    catch { return [name, 'unreadable']; }
  }));
}

export function routineIdentityPolicySnapshot(ctx: HandlerContext, storyId: string) {
  const story = ctx.store.readStory(storyId);
  const checklist = ctx.store.readChecklist(storyId);
  let decision = null;
  try { decision = ctx.store.readDecision(storyId); } catch { /* optional */ }
  const verificationPolicy = resolveVerificationIntentPolicy(story, checklist, decision);
  const workflowPolicy = resolveWorkflowPolicy(loadConfig(ctx.root), story);
  return { checklist, verificationPolicy, workflowPolicy, identityPolicyInputs: {
    requiredVerificationIntentDefinitions: requiredVerificationIntentDefinitions(checklist),
    verificationPolicy, workflowPolicy,
  } };
}

export function buildValidateFileCommand(ctx: HandlerContext, args: { story?: string; full?: string | boolean; focus?: string; json?: boolean }, validateFile: string): ValidationCommand {
  const projectRoot = ctx.root;
  const focus = args.focus;
      const tsArgs: string[] = [validateFile];
      if (args.full !== undefined) {
        if (typeof args.full === 'string' && args.full.length > 0) {
          tsArgs.push(`--full=${args.full}`);
        } else {
          tsArgs.push('--full');
        }
      }
      if (focus) {
        tsArgs.push(`--focus=${focus}`);
      }
      if (args.story) {
        tsArgs.push(`--story=${args.story}`);
        // Git diff 推断：把全部改动文件传给 validate.ts，让项目自己决定跑哪���测试
        // B-db56: resolve gitCwd via resolveGitCwd so wrapper-root layouts
        // (metadataRoot ≠ gitRoot) run git diff in the real repo subdir.
        const gitCwd = resolveGitCwd({ store: ctx.store, storyId: args.story, metadataRoot: projectRoot, projectRoot });
        try {
          const diff = execSync('git diff main...HEAD --name-only', {
            cwd: gitCwd,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          if (diff) {
            const changedFiles = diff.split('\n')
              .filter(Boolean)
              .filter((path) => !isMaterialExcludedPath(path, projectRoot));
            // validate.ts only consumes material changes. Story metadata and
            // registered runtime artifacts must not perturb command identity.
            if (changedFiles.length > 0) tsArgs.push(`--changed-files=${changedFiles.join(',')}`);
            ctx.log?.(`story ${args.story}: git diff 发现 ${changedFiles.length} 个 material 改动文件`);
          }
        } catch { /* git diff 失败不阻塞 */ }
      }
      if (args.json) {
        tsArgs.push('--json');
      }

      return {
        label: validateFile,
        ...(focus ? { focus: [focus] } : {}),
        command: 'npx',
        args: ['tsx', ...tsArgs],
        ...(validateFileDefaultTimeoutMs() ? { timeoutMs: validateFileDefaultTimeoutMs() } : {}),
      };
}

/** Reconstruct current fast authority from project inputs, never from a stored receipt. */
export function currentPrecertFastIdentity(ctx: HandlerContext, storyId: string) {
  const entrypoint = findValidateFile(ctx.root);
  const sourceKind = entrypoint ? 'validate-file' : 'configured';
  const commands = entrypoint
    ? [buildValidateFileCommand(ctx, { story: storyId, focus: 'fast', json: true }, entrypoint)]
    : filterFocusedConfiguredCommands(configuredValidationCommands(ctx.root), 'fast');
  const policy = routineIdentityPolicySnapshot(ctx, storyId);
  return buildRoutineValidationIdentity({
    projectRoot: ctx.root, sourceKind, commands, focus: 'fast',
    sourceInputs: sourceInputSnapshot(ctx.root, sourceKind),
    ...(entrypoint ? { entrypointPath: join(ctx.root, entrypoint) } : {}),
    profile: policy.workflowPolicy.profile,
    verificationPolicyInputs: policy.identityPolicyInputs,
  });
}
