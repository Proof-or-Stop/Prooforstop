#!/usr/bin/env node
/**
 * @task B-3740
 * @checklist CHK-002
 * @title lifecycle registry consistency contract
 * @type chore
 * @priority high
 * @description
 *   Cross-checks the lifecycle registry's command + artifact dimensions
 *   (B-3740 CHK-001) against the three independent truth sources that can
 *   silently drift from it:
 *     1. command-policy.ts  COMMAND_POLICIES.allowedPhases
 *     2. config.ts          DEFAULT_PHASE_TOOLS (with the `*` wildcard bucket)
 *     3. process-fact lifecycle (process-fact-levels.ts / process-fact-registry.ts)
 *   Plus: every oracleRows/gates id that names an artifact must resolve to a
 *   declared LifecycleArtifact enum value.
 *
 *   Fails with a NAMED divergence (command / artifact / phase), never a
 *   generic message. Models the same resolution semantics DEFAULT_PHASE_TOOLS
 *   uses — `*` wildcard bucket + per-phase additions — and compares the
 *   RESOLVED effective command set, never raw literal tables (preMortem #1).
 * @changes
 *   - [CHK-002] Add lifecycle registry consistency contract
 *   - [B-5e4a CHK-002] Add acceptance-topology artifact classification check +
 *     StoryStore top-level artifact filename coverage invariant
 *   - [B-5e4a F-002] Scope the helper-parameter classification of unresolved
 *     storyDir join-site identifiers to the enclosing callable's parameter
 *     list (whole-source parameter search silently skipped coincidental names)
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_LIFECYCLE_PHASES,
  PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES,
  LIFECYCLE_ORACLE_ARTIFACT_REFS,
  LIFECYCLE_PHASE_ARTIFACTS,
  LIFECYCLE_TRANSITIONS,
  classifyLifecycleArtifact,
  isLifecycleArtifact,
  lifecycleArtifactsByPhase,
  lifecycleArtifactsByTransition,
  lifecycleCommandsByPhase,
  lifecycleResolvedCommandsForPhase,
  type CommandPhase,
  type LifecycleArtifactRole,
} from '../core/lifecycle-registry.js';
import { getCommandPolicyEntries } from '../core/command-policy.js';
import { DEFAULT_PHASE_TOOLS } from '../core/config.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';

/** A single named divergence between the registry and a truth source. */
interface Divergence {
  /** Which cross-check produced this divergence. */
  source: string;
  /** Human-readable detail, MUST name the divergent command / artifact / phase. */
  detail: string;
}

/**
 * B-7813: pre-existing phase-tools reachability gaps, tracked separately.
 *
 * The converse reachability check (checkCommandDimension check (3)) flags any
 * command-policy allowedPhases entry that no DEFAULT_PHASE_TOOLS pattern grants
 * in that phase (a dead command). Entries here are pre-existing gaps that predate
 * B-7813 and are out of this story's scope to individually fix; seeding them keeps
 * the new check ACTIVE (it fails on any NEW unreachable command like the
 * stall_resolution_set regression) without expanding B-7813 to remediate the whole
 * back-catalog. Each entry is a command NAME (exempt in every phase its policy
 * allows). Remove an entry once its DEFAULT_PHASE_TOOLS coverage is fixed — the
 * stale-exemption guard fails if an entry is no longer unreachable anywhere.
 */
const PHASE_TOOLS_REACHABILITY_EXEMPTIONS: ReadonlySet<string> = new Set([]);

const divergences: Divergence[] = [];

function record(source: string, detail: string): void {
  divergences.push({ source, detail });
}

/**
 * Models DEFAULT_PHASE_TOOLS' pattern matching: a trailing `*` is a prefix
 * wildcard, otherwise an exact command-name match. Same semantics as
 * `patternMatchesCommand` in core/config.ts.
 */
function patternMatchesCommand(pattern: string, command: string): boolean {
  if (pattern.endsWith('*')) return command.startsWith(pattern.slice(0, -1));
  return command === pattern;
}

/**
 * Resolves the effective set of commands DEFAULT_PHASE_TOOLS grants in a phase.
 * Mirrors core/config.ts `commandAllowedByPatterns`: the `*` wildcard bucket
 * patterns PLUS the per-phase patterns, expanded against the known command
 * universe. This is the resolution-semantics model that prevents a false
 * positive on the `*` bucket (preMortem #1).
 */
function resolveDefaultPhaseToolsCommands(phase: CommandPhase, allCommands: readonly string[]): Set<string> {
  const wildcardPatterns = DEFAULT_PHASE_TOOLS['*'] ?? [];
  const phasePatterns = DEFAULT_PHASE_TOOLS[phase] ?? [];
  const patterns = [...wildcardPatterns, ...phasePatterns];
  const resolved = new Set<string>();
  for (const command of allCommands) {
    if (patterns.some((pattern) => patternMatchesCommand(pattern, command))) {
      resolved.add(command);
    }
  }
  return resolved;
}

/**
 * Cross-check 1 + 2: the registry command dimension vs command-policy
 * allowedPhases vs DEFAULT_PHASE_TOOLS.
 *
 * The registry command projection (lifecycleCommandsByPhase) is derived from
 * command-policy's allowedPhases — so check (1) is that the projection is
 * internally well-formed, and check (2) is that DEFAULT_PHASE_TOOLS never
 * grants a phase a command the registry/command-policy does not allow.
 */
function checkCommandDimension(): void {
  const policyEntries = getCommandPolicyEntries();
  const allCommands = policyEntries.map(([command]) => command);
  const projection = lifecycleCommandsByPhase();

  // (1) registry projection well-formedness: a command is either in the
  // wildcard bucket (allowedPhases='all') or some per-phase list, never both,
  // and every per-phase command's policy must list that phase.
  for (const [command, policy] of policyEntries) {
    if (policy.allowedPhases === 'all') {
      if (!projection.wildcard.includes(command)) {
        record('registry-projection', `command ${command} has allowedPhases='all' but is absent from the registry wildcard bucket`);
      }
      continue;
    }
    if (!policy.allowedPhases) continue; // rootOnly / legacy with no phase list — legal in no active story phase
    for (const phase of policy.allowedPhases) {
      if (!projection.byPhase[phase].includes(command)) {
        record('registry-projection', `command ${command} declares phase ${phase} in command-policy but the registry projection.byPhase.${phase} is missing it`);
      }
    }
  }

  // (2) DEFAULT_PHASE_TOOLS resolved effective set must be a subset of the
  // registry's resolved effective set (`*` bucket + per-phase) for each phase.
  for (const phase of COMMAND_LIFECYCLE_PHASES) {
    const phaseToolsResolved = resolveDefaultPhaseToolsCommands(phase, allCommands);
    const registryResolved = new Set(lifecycleResolvedCommandsForPhase(phase));
    for (const command of phaseToolsResolved) {
      if (!registryResolved.has(command)) {
        record(
          'default-phase-tools',
          `DEFAULT_PHASE_TOOLS resolves command ${command} as legal in phase ${phase}, but the registry command dimension (command-policy allowedPhases) does not`,
        );
      }
    }
  }

  // (3) CONVERSE reachability (B-7813): every command-policy allowedPhases entry
  // must ALSO be reachable in DEFAULT_PHASE_TOOLS for that phase. isCommandAllowed
  // intersects the policy ceiling with DEFAULT_PHASE_TOOLS, so a command whose
  // policy lists a phase but which no DEFAULT_PHASE_TOOLS pattern grants in that
  // phase is DEAD — permanently rejected in exactly the phase it exists for
  // (the B-7813 stall_resolution_set regression class). Check (2) only proves the
  // subset direction (phase-tools ⊆ policy); this proves the converse
  // (policy-per-phase ⊆ phase-tools), closing the blind spot. Pre-existing gaps
  // unrelated to B-7813 are seeded in PHASE_TOOLS_REACHABILITY_EXEMPTIONS so the
  // check passes now yet fails on any NEW unreachable command.
  for (const phase of COMMAND_LIFECYCLE_PHASES) {
    const phaseToolsResolved = resolveDefaultPhaseToolsCommands(phase, allCommands);
    const registryResolved = lifecycleResolvedCommandsForPhase(phase);
    for (const command of registryResolved) {
      if (phaseToolsResolved.has(command)) continue;
      if (PHASE_TOOLS_REACHABILITY_EXEMPTIONS.has(command)) continue;
      record(
        'default-phase-tools-reachability',
        `command ${command} declares phase ${phase} legal in command-policy (allowedPhases) but no DEFAULT_PHASE_TOOLS pattern grants it in ${phase} — isCommandAllowed will REJECT it there (dead command). Add it to DEFAULT_PHASE_TOOLS[${phase}] (or the '*' bucket) in packages/main/src/core/config.ts, or add a justified entry to PHASE_TOOLS_REACHABILITY_EXEMPTIONS`,
      );
    }
  }
  // Stale-exemption guard: an exemption that is no longer unreachable in ANY
  // phase (i.e. every phase its policy allows is now granted by DEFAULT_PHASE_TOOLS)
  // must be removed so the allowlist cannot silently mask a future regression.
  for (const command of PHASE_TOOLS_REACHABILITY_EXEMPTIONS) {
    let stillUnreachableSomewhere = false;
    for (const phase of COMMAND_LIFECYCLE_PHASES) {
      const registryResolved = new Set(lifecycleResolvedCommandsForPhase(phase));
      if (!registryResolved.has(command)) continue; // policy does not allow it here
      const phaseToolsResolved = resolveDefaultPhaseToolsCommands(phase, allCommands);
      if (!phaseToolsResolved.has(command)) {
        stillUnreachableSomewhere = true;
        break;
      }
    }
    if (!stillUnreachableSomewhere) {
      record(
        'default-phase-tools-reachability',
        `exemption ${command} is now reachable in DEFAULT_PHASE_TOOLS for every phase its command-policy allows — remove the stale PHASE_TOOLS_REACHABILITY_EXEMPTIONS entry`,
      );
    }
  }
}

/**
 * Cross-check 3: process-fact lifecycle references vs the registry command
 * dimension. Every process-fact command entry (excluding runtime: / flow-policy:
 * pseudo-entries) must have a command-policy entry — i.e. must be a known
 * command in the registry command dimension.
 */
function checkProcessFactLifecycle(): void {
  const knownCommands = new Set<string>(getCommandPolicyEntries().map(([command]) => command));
  for (const entry of PROCESS_FACT_LEVELS) {
    if (entry.name.startsWith('runtime:') || entry.name.startsWith('flow-policy:')) continue;
    if (!knownCommands.has(entry.name)) {
      record(
        'process-fact-lifecycle',
        `process-fact lifecycle entry ${entry.name} (level ${entry.level}) has no command-policy entry — it is not in the registry command dimension`,
      );
    }
  }
  // Reverse direction: every command in the registry command dimension must be
  // tracked by the process-fact lifecycle, so a new command cannot be added to
  // command-policy without a process-fact level classification.
  const processFactNames = new Set<string>(PROCESS_FACT_LEVELS.map((entry) => entry.name));
  for (const command of knownCommands) {
    if (!processFactNames.has(command)) {
      record(
        'process-fact-lifecycle',
        `command ${command} is in the registry command dimension (command-policy) but has no process-fact lifecycle level entry`,
      );
    }
  }
}

/**
 * Cross-check 4: every oracleRows / gates id that names an artifact must
 * resolve to a declared LifecycleArtifact enum value, and every artifact named
 * in the phase / transition dimensions must be a declared LifecycleArtifact.
 */
function checkArtifactReferences(): void {
  // 4a. LIFECYCLE_ORACLE_ARTIFACT_REFS values must all be declared artifacts.
  for (const [oracleId, artifact] of Object.entries(LIFECYCLE_ORACLE_ARTIFACT_REFS)) {
    if (!isLifecycleArtifact(artifact)) {
      record('artifact-reference', `oracle id ${oracleId} maps to ${artifact}, which is not a declared LifecycleArtifact`);
    }
  }

  // 4b. Per-phase produces/consumes artifacts must all be declared artifacts.
  const artifactRoles: readonly LifecycleArtifactRole[] = ['produces', 'consumes'];
  for (const [phase, phaseArtifacts] of Object.entries(LIFECYCLE_PHASE_ARTIFACTS)) {
    for (const role of artifactRoles) {
      for (const artifact of phaseArtifacts[role]) {
        if (!isLifecycleArtifact(artifact)) {
          record('artifact-reference', `phase ${phase} ${role} undeclared artifact ${artifact}`);
        }
      }
    }
  }

  // 4c. Transition artifact projection must only surface declared artifacts.
  for (const transitionArtifacts of lifecycleArtifactsByTransition()) {
    for (const artifact of transitionArtifacts.artifacts) {
      if (!isLifecycleArtifact(artifact)) {
        record(
          'artifact-reference',
          `transition ${transitionArtifacts.from}->${transitionArtifacts.to} resolves undeclared artifact ${artifact}`,
        );
      }
    }
  }

  // 4d. Every transition oracleRows/gates id that LOOKS like an artifact
  // (matches an entry in LIFECYCLE_ORACLE_ARTIFACT_REFS) must resolve. This
  // proves the transition artifact projection is complete: each named-artifact
  // reference on a transition is accounted for.
  for (const transition of LIFECYCLE_TRANSITIONS) {
    const projected = lifecycleArtifactsByTransition().find(
      (entry) => entry.from === transition.from && entry.to === transition.to,
    );
    for (const ref of [...transition.oracleRows, ...transition.gates]) {
      const mapped = LIFECYCLE_ORACLE_ARTIFACT_REFS[ref as keyof typeof LIFECYCLE_ORACLE_ARTIFACT_REFS];
      if (mapped === undefined) continue; // conceptual id, not an artifact reference
      if (!projected || !projected.artifacts.includes(mapped)) {
        record(
          'artifact-reference',
          `transition ${transition.from}->${transition.to} names artifact-bearing oracle/gate id ${ref} (${mapped}) but the transition artifact projection omits it`,
        );
      }
    }
  }
}

/**
 * Cross-check 5 (B-5e4a CHK-002): the four acceptance-topology StoryStore
 * artifact filenames — plus the review-loops.jsonl REVIEW loop ledger
 * (B-5e4a F-001) — must classify via classifyLifecycleArtifact as
 * kind='lifecycle' under an active story dir. This is the runtime projection of
 * the B-5e4a registration (registry membership alone is not enough — the
 * classifier's prefix + storyId + closed-set pipeline must accept the full
 * path).
 */
const CLASSIFICATION_CROSS_CHECK_FILENAMES = [
  'acceptance-basis.json',
  'pre-review-check.json',
  'topology-critic-receipt.json',
  'topology-exclusion-approvals.json',
  // REVIEW loop ledger written via join(this.storyDir(...), REVIEW_LOOP_FILENAME)
  // in store.ts; B-5e4a F-001.
  'review-loops.jsonl',
] as const;

function checkAcceptanceTopologyArtifactClassification(): void {
  for (const fileName of CLASSIFICATION_CROSS_CHECK_FILENAMES) {
    const path = `.proof-or-stop/story/actives/B-5e4a/${fileName}`;
    const classification = classifyLifecycleArtifact(path);
    if (!classification || classification.kind !== 'lifecycle') {
      record(
        'acceptance-topology-classification',
        `${fileName} does not classify as kind='lifecycle' under .proof-or-stop/story/actives/<storyId>/ — ` +
        `classifyLifecycleArtifact('${path}') returned ${classification ? `kind='${classification.kind}'` : 'null'} ` +
        `(is ${fileName} missing from PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES?)`,
      );
    }
  }
}

/**
 * Cross-check 6 (B-5e4a CHK-002): StoryStore top-level artifact filename
 * coverage invariant. Derives, from packages/main/src/core/store.ts SOURCE,
 * every top-level story artifact filename reachable through TWO write/read
 * shapes:
 *   1. single-segment filename literals (no slash) passed to the
 *      readJson/writeJson-style story-dir helpers, and
 *   2. `join(this.storyDir(<arg>), <X>)` sites (B-5e4a F-001), where <X> is a
 *      string literal or an identifier resolved to one (store.ts const, or a
 *      const followed through store.ts's relative import — e.g.
 *      REVIEW_LOOP_FILENAME → './review-loop.js' → 'review-loops.jsonl').
 * Each derived filename must be either registered in
 * PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES or listed in the named exemption
 * constant below. This closes the B-956f / B-bf52 regression class
 * mechanically: a new StoryStore top-level artifact write without a registry
 * entry fails this contract with a named divergence instead of surfacing later
 * as an OUT_OF_SCOPE scope violation.
 */
const STORYSTORE_TOP_LEVEL_FILENAME_EXEMPTIONS: ReadonlySet<string> = new Set([
  // dead writeLegacyReceiptRefs path, Authority future-capability domain,
  // register it when its write path goes live.
  'authority-receipt-refs.json',
]);

/**
 * Sanity floor for the derived set. store.ts currently references ~49 distinct
 * top-level filenames through the two derivation passes (helper literals +
 * storyDir join sites); a derivation yielding fewer than this floor means an
 * extraction regex or a call shape drifted, and the check must fail loudly
 * rather than report vacuous coverage.
 */
const STORYSTORE_DERIVED_SET_FLOOR = 40;

/**
 * Pass 1: matches a story-dir helper call whose second argument is a
 * single-segment filename literal, e.g.:
 *   this.readJson<StoryInfo>(storyId, 'index.json')
 *   this.writeJson(storyId, 'scope-check.json', data)
 * Capsule/nested writes use template literals with a directory prefix
 * (`${CAPSULE_DIR_NAME}/...`) and therefore never match; type-position string
 * unions do not match the helper-call shape either. join(this.storyDir(...))
 * sites are covered by pass 2 (STORYSTORE_STORYDIR_JOIN_SITE_RE, B-5e4a F-001).
 */
const STORYSTORE_TOP_LEVEL_ARTIFACT_CALL_RE =
  /\.(?:readJson|writeJson)\w*(?:<[^(]*?>)?\(\s*[A-Za-z_$][\w$]*\s*,\s*'([a-z0-9-]+\.(?:json|jsonl|md))'/g;

/**
 * Pass 2 (B-5e4a F-001): matches a `join(this.storyDir(<arg>), <X>)` site in
 * store.ts where <X> is a single-quoted string literal (capture group 1) or an
 * identifier (capture group 2). store.ts writes some top-level story artifacts
 * — e.g. the review-loops.jsonl REVIEW loop ledger, via appendFileSync /
 * writeFileSync — through this path shape instead of the readJson/writeJson
 * helpers, so pass 1 alone cannot see them.
 */
const STORYSTORE_STORYDIR_JOIN_SITE_RE =
  /\bjoin\(\s*this\.storyDir\(\s*[A-Za-z_$][\w$]*\s*\)\s*,\s*(?:'([^']*)'|([A-Za-z_$][\w$]*))/g;

/**
 * Domain filter for pass 2: only resolved values shaped like a top-level story
 * artifact filename belong to this coverage check. Directory names (e.g.
 * CAPSULE_DIR_NAME → 'capsule') and slash-containing relative paths live in
 * other classifier domains and are correctly filtered out here.
 */
const TOP_LEVEL_ARTIFACT_FILENAME_RE = /^[a-z0-9][a-z0-9-]*\.(?:json|jsonl|md)$/;

/** Escapes an identifier for safe interpolation into a RegExp (`$` in idents). */
function escapeIdentForRegExp(ident: string): string {
  return ident.replace(/\$/g, '\\$');
}

/** Resolves `const <IDENT> = '<literal>'` within the given source, or null. */
function resolveConstLiteral(source: string, ident: string): string | null {
  const re = new RegExp(String.raw`\bconst\s+${escapeIdentForRegExp(ident)}\b\s*=\s*'([^']*)'`);
  const match = source.match(re);
  return match ? match[1] : null;
}

/**
 * Follows store.ts's named-import statement for `ident` to its relative module
 * (e.g. './review-loop.js' → src/core/review-loop.ts, which ships alongside
 * dist) and resolves `const <original name> = '<literal>'` there. Handles
 * `X as Y` aliasing; returns null when the identifier is not imported from a
 * resolvable relative module or the module declares no such const literal.
 */
function resolveImportedLiteral(storeSource: string, storeDir: string, ident: string): string | null {
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(\.[^']*)'/g;
  for (const importMatch of storeSource.matchAll(importRe)) {
    const clause = importMatch[1];
    const moduleRel = importMatch[2];
    for (const rawName of clause.split(',')) {
      const name = rawName.trim().replace(/^type\s+/, '');
      if (!name) continue;
      const aliasMatch = name.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      const localName = aliasMatch ? aliasMatch[2] : name;
      if (localName !== ident) continue;
      const sourceName = aliasMatch ? aliasMatch[1] : name;
      const modulePath = join(storeDir, moduleRel).replace(/\.js$/, '.ts');
      if (!existsSync(modulePath)) return null;
      return resolveConstLiteral(readFileSync(modulePath, 'utf-8'), sourceName);
    }
  }
  return null;
}

/** Keywords whose `(...)` group before a `{` is a control clause, not a callable's parameter list. */
const NON_CALLABLE_PAREN_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'typeof', 'await',
]);

/**
 * Backward-scans from `fromIndex` (exclusive) for the nearest UNMATCHED `{` —
 * i.e. the opener of the block that lexically encloses `fromIndex`. Balanced
 * `{...}` pairs encountered on the way (earlier sibling blocks, object/template
 * interpolations) cancel out via the depth counter. Returns -1 at top level.
 */
function findEnclosingBraceOpen(source: string, fromIndex: number): number {
  let depth = 0;
  for (let i = fromIndex - 1; i >= 0; i--) {
    const ch = source[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** Backward-scans from the `)` at `closeIndex` to its balanced matching `(`, or -1. */
function findMatchingParenOpen(source: string, closeIndex: number): number {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i--) {
    const ch = source[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * If the `{` at `braceIndex` opens a CALLABLE body (method / function / arrow),
 * returns the raw text of that callable's parameter list (the content between
 * its parens); otherwise null. A callable body opener is `(<params>)` followed
 * only by an optional return-type annotation and/or `=>` before the `{`, where
 * the token before `(` is a method/function name (optionally generic, e.g.
 * `readJson<T>(...)`) — control clauses (`if (...) {` etc.) are rejected so the
 * enclosing-scope walker keeps ascending past them.
 */
function callableParamListForBodyOpen(source: string, braceIndex: number): string | null {
  const before = source.slice(0, braceIndex);
  const headerMatch = before.match(/\)\s*(?::\s*[\w$.<>[\]|&\s]*)?(?:=>\s*)?$/);
  if (!headerMatch || headerMatch.index === undefined) return null;
  const closeParen = headerMatch.index;
  const openParen = findMatchingParenOpen(source, closeParen);
  if (openParen === -1) return null;
  // Token before `(`: skip an optional generic group (`<T>`), then read the
  // identifier. Bare arrow param lists (`(x) => {`) have no leading identifier
  // and are accepted as callables.
  let cursor = openParen - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor--;
  if (source[cursor] === '>') {
    let angleDepth = 0;
    while (cursor >= 0) {
      if (source[cursor] === '>') angleDepth++;
      else if (source[cursor] === '<') {
        angleDepth--;
        if (angleDepth === 0) {
          cursor--;
          break;
        }
      }
      cursor--;
    }
    while (cursor >= 0 && /\s/.test(source[cursor])) cursor--;
  }
  let nameEnd = cursor + 1;
  while (cursor >= 0 && /[\w$]/.test(source[cursor])) cursor--;
  const name = source.slice(cursor + 1, nameEnd);
  if (name && NON_CALLABLE_PAREN_KEYWORDS.has(name)) return null;
  return source.slice(openParen + 1, closeParen);
}

/**
 * True when the join-site identifier is declared as a typed string PARAMETER of
 * the callable (method/function) that lexically ENCLOSES that join site — e.g.
 * `file` inside `storyFilePath(storyId: string, file: string)`. Such sites are
 * generic helper plumbing — the concrete filenames flow in from call sites,
 * which pass 1 covers for the readJson/writeJson helpers — not a per-artifact
 * derivation blind spot.
 *
 * SCOPED rule (B-5e4a F-002): the classification walks up the enclosing blocks
 * from the join site itself and inspects ONLY the parameter lists of callables
 * that lexically enclose that site (innermost method plus any outer callables,
 * for sites inside nested callbacks — those parameters are in scope via
 * closure). A whole-source search would silently skip a local variable whose
 * name merely coincides with a typed parameter declared elsewhere in store.ts
 * (e.g. a `const file = someCall()` join site) — exactly the derivation blind
 * spot this pass exists to fail loudly on. Any ambiguity (no enclosing
 * callable found, lexical walker confused) classifies as NOT a helper
 * parameter, so the fail direction is always the named divergence.
 */
function isEnclosingCallableParameter(source: string, ident: string, siteIndex: number): boolean {
  const paramRe = new RegExp(String.raw`[(,]\s*${escapeIdentForRegExp(ident)}\s*:\s*string\b`);
  let cursor = siteIndex;
  while (true) {
    const braceOpen = findEnclosingBraceOpen(source, cursor);
    if (braceOpen === -1) return false;
    const paramList = callableParamListForBodyOpen(source, braceOpen);
    if (paramList !== null && paramRe.test(`(${paramList}`)) return true;
    // Non-callable block (if/for/try/object literal) or a callable that does
    // not declare `ident`: keep ascending — an outer enclosing callable may.
    cursor = braceOpen;
  }
}

/**
 * Pass 2 derivation: resolves every `join(this.storyDir(...), <X>)` site to a
 * filename. Resolution order: inline literal → store.ts const literal →
 * imported const literal → typed string parameter of the callable enclosing
 * THAT site (scoped, B-5e4a F-002). An identifier that resolves to none of
 * these is a derivation blind spot and fails loudly with a named divergence —
 * never skipped silently (B-5e4a F-001).
 */
function deriveStoryDirJoinFilenames(source: string, storeDir: string): Set<string> {
  const derived = new Set<string>();
  for (const match of source.matchAll(STORYSTORE_STORYDIR_JOIN_SITE_RE)) {
    const literal = match[1];
    const ident = match[2];
    let resolved: string | null = null;
    if (literal !== undefined) {
      resolved = literal;
    } else {
      resolved = resolveConstLiteral(source, ident) ?? resolveImportedLiteral(source, storeDir, ident);
      if (resolved === null) {
        if (isEnclosingCallableParameter(source, ident, match.index ?? 0)) continue;
        record(
          'storystore-coverage',
          `join(this.storyDir(...), ${ident}) site in store.ts: identifier ${ident} cannot be resolved to a ` +
          `string literal (not a store.ts const, not a const behind a resolvable relative import, not a typed ` +
          `string parameter of the enclosing method) — derivation blind spot; coverage was NOT verified for this site`,
        );
        continue;
      }
    }
    if (TOP_LEVEL_ARTIFACT_FILENAME_RE.test(resolved)) derived.add(resolved);
  }
  return derived;
}

function resolveStoryStoreSourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/tasks → dist → packages/main (runtime) and src/tasks → src →
  // packages/main (tsx). The TypeScript SOURCE ships alongside dist, so both
  // execution modes resolve the same file.
  const packageRoot = join(here, '..', '..');
  return join(packageRoot, 'src', 'core', 'store.ts');
}

function deriveStoryStoreTopLevelFilenames(source: string): Set<string> {
  const derived = new Set<string>();
  for (const match of source.matchAll(STORYSTORE_TOP_LEVEL_ARTIFACT_CALL_RE)) {
    derived.add(match[1]);
  }
  return derived;
}

interface StoryStoreCoverageResult {
  /** Merged derived-set size across both passes (0 when the derivation itself is broken). */
  derivedCount: number;
  /** Filenames contributed by the storyDir join-site pass (pass 2), sorted. */
  joinSiteFilenames: readonly string[];
}

function checkStoryStoreTopLevelArtifactCoverage(): StoryStoreCoverageResult {
  const storePath = resolveStoryStoreSourcePath();
  if (!existsSync(storePath)) {
    record(
      'storystore-coverage',
      `cannot locate StoryStore source at ${storePath} — the derivation is broken; coverage was NOT verified`,
    );
    return { derivedCount: 0, joinSiteFilenames: [] };
  }
  const source = readFileSync(storePath, 'utf-8');
  const derived = deriveStoryStoreTopLevelFilenames(source);
  const joinDerived = deriveStoryDirJoinFilenames(source, dirname(storePath));
  for (const fileName of joinDerived) derived.add(fileName);
  const joinSiteFilenames = [...joinDerived].sort();
  if (derived.size < STORYSTORE_DERIVED_SET_FLOOR) {
    record(
      'storystore-coverage',
      `derived StoryStore top-level artifact set has only ${derived.size} entries, below the sanity floor of ` +
      `${STORYSTORE_DERIVED_SET_FLOOR} — the derivation is broken (extraction regex or store.ts call shape drifted); ` +
      `coverage was NOT verified`,
    );
    return { derivedCount: derived.size, joinSiteFilenames };
  }
  const missing = [...derived]
    .filter((fileName) =>
      !PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES.has(fileName) &&
      !STORYSTORE_TOP_LEVEL_FILENAME_EXEMPTIONS.has(fileName))
    .sort();
  for (const fileName of missing) {
    record(
      'storystore-coverage',
      `StoryStore reads/writes top-level story artifact ${fileName} but it is neither in ` +
      `PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES nor in STORYSTORE_TOP_LEVEL_FILENAME_EXEMPTIONS — register it in ` +
      `packages/main/src/core/lifecycle-registry.ts or add a justified named exemption`,
    );
  }
  // Stale-exemption guard: every exemption must still be derived from store.ts
  // and must not be silently double-listed in the registry.
  for (const fileName of STORYSTORE_TOP_LEVEL_FILENAME_EXEMPTIONS) {
    if (!derived.has(fileName)) {
      record(
        'storystore-coverage',
        `exemption ${fileName} is no longer derived from StoryStore — remove the stale exemption`,
      );
    }
    if (PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES.has(fileName)) {
      record(
        'storystore-coverage',
        `exemption ${fileName} is now registered in PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES — remove the redundant exemption`,
      );
    }
  }
  return { derivedCount: derived.size, joinSiteFilenames };
}

function main(): void {
  checkCommandDimension();
  checkProcessFactLifecycle();
  checkArtifactReferences();
  checkAcceptanceTopologyArtifactClassification();
  const storyStoreCoverage = checkStoryStoreTopLevelArtifactCoverage();

  if (divergences.length > 0) {
    console.error('lifecycle-registry consistency: FAIL');
    console.error(`  ${divergences.length} divergence(s) found:`);
    for (const divergence of divergences) {
      console.error(`  [${divergence.source}] ${divergence.detail}`);
    }
    process.exit(1);
  }

  // Sanity: the artifact projection must cover every phase (stable structured data).
  const artifactsByPhase = lifecycleArtifactsByPhase();
  const phaseCount = Object.keys(artifactsByPhase).length;
  console.log(
    `lifecycle-registry consistency: PASS — command-policy / DEFAULT_PHASE_TOOLS / process-fact lifecycle consistent with registry, ` +
    `${phaseCount} phases projected, ${storyStoreCoverage.derivedCount} StoryStore top-level artifact filenames derived ` +
    `(floor ${STORYSTORE_DERIVED_SET_FLOOR}; storyDir join-site pass: ` +
    `${storyStoreCoverage.joinSiteFilenames.length > 0 ? storyStoreCoverage.joinSiteFilenames.join(', ') : 'none'}) ` +
    `and registered-or-exempted, 0 divergences`,
  );
}

main();
