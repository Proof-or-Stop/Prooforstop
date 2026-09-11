/** Shared read-only validation entry construction and identity policy. */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HandlerContext } from './context.js';
import type { ChecklistData } from '../core/types.js';
import type { ValidationCommand, RoutineValidationSourceKind } from '../core/validation-types.js';
import { loadConfig } from '../core/config.js';
import { CONFIG_FILENAMES } from '../core/brand-paths.js';
import { normalizeConfiguredValidationCommands, filterFocusedConfiguredCommands } from '../core/validation-command-config.js';
import { resolveVerificationIntentPolicy, resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { isMaterialExcludedPath } from '../core/evidence-freshness.js';
import { findValidateFile, validateFileDefaultTimeoutMs } from '../core/validation-file-entry.js';
import { buildRoutineValidationIdentity } from '../core/validation-evidence-reuse.js';

export { commandFromString, filterFocusedConfiguredCommands } from '../core/validation-command-config.js';

export function configuredValidationCommands(projectRoot: string): ValidationCommand[] {
  return normalizeConfiguredValidationCommands(loadConfig(projectRoot));
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
          scope: intent.scope,
          expectation: intent.expectation,
          requirementSource: intent.requirementSource,
          baselineRef: intent.baselineRef,
          requirementRef: intent.requirementRef,
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
