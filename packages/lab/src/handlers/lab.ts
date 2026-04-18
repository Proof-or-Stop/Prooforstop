import type { HandlerContext } from '../../../main/dist/handlers/context.js';
import { buildExperimentConfig, validateExperimentConfig } from '../core/config.js';
import { evaluatePatchPolicy, parsePatchTouchedPaths, readPatchFile } from '../core/patch-policy.js';
import { createSandbox, planSandbox } from '../core/sandbox.js';
import { ensureExperimentDirs, listRunResults, nextRunId, readExperimentConfig, writeExperimentConfig, writeRunArtifacts } from '../core/storage.js';
import type { LabExperimentConfig, LabRunMetrics, LabRunResult } from '../types.js';

function formatCreateResult(configPath: string, config: LabExperimentConfig): string {
  return [
    `Created experiment ${config.id}`,
    `Config: ${configPath}`,
    `Next: koala lab run --config ${configPath} --dry-run`,
  ].join('\n');
}

function defaultMetrics(config: LabExperimentConfig): LabRunMetrics {
  return {
    profile: config.dataset.profile,
    quality: 0,
    latencyPenalty: 0,
    complexityPenalty: 0,
    stabilityPenalty: 0,
    submetrics: {},
  };
}

function defaultResult(runId: string): LabRunResult {
  return {
    runId,
    status: 'initialized',
    score: 0,
    baselineScore: 0,
    delta: 0,
    candidatePatch: null,
    changedFiles: 0,
    changedLines: 0,
    timing: {
      wallClockSeconds: 0,
      evalSeconds: 0,
    },
    reason: 'Foundation run placeholder; no evaluation executed yet.',
  };
}

export function createLabHandlers(ctx: HandlerContext) {
  const { root } = ctx;

  return {
    lab_create(args: {
      target: string;
      profile: string;
      id?: string;
      name?: string;
      editableFiles?: string[];
    }): string {
      const config = buildExperimentConfig(args);
      const configPath = writeExperimentConfig(root, config);
      return formatCreateResult(configPath.replace(`${root}/`, ''), config);
    },

    lab_run(args: {
      config: string;
      dryRun?: boolean;
      confirm?: boolean;
    }): string {
      const config = readExperimentConfig(root, args.config);
      validateExperimentConfig(config);
      ensureExperimentDirs(root, config);
      const runId = nextRunId(root, config);
      const sandbox = planSandbox(root, config, runId);
      const runDir = `${config.outputs.runDir}/${runId}`;

      if (args.dryRun) {
        return [
          `[lab] sandbox ready at ${sandbox.sandboxPath}`,
          `[lab] patch policy: only ${config.target.editableFiles.join(', ')} is editable`,
          `[lab] would write: ${runDir}/config.snapshot.json, ${runDir}/metrics.json, ${runDir}/result.json, ${runDir}/summary.md`,
          '✓ Dry run complete. No project files outside the sandbox were modified.',
        ].join('\n');
      }

      createSandbox(root, sandbox);
      writeRunArtifacts({
        root,
        config,
        runId,
        configSnapshot: config,
        metrics: defaultMetrics(config),
        result: defaultResult(runId),
        summary: [
          `# ${config.id} / ${runId}`,
          '',
          'Status: initialized',
          `Sandbox: ${sandbox.sandboxPath}`,
          `Branch: ${sandbox.branch}`,
          '',
          'Why initialized:',
          '- koala-lab foundation created the isolated sandbox and placeholder artifacts',
          '- no scoring or candidate evaluation has run yet',
        ].join('\n'),
      });

      return [
        `[lab] sandbox ready at ${sandbox.sandboxPath}`,
        `[lab] branch: ${sandbox.branch}`,
        `[lab] artifacts: ${runDir}`,
        '✓ Sandbox created and placeholder artifacts written.',
      ].join('\n');
    },

    lab_eval(args: {
      config: string;
      patchFile?: string;
      files?: string[];
    }): string {
      const config = readExperimentConfig(root, args.config);
      let touchedPaths: string[] = [];
      if (args.patchFile) {
        touchedPaths = parsePatchTouchedPaths(readPatchFile(root, args.patchFile));
      } else if (args.files && args.files.length > 0) {
        touchedPaths = args.files;
      } else {
        throw new Error('lab_eval 需要 patchFile 或 files 至少其一');
      }
      return JSON.stringify(evaluatePatchPolicy(root, config, touchedPaths), null, 2);
    },

    lab_compare(args: { config: string }): string {
      const config = readExperimentConfig(root, args.config);
      const runs = listRunResults(root, config);
      if (runs.length === 0) {
        return `No runs recorded yet for ${config.id}.`;
      }
      const best = runs.reduce((acc, current) => current.result.score > acc.result.score ? current : acc);
      return JSON.stringify({
        experimentId: config.id,
        baseline: {
          score: 0,
        },
        best: {
          runId: best.runId,
          score: best.result.score,
          status: best.result.status,
        },
        runs: runs.map((run) => ({
          runId: run.runId,
          score: run.result.score,
          status: run.result.status,
        })),
      }, null, 2);
    },

    lab_promote(args: { config: string }): string {
      const config = readExperimentConfig(root, args.config);
      const runs = listRunResults(root, config);
      if (runs.length === 0) {
        throw new Error(`lab_promote 失败：${config.id} 还没有任何 run`);
      }
      const best = runs.reduce((acc, current) => current.result.score > acc.result.score ? current : acc);
      return JSON.stringify({
        experimentId: config.id,
        status: 'ready_for_review',
        bestRunId: best.runId,
        promotePatch: best.result.candidatePatch,
        summaryPath: `${config.outputs.runDir}/${best.runId}/summary.md`,
      }, null, 2);
    },
  };
}
