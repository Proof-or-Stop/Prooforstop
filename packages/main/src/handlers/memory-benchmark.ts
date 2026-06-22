import type { HandlerContext } from './context.js';
import {
  compareMemoryBenchmarks,
  renderMemoryBenchmarkComparisonText,
  renderMemoryBenchmarkRunText,
  runMemoryBenchmark,
  type CandidateCountInput,
} from '../core/memory-benchmark.js';
import {
  renderMemoryBenchmarkRealDataText,
  runMemoryBenchmarkRealData,
} from '../core/memory-benchmark-real-data.js';

interface MemoryBenchmarkRunArgs {
  tier?: string;
  candidateCount?: CandidateCountInput;
  queryCount?: number;
  seed?: number;
  format?: 'text' | 'json';
  json?: boolean;
}

interface MemoryBenchmarkCompareArgs {
  candidateCounts?: CandidateCountInput[] | CandidateCountInput;
  queryCount?: number;
  seed?: number;
  format?: 'text' | 'json';
  json?: boolean;
}

interface MemoryBenchmarkRealDataArgs {
  outputDir?: string;
  format?: 'text' | 'json';
  json?: boolean;
}

function wantsJson(args: { format?: 'text' | 'json'; json?: boolean }): boolean {
  return args.json === true || args.format === 'json';
}

export function createMemoryBenchmarkHandlers(_ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    memory_benchmark_run(args: MemoryBenchmarkRunArgs = {}) {
      const result = runMemoryBenchmark({
        tier: args.tier,
        candidateCount: args.candidateCount,
        queryCount: args.queryCount,
        seed: args.seed,
      });
      if (wantsJson(args)) return result;
      return renderMemoryBenchmarkRunText(result);
    },
    memory_benchmark_compare(args: MemoryBenchmarkCompareArgs = {}) {
      const result = compareMemoryBenchmarks({
        candidateCounts: args.candidateCounts,
        queryCount: args.queryCount,
        seed: args.seed,
      });
      if (wantsJson(args)) return result;
      return renderMemoryBenchmarkComparisonText(result);
    },
    memory_benchmark_real_data(args: MemoryBenchmarkRealDataArgs = {}) {
      const result = runMemoryBenchmarkRealData({
        root: _ctx.root,
        outputDir: args.outputDir,
      });
      if (wantsJson(args)) return result;
      return renderMemoryBenchmarkRealDataText(result);
    },
  };
}
