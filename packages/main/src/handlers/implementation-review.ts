import type { HandlerContext } from './context.js';
import type { ImplementationReviewFinding, ImplementationReviewResultData } from '../core/types.js';

function validateFindings(findings: ImplementationReviewFinding[]): void {
  for (const finding of findings) {
    if (!finding.file || finding.file.trim().length === 0) {
      throw new Error('implementation review finding.file 不能为空');
    }
    if (!Number.isInteger(finding.line) || finding.line < 1) {
      throw new Error('implementation review finding.line 必须是 >= 1 的整数');
    }
    if (!finding.why || finding.why.trim().length < 5) {
      throw new Error('implementation review finding.why 必须 >= 5 字符');
    }
    if (!['info', 'medium', 'high'].includes(finding.severity)) {
      throw new Error('implementation review finding.severity 必须是 info|medium|high');
    }
  }
}

export function createImplementationReviewHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    implementation_review_result_set(args: {
      storyId: string;
      verdict: 'pass' | 'fail';
      findings: ImplementationReviewFinding[];
      summary: string;
    }): string {
      store.readStory(args.storyId);
      if (!Array.isArray(args.findings)) throw new Error('findings 必须是数组');
      if (!args.summary || args.summary.trim().length < 5) {
        throw new Error('summary 必须 >= 5 字符');
      }
      validateFindings(args.findings);
      if (args.verdict === 'pass' && args.findings.some((f) => f.severity === 'high')) {
        throw new Error('verdict=pass 时不应包含 high severity finding');
      }

      const existing = store.readImplementationReview(args.storyId);
      const now = new Date().toISOString();
      const data: ImplementationReviewResultData = {
        storyId: args.storyId,
        verdict: args.verdict,
        findings: args.findings,
        summary: args.summary,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      store.writeImplementationReview(args.storyId, data);

      return [
        `Implementation review saved for ${args.storyId}`,
        `  verdict:  ${data.verdict}`,
        `  findings: ${data.findings.length}`,
        `  summary:  ${data.summary.length} chars`,
      ].join('\n');
    },

    implementation_review_result_get(args: { storyId: string }): ImplementationReviewResultData | { _empty: true } {
      const data = store.readImplementationReview(args.storyId);
      if (!data) return { _empty: true };
      return data;
    },
  };
}
