import { loadConfig } from './config.js';
import { STATE_DIR_NAMES } from './brand-paths.js';
import { scan, filterTasks, toMarkdown, CODE_EXTENSIONS, extractBlocks, extractFlows } from '../tasks/extract.js';
import { validate } from '../tasks/validate.js';
import { checkCoverage } from '../tasks/coverage.js';
import { locateTasks } from '../tasks/locate.js';
import { MetadataStore } from '../tasks/metadata-store.js';
import { validateMetadata } from '../tasks/metadata-validate.js';
import { loadTraceSnapshot, scanAllTraces } from '../tasks/trace-store.js';
import { diffTraces, summarizeDiff } from '../tasks/trace-diff.js';
import { startProfiler } from '../tasks/profiler.js';
import { runCase, createIsolatedHandlers } from '../handlers/test-runner-core.js';
import { scanTruth, generateNav } from '../tasks/truth.js';
import { analyzeTruth, truthToStory } from '../tasks/truth-analyze.js';
import { analyzeGap, checkConvergence } from '../tasks/gap-analyze.js';

/**
 * Runtime capabilities supplied to optional CLI extensions through
 * HandlerContext. Extensions consume this object instead of importing Core's
 * private dist layout, which is not stable across an npm package boundary.
 */
export function createProofOrStopExtensionRuntime() {
  return {
    CODE_EXTENSIONS,
    STATE_DIR_NAMES,
    MetadataStore,
    analyzeGap,
    analyzeTruth,
    checkConvergence,
    checkCoverage,
    createIsolatedHandlers,
    diffTraces,
    extractBlocks,
    extractFlows,
    filterTasks,
    generateNav,
    loadConfig,
    loadTraceSnapshot,
    locateTasks,
    runCase,
    scan,
    scanAllTraces,
    scanTruth,
    startProfiler,
    summarizeDiff,
    toMarkdown,
    truthToStory,
    validate,
    validateMetadata,
  };
}

export type ProofOrStopExtensionRuntime = ReturnType<typeof createProofOrStopExtensionRuntime>;
