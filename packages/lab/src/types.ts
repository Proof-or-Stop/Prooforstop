export type LabTargetKind = 'prompt' | 'policy' | 'summary';
export type LabMode = 'offline';
export type LabStatus = 'draft' | 'active';
export type LabSelectionTieBreak = 'lower_complexity';

export interface LabTargetConfig {
  kind: LabTargetKind;
  id: string;
  entryFile: string;
  editableFiles: string[];
}

export interface LabBudgetConfig {
  maxIterations: number;
  maxWallClockMinutes: number;
  perIterationTimeoutMinutes: number;
  repeatsPerCandidate: number;
}

export interface LabCandidatePolicy {
  strategy: 'rewrite_prompt' | 'tune_threshold' | 'reorder_output';
  maxChangedFiles: number;
  maxChangedLines: number;
  allowDependencyChanges: boolean;
  allowStoryMutation: boolean;
  allowFixtureMutation: boolean;
  allowDocsStoryMutation: boolean;
  allowTestsFixturesMutation: boolean;
}

export interface LabSelectionPolicy {
  minScoreGain: number;
  requireNoRegression: boolean;
  requireHoldoutPass: boolean;
  tieBreak: LabSelectionTieBreak;
}

export interface LabScoringConfig {
  qualityWeight: number;
  latencyWeight: number;
  complexityWeight: number;
  stabilityWeight: number;
}

export interface LabGuardsConfig {
  mustRunInIsolatedWorktree: boolean;
  forbidMainBranchWrite: boolean;
  forbidDestructiveGit: boolean;
}

export interface LabOutputsConfig {
  runDir: string;
  baselineDir: string;
  reportFormat: 'md' | 'json';
}

export interface LabDatasetConfig {
  profile: string;
  source: 'lab-dataset';
  datasetId: string;
  trainSplit: number;
  devSplit: number;
  holdoutSplit: number;
}

export interface LabBaselineConfig {
  source: 'working-tree';
  ref: string;
}

export interface LabExperimentConfig {
  $schema: string;
  id: string;
  name: string;
  status: LabStatus;
  mode: LabMode;
  target: LabTargetConfig;
  baseline: LabBaselineConfig;
  dataset: LabDatasetConfig;
  budget: LabBudgetConfig;
  candidatePolicy: LabCandidatePolicy;
  selectionPolicy: LabSelectionPolicy;
  scoring: LabScoringConfig;
  guards: LabGuardsConfig;
  outputs: LabOutputsConfig;
}

export interface LabRunMetrics {
  profile: string;
  quality: number;
  latencyPenalty: number;
  complexityPenalty: number;
  stabilityPenalty: number;
  submetrics: Record<string, number>;
}

export interface LabRunResult {
  runId: string;
  status: 'initialized' | 'kept' | 'rejected';
  score: number;
  baselineScore: number;
  delta: number;
  candidatePatch: string | null;
  changedFiles: number;
  changedLines: number;
  timing: {
    wallClockSeconds: number;
    evalSeconds: number;
  };
  reason: string;
}

export interface LabSandboxPlan {
  repoRootPath: string;
  sandboxPath: string;
  branch: string;
  worktreeDir: string;
}

export interface LabPatchPolicyReport {
  ok: boolean;
  touchedPaths: string[];
  violations: string[];
}
