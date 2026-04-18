import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import type { LabHandlerContext } from '../core/runtime-types.js';
import { buildExperimentConfig, validateExperimentConfig } from '../core/config.js';
import { createCandidatePatch } from '../core/diff.js';
import { resolveProfile } from '../core/profile.js';
import { evaluatePatchPolicy, parsePatchTouchedPaths, readPatchFile } from '../core/patch-policy.js';
import { createSandbox, planSandbox } from '../core/sandbox.js';
import { computeNormalizedScore, computeStabilityPenalty, computeTotalScore, decideCandidate } from '../core/scoring.js';
import { ensureExperimentDirs, listRunResults, nextRunId, readBaselineRecord, readExperimentConfig, writeBaselineRecord, writeExperimentConfig, writeRunArtifacts } from '../core/storage.js';
import type { LabBaselineRecord, LabExperimentConfig, LabRunMetrics, LabRunResult } from '../types.js';

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
    normalizedScore: 0,
    submetrics: {},
  };
}

function defaultResult(runId: string): LabRunResult {
  return {
    runId,
    status: 'initialized',
    score: 0,
    normalizedScore: 0,
    baselineScore: 0,
    baselineNormalizedScore: 0,
    delta: 0,
    normalizedDelta: 0,
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

function pickBestRun(runs: Array<{ runId: string; result: LabRunResult }>): { runId: string; result: LabRunResult } {
  return runs.reduce((best, current) => {
    if (current.result.score > best.result.score) return current;
    if (current.result.score < best.result.score) return best;
    const currentComplexity = current.result.changedFiles * 1000 + current.result.changedLines;
    const bestComplexity = best.result.changedFiles * 1000 + best.result.changedLines;
    if (currentComplexity < bestComplexity) return current;
    if (currentComplexity === bestComplexity && best.result.normalizedScore == null && current.result.normalizedScore != null) return current;
    return best;
  });
}

function runGit(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function resolveFilePath(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

function readCandidateContent(root: string, targetPath: string): string {
  const resolved = resolveFilePath(root, targetPath);
  if (!existsSync(resolved)) {
    throw new Error(`koala-lab candidate target 不存在: ${targetPath}`);
  }
  return readFileSync(resolved, 'utf8');
}

function readBaselineContent(root: string, ref: string, targetPath: string): string {
  try {
    return execFileSync('git', ['show', `${ref}:${targetPath}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return readCandidateContent(root, targetPath);
  }
}

function computeDiffStats(root: string, ref: string, editableFiles: string[]): { changedFiles: number; changedLines: number } {
  const output = execFileSync('git', ['diff', '--numstat', ref, '--', ...editableFiles], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (!output) return { changedFiles: 0, changedLines: 0 };
  let changedLines = 0;
  const rows = output.split('\n').filter(Boolean);
  for (const row of rows) {
    const [added, removed] = row.split('\t');
    const add = added === '-' ? 0 : Number(added);
    const del = removed === '-' ? 0 : Number(removed);
    changedLines += add + del;
  }
  return {
    changedFiles: rows.length,
    changedLines,
  };
}

function evaluateBaseline(args: {
  root: string;
  config: LabExperimentConfig;
  targetPath: string;
}): LabBaselineRecord {
  const profile = resolveProfile(args.config.dataset.profile);
  const content = readBaselineContent(args.root, args.config.baseline.ref, args.targetPath);
  const metrics = profile({
    config: args.config,
    content,
    targetPath: args.targetPath,
    repeatIndex: 0,
    changedFiles: 0,
    changedLines: 0,
  });
  const score = computeTotalScore(metrics, args.config.scoring);
  const normalizedScore = computeNormalizedScore(metrics);
  metrics.normalizedScore = normalizedScore;
  return {
    experimentId: args.config.id,
    ref: args.config.baseline.ref,
    score,
    normalizedScore,
    metrics,
    evaluatedAt: new Date().toISOString(),
  };
}

function evaluateCandidate(args: {
  root: string;
  config: LabExperimentConfig;
  targetPath: string;
}): { metrics: LabRunMetrics; score: number; normalizedScore: number; changedFiles: number; changedLines: number; stddev: number; hadCrash: boolean } {
  const profile = resolveProfile(args.config.dataset.profile);
  const content = readCandidateContent(args.root, args.targetPath);
  const diffStats = computeDiffStats(args.root, args.config.baseline.ref, args.config.target.editableFiles);
  const repeatScores: number[] = [];
  let hadCrash = false;
  let chosenMetrics: LabRunMetrics | null = null;

  for (let repeatIndex = 0; repeatIndex < args.config.budget.repeatsPerCandidate; repeatIndex++) {
    try {
      const metrics = profile({
        config: args.config,
        content,
        targetPath: args.targetPath,
        repeatIndex,
        changedFiles: diffStats.changedFiles,
        changedLines: diffStats.changedLines,
      });
      if (!chosenMetrics) chosenMetrics = metrics;
      repeatScores.push(computeTotalScore(metrics, args.config.scoring));
    } catch {
      hadCrash = true;
    }
  }

  if (!chosenMetrics) {
    throw new Error(`koala-lab candidate evaluation failed for ${args.targetPath}`);
  }

  const stability = computeStabilityPenalty({ repeatScores, hadCrash });
  chosenMetrics.stabilityPenalty = stability.penalty;
  chosenMetrics.submetrics = {
    ...chosenMetrics.submetrics,
    stabilityStdDev: stability.stddev,
  };

  const normalizedScore = computeNormalizedScore(chosenMetrics);
  chosenMetrics.normalizedScore = normalizedScore;
  return {
    metrics: chosenMetrics,
    score: computeTotalScore(chosenMetrics, args.config.scoring),
    normalizedScore,
    changedFiles: diffStats.changedFiles,
    changedLines: diffStats.changedLines,
    stddev: stability.stddev,
    hadCrash,
  };
}

export function createLabHandlers(ctx: LabHandlerContext) {
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
      const patch = createCandidatePatch({
        root,
        config,
        runId,
      });
      const baseline = evaluateBaseline({
        root,
        config,
        targetPath: config.target.entryFile,
      });
      const candidate = evaluateCandidate({
        root,
        config,
        targetPath: config.target.entryFile,
      });
      let decision = decideCandidate({
        baselineScore: baseline.score,
        candidateScore: candidate.score,
        selection: config.selectionPolicy,
      });
      if (!patch.patchPath) {
        decision = {
          status: 'rejected',
          delta: candidate.score - baseline.score,
          reason: patch.violations.length > 0
            ? `candidate patch rejected by patch policy: ${patch.violations.join('; ')}`
            : 'no candidate patch relative to baseline',
        };
      }
      writeBaselineRecord(root, config, baseline);
      writeRunArtifacts({
        root,
        config,
        runId,
        configSnapshot: config,
        metrics: candidate.metrics,
        result: {
          ...defaultResult(runId),
          status: decision.status,
          score: candidate.score,
          normalizedScore: candidate.normalizedScore,
          baselineScore: baseline.score,
          baselineNormalizedScore: baseline.normalizedScore,
          delta: decision.delta,
          normalizedDelta: Number((candidate.normalizedScore - (baseline.normalizedScore ?? 0)).toFixed(4)),
          candidatePatch: patch.patchPath,
          changedFiles: patch.touchedPaths.length || candidate.changedFiles,
          changedLines: candidate.changedLines,
          reason: decision.reason,
        },
        summary: [
          `# ${config.id} / ${runId}`,
          '',
          `Status: ${decision.status}`,
          `Sandbox: ${sandbox.sandboxPath}`,
          `Branch: ${sandbox.branch}`,
          `Score: ${candidate.score}`,
          `NormalizedScore: ${candidate.normalizedScore}`,
          `Baseline: ${baseline.score}`,
          `BaselineNormalizedScore: ${baseline.normalizedScore}`,
          `Delta: ${decision.delta}`,
          `NormalizedDelta: ${Number((candidate.normalizedScore - (baseline.normalizedScore ?? 0)).toFixed(4))}`,
          `Patch: ${patch.patchPath ?? '(none)'}`,
          '',
          `Why ${decision.status}:`,
          `- ${decision.reason}`,
          `- profile: ${config.dataset.profile}`,
          `- changed files: ${patch.touchedPaths.length || candidate.changedFiles}, changed lines: ${candidate.changedLines}`,
        ].join('\n'),
      });

      return [
        `[lab] sandbox ready at ${sandbox.sandboxPath}`,
        `[lab] branch: ${sandbox.branch}`,
        `[lab] score: ${candidate.score} (baseline ${baseline.score}, delta ${decision.delta})`,
        `[lab] normalizedScore: ${candidate.normalizedScore} (baseline ${baseline.normalizedScore}, delta ${Number((candidate.normalizedScore - (baseline.normalizedScore ?? 0)).toFixed(4))})`,
        `[lab] decision: ${decision.status}`,
        `[lab] patch: ${patch.patchPath ?? '(none)'}`,
        `✓ ${decision.reason}.`,
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
      const baseline = readBaselineRecord(root, config);
      const best = pickBestRun(runs);
      return JSON.stringify({
        experimentId: config.id,
        baseline: baseline ? { score: baseline.score, normalizedScore: baseline.normalizedScore ?? null, ref: baseline.ref } : null,
        best: {
          runId: best.runId,
          score: best.result.score,
          normalizedScore: best.result.normalizedScore ?? null,
          status: best.result.status,
          delta: best.result.delta,
          normalizedDelta: best.result.normalizedDelta ?? null,
          patch: best.result.candidatePatch,
          reason: best.result.reason,
        },
        decision: best.result.status,
        runs: runs.map((run) => ({
          runId: run.runId,
          score: run.result.score,
          normalizedScore: run.result.normalizedScore ?? null,
          status: run.result.status,
          delta: run.result.delta,
          normalizedDelta: run.result.normalizedDelta ?? null,
          patch: run.result.candidatePatch,
        })),
      }, null, 2);
    },

    lab_promote(args: { config: string }): string {
      const config = readExperimentConfig(root, args.config);
      const runs = listRunResults(root, config);
      if (runs.length === 0) {
        throw new Error(`lab_promote 失败：${config.id} 还没有任何 run`);
      }
      const eligible = runs.filter((run) => run.result.status === 'kept');
      if (eligible.length === 0) {
        throw new Error(`lab_promote 失败：${config.id} 还没有可晋升的 kept run`);
      }
      const best = pickBestRun(eligible);
      return JSON.stringify({
        experimentId: config.id,
        status: 'ready_for_review',
        bestRunId: best.runId,
        promotePatch: best.result.candidatePatch,
        baselineRef: config.baseline.ref,
        score: best.result.score,
        normalizedScore: best.result.normalizedScore ?? null,
        reason: best.result.reason,
        summaryPath: `${config.outputs.runDir}/${best.runId}/summary.md`,
      }, null, 2);
    },
  };
}
