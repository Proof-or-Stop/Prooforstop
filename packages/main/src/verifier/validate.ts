// ============================================================
// verifier/validate — Generic Machine validator
// ============================================================

import type { MachineConfig, CheckResult, ValidateOptions, ValidateResult, ExternalVerifierResult } from './types.js';
import { executeCliCases } from './cli-executor.js';
import { executeBrowserCases } from './browser-executor.js';
import { execSync } from 'node:child_process';

declare const process: { cwd(): string };

function check(results: CheckResult[], name: string, pass: boolean, details: string): void {
  results.push({ name, pass, details });
}

/** Validate integrity and consistency of a single Machine */
export async function validateMachine(machine: MachineConfig, options: ValidateOptions): Promise<ValidateResult> {
  const results: CheckResult[] = [];
  const { fnExports, extraExports, machineSource } = options;

  // ═══════════════════════════════════════════════
  // Layer 1: Static sensors (declaration consistency)
  // ═══════════════════════════════════════════════

  // 1. All action references are real functions
  {
    const missing: string[] = [];
    for (const t of machine.transitions) {
      if (typeof t.action.fn !== 'function') {
        missing.push(`${t.from}→${t.to}: action "${t.action.name}" is not a function`);
      }
    }
    check(results, 'Action functions exist',
      missing.length === 0,
      missing.length === 0
        ? `All ${machine.transitions.length} transitions have valid action functions`
        : missing.join('; ')
    );
  }

  // 2. All guard references are real functions
  {
    const missing: string[] = [];
    for (const t of machine.transitions) {
      if (typeof t.guard.fn !== 'function') {
        missing.push(`${t.from}→${t.to}: guard "${t.guard.name}" is not a function`);
      }
    }
    check(results, 'Guard functions exist',
      missing.length === 0,
      missing.length === 0
        ? `All ${machine.transitions.length} transitions have valid guard functions`
        : missing.join('; ')
    );
  }

  // 3. All states in transitions are in the states list
  {
    const stateSet = new Set(machine.states);
    const undeclared: string[] = [];
    for (const t of machine.transitions) {
      if (!stateSet.has(t.from)) undeclared.push(`from: "${t.from}"`);
      if (!stateSet.has(t.to)) undeclared.push(`to: "${t.to}"`);
    }
    if (!stateSet.has(machine.initial)) {
      undeclared.push(`initial: "${machine.initial}"`);
    }
    check(results, 'State declarations complete',
      undeclared.length === 0,
      undeclared.length === 0
        ? `All ${stateSet.size} states declared consistently`
        : `Undeclared states: ${undeclared.join(', ')}`
    );
  }

  // 4. All states reachable from initial state
  {
    const reachable = new Set<string>();
    const queue: string[] = [machine.initial];
    reachable.add(machine.initial);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const t of machine.transitions) {
        if (t.from === current && !reachable.has(t.to)) {
          reachable.add(t.to);
          queue.push(t.to);
        }
      }
    }
    const unreachable = machine.states.filter(s => !reachable.has(s));
    check(results, 'All states reachable',
      unreachable.length === 0,
      unreachable.length === 0
        ? `All ${machine.states.length} states reachable from "${machine.initial}"`
        : `Unreachable states: ${unreachable.join(', ')}`
    );
  }

  // 5. No dead-ends in non-terminal states
  {
    const terminalSet = new Set(machine.terminalStates);
    const deadEnds: string[] = [];
    for (const state of machine.states) {
      if (terminalSet.has(state)) continue;
      const hasOutgoing = machine.transitions.some(t => t.from === state);
      if (!hasOutgoing) deadEnds.push(state);
    }
    check(results, 'No dead-end states',
      deadEnds.length === 0,
      deadEnds.length === 0
        ? 'All non-terminal states have outgoing edges'
        : `Dead-end states: ${deadEnds.join(', ')}`
    );
  }

  // 6. All transitions must have a description
  {
    const missing = machine.transitions.filter(t => !t.description?.trim());
    check(results, 'Transition descriptions complete',
      missing.length === 0,
      missing.length === 0
        ? `All ${machine.transitions.length} transitions have descriptions`
        : `Missing descriptions: ${missing.map(t => `${t.from}→${t.to} [${t.event}]`).join(', ')}`
    );
  }

  // 7. Machine pure-config check
  if (machineSource) {
    const fnDefs = [...machineSource.matchAll(/^(?:export\s+)?function\s+(\w+)/gm)];
    const plannedStubNames = machine.transitions
      .filter(t => t.planned)
      .map(t => t.action.name);
    const violations: string[] = [];
    for (const m of fnDefs) {
      if (!plannedStubNames.includes(m[1])) {
        violations.push(m[1]);
      }
    }
    check(results, 'Machine pure config (no function definitions)',
      violations.length === 0,
      violations.length === 0
        ? 'machine.ts contains only planned stubs, no illegal function definitions'
        : `Non-stub functions found in machine.ts: ${violations.join(', ')} (should be moved to fn.ts)`
    );
  }

  // 8. Non-planned actions must come from fn.ts
  {
    const fnNames = new Set(Object.keys(fnExports));
    const violations: string[] = [];
    for (const t of machine.transitions) {
      if (t.planned) continue;
      if (!fnNames.has(t.action.name)) {
        violations.push(`${t.from}→${t.to}: action "${t.action.name}" not in fn.ts`);
      }
    }
    check(results, 'Action source compliance (non-planned)',
      violations.length === 0,
      violations.length === 0
        ? 'All active transition actions come from fn.ts'
        : violations.join('; ')
    );
  }

  // 9. Planned transition list
  {
    const plannedList = machine.transitions.filter(t => t.planned);
    if (plannedList.length > 0) {
      const items = plannedList.map(t => `${t.from}→${t.to} [${t.event}]`);
      check(results, 'Planned transitions (to be implemented)',
        true,
        `${plannedList.length} pending implementation: ${items.join(', ')}`
      );
    }
  }

  // 10. Constraint-referenced functions exist
  {
    const allNames = new Set([
      ...Object.keys(fnExports),
      ...Object.keys(extraExports ?? {}),
    ]);
    const missing: string[] = [];
    for (const c of machine.constraints) {
      if (!allNames.has(c.name)) {
        missing.push(`"${c.name}" (time: ${c.time}ms)`);
      }
    }
    check(results, 'Performance constraint functions exist',
      missing.length === 0,
      missing.length === 0
        ? `All functions referenced by ${machine.constraints.length} constraints exist`
        : `Missing: ${missing.join(', ')}`
    );
  }

  // 11. Orphan function detection
  {
    const referencedFns = new Set<Function>();
    for (const t of machine.transitions) {
      referencedFns.add(t.guard.fn);
      referencedFns.add(t.action.fn);
    }

    const fnEntries = Object.entries(fnExports).filter(([_, v]) => typeof v === 'function') as [string, Function][];

    const directlyReferenced = new Set<string>();
    for (const [name, fn] of fnEntries) {
      if (referencedFns.has(fn)) directlyReferenced.add(name);
    }
    for (const c of machine.constraints) {
      if (fnExports[c.name]) directlyReferenced.add(c.name);
    }

    // BFS to find indirect references
    const visited = new Set<string>(directlyReferenced);
    const queue = [...directlyReferenced];
    while (queue.length > 0) {
      const name = queue.shift()!;
      const fn = fnExports[name];
      if (typeof fn !== 'function') continue;
      const body = fn.toString();
      for (const [otherName] of fnEntries) {
        if (!visited.has(otherName) && body.includes(otherName)) {
          visited.add(otherName);
          queue.push(otherName);
        }
      }
    }

    const orphans = fnEntries.map(([n]) => n).filter(n => !visited.has(n));

    if (orphans.length > 0) {
      check(results, 'Orphan function detection',
        true, // warning, not error
        `⚠ ${orphans.length} functions in fn.ts not referenced by Machine (possibly leftover code): ${orphans.join(', ')}`
      );
    }
  }

  // 12. shellSources check: I/O shells must not directly import fn.ts
  if (options.shellSources) {
    const violations: string[] = [];
    for (const [file, content] of Object.entries(options.shellSources)) {
      // Match import ... from '...fn.js' or './fn' etc.
      if (/from\s+['"][^'"]*\/fn(?:\.js|\.ts)?['"]/m.test(content) || /from\s+['"]\.\/fn(?:\.js|\.ts)?['"]/m.test(content)) {
        violations.push(file);
      }
    }
    check(results, 'I/O shell isolation (Bridge)',
      violations.length === 0,
      violations.length === 0
        ? 'All shell files interact via bridge, none directly import fn'
        : `The following shell files directly import fn (should interact via bridge): ${violations.join(', ')}`
    );
  }

  // 13. Finding coverage check (if findings + integrationTests/logicTests with findingRef are provided)
  if (options.findings && options.findings.length > 0) {
    const criticalFindings = options.findings.filter(f => f.severity === 'critical' || f.severity === 'high');
    const coveredIds = new Set<string>();
    if (options.integrationTests) {
      for (const it of options.integrationTests) {
        if (it.findingRef) coveredIds.add(it.findingRef);
      }
    }
    if (options.logicTests) {
      for (const lt of options.logicTests) {
        if (lt.findingRef) coveredIds.add(lt.findingRef);
      }
    }
    const uncovered = criticalFindings.filter(f => !coveredIds.has(f.id));
    check(results, 'Finding coverage',
      uncovered.length === 0,
      uncovered.length === 0
        ? `All ${criticalFindings.length} critical/high findings have test coverage`
        : `${uncovered.length} critical/high findings lack test coverage: ${uncovered.map(f => `${f.id} (${f.severity}) ${f.desc}`).join('; ')}`
    );
  }

  // ═══════════════════════════════════════════════
  // Second layer: logic path tests (white box, run pure functions in memory)
  // ═══════════════════════════════════════════════

  if (options.logicTests && options.logicTests.length > 0) {
    const failures: string[] = [];

    for (const pt of options.logicTests) {
      let currentState = pt.initialMachineState ?? machine.initial;
      let state = pt.initialState;
      const actualPath = [currentState];
      let failed = false;

      for (let i = 0; i < pt.steps.length; i++) {
        const step = pt.steps[i];
        const { guardArgs, actionArgs } = pt.resolveArgs(state, step.input);

        const candidates = machine.transitions.filter(
          t => t.from === currentState && t.event === step.event && !t.planned
        );

        let matched: typeof machine.transitions[0] | null = null;
        for (const t of candidates) {
          try {
            if (t.guard.fn(...guardArgs)) {
              matched = t;
              break;
            }
          } catch { /* guard threw = no match */ }
        }

        if (!matched) {
          failures.push(`[${pt.name}] step ${i + 1}: no matching transition at "${currentState}" (event=${step.event})`);
          failed = true;
          break;
        }

        try {
          const result = matched.action.fn(...actionArgs);
          state = pt.extractState(result);
        } catch (e) {
          failures.push(`[${pt.name}] step ${i + 1}: action "${matched.action.name}" threw: ${e}`);
          failed = true;
          break;
        }

        currentState = matched.to;
        actualPath.push(currentState);
      }

      if (!failed) {
        const expected = pt.expectedPath.join(' → ');
        const actual = actualPath.join(' → ');
        if (expected !== actual) {
          failures.push(`[${pt.name}] path mismatch\n      expected: ${expected}\n      actual: ${actual}`);
        }
      }
    }

    const passedTests = options.logicTests.map(pt => `[${pt.name}] ${pt.expectedPath.join(' → ')}`);
    check(results, `Logic path tests (${options.logicTests.length})`,
      failures.length === 0,
      failures.length === 0
        ? passedTests.join('\n    ')
        : failures.join('\n    ')
    );
  }

  // Logic test coverage
  {
    const active = machine.transitions.filter(t => !t.planned);
    const coveredSet = new Set<string>();
    if (options.logicTests) {
      for (const pt of options.logicTests) {
        for (let i = 0; i < pt.expectedPath.length - 1; i++) {
          coveredSet.add(`${pt.expectedPath[i]}→${pt.expectedPath[i + 1]}`);
        }
      }
    }
    const uncovered = active.filter(t => !coveredSet.has(`${t.from}→${t.to}`));
    check(results, 'Logic test coverage',
      uncovered.length === 0,
      uncovered.length === 0
        ? `All ${active.length} active transitions have logic test coverage`
        : `${uncovered.length} uncovered: ${uncovered.map(t => `${t.from}→${t.to} [${t.event}]`).join(', ')}`
    );
  }

  // ═══════════════════════════════════════════════
  // Third layer: real-machine integration tests (black box, spawn real processes)
  // ═══════════════════════════════════════════════

  if (options.integrationTests && options.integrationTests.length > 0) {
    const active = machine.transitions.filter(t => !t.planned);

    // Coverage check: overall
    const coveredByIntegration = new Set<string>();
    for (const it of options.integrationTests) {
      for (const c of it.covers) coveredByIntegration.add(c);
    }
    const uncovered = active.filter(t => !coveredByIntegration.has(`${t.from}→${t.to}`));
    check(results, 'Real-machine test coverage declaration',
      uncovered.length === 0,
      uncovered.length === 0
        ? `All ${active.length} active transitions have real-machine test declarations`
        : `${uncovered.length} uncovered: ${uncovered.map(t => `${t.from}→${t.to}`).join(', ')}`
    );

    // Per-shell coverage check (defaults to ['cli'] when shells not declared, CLI completeness principle; falls back to core when core test exists)
    const hasCoreTests = options.integrationTests.some(it => it.type === 'core');
    const effectiveShells = (machine.shells && machine.shells.length > 0)
      ? machine.shells
      : hasCoreTests ? ['core'] as ('cli' | 'browser' | 'core')[] : ['cli'] as ('cli' | 'browser' | 'core')[];
    {
      for (const shell of effectiveShells) {
        const shellTests = options.integrationTests.filter(it => it.type === shell);
        const shellCovered = new Set<string>();
        for (const it of shellTests) {
          for (const c of it.covers) shellCovered.add(c);
        }
        const shellUncovered = active.filter(t => !shellCovered.has(`${t.from}→${t.to}`));
        check(results, `${shell} test coverage`,
          shellUncovered.length === 0,
          shellUncovered.length === 0
            ? `All ${active.length} active transitions have ${shell} test coverage`
            : `${shellUncovered.length} not covered by ${shell}: ${shellUncovered.map(t => `${t.from}→${t.to}`).join(', ')}`
        );
      }
    }

    // Filter tests to run
    const filter = options.integrationFilter;
    const testsToRun = filter
      ? options.integrationTests.filter(it =>
          filter.some(f =>
            it.name.includes(f) || it.covers.some(c => c.includes(f))
          )
        )
      : options.integrationTests;

    if (testsToRun.length === 0 && filter) {
      check(results, 'Real-machine integration tests', true,
        `No matching tests after filtering (filter: ${filter.join(', ')})`);
    }

    // Split by type and execute
    const cliTests = testsToRun.filter(it => it.type === 'cli');
    const coreTests = testsToRun.filter(it => it.type === 'core');
    const browserTests = testsToRun.filter(it => it.type === 'browser');

    const testResults: string[] = [];
    const failures: string[] = [];

    // Run core tests
    if (coreTests.length > 0) {
      if (!options.bridgeFactory) {
        for (const it of coreTests) {
          failures.push(`[${it.name}] requires bridgeFactory (project validate.ts did not provide one)`);
        }
      } else {
        for (const it of coreTests) {
          try {
            const bridge = options.bridgeFactory();
            let allStepsPassed = true;
            for (let i = 0; i < (it.coreSteps ?? []).length; i++) {
              const step = it.coreSteps![i];
              const result = bridge.sendEvent(step.sendEvent, step.input);

              if (step.expectResult !== undefined && result !== step.expectResult) {
                failures.push(`[${it.name}] step ${i + 1}: sendEvent("${step.sendEvent}") returned ${result}, expected ${step.expectResult}`);
                allStepsPassed = false;
                break;
              }
              if (step.expectMachine !== undefined) {
                const ms = bridge.getMachineState();
                if (ms !== step.expectMachine) {
                  failures.push(`[${it.name}] step ${i + 1}: machineState="${ms}", expected "${step.expectMachine}"`);
                  allStepsPassed = false;
                  break;
                }
              }
              if (step.expectState !== undefined) {
                const state = bridge.getState();
                for (const [key, val] of Object.entries(step.expectState)) {
                  if (JSON.stringify(state[key]) !== JSON.stringify(val)) {
                    failures.push(`[${it.name}] step ${i + 1}: state.${key}=${JSON.stringify(state[key])}, expected ${JSON.stringify(val)}`);
                    allStepsPassed = false;
                    break;
                  }
                }
                if (!allStepsPassed) break;
              }
            }
            if (allStepsPassed) {
              testResults.push(`[${it.name}] ✓`);
            }
          } catch (e) {
            failures.push(`[${it.name}] execution failed: ${e}`);
          }
        }
      }
    }

    // Run CLI tests
    if (cliTests.length > 0) {
      const groups = new Map<string, typeof cliTests>();
      for (const it of cliTests) {
        const cmd = it.command ?? 'node';
        const cwd = it.cwd ?? process.cwd();
        const key = `${cmd}|${cwd}`;
        const group = groups.get(key) ?? [];
        group.push(it);
        groups.set(key, group);
      }

      for (const [key, group] of groups) {
        const [command, cwd] = key.split('|');
        const cases = group.map(it => ({
          name: it.name,
          steps: it.steps ?? [],
        }));
        const firstTimeout = group[0].timeout;

        try {
          const result = await executeCliCases(
            { command, cwd, timeoutMs: firstTimeout, env: group[0].env },
            cases,
          );
          for (const cr of result.cases) {
            if (cr.passed) {
              testResults.push(`[${cr.name}] ✓ (${cr.durationMs}ms)`);
            } else {
              const stepErrors = cr.steps
                .filter(s => !s.passed)
                .map(s => s.error || `expected "${s.expect}"`)
                .join('; ');
              failures.push(`[${cr.name}] ${stepErrors}`);
            }
          }
        } catch (e) {
          for (const it of group) {
            failures.push(`[${it.name}] execution failed: ${e}`);
          }
        }
      }
    }

    // Run browser tests
    if (browserTests.length > 0) {
      const groups = new Map<string, typeof browserTests>();
      for (const it of browserTests) {
        const root = it.projectRoot ?? process.cwd();
        const dev = it.devCommand ?? '';
        const key = `${root}|${dev}`;
        const group = groups.get(key) ?? [];
        group.push(it);
        groups.set(key, group);
      }

      for (const [key, group] of groups) {
        const [projectRoot, devCommand] = key.split('|');
        const cases = group.map(it => ({
          name: it.name,
          steps: it.browserSteps ?? [],
        }));

        try {
          const result = await executeBrowserCases(
            { devCommand, projectRoot },
            cases,
          );
          for (const cr of result.cases) {
            if (cr.passed) {
              testResults.push(`[${cr.name}] ✓ (${cr.durationMs}ms)`);
            } else {
              const stepErrors = cr.steps
                .filter(s => !s.passed)
                .map(s => `${s.action}: ${s.error || 'failed'}`)
                .join('; ');
              failures.push(`[${cr.name}] ${stepErrors}`);
            }
          }
        } catch (e) {
          for (const it of group) {
            failures.push(`[${it.name}] execution failed: ${e}`);
          }
        }
      }
    }

    check(results, `Real-machine integration tests (${testsToRun.length}: ${cliTests.length} cli, ${coreTests.length} core, ${browserTests.length} browser)`,
      failures.length === 0,
      failures.length === 0
        ? testResults.join('\n    ')
        : failures.join('\n    ')
    );
  }

  return { results, allPass: results.every(r => r.pass) };
}

/** Project status summary (printed to stdout) */
export function statusReport(machine: MachineConfig, options?: { logicTests?: Array<{ name: string, steps: Array<{ event: string }>, expectedPath: string[] }>, integrationTests?: Array<{ name: string }> }): void {
  const active = machine.transitions.filter(t => !t.planned);
  const planned = machine.transitions.filter(t => t.planned);

  const coveredTransitions = new Set<string>();
  if (options?.logicTests) {
    for (const pt of options.logicTests) {
      for (let i = 0; i < pt.expectedPath.length - 1; i++) {
        coveredTransitions.add(`${pt.expectedPath[i]}→${pt.expectedPath[i + 1]}`);
      }
    }
  }

  const uncovered = active.filter(t => !coveredTransitions.has(`${t.from}→${t.to}`));

  const activeStates = new Set<string>();
  activeStates.add(machine.initial);
  for (const t of active) {
    activeStates.add(t.from);
    activeStates.add(t.to);
  }
  const plannedOnlyStates = machine.states.filter(s => !activeStates.has(s));

  console.log(`\n── ${machine.name} ──`);
  console.log(`  ${machine.description}\n`);
  console.log(`  States: ${machine.states.length} (${activeStates.size} active, ${plannedOnlyStates.length} planned only)`);
  console.log(`  Transitions: ${machine.transitions.length} (${active.length} active, ${planned.length} planned)`);
  console.log(`  Terminal states: ${machine.terminalStates.length}`);

  if (options?.logicTests) {
    console.log(`  Logic path tests: ${options.logicTests.length}, covering ${coveredTransitions.size}/${active.length} active transitions`);
    for (const pt of options.logicTests) {
      console.log(`    · ${pt.name} (${pt.expectedPath.join(' → ')})`);
    }
  }

  if (options?.integrationTests) {
    console.log(`  Real-machine integration tests: ${options.integrationTests.length}`);
    for (const it of options.integrationTests) {
      console.log(`    · ${it.name}`);
    }
  }

  if (active.length > 0) {
    console.log('\n  Implemented:');
    for (const t of active) {
      const covered = coveredTransitions.has(`${t.from}→${t.to}`) ? ' ✓tested' : ' ⚠untested';
      const desc = t.description ? ` — ${t.description}` : '';
      console.log(`    ${t.from} → ${t.to} [${t.event}]${covered}${desc}`);
    }
  }

  if (planned.length > 0) {
    console.log('\n  Pending (planned):');
    for (const t of planned) {
      const desc = t.description ? ` — ${t.description}` : '';
      console.log(`    ${t.from} → ${t.to} [${t.event}]${desc}`);
    }
  }

  if (uncovered.length > 0) {
    console.log('\n  \x1b[33m⚠ Not covered by logic tests:\x1b[0m');
    for (const t of uncovered) {
      console.log(`    ${t.from} → ${t.to} [${t.event}]`);
    }
  }

  if (plannedOnlyStates.length > 0) {
    console.log('\n  \x1b[33m⚠ States only referenced by planned (must be deleted together when planned is cancelled):\x1b[0m');
    for (const s of plannedOnlyStates) {
      console.log(`    ${s}`);
    }
  }

  console.log('');
}

/** Print validation report */
export function printReport(result: ValidateResult, title?: string): void {
  const label = title ?? 'State machine validation report';
  const pad = Math.max(label.length * 2 + 6, 38);
  const border = '═'.repeat(pad);

  console.log(`\n╔${border}╗`);
  console.log(`║   ${label}   ║`);
  console.log(`╚${border}╝\n`);

  for (const r of result.results) {
    const icon = r.pass ? '✓' : '✗';
    const color = r.pass ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';
    console.log(`  ${color}${icon}${reset} ${r.name}`);
    console.log(`    ${r.details}`);
  }

  console.log('');
  if (result.allPass) {
    console.log('\x1b[32m  All checks passed!\x1b[0m\n');
  } else {
    console.log('\x1b[31m  Validation failures exist, please fix and rerun.\x1b[0m\n');
  }
}

/** Module dependency graph: analyze import relationships among multiple modules */
export function dependencyReport(modules: Array<{ name: string; sources: string[] }>): void {
  // sources is an array of source code text (the caller reads the files and passes them in)
  const deps = new Map<string, Set<string>>();

  for (const mod of modules) {
    const modDeps = new Set<string>();
    for (const content of mod.sources) {
      const importMatches = content.matchAll(/from\s+['"]([^'"]+)['"]/g);
      for (const m of importMatches) {
        const importPath = m[1];
        for (const other of modules) {
          if (other.name === mod.name) continue;
          if (importPath.includes(`/${other.name}/`) || importPath.includes(`../${other.name}`)) {
            modDeps.add(other.name);
          }
        }
      }
    }
    deps.set(mod.name, modDeps);
  }

  console.log('\n── Module Dependencies ──');
  for (const [name, modDeps] of deps) {
    if (modDeps.size === 0) {
      console.log(`  ${name} → no external dependencies`);
    } else {
      console.log(`  ${name} → depends on ${[...modDeps].join(', ')}`);
    }
  }

  // Check for circular dependencies
  const cycles: string[] = [];
  for (const [a, aDeps] of deps) {
    for (const b of aDeps) {
      const bDeps = deps.get(b);
      if (bDeps?.has(a)) {
        const pair = [a, b].sort().join(' ↔ ');
        if (!cycles.includes(pair)) cycles.push(pair);
      }
    }
  }
  if (cycles.length > 0) {
    console.log(`\n  \x1b[31m✗ Circular dependency: ${cycles.join(', ')}\x1b[0m`);
  }
  console.log('');
}

/** Convert ValidateResult to ExternalVerifierResult (for koala gate consumption) */
export function toExternalResult(result: ValidateResult, machineName?: string): ExternalVerifierResult {
  let headSha: string | undefined;
  try {
    headSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch { /* not git */ }

  const failures = result.results.filter(r => !r.pass);
  const warnings = result.results.filter(r => r.pass && r.details.startsWith('⚠'));

  return {
    provider: 'koala-verifier',
    status: result.allPass ? (warnings.length > 0 ? 'warn' : 'pass') : 'fail',
    allPass: result.allPass,
    summary: result.allPass
      ? `${machineName || 'Machine'}: ${result.results.length} checks passed`
      : `${machineName || 'Machine'}: ${failures.length} checks failed`,
    details: result.results.map(r => `${r.pass ? '✓' : '✗'} ${r.name}: ${r.details}`),
    warnings: warnings.map(r => r.details),
    timestamp: new Date().toISOString(),
    headSha,
  };
}
