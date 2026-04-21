// ============================================================
// verifier/validate — 通用 Machine 校验器
// ============================================================

import type { MachineConfig, CheckResult, ValidateOptions, ValidateResult, ExternalVerifierResult } from './types.js';
import { executeCliCases } from './cli-executor.js';
import { executeBrowserCases } from './browser-executor.js';
import { execSync } from 'node:child_process';

declare const process: { cwd(): string };

function check(results: CheckResult[], name: string, pass: boolean, details: string): void {
  results.push({ name, pass, details });
}

/** 校验单个 Machine 的完整性和一致性 */
export async function validateMachine(machine: MachineConfig, options: ValidateOptions): Promise<ValidateResult> {
  const results: CheckResult[] = [];
  const { fnExports, extraExports, machineSource } = options;

  // ═══════════════════════════════════════════════
  // 第一层：静态传感器（声明一致性）
  // ═══════════════════════════════════════════════

  // 1. 所有 action 引用都是真实函数
  {
    const missing: string[] = [];
    for (const t of machine.transitions) {
      if (typeof t.action.fn !== 'function') {
        missing.push(`${t.from}→${t.to}: action "${t.action.name}" 不是函数`);
      }
    }
    check(results, 'Action 函数存在',
      missing.length === 0,
      missing.length === 0
        ? `全部 ${machine.transitions.length} 条转换的 action 均为有效函数`
        : missing.join('; ')
    );
  }

  // 2. 所有 guard 引用都是真实函数
  {
    const missing: string[] = [];
    for (const t of machine.transitions) {
      if (typeof t.guard.fn !== 'function') {
        missing.push(`${t.from}→${t.to}: guard "${t.guard.name}" 不是函数`);
      }
    }
    check(results, 'Guard 函数存在',
      missing.length === 0,
      missing.length === 0
        ? `全部 ${machine.transitions.length} 条转换的 guard 均为有效函数`
        : missing.join('; ')
    );
  }

  // 3. 所有转换中的状态都在 states 列表中
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
    check(results, '状态声明完整',
      undeclared.length === 0,
      undeclared.length === 0
        ? `全部 ${stateSet.size} 个状态声明一致`
        : `未声明的状态: ${undeclared.join(', ')}`
    );
  }

  // 4. 所有状态从初始状态可达
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
    check(results, '所有状态可达',
      unreachable.length === 0,
      unreachable.length === 0
        ? `从 "${machine.initial}" 可达全部 ${machine.states.length} 个状态`
        : `不可达状态: ${unreachable.join(', ')}`
    );
  }

  // 5. 非终止状态不存在死路
  {
    const terminalSet = new Set(machine.terminalStates);
    const deadEnds: string[] = [];
    for (const state of machine.states) {
      if (terminalSet.has(state)) continue;
      const hasOutgoing = machine.transitions.some(t => t.from === state);
      if (!hasOutgoing) deadEnds.push(state);
    }
    check(results, '无死路状态',
      deadEnds.length === 0,
      deadEnds.length === 0
        ? '全部非终止状态都有出边'
        : `死路状态: ${deadEnds.join(', ')}`
    );
  }

  // 6. 所有 transition 必须有 description
  {
    const missing = machine.transitions.filter(t => !t.description?.trim());
    check(results, 'Transition 描述完整',
      missing.length === 0,
      missing.length === 0
        ? `全部 ${machine.transitions.length} 条转换都有 description`
        : `缺少描述: ${missing.map(t => `${t.from}→${t.to} [${t.event}]`).join(', ')}`
    );
  }

  // 7. Machine 纯配置检查
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
    check(results, 'Machine 纯配置（无函数定义）',
      violations.length === 0,
      violations.length === 0
        ? 'machine.ts 仅含 planned stub，无非法函数定义'
        : `machine.ts 中发现非 stub 函数: ${violations.join(', ')}（应移到 fn.ts）`
    );
  }

  // 8. 非 planned action 必须来自 fn.ts
  {
    const fnNames = new Set(Object.keys(fnExports));
    const violations: string[] = [];
    for (const t of machine.transitions) {
      if (t.planned) continue;
      if (!fnNames.has(t.action.name)) {
        violations.push(`${t.from}→${t.to}: action "${t.action.name}" 不在 fn.ts 中`);
      }
    }
    check(results, 'Action 来源合规（非 planned）',
      violations.length === 0,
      violations.length === 0
        ? '全部活跃转换的 action 均来自 fn.ts'
        : violations.join('; ')
    );
  }

  // 9. Planned 转换清单
  {
    const plannedList = machine.transitions.filter(t => t.planned);
    if (plannedList.length > 0) {
      const items = plannedList.map(t => `${t.from}→${t.to} [${t.event}]`);
      check(results, 'Planned 转换（待实现）',
        true,
        `${plannedList.length} 条待实现: ${items.join(', ')}`
      );
    }
  }

  // 10. Constraint 引用的函数存在
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
    check(results, '性能约束函数存在',
      missing.length === 0,
      missing.length === 0
        ? `全部 ${machine.constraints.length} 条约束引用的函数均存在`
        : `缺失: ${missing.join(', ')}`
    );
  }

  // 11. 孤儿函数检测
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

    // BFS 找间接引用
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
      check(results, '孤儿函数检测',
        true, // warning 不是 error
        `⚠ fn.ts 中 ${orphans.length} 个函数未被 Machine 引用（可能是残留代码）: ${orphans.join(', ')}`
      );
    }
  }

  // 12. shellSources 检查：I/O 壳不应直接 import fn.ts
  if (options.shellSources) {
    const violations: string[] = [];
    for (const [file, content] of Object.entries(options.shellSources)) {
      // 匹配 import ... from '...fn.js' 或 './fn' 等
      if (/from\s+['"][^'"]*\/fn(?:\.js|\.ts)?['"]/m.test(content) || /from\s+['"]\.\/fn(?:\.js|\.ts)?['"]/m.test(content)) {
        violations.push(file);
      }
    }
    check(results, 'I/O 壳隔离（Bridge）',
      violations.length === 0,
      violations.length === 0
        ? '所有 shell 文件通过 bridge 交互，未直接 import fn'
        : `以下 shell 文件直接 import 了 fn（应通过 bridge 交互）: ${violations.join(', ')}`
    );
  }

  // 13. Finding 覆盖率检查（如果传入 findings + integrationTests/logicTests with findingRef）
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
    check(results, 'Finding 覆盖率',
      uncovered.length === 0,
      uncovered.length === 0
        ? `全部 ${criticalFindings.length} 条 critical/high finding 都有测试覆盖`
        : `${uncovered.length} 条 critical/high finding 无测试覆盖: ${uncovered.map(f => `${f.id} (${f.severity}) ${f.desc}`).join('; ')}`
    );
  }

  // ═══════════════════════════════════════════════
  // 第二层：逻辑链路测试（白盒，内存里跑纯函数）
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
          } catch { /* guard 抛异常 = 不匹配 */ }
        }

        if (!matched) {
          failures.push(`[${pt.name}] 步骤 ${i + 1}: 在 "${currentState}" 无匹配转换 (event=${step.event})`);
          failed = true;
          break;
        }

        try {
          const result = matched.action.fn(...actionArgs);
          state = pt.extractState(result);
        } catch (e) {
          failures.push(`[${pt.name}] 步骤 ${i + 1}: action "${matched.action.name}" 抛异常: ${e}`);
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
          failures.push(`[${pt.name}] 路径不匹配\n      期望: ${expected}\n      实际: ${actual}`);
        }
      }
    }

    const passedTests = options.logicTests.map(pt => `[${pt.name}] ${pt.expectedPath.join(' → ')}`);
    check(results, `逻辑链路测试（${options.logicTests.length} 条）`,
      failures.length === 0,
      failures.length === 0
        ? passedTests.join('\n    ')
        : failures.join('\n    ')
    );
  }

  // 逻辑测试覆盖率
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
    check(results, '逻辑测试覆盖率',
      uncovered.length === 0,
      uncovered.length === 0
        ? `全部 ${active.length} 条活跃转换都有逻辑测试覆盖`
        : `${uncovered.length} 条未覆盖: ${uncovered.map(t => `${t.from}→${t.to} [${t.event}]`).join(', ')}`
    );
  }

  // ═══════════════════════════════════════════════
  // 第三层：真机集成测试（黑盒，spawn 真进程）
  // ═══════════════════════════════════════════════

  if (options.integrationTests && options.integrationTests.length > 0) {
    const active = machine.transitions.filter(t => !t.planned);

    // Coverage check: overall
    const coveredByIntegration = new Set<string>();
    for (const it of options.integrationTests) {
      for (const c of it.covers) coveredByIntegration.add(c);
    }
    const uncovered = active.filter(t => !coveredByIntegration.has(`${t.from}→${t.to}`));
    check(results, '真机测试覆盖声明',
      uncovered.length === 0,
      uncovered.length === 0
        ? `全部 ${active.length} 条活跃转换都有真机测试声明覆盖`
        : `${uncovered.length} 条未覆盖: ${uncovered.map(t => `${t.from}→${t.to}`).join(', ')}`
    );

    // Per-shell coverage check（未声明 shells 时默认 ['cli']，CLI 完整性原则；有 core test 时用 core 兜底）
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
        check(results, `${shell} 测试覆盖率`,
          shellUncovered.length === 0,
          shellUncovered.length === 0
            ? `全部 ${active.length} 条活跃转换都有 ${shell} 测试覆盖`
            : `${shellUncovered.length} 条未被 ${shell} 覆盖: ${shellUncovered.map(t => `${t.from}→${t.to}`).join(', ')}`
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
      check(results, '真机集成测试', true,
        `过滤后无匹配测试（filter: ${filter.join(', ')}）`);
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
          failures.push(`[${it.name}] 需要 bridgeFactory（项目 validate.ts 未提供）`);
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
                failures.push(`[${it.name}] 步骤 ${i + 1}: sendEvent("${step.sendEvent}") 返回 ${result}，期望 ${step.expectResult}`);
                allStepsPassed = false;
                break;
              }
              if (step.expectMachine !== undefined) {
                const ms = bridge.getMachineState();
                if (ms !== step.expectMachine) {
                  failures.push(`[${it.name}] 步骤 ${i + 1}: machineState="${ms}"，期望 "${step.expectMachine}"`);
                  allStepsPassed = false;
                  break;
                }
              }
              if (step.expectState !== undefined) {
                const state = bridge.getState();
                for (const [key, val] of Object.entries(step.expectState)) {
                  if (JSON.stringify(state[key]) !== JSON.stringify(val)) {
                    failures.push(`[${it.name}] 步骤 ${i + 1}: state.${key}=${JSON.stringify(state[key])}，期望 ${JSON.stringify(val)}`);
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
            failures.push(`[${it.name}] 执行失败: ${e}`);
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
            failures.push(`[${it.name}] 执行失败: ${e}`);
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
            failures.push(`[${it.name}] 执行失败: ${e}`);
          }
        }
      }
    }

    check(results, `真机集成测试（${testsToRun.length} 条: ${cliTests.length} cli, ${coreTests.length} core, ${browserTests.length} browser）`,
      failures.length === 0,
      failures.length === 0
        ? testResults.join('\n    ')
        : failures.join('\n    ')
    );
  }

  return { results, allPass: results.every(r => r.pass) };
}

/** 项目状态摘要（打印到 stdout） */
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
  console.log(`  状态: ${machine.states.length} 个（${activeStates.size} 活跃, ${plannedOnlyStates.length} 仅 planned）`);
  console.log(`  转换: ${machine.transitions.length} 条（${active.length} 活跃, ${planned.length} planned）`);
  console.log(`  终态: ${machine.terminalStates.length} 个`);

  if (options?.logicTests) {
    console.log(`  逻辑链路测试: ${options.logicTests.length} 条，覆盖 ${coveredTransitions.size}/${active.length} 活跃转换`);
    for (const pt of options.logicTests) {
      console.log(`    · ${pt.name} (${pt.expectedPath.join(' → ')})`);
    }
  }

  if (options?.integrationTests) {
    console.log(`  真机集成测试: ${options.integrationTests.length} 条`);
    for (const it of options.integrationTests) {
      console.log(`    · ${it.name}`);
    }
  }

  if (active.length > 0) {
    console.log('\n  已实现:');
    for (const t of active) {
      const covered = coveredTransitions.has(`${t.from}→${t.to}`) ? ' ✓tested' : ' ⚠untested';
      const desc = t.description ? ` — ${t.description}` : '';
      console.log(`    ${t.from} → ${t.to} [${t.event}]${covered}${desc}`);
    }
  }

  if (planned.length > 0) {
    console.log('\n  待实现 (planned):');
    for (const t of planned) {
      const desc = t.description ? ` — ${t.description}` : '';
      console.log(`    ${t.from} → ${t.to} [${t.event}]${desc}`);
    }
  }

  if (uncovered.length > 0) {
    console.log('\n  \x1b[33m⚠ 未被逻辑测试覆盖:\x1b[0m');
    for (const t of uncovered) {
      console.log(`    ${t.from} → ${t.to} [${t.event}]`);
    }
  }

  if (plannedOnlyStates.length > 0) {
    console.log('\n  \x1b[33m⚠ 仅由 planned 引用的状态（planned 取消时需一起删除）:\x1b[0m');
    for (const s of plannedOnlyStates) {
      console.log(`    ${s}`);
    }
  }

  console.log('');
}

/** 打印校验报告 */
export function printReport(result: ValidateResult, title?: string): void {
  const label = title ?? '状态机校验报告';
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
    console.log('\x1b[32m  全部检查通过！\x1b[0m\n');
  } else {
    console.log('\x1b[31m  存在校验失败项，请修复后重新运行。\x1b[0m\n');
  }
}

/** 模块依赖图：分析多个模块之间的 import 关系 */
export function dependencyReport(modules: Array<{ name: string; sources: string[] }>): void {
  // sources 是源码文本数组（调用方自己读文件传进来）
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

  console.log('\n── 模块依赖 ──');
  for (const [name, modDeps] of deps) {
    if (modDeps.size === 0) {
      console.log(`  ${name} → 无外部依赖`);
    } else {
      console.log(`  ${name} → 依赖 ${[...modDeps].join(', ')}`);
    }
  }

  // 检查循环依赖
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
    console.log(`\n  \x1b[31m✗ 循环依赖: ${cycles.join(', ')}\x1b[0m`);
  }
  console.log('');
}

/** 将 ValidateResult 转换为 ExternalVerifierResult（给 koala gate 消费） */
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
