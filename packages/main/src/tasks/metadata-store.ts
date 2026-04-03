
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { TaskAnnotation, FlowChain, FlowStep } from './types.js';

/** task.json 中每条记录 */
export interface TaskRecord {
  /** 唯一键：sourceFile:functionName */
  key: string;
  task: string;
  checklist?: string[];
  title?: string;
  type?: string;
  priority?: string;
  version?: string;
  scope?: string;
  depends?: string[];
  author?: string;
  date?: string;
  description?: string;
  changes?: string[];
  affected?: string[];
  sourceFile: string;
  sourceLine: number;
  functionName?: string;
  functionSignature?: string;
  test?: string;
  /** flow 信息（如果该函数参与 flow） */
  flow?: {
    name: string;
    step: number;
    input?: string;
    output?: string;
    next?: string;
  };
}

/** task.json 根结构 */
export interface TaskStore {
  version: number;
  updatedAt: string;
  tasks: TaskRecord[];
}

/** flow.json 根结构 */
export interface FlowStore {
  version: number;
  updatedAt: string;
  flows: FlowChain[];
}

export class MetadataStore {
  private taskPath: string;
  private flowPath: string;

  constructor(projectRoot: string, metadataDir?: string) {
    const dir = metadataDir || join(projectRoot, 'docs', 'metadata');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.taskPath = join(dir, 'task.json');
    this.flowPath = join(dir, 'flow.json');
  }

  // ── Task ──

  readTasks(): TaskStore {
    if (!existsSync(this.taskPath)) {
      return { version: 1, updatedAt: new Date().toISOString(), tasks: [] };
    }
    return JSON.parse(readFileSync(this.taskPath, 'utf-8'));
  }

  writeTasks(store: TaskStore): void {
    store.updatedAt = new Date().toISOString();
    writeFileSync(this.taskPath, JSON.stringify(store, null, 2) + '\n');
  }

  findTask(sourceFile: string, functionName?: string): TaskRecord | undefined {
    const store = this.readTasks();
    const key = functionName ? `${sourceFile}:${functionName}` : sourceFile;
    return store.tasks.find(t => t.key === key);
  }

  upsertTask(record: TaskRecord): void {
    const store = this.readTasks();
    const idx = store.tasks.findIndex(t => t.key === record.key);
    if (idx >= 0) {
      store.tasks[idx] = record;
    } else {
      store.tasks.push(record);
    }
    this.writeTasks(store);
  }

  deleteTask(key: string): boolean {
    const store = this.readTasks();
    const idx = store.tasks.findIndex(t => t.key === key);
    if (idx < 0) return false;
    store.tasks.splice(idx, 1);
    this.writeTasks(store);
    return true;
  }

  // ── Flow ──

  readFlows(): FlowStore {
    if (!existsSync(this.flowPath)) {
      return { version: 1, updatedAt: new Date().toISOString(), flows: [] };
    }
    return JSON.parse(readFileSync(this.flowPath, 'utf-8'));
  }

  writeFlows(store: FlowStore): void {
    store.updatedAt = new Date().toISOString();
    writeFileSync(this.flowPath, JSON.stringify(store, null, 2) + '\n');
  }

  findFlow(name: string): FlowChain | undefined {
    return this.readFlows().flows.find(f => f.name === name);
  }

  upsertFlow(flow: FlowChain): void {
    const store = this.readFlows();
    const idx = store.flows.findIndex(f => f.name === flow.name);
    if (idx >= 0) {
      store.flows[idx] = flow;
    } else {
      store.flows.push(flow);
    }
    this.writeFlows(store);
  }

  // ── Conversion helpers ──

  /** TaskAnnotation → TaskRecord */
  static fromAnnotation(ann: TaskAnnotation): TaskRecord {
    const key = ann.functionName
      ? `${ann.sourceFile}:${ann.functionName}`
      : ann.sourceFile;
    return {
      key,
      task: ann.task,
      checklist: ann.checklist,
      title: ann.title,
      type: ann.type,
      priority: ann.priority,
      version: ann.version,
      scope: ann.scope,
      depends: ann.depends,
      author: ann.author,
      date: ann.date,
      description: ann.description,
      changes: ann.changes,
      affected: ann.affected,
      sourceFile: ann.sourceFile,
      sourceLine: ann.sourceLine,
      functionName: ann.functionName,
      functionSignature: ann.functionSignature,
      test: ann.test,
      ...(ann.flow ? {
        flow: {
          name: ann.flow,
          step: ann.step!,
          input: ann.input,
          output: ann.output,
          next: ann.next,
        },
      } : {}),
    };
  }

  /** TaskRecord → TaskAnnotation (for backwards compat) */
  static toAnnotation(record: TaskRecord): TaskAnnotation {
    return {
      task: record.task,
      checklist: record.checklist,
      title: record.title,
      type: record.type,
      priority: record.priority,
      version: record.version,
      scope: record.scope,
      depends: record.depends,
      author: record.author,
      date: record.date,
      description: record.description,
      changes: record.changes,
      affected: record.affected,
      sourceFile: record.sourceFile,
      sourceLine: record.sourceLine,
      functionName: record.functionName,
      functionSignature: record.functionSignature,
      test: record.test,
      flow: record.flow?.name,
      step: record.flow?.step,
      input: record.flow?.input,
      output: record.flow?.output,
      next: record.flow?.next,
    };
  }
}
