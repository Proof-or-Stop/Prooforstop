import type { HandlerContext } from './context.js';
import type { ImplementationReviewFinding, ImplementationReviewResultData } from '../core/types.js';

function validateFindings(findings: ImplementationReviewFinding[]): void {
  for (const finding of findings) {
    if (!finding.file || finding.file.trim().length === 0) {
      throw new Error('implementation review finding.file must not be empty');
    }
    if (!Number.isInteger(finding.line) || finding.line < 1) {
      throw new Error('implementation review finding.line must be an integer >= 1');
    }
    if (!finding.why || finding.why.trim().length < 5) {
      throw new Error('implementation review finding.why must be >= 5 characters');
    }
    if (!['info', 'medium', 'high'].includes(finding.severity)) {
      throw new Error('implementation review finding.severity must be info|medium|high');
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
      if (!Array.isArray(args.findings)) throw new Error('findings must be an array');
      if (!args.summary || args.summary.trim().length < 5) {
        throw new Error('summary must be >= 5 characters');
      }
      validateFindings(args.findings);
      if (args.verdict === 'pass' && args.findings.some((f) => f.severity === 'high')) {
        throw new Error('verdict=pass must not include high severity finding');
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
