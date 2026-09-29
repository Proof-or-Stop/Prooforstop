import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalAgentRoleId, APPROVED_PROMPT_POLICY_MANIFEST, EXPECTED_ROLE_COUNT, APPROVED_ROLE_BODY_ROLLOUT_MANIFEST, PROMPT_POLICY_PRIMARY_BOUNDARY, ROOT, BUILT_REGISTRY_PATH, CLI_PATH, LEGACY_VOCABULARY_EXEMPT_STATUSES, LEGACY_VOCABULARY_KNOWN_STATUSES, LEGACY_VOCABULARY_CONTEXT_ALLOWLIST, LEGACY_PATTERNS, DIRECT_STORY_WRITE_ALLOWLIST, DIRECT_STORY_REFERENCE_ALLOWLIST, DIRECT_STORY_SAFE_NEGATIVE_ACTIONS, roleMatrixDefaultsFor, LEGACY_VOCABULARY_BLOCK_REJECTION, STORY_INSTRUCTION_CONTEXT_RADIUS, BUILT_ROLE_CONTRACT_REGISTRY_PATH } from './policy-data.mjs';
import { assertDirectStoryWritePolicy, directStoryReferenceExerciseErrors } from './verification.mjs';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalPromptRoleId(role) {
  return typeof role === 'string' ? canonicalAgentRoleId(role) : role;
}

export function canonicalizeRoleManifestEntries(entries) {
  if (!Array.isArray(entries)) return entries;
  return entries.map(entry => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? { ...entry, role: canonicalPromptRoleId(entry.role) }
      : entry
  ));
}

export function canonicalizePromptPolicyAudit(audit) {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return audit;
  return {
    ...audit,
    roles: canonicalizeRoleManifestEntries(audit.roles),
    roleBodyRollout: canonicalizeRoleManifestEntries(audit.roleBodyRollout),
  };
}

export function approvedPromptPolicyManifestErrors(roleEntries) {
  const errors = [];
  const manifestByRole = new Map();
  if (APPROVED_PROMPT_POLICY_MANIFEST.length !== EXPECTED_ROLE_COUNT) {
    errors.push(
      `approved prompt policy manifest role count: expected ${EXPECTED_ROLE_COUNT}, got ${APPROVED_PROMPT_POLICY_MANIFEST.length}`,
    );
  }
  for (const entry of APPROVED_PROMPT_POLICY_MANIFEST) {
    if (manifestByRole.has(entry.role)) {
      errors.push(`duplicate approved prompt policy manifest role ${entry.role}`);
      continue;
    }
    manifestByRole.set(entry.role, entry);
    if (!/^[a-f0-9]{64}$/.test(entry.templateHash)) {
      errors.push(`invalid approved prompt policy manifest hash for ${entry.role}`);
    }
  }

  if (!Array.isArray(roleEntries)) {
    return [...errors, 'prompt policy collector role entries are not an array'];
  }
  if (roleEntries.length !== EXPECTED_ROLE_COUNT) {
    errors.push(
      `prompt policy collector role count: expected ${EXPECTED_ROLE_COUNT}, got ${roleEntries.length}`,
    );
  }

  const entriesByRole = new Map();
  for (const entry of roleEntries) {
    const role = typeof entry?.role === 'string' ? canonicalPromptRoleId(entry.role) : '';
    if (!role) {
      errors.push('prompt policy collector entry has a missing role');
      continue;
    }
    if (entriesByRole.has(role)) {
      errors.push(`duplicate prompt policy collector role ${role}`);
      continue;
    }
    entriesByRole.set(role, { ...entry, role });
    const approved = manifestByRole.get(role);
    if (!approved) {
      errors.push(`unapproved prompt policy collector role ${role}`);
      continue;
    }
    if (typeof entry.templateHash !== 'string' || entry.templateHash.length === 0) {
      errors.push(`missing prompt policy collector templateHash for ${role}`);
      continue;
    }
    if (typeof entry.content !== 'string') {
      errors.push(`missing prompt policy collector content for ${role}`);
      continue;
    }
    const contentHash = sha256(entry.content);
    if (contentHash !== entry.templateHash) {
      errors.push(
        `prompt policy collector content hash mismatch for ${role}: content=${contentHash} entry=${entry.templateHash}`,
      );
    }
    // Independent approval binds the current canonical selected body, including
    // its terminal triage contract. Retired-mode pins are not current evidence.
    const approvedContentHash = sha256(entry.content);
    if (approvedContentHash !== approved.templateHash) {
      errors.push(
        `approved prompt policy manifest hash mismatch for ${role}: approved=${approved.templateHash} entry=${approvedContentHash}`,
      );
    }
  }

  for (const role of manifestByRole.keys()) {
    if (!entriesByRole.has(role)) {
      errors.push(`approved prompt policy manifest role missing from collector ${role}`);
    }
  }
  return errors;
}

export function assertApprovedPromptPolicyManifest(roleEntries) {
  const errors = approvedPromptPolicyManifestErrors(roleEntries);
  if (errors.length === 0) return;
  throw new Error(
    `Refusing to collect or refresh the baseline because the approved prompt policy manifest failed:\n- ${errors.join('\n- ')}`,
  );
}

export function assertApprovedCanonicalRollout(actualRows) {
  if (!Array.isArray(actualRows) || actualRows.length !== APPROVED_ROLE_BODY_ROLLOUT_MANIFEST.length) {
    throw new Error('approved canonical rollout row count mismatch');
  }
  const seen = new Set();
  for (const actual of actualRows) {
    const approved = APPROVED_ROLE_BODY_ROLLOUT_MANIFEST.find(entry => entry.role === actual.role);
    if (!approved || seen.has(actual.role)) throw new Error('approved canonical rollout role set mismatch');
    seen.add(actual.role);
    if (Object.keys(actual).sort().join(',') !== Object.keys(approved).sort().join(',')) {
      throw new Error(`approved canonical rollout field set mismatch for ${actual.role}`);
    }
    for (const [field, digest] of Object.entries(approved)) {
      if (actual[field] !== digest) {
        throw new Error(`approved canonical rollout mismatch for ${actual.role}.${field}: expected ${digest}, got ${actual[field]}`);
      }
    }
  }
}

export function buildPromptPolicyManifestAudit() {
  return {
    model: 'independent-hardcoded-role-and-mode-aware-whole-prompt-digest-manifest',
    algorithm: 'sha256',
    roleCount: EXPECTED_ROLE_COUNT,
    primaryBoundary: PROMPT_POLICY_PRIMARY_BOUNDARY,
    roles: APPROVED_PROMPT_POLICY_MANIFEST.map(entry => ({ ...entry })),
    roleBodyRollout: APPROVED_ROLE_BODY_ROLLOUT_MANIFEST.map(entry => ({ ...entry })),
  };
}

export function toRepoPath(path) {
  return relative(ROOT, path).split('\\').join('/');
}

export function countLines(text) {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

export function normalizeCliPrint(stdout) {
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
}

export function assertBuiltArtifacts() {
  if (!existsSync(BUILT_REGISTRY_PATH) || !existsSync(CLI_PATH)) {
    throw new Error(
      'Built prompt registry or canonical CLI bootstrap not found. Run `npm --prefix packages/main run build` before this verifier.',
    );
  }
}

export function runAgentPrompt(role) {
  return execFileSync(process.execPath, [CLI_PATH, 'agent_prompt', `--role=${role}`], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function classifyLegacyRoleStatus(roleStatus) {
  if (typeof roleStatus !== 'string' || roleStatus.trim().length === 0) {
    return 'unknown-status';
  }
  if (LEGACY_VOCABULARY_EXEMPT_STATUSES.includes(roleStatus)) return 'exempt';
  if (LEGACY_VOCABULARY_KNOWN_STATUSES.includes(roleStatus)) return 'enforced';
  return 'unknown-status';
}

export function classifyLegacyVocabularyPolicy(
  role,
  roleStatus,
  term,
  excerpt,
  clause,
  occurrence,
) {
  const statusClassification = classifyLegacyRoleStatus(roleStatus);
  if (statusClassification === 'unknown-status') {
    return {
      roleStatus,
      statusClassification,
      policyStatus: 'blocked-unknown-status',
      policyReason: `Unknown legacy-vocabulary role status ${JSON.stringify(roleStatus)}.`,
    };
  }
  if (statusClassification === 'exempt') {
    return {
      roleStatus,
      statusClassification,
      policyStatus: 'allowed-role-status',
      policyReason: `Role status ${roleStatus} is explicitly exempt from live-role legacy-vocabulary enforcement.`,
    };
  }
  if (isStrictNegativeLegacyReference(clause, occurrence)) {
    return {
      roleStatus,
      statusClassification,
      policyStatus: 'allowed-negative-reference',
      policyReason: 'The whole occurrence clause matches the closed safe-negative grammar.',
    };
  }
  if (isRegisteredLegacyContext(role, term, excerpt)) {
    return {
      roleStatus,
      statusClassification,
      policyStatus: 'allowed-registered-context',
      policyReason: 'Exact role/term/excerpt occurrence is registered as current historical context.',
    };
  }
  return {
    roleStatus,
    statusClassification,
    policyStatus: 'blocked-active-use',
    policyReason: 'Enforced legacy-vocabulary occurrence is neither a safe negative nor a registered context.',
  };
}

export function isRegisteredLegacyContext(role, term, excerpt) {
  const canonicalRole = canonicalPromptRoleId(role);
  return LEGACY_VOCABULARY_CONTEXT_ALLOWLIST.some(
    entry =>
      canonicalPromptRoleId(entry.role) === canonicalRole &&
      entry.term === term &&
      entry.excerpt === excerpt,
  );
}

export function isStrictNegativeLegacyReference(clause, occurrence) {
  const beforeOccurrence = stripDirectiveFormatting(clause.slice(0, occurrence.index))
    .replace(/[*_`]+/g, '')
    .trim();
  if (LEGACY_PATTERNS.some(pattern => pattern.regex.test(beforeOccurrence))) return false;
  const safeAction = /^(?:do\s+not|don't|must\s+not|should\s+not|never|avoid|without|not)\s+(?:directly\s+)?(?:use|using|write|writing|set|setting|add|adding|create|creating|populate|populating|record|recording|assign|assigning|update|updating|enable|enabling|require|requiring|generate|generating|enter|entering|resurrect|resurrecting|review|reviewing|modify|modifying)\b([\s\S]*)$/i;
  const match = beforeOccurrence.match(safeAction);
  if (!match) return false;
  const safeTargetWords = new Set([
    'the',
    'a',
    'an',
    'any',
    'old',
    'legacy',
    'deprecated',
    'retired',
    'engineering',
    'coverage',
    'of',
    'code',
    'tests',
    'or',
    'field',
    'fields',
    'phase',
    'value',
    'values',
    'current',
    'existing',
  ]);
  const targetWords = match[1].match(/[A-Za-z]+/g) ?? [];
  if (targetWords.some(word => !safeTargetWords.has(word.toLowerCase()))) return false;
  const afterOccurrence = clause
    .slice(occurrence.index + occurrence.text.length)
    .replace(/[*_`]+/g, '')
    .trim();
  return afterOccurrence.replace(/[\s,.;:()\[\]{}\/-]+/g, '') === '';
}

export function classifyLegacyFinding(role, term, excerpt, roleStatus, clause, occurrence) {
  const canonicalRole = canonicalPromptRoleId(role);
  const policy = classifyLegacyVocabularyPolicy(
    role,
    roleStatus,
    term,
    excerpt,
    clause,
    occurrence,
  );
  if (
    canonicalRole === 'proof-or-stop-test-intent' ||
    canonicalRole === 'proof-or-stop-test-case-reviewer'
  ) {
    return {
      classification: 'legacy-prompt-body',
      note: 'Legacy compatibility prompt; visible until migration or retirement.',
      ...policy,
    };
  }
  if (canonicalRole === 'proof-or-stop-review-test-coverage') {
    return {
      classification: 'legacy-value-reference',
      note: 'Current reviewer explicitly references the old TEST_CASE_REVIEW value without reviving the phase.',
      ...policy,
    };
  }
  if (canonicalRole === 'proof-or-stop-review-concept') {
    return {
      classification: 'legacy-example',
      note: 'Example of concept deletion terminology, not an active testIntent instruction.',
      ...policy,
    };
  }
  if (
    canonicalRole === 'proof-or-stop-implementation-reviewer' ||
    canonicalRole === 'proof-or-stop-product-reviewer'
  ) {
    return {
      classification: 'legacy-overlap-wording',
      note: 'Legacy wording called out for later prompt consolidation.',
      ...policy,
    };
  }
  return {
    classification: term === 'testIntent' ? 'legacy-vocabulary-reference' : 'legacy-phase-reference',
    note: 'Registered legacy vocabulary occurrence.',
    ...policy,
  };
}

export function isExplicitlyGrandfatheredDirectStoryWrite(role, excerpt) {
  const canonicalRole = canonicalPromptRoleId(role);
  return DIRECT_STORY_WRITE_ALLOWLIST.some(
    entry => canonicalPromptRoleId(entry.role) === canonicalRole && entry.excerpt === excerpt,
  );
}

export function getRegisteredDirectStoryReference(role, excerpt) {
  const canonicalRole = canonicalPromptRoleId(role);
  return DIRECT_STORY_REFERENCE_ALLOWLIST.find(
    entry => canonicalPromptRoleId(entry.role) === canonicalRole && entry.excerpt === excerpt,
  );
}

export function classifyStoryFinding(role, excerpt, canonicalExcerpt = canonicalizeStoryDiagnosticText(excerpt)) {
  const registeredReference = getRegisteredDirectStoryReference(role, excerpt);
  if (registeredReference) {
    return {
      classification: registeredReference.classification,
      grandfathered: true,
      note: 'Exact code-reviewed current story-file reference.',
    };
  }
  if (isNegativeStoryPolicyReminder(canonicalExcerpt)) {
    return {
      classification: 'policy-reminder',
      grandfathered: false,
      note: 'Prompt reminds agents not to bypass CLI-mediated story operations.',
    };
  }
  if (isExplicitlyGrandfatheredDirectStoryWrite(role, excerpt)) {
    return {
      classification: 'direct-write',
      grandfathered: true,
      note: 'Registered direct story-file write instruction to replace with CLI-mediated writes in later milestones.',
    };
  }
  if (hasRecognizedStoryWriteAction(canonicalExcerpt)) {
    return {
      classification: 'direct-write',
      grandfathered: false,
      note: 'Unregistered direct story-file write instruction; collection and baseline refresh must stop.',
    };
  }
  return {
    classification: 'unclassified-actionable',
    grandfathered: false,
    note: 'Unregistered story-file instruction or reference; collection and baseline refresh must stop.',
  };
}

export function splitLegacyVocabularyClauses(excerpt) {
  return excerpt
    .replace(/\\\s*\r?\n\s*/g, ' ')
    .split(/\r?\n|;|(?<=[.!?])\s+|,\s*(?:but|however|then|instead)\s+|\s+(?:and\s+(?:then|instead)|but|however|then|instead)\s+/i)
    .map(clause => clause.trim())
    .filter(Boolean);
}

export function splitInstructionSegments(excerpt) {
  return excerpt
    .replace(/\\\s*\r?\n\s*/g, ' ')
    .split(/\r?\n|;|(?<=[.!?])\s+/)
    .map(segment => segment.trim())
    .filter(Boolean);
}

export function stripDirectiveFormatting(clause) {
  return clause
    .trim()
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/^[^A-Za-z0-9`'"]+\s*/, '')
    .replace(/^(?:[#>`]+\s*)+/, '')
    .replace(/^[*_`]+/, '')
    .trim();
}

export function isNegativeStoryPolicyReminder(excerpt) {
  if (!/docs\/story/i.test(excerpt)) return false;
  let hasStoryPolicy = false;
  for (const segment of splitInstructionSegments(excerpt)) {
    if (
      isStrictNegativeStorySegment(segment) ||
      isStrictDirectEditCliReminder(segment) ||
      isKnownWrappedStoryPolicyFragment(segment)
    ) {
      hasStoryPolicy = true;
      continue;
    }
    if (isStrictCliMediatedStorySegment(segment)) continue;
    return false;
  }
  return hasStoryPolicy;
}

export function normalizeStoryPolicySegment(segment) {
  return stripDirectiveFormatting(segment)
    .replace(/[*_`'"“”]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();
}

export const STORY_PATH_DIAGNOSTIC_SOURCE = String.raw`\bdocs(?:(?:\/+)(?:\s*\.\s*\/+)*)\s*story\b`;

export function canonicalizeStoryDiagnosticText(value) {
  return String(value)
    .replace(/\\[ \t]*\r?\n[ \t]*/g, '')
    .replace(new RegExp(STORY_PATH_DIAGNOSTIC_SOURCE, 'gi'), 'docs/story');
}

export function findStoryCandidateLineIndexes(content) {
  const candidateSource = content.replace(/\\(?=[ \t]*\r?\n)/g, ' ');
  const indexes = new Set();
  for (const match of candidateSource.matchAll(new RegExp(STORY_PATH_DIAGNOSTIC_SOURCE, 'gi'))) {
    const offset = match.index ?? 0;
    indexes.add((candidateSource.slice(0, offset).match(/\n/g) ?? []).length);
  }
  return [...indexes].sort((a, b) => a - b);
}

export function isStrictNegativeStorySegment(segment) {
  const directive = normalizeStoryPolicySegment(segment);
  const action = `(?:${DIRECT_STORY_SAFE_NEGATIVE_ACTIONS.join('|')})`;
  const match = directive.match(
    new RegExp(
      String.raw`^(?:do\s+not|don't|must\s+not|never|avoid)\s+(?:directly\s+)?${action}(?:(?:\s*\/\s*|\s+(?:or|and)\s+)${action})*\s+([\s\S]+)$`,
      'i',
    ),
  );
  if (!match) return false;

  const target = match[1];
  const storyPath = target.match(/docs\/story(?:\/[^\s`'")\]},;!?]*)?/i);
  if (!storyPath || storyPath.index === undefined) return false;
  const beforePath = target.slice(0, storyPath.index);
  const afterPath = target.slice(storyPath.index + storyPath[0].length);
  const safeTargetWords = new Set([
    'the',
    'story',
    'metadata',
    'json',
    'file',
    'files',
    'artifact',
    'artifacts',
    'directory',
    'directories',
    'content',
    'anything',
    'directly',
    'under',
    'in',
    'into',
    'inside',
    'within',
    'at',
    'from',
    'to',
    'on',
    'onto',
    'beneath',
  ]);
  const beforeWords = beforePath.match(/[A-Za-z]+/g) ?? [];
  if (beforeWords.some(word => !safeTargetWords.has(word.toLowerCase()))) return false;
  if (afterPath.replace(/[\s`'"*_,.:;!?()[\]{}<>/\\-]+/g, '') === '') return true;
  return /^\s*,?\s+and\s+do\s+not\s+write\s+fixtures\s+directly\s+under(?:\s+tests\/fixtures\/?)?\s*$/i.test(
    afterPath,
  );
}

export const CLI_BRAND_NAME_SOURCE = String.raw`(?:proofOrStop|proof-or-stop)\s+cli`;

export function isStrictCliMediatedStorySegment(segment) {
  const directive = normalizeStoryPolicySegment(segment);
  return (
    new RegExp(
      String.raw`^(?:story\s+operations\s+must\s+use|use)\s+(?:the\s+)?${CLI_BRAND_NAME_SOURCE}(?:\s+commands?)?(?:\s+instead)?$`,
      'i',
    ).test(directive) ||
    new RegExp(
      String.raw`^all\s+story\s+changes\s+go\s+through\s+(?:the\s+)?${CLI_BRAND_NAME_SOURCE}$`,
      'i',
    ).test(directive)
  );
}

export function isStrictDirectEditCliReminder(segment) {
  const directive = normalizeStoryPolicySegment(segment);
  return new RegExp(
    String.raw`^directly\s+read\s*\/\s*edit\s+json\s+files?\s+under\s+docs\/story\/?\s*:\s*all\s+story\s+changes\s+go\s+through\s+(?:the\s+)?${CLI_BRAND_NAME_SOURCE}$`,
    'i',
  ).test(directive);
}

export function isKnownWrappedStoryPolicyFragment(segment) {
  const directive = normalizeStoryPolicySegment(segment);
  return /^story\s+metadata\s+under\s+docs\/story\/?\s*,?\s+and\s+do\s+not\s+write\s+fixtures\s+directly\s+under$/i.test(
    directive,
  );
}

export function hasRecognizedStoryWriteAction(clause) {
  return (
    /^\s*\*{3}\s+(?:add|update|delete)\s+file\s*:/i.test(clause) ||
    /\bapply_patch\b/i.test(clause) ||
    /\bdirectly\s+read\s*\/\s*edit\b/i.test(clause) ||
    /\b(?:use|using|run|invoke|call)\s+(?:the\s+)?(?:edit|write)\b/i.test(clause) ||
    /\b(?:cp|copy|mv|move|install|rsync)\b[\s\S]*docs\/story/i.test(clause) ||
    /\b(?:edit|write|create|update|delete|remove|append|overwrite|replace)\b[\s\S]*docs\/story/i.test(clause) ||
    /docs\/story[\s\S]*\b(?:edit|write|create|update|delete|remove|append|overwrite|replace)\b/i.test(clause) ||
    /\b(?:tee|sed\s+-i|perl\s+-i)\b[\s\S]*docs\/story/i.test(clause) ||
    /(?:^|\s)(?:--output(?:=|\s+)|-o\s+)["'`]?docs\/story/i.test(clause) ||
    /\b(?:echo|printf|cat)\b[\s\S]*(?:>|>>)\s*docs\/story/i.test(clause) ||
    /\b(?:echo|printf)\b[\s\S]*\|\s*tee\b[\s\S]*docs\/story/i.test(clause) ||
    /(?:^|\s)(?:>|>>)\s*docs\/story/i.test(clause)
  );
}

export function scanLegacyVocabulary(roleEntries) {
  const findings = [];
  for (const entry of roleEntries) {
    const roleStatus = entry.status ?? roleMatrixDefaultsFor(entry.role)?.status ?? 'unknown';
    if (classifyLegacyRoleStatus(roleStatus) === 'unknown-status') {
      throw new Error(
        `unknown legacy-vocabulary role status ${JSON.stringify(roleStatus)} for ${entry.role}`,
      );
    }
    const lines = entry.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const excerpt = lines[index].trim();
      if (!excerpt) continue;
      const clauses = splitLegacyVocabularyClauses(excerpt);
      let occurrence = 0;
      for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
        const clause = clauses[clauseIndex];
        const clauseOccurrences = [];
        for (const pattern of LEGACY_PATTERNS) {
          const flags = pattern.regex.flags.includes('g')
            ? pattern.regex.flags
            : `${pattern.regex.flags}g`;
          for (const match of clause.matchAll(new RegExp(pattern.regex.source, flags))) {
            clauseOccurrences.push({
              term: pattern.term,
              index: match.index,
              text: match[0],
            });
          }
        }
        clauseOccurrences.sort(
          (a, b) => a.index - b.index || a.term.localeCompare(b.term),
        );
        for (const matched of clauseOccurrences) {
          occurrence += 1;
          const classification = classifyLegacyFinding(
            entry.role,
            matched.term,
            excerpt,
            roleStatus,
            clause,
            matched,
          );
          findings.push({
            id: sha256(`${entry.role}\0${index + 1}\0${occurrence}\0${matched.term}\0${excerpt}`).slice(0, 16),
            role: entry.role,
            line: index + 1,
            clauseIndex: clauseIndex + 1,
            occurrence,
            term: matched.term,
            matchedText: matched.text,
            clause,
            excerpt,
            ...classification,
          });
        }
      }
    }
  }
  return findings.sort(compareFinding);
}

export function legacyVocabularyPolicyErrors(findings) {
  return findings
    .filter(finding => finding.policyStatus === 'blocked-active-use')
    .map(
      finding =>
        `${LEGACY_VOCABULARY_BLOCK_REJECTION} at ${finding.role}:${finding.line ?? 'probe'} (${finding.term}): ${finding.excerpt}`,
    );
}

export function assertLegacyVocabularyPolicy(findings) {
  const errors = legacyVocabularyPolicyErrors(findings);
  if (errors.length === 0) return;
  throw new Error(
    `Refusing to collect or refresh the baseline because legacy-vocabulary policy failed:\n- ${errors.join('\n- ')}`,
  );
}

export function collectLegacyVocabularyFindings(roleEntries) {
  assertApprovedPromptPolicyManifest(roleEntries);
  const findings = scanLegacyVocabulary(roleEntries);
  assertLegacyVocabularyPolicy(findings);
  return findings;
}

export function buildStoryScanExcerpts(content) {
  const lines = content.split(/\r?\n/);
  const contexts = new Map();
  for (const index of findStoryCandidateLineIndexes(content)) {
    let start = index;
    let end = index;
    for (let distance = 0; distance < STORY_INSTRUCTION_CONTEXT_RADIUS; distance += 1) {
      if (start === 0 || isInstructionBoundary(lines[start - 1], lines[start])) break;
      start -= 1;
    }
    for (let distance = 0; distance < STORY_INSTRUCTION_CONTEXT_RADIUS; distance += 1) {
      if (end + 1 >= lines.length || isInstructionBoundary(lines[end], lines[end + 1])) break;
      end += 1;
    }
    const key = `${start}:${end}`;
    if (contexts.has(key)) continue;
    const rawExcerpt = lines.slice(start, end + 1).join('\n').trim();
    contexts.set(key, {
      line: start + 1,
      excerpt: rawExcerpt.split(/\r?\n/).map(line => line.trim()).join(' ').trim(),
      diagnosticExcerpt: canonicalizeStoryDiagnosticText(rawExcerpt)
        .split(/\r?\n/)
        .map(line => line.trim())
        .join(' ')
        .trim(),
    });
  }
  return [...contexts.values()].sort((a, b) => a.line - b.line);
}

export function isInstructionBoundary(previousLine, nextLine) {
  if (!previousLine.trim() || !nextLine.trim()) return true;
  if (/^\s*```/.test(previousLine) || /^\s*```/.test(nextLine)) return true;
  if (/^\s*#{1,6}\s+/.test(previousLine) || /^\s*#{1,6}\s+/.test(nextLine)) {
    return true;
  }
  const previousIsListItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(previousLine);
  const nextIsListItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(nextLine);
  if (previousIsListItem && nextIsListItem) return true;
  if (
    !previousIsListItem &&
    nextIsListItem &&
    !/docs\/story/i.test(previousLine) &&
    !/docs\/story/i.test(nextLine)
  ) {
    return true;
  }
  return false;
}

export function scanStoryFileReferences(roleEntries) {
  const findings = [];
  const storyPattern = /docs\/story(?:\/[^\s`'"<>)\]}]*)?/gi;
  for (const entry of roleEntries) {
    for (const { line, excerpt, diagnosticExcerpt } of buildStoryScanExcerpts(entry.content)) {
      if (!excerpt) continue;
      const references = [...diagnosticExcerpt.matchAll(storyPattern)].map(match => match[0]);
      if (references.length === 0) continue;
      const classification = classifyStoryFinding(entry.role, excerpt, diagnosticExcerpt);
      findings.push({
        id: sha256(`${entry.role}\0${line}\0${references.join(',')}\0${excerpt}`).slice(0, 16),
        role: entry.role,
        line,
        references: [...new Set(references)].sort(),
        excerpt,
        ...classification,
      });
    }
  }
  return findings.sort(compareFinding);
}

export function collectDirectStoryFindings(roleEntries) {
  assertApprovedPromptPolicyManifest(roleEntries);
  const findings = scanStoryFileReferences(roleEntries);
  assertDirectStoryWritePolicy(findings);
  const referenceErrors = directStoryReferenceExerciseErrors(findings);
  if (referenceErrors.length) {
    throw new Error(`Exact current story-reference policy failed:\n- ${referenceErrors.join('\n- ')}`);
  }
  return findings;
}

export function compareFinding(a, b) {
  return (
    a.role.localeCompare(b.role) ||
    a.line - b.line ||
    (a.occurrence ?? 0) - (b.occurrence ?? 0) ||
    String(a.term ?? a.references?.[0] ?? '').localeCompare(String(b.term ?? b.references?.[0] ?? '')) ||
    a.excerpt.localeCompare(b.excerpt)
  );
}

export function buildFindingKey(finding) {
  const discriminator = finding.term ?? (finding.references ?? []).join(',');
  return `${finding.role}:${finding.line}:${finding.clauseIndex ?? 0}:${finding.occurrence ?? 0}:${discriminator}:${sha256(finding.excerpt).slice(0, 16)}`;
}

export async function loadBuiltRegistry() {
  assertBuiltArtifacts();
  const registryModule = await import(`${pathToFileURL(BUILT_REGISTRY_PATH).href}?v=${Date.now()}`);
  return registryModule;
}

export async function loadBuiltRoleContractRegistry() {
  assertBuiltArtifacts();
  return import(`${pathToFileURL(BUILT_ROLE_CONTRACT_REGISTRY_PATH).href}?v=${Date.now()}`);
}
