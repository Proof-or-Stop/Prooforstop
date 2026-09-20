// Subprocess adapter for synchronous signature regressions. All positive review
// records go through the actual acknowledged managed provider-process helper.
import { deliverInitReviewerVerdict } from './managed-init-reviewer-delivery.mjs';
const [root, storyId, agentType, issuesText] = process.argv.slice(2);
const issues = JSON.parse(issuesText).map(issue => ({ ...issue,
  kind: agentType === 'proof-or-stop-product-reviewer' ? 'user_outcome_unspecified' : 'story_metadata_inconsistent',
  requirementRef: 'story:description',
}));
const result = await deliverInitReviewerVerdict({ root, storyId, agentType, issues });
console.log('MANAGED_INIT_VERDICT_FIXTURE_RECORDED ' + agentType + ' ' + result.runId);
