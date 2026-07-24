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
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_LIFECYCLE_PHASES,
  LATTICE_LIFECYCLE_ARTIFACT_FILENAMES,
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
 * artifact filenames must classify via classifyLifecycleArtifact as
 * kind='lifecycle' under an active story dir. This is the runtime projection of
 * the B-5e4a registration (registry membership alone is not enough — the
 * classifier's prefix + storyId + closed-set pipeline must accept the full
 * path).
 */
const ACCEPTANCE_TOPOLOGY_ARTIFACT_FILENAMES = [
  'acceptance-basis.json',
  'pre-review-check.json',
  'topology-critic-receipt.json',
  'topology-exclusion-approvals.json',
] as const;

function checkAcceptanceTopologyArtifactClassification(): void {
  for (const fileName of ACCEPTANCE_TOPOLOGY_ARTIFACT_FILENAMES) {
    const path = `.lattice/story/actives/B-5e4a/${fileName}`;
    const classification = classifyLifecycleArtifact(path);
    if (!classification || classification.kind !== 'lifecycle') {
      record(
        'acceptance-topology-classification',
        `${fileName} does not classify as kind='lifecycle' under .lattice/story/actives/<storyId>/ — ` +
        `classifyLifecycleArtifact('${path}') returned ${classification ? `kind='${classification.kind}'` : 'null'} ` +
        `(is ${fileName} missing from LATTICE_LIFECYCLE_ARTIFACT_FILENAMES?)`,
      );
    }
  }
}

/**
 * Cross-check 6 (B-5e4a CHK-002): StoryStore top-level artifact filename
 * coverage invariant. Derives, from packages/main/src/core/store.ts SOURCE,
 * every single-segment filename literal (no slash) passed to the
 * readJson/writeJson/appendJsonl-style story-dir helpers, and asserts each
 * derived filename is either registered in LATTICE_LIFECYCLE_ARTIFACT_FILENAMES
 * or listed in the named exemption constant below. This closes the B-956f /
 * B-bf52 regression class mechanically: a new StoryStore top-level artifact
 * write without a registry entry fails this contract with a named divergence
 * instead of surfacing later as an OUT_OF_SCOPE scope violation.
 */
const STORYSTORE_TOP_LEVEL_FILENAME_EXEMPTIONS: ReadonlySet<string> = new Set([
  // dead writeLegacyReceiptRefs path, Authority future-capability domain,
  // register it when its write path goes live.
  'authority-receipt-refs.json',
]);

/**
 * Sanity floor for the derived set. store.ts currently references ~48 distinct
 * top-level filenames through the helpers; a derivation yielding fewer than
 * this floor means the extraction regex or the helper call shape drifted, and
 * the check must fail loudly rather than report vacuous coverage.
 */
const STORYSTORE_DERIVED_SET_FLOOR = 40;

/**
 * Matches a story-dir helper call whose second argument is a single-segment
 * filename literal, e.g.:
 *   this.readJson<StoryInfo>(storyId, 'index.json')
 *   this.writeJson(storyId, 'scope-check.json', data)
 * Capsule/nested writes use template literals with a directory prefix
 * (`${CAPSULE_DIR_NAME}/...`) and therefore never match; type-position string
 * unions and join(...) literals do not match the helper-call shape either.
 */
const STORYSTORE_TOP_LEVEL_ARTIFACT_CALL_RE =
  /\.(?:readJson|writeJson|appendJsonl)\w*(?:<[^(]*?>)?\(\s*[A-Za-z_$][\w$]*\s*,\s*'([a-z0-9-]+\.(?:json|jsonl|md))'/g;

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

/** Returns the derived-set size (0 when the derivation itself is broken). */
function checkStoryStoreTopLevelArtifactCoverage(): number {
  const storePath = resolveStoryStoreSourcePath();
  if (!existsSync(storePath)) {
    record(
      'storystore-coverage',
      `cannot locate StoryStore source at ${storePath} — the derivation is broken; coverage was NOT verified`,
    );
    return 0;
  }
  const source = readFileSync(storePath, 'utf-8');
  const derived = deriveStoryStoreTopLevelFilenames(source);
  if (derived.size < STORYSTORE_DERIVED_SET_FLOOR) {
    record(
      'storystore-coverage',
      `derived StoryStore top-level artifact set has only ${derived.size} entries, below the sanity floor of ` +
      `${STORYSTORE_DERIVED_SET_FLOOR} — the derivation is broken (extraction regex or store.ts helper shape drifted); ` +
      `coverage was NOT verified`,
    );
    return derived.size;
  }
  const missing = [...derived]
    .filter((fileName) =>
      !LATTICE_LIFECYCLE_ARTIFACT_FILENAMES.has(fileName) &&
      !STORYSTORE_TOP_LEVEL_FILENAME_EXEMPTIONS.has(fileName))
    .sort();
  for (const fileName of missing) {
    record(
      'storystore-coverage',
      `StoryStore reads/writes top-level story artifact ${fileName} but it is neither in ` +
      `LATTICE_LIFECYCLE_ARTIFACT_FILENAMES nor in STORYSTORE_TOP_LEVEL_FILENAME_EXEMPTIONS — register it in ` +
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
    if (LATTICE_LIFECYCLE_ARTIFACT_FILENAMES.has(fileName)) {
      record(
        'storystore-coverage',
        `exemption ${fileName} is now registered in LATTICE_LIFECYCLE_ARTIFACT_FILENAMES — remove the redundant exemption`,
      );
    }
  }
  return derived.size;
}

function main(): void {
  checkCommandDimension();
  checkProcessFactLifecycle();
  checkArtifactReferences();
  checkAcceptanceTopologyArtifactClassification();
  const storyStoreDerivedCount = checkStoryStoreTopLevelArtifactCoverage();

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
    `${phaseCount} phases projected, ${storyStoreDerivedCount} StoryStore top-level artifact filenames derived ` +
    `(floor ${STORYSTORE_DERIVED_SET_FLOOR}) and registered-or-exempted, 0 divergences`,
  );
}

main();
