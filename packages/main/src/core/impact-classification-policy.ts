import { domainSeparatedDigest } from './prompt-contracts.js';

export const IMPACT_CLASSIFICATION_POLICY_VERSION = 'proof-or-stop.impact-classification.v1';

export type ImpactCategory =
  | 'no-material-change'
  | 'pure-story-fixture'
  | 'docs'
  | 'private-implementation'
  | 'public-contract'
  | 'authority-or-permission'
  | 'command-or-gate-policy'
  | 'dependency-or-build'
  | 'dynamic-or-unparsed'
  | 'unsupported-rename'
  | 'unknown';

export type ImpactReasonCode =
  | 'ELIGIBLE_NO_MATERIAL_CHANGE'
  | 'ELIGIBLE_PURE_STORY_FIXTURE'
  | 'FULL_DOCS_V1'
  | 'FULL_PRIVATE_IMPLEMENTATION_V1'
  | 'FULL_PUBLIC_CONTRACT'
  | 'FULL_AUTHORITY_OR_PERMISSION'
  | 'FULL_COMMAND_OR_GATE_POLICY'
  | 'FULL_DEPENDENCY_OR_BUILD'
  | 'FULL_DYNAMIC_OR_PARSE_FAILURE'
  | 'FULL_UNSUPPORTED_RENAME'
  | 'FULL_UNKNOWN_IMPACT'
  | 'FULL_FIXTURE_BINDING_INCOMPLETE';

export interface ChangedPathImpact {
  path: string;
  category: ImpactCategory;
  reasonCode: ImpactReasonCode;
}

export interface ImpactClassification {
  policyVersion: typeof IMPACT_CLASSIFICATION_POLICY_VERSION;
  eligible: boolean;
  impacts: ChangedPathImpact[];
  impactedFiles: string[];
  reasonCodes: ImpactReasonCode[];
  digest: string;
}

export interface ImpactClassificationInput {
  changedFiles: readonly string[];
  declaredTestFiles: readonly string[];
  testIntentRefsByFile: Readonly<Record<string, readonly string[]>>;
  /**
   * True only when the trusted git-backed fixture reader proved that every
   * added/changed case is bound to a current Story-scoped verification intent
   * and that no case was removed. Missing entries fail closed.
   */
  fixtureCaseClosureByFile?: Readonly<Record<string, boolean>>;
  changedFileStatus?: Readonly<Record<string, string>>;
  classificationUnavailable?: boolean;
}

const PUBLIC_CONTRACT_RE = /(^|\/)(api|schema|schemas|protocol|protocols|public|types?)(\/|$)|\.(proto|graphql|gql|json-schema)$/i;
const AUTHORITY_RE = /(^|\/)(auth|authority|permission|permissions|rbac|acl)(\/|$)/i;
const COMMAND_GATE_RE = /(^|\/)(command-policy|process-fact|story-machine|gate|gates|lifecycle)(\.|\/|$)/i;
const DEPENDENCY_BUILD_RE = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|vite\.config|webpack\.config|rollup\.config|build)(\.|\/|$)/i;
const DOC_RE = /(^|\/)(docs?|requirements)(\/|$)|\.(md|mdx|rst|adoc)$/i;
const DYNAMIC_RE = /(^|\/)(generated|vendor)(\/|$)|\.(mjs|cjs|js|ts|tsx|jsx)$/i;

function canonicalPaths(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.replace(/\\/g, '/').trim()).filter(Boolean))].sort();
}

function classifyForcedFull(path: string, status: string | undefined): ChangedPathImpact {
  if (status?.startsWith('R') || status?.startsWith('C') || status === 'D') {
    return { path, category: 'unsupported-rename', reasonCode: 'FULL_UNSUPPORTED_RENAME' };
  }
  if (DOC_RE.test(path)) return { path, category: 'docs', reasonCode: 'FULL_DOCS_V1' };
  if (AUTHORITY_RE.test(path)) return { path, category: 'authority-or-permission', reasonCode: 'FULL_AUTHORITY_OR_PERMISSION' };
  if (COMMAND_GATE_RE.test(path)) return { path, category: 'command-or-gate-policy', reasonCode: 'FULL_COMMAND_OR_GATE_POLICY' };
  if (DEPENDENCY_BUILD_RE.test(path)) return { path, category: 'dependency-or-build', reasonCode: 'FULL_DEPENDENCY_OR_BUILD' };
  if (PUBLIC_CONTRACT_RE.test(path)) return { path, category: 'public-contract', reasonCode: 'FULL_PUBLIC_CONTRACT' };
  if (DYNAMIC_RE.test(path)) return { path, category: 'private-implementation', reasonCode: 'FULL_PRIVATE_IMPLEMENTATION_V1' };
  return { path, category: 'unknown', reasonCode: 'FULL_UNKNOWN_IMPACT' };
}

/**
 * V1 deliberately recognizes only two bounded incremental categories:
 * no material change, and Story-declared pure test fixtures with intentRefs.
 * Everything else is a stable, explicit full-context reason.
 */
export function classifyImpact(input: ImpactClassificationInput): ImpactClassification {
  const changedFiles = canonicalPaths(input.changedFiles);
  const declaredTests = new Set(canonicalPaths(input.declaredTestFiles));
  let impacts: ChangedPathImpact[];
  if (input.classificationUnavailable) {
    impacts = [{ path: '<classification-unavailable>', category: 'dynamic-or-unparsed', reasonCode: 'FULL_DYNAMIC_OR_PARSE_FAILURE' }];
  } else if (changedFiles.length === 0) {
    impacts = [{ path: '<none>', category: 'no-material-change', reasonCode: 'ELIGIBLE_NO_MATERIAL_CHANGE' }];
  } else if (changedFiles.every(path => declaredTests.has(path))) {
    impacts = changedFiles.map(path => {
      const status = input.changedFileStatus?.[path];
      if (status?.startsWith('R') || status?.startsWith('C') || status === 'D') {
        return { path, category: 'unsupported-rename' as const, reasonCode: 'FULL_UNSUPPORTED_RENAME' as const };
      }
      const refs = [...new Set(input.testIntentRefsByFile[path] ?? [])].filter(ref => ref.trim().length > 0);
      return refs.length > 0 && input.fixtureCaseClosureByFile?.[path] === true
        ? { path, category: 'pure-story-fixture' as const, reasonCode: 'ELIGIBLE_PURE_STORY_FIXTURE' as const }
        : { path, category: 'pure-story-fixture' as const, reasonCode: 'FULL_FIXTURE_BINDING_INCOMPLETE' as const };
    });
  } else {
    impacts = changedFiles.map(path => classifyForcedFull(path, input.changedFileStatus?.[path]));
  }
  const reasonCodes = [...new Set(impacts.map(impact => impact.reasonCode))].sort() as ImpactReasonCode[];
  const eligible = reasonCodes.length > 0 && reasonCodes.every(code => code.startsWith('ELIGIBLE_'));
  const impactedFiles = impacts.filter(impact => impact.path !== '<none>').map(impact => impact.path).sort();
  const semantic: Omit<ImpactClassification, 'digest'> = {
    policyVersion: IMPACT_CLASSIFICATION_POLICY_VERSION,
    eligible,
    impacts,
    impactedFiles,
    reasonCodes,
  };
  return {
    ...semantic,
    digest: domainSeparatedDigest('impact-classification-policy.v1', semantic),
  };
}
