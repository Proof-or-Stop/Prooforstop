// ============================================================
// verifier/types — koala 内建 verifier 类型定义
// ============================================================

import type { CliStep } from './cli-executor.js';
import type { BrowserStep } from './browser-executor.js';
import type { Finding } from '../core/types.js';

/** Input schema 字段定义（用于 Dashboard 自动生成表单，可选） */
export interface InputFieldSchema {
  type: 'number' | 'string' | 'boolean' | 'select';
  label?: string;
  min?: number;
  max?: number;
  default?: any;
  options?: Array<{ value: any; label: string }>;
}

/** Circuit 跨端引用：声明跨 machine 的事件路由 */
export interface CircuitRef {
  /** 链路名称，同名 circuit 的 transition 自动串联 */
  name: string;
  /** 跨端跳转目标，格式 "endpoint:EVENT"，数组表示 fan-out */
  next?: string | string[];
  /** 超时毫秒数 */
  timeout?: number;
  /** 超时后触发的事件 */
  onTimeout?: string;
  /** input 中用于关联不同实例的字段名（跨设备场景按此字段精确匹配） */
  key?: string;
}

/** 状态转换 */
export interface Transition {
  from: string;
  to: string;
  event: string;
  guard: { name: string; fn: (...args: any[]) => boolean };
  action: { name: string; fn: (...args: any[]) => any };
  planned?: boolean;
  /** 这条转换做什么（给人和 AI 看的说明，必填） */
  description: string;
  /** Input 结构描述（可选，Dashboard 用来生成表单，不影响 API） */
  inputSchema?: Record<string, InputFieldSchema>;
  /** Circuit 跨端路由声明（可选，用于 koala serve --circuit 多 machine 联调） */
  circuit?: CircuitRef;
}

/** 性能约束 */
export interface Constraint {
  name: string;
  time: number;
}

/** Machine 配置 */
export interface MachineConfig {
  /** Machine 名称 */
  name: string;
  /** 这个 Machine 做什么（项目级描述） */
  description: string;
  initial: string;
  states: string[];
  terminalStates: string[];
  transitions: Transition[];
  constraints: Constraint[];
  /** Which test shells this machine supports */
  shells?: ('cli' | 'browser' | 'core')[];
}

/** 单项检查结果 */
export interface CheckResult {
  name: string;
  pass: boolean;
  details: string;
}

/** 逻辑链路测试：纯函数走 Machine 路径（白盒，内存里跑） */
export interface LogicTest {
  name: string;
  initialState: any;
  /** 初始 machine state（默认 machine.initial） */
  initialMachineState?: string;
  expectedPath: string[];
  steps: Array<{ event: string; input: any }>;
  resolveArgs: (state: any, input: any) => { guardArgs: any[]; actionArgs: any[] };
  extractState: (actionResult: any) => any;
  /** 关联的 Finding ID（如 B-xxx:F-001） */
  findingRef?: string;
}

/** Core test step：在当前进程内通过 bridge 直接驱动 */
export interface CoreStep {
  sendEvent: string;
  input: any;
  /** 期望 sendEvent 返回值（true=处理了, false=无匹配 transition） */
  expectResult?: boolean;
  /** 期望的 machine state（如 'waiting_white'） */
  expectMachine?: string;
  /** 期望的 game state 部分匹配 */
  expectState?: Record<string, any>;
}

/** 真机集成测试：spawn 真进程，发真输入，验真输出（黑盒） */
export interface IntegrationTest {
  type: 'cli' | 'browser' | 'core';
  name: string;
  /** 这条测试覆盖哪些 transition（格式：'from→to'） */
  covers: string[];
  /** 超时 ms（默认 30000） */
  timeout?: number;

  // ---- CLI-specific fields ----
  /** CLI steps: sequential stdin/stdout interactions */
  steps?: CliStep[];
  /** CLI launch command (e.g. "npx tsx main.ts") */
  command?: string;
  /** Extra environment variables for CLI */
  env?: Record<string, string>;
  /** Working directory for CLI (defaults to process.cwd()) */
  cwd?: string;

  // ---- Core-specific fields ----
  /** Core test steps: in-process bridge interactions */
  coreSteps?: CoreStep[];

  // ---- Browser-specific fields ----
  /** Browser steps: click/eval/assert/screenshot/wait/type */
  browserSteps?: BrowserStep[];
  /** Dev server command (e.g. "npm run dev") */
  devCommand?: string;
  /** Project root for browser tests */
  projectRoot?: string;
  /** Pattern to detect dev server ready */
  serverReadyPattern?: string;
  /** 关联的 Finding ID（如 B-xxx:F-001） */
  findingRef?: string;
}

/** validate 选项 */
export interface ValidateOptions {
  fnExports: Record<string, unknown>;
  extraExports?: Record<string, unknown>;
  machineSource?: string;
  /** 逻辑链路测试（白盒） */
  logicTests?: LogicTest[];
  /** 真机集成测试（黑盒） */
  integrationTests?: IntegrationTest[];
  /** 只跑 covers 包含指定 transition 的集成测试 */
  integrationFilter?: string[];
  /** constraint 测量次数（默认 10，设 0 跳过） */
  constraintRuns?: number;
  /** Shell 源码文本（key=文件名, value=源码），用于 Bridge I/O 隔离检查 */
  shellSources?: Record<string, string>;
  /** Finding 列表（koala-reviewer 发现项），用于覆盖率检查 */
  findings?: Finding[];
  /** Core test 用的 bridge 工厂函数（由项目 validate.ts 提供） */
  bridgeFactory?: () => { sendEvent(event: string, input: any): boolean; getState(): any; getMachineState(): string; reset(): void };
}

/** validate 返回结果 */
export interface ValidateResult {
  results: CheckResult[];
  allPass: boolean;
}

/** koala validate --json 结构化输出（给 gate 消费） */
export interface ExternalVerifierResult {
  provider: 'koala-verifier';
  status: 'pass' | 'fail' | 'warn';
  allPass: boolean;
  summary: string;
  details: string[];
  warnings: string[];
  artifacts?: Array<{
    type: 'json' | 'text' | 'screenshot' | 'log';
    label: string;
    path?: string;
  }>;
  timestamp: string;
  headSha?: string;
}
