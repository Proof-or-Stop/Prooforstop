
import type { HandlerContext } from './context.js';
import { collectContext } from './context.js';
import { createStoryActor } from '../core/machine.js';
import { loadConfig } from '../core/config.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { renderAntiStall, reviewAntiStall, waitingAntiStall } from '../core/anti-stall.js';

/**
 * Collect intentRef values from fixture files under fixturesDir, scoped by storyId.
 *
 * B-c745: intentRef used to be a flat string like "CHK-001:happy:0" which
 * collided across stories when the same CHK id appeared in different stories.
 * The scoped format is "<storyId>:CHK-NNN:lane:idx" (e.g. "B-c745:CHK-001:happy:0").
 *
 * This function returns the set of *unscoped* refs that belong to `storyId`:
 *   - "<storyId>:CHK-NNN:lane:idx" in fixtures → "CHK-NNN:lane:idx" in returned set
 *   - Bare "CHK-NNN:lane:idx" (legacy, no story prefix) → treated as belonging
 *     to whichever story owns the fixture file (detected via case.storyId), or
 *     if case.storyId is absent, IGNORED (no cross-story leakage).
 *
 * This means legacy fixtures that predate storyId scoping CANNOT keep new
 * stories passing by accident — they have to be explicitly re-tagged.
 */
function collectIntentRefs(fixturesDir: string, storyId: string): Set<string> {
  const refs = new Set<string>();
  if (!existsSync(fixturesDir)) return refs;
  const scopedPrefix = `${storyId}:`;
  const scanDir = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { scanDir(join(dir, entry.name)); continue; }
      if (!entry.name.endsWith('.json')) continue;
      try {
        const content = JSON.parse(readFileSync(join(dir, entry.name), 'utf-8'));
        for (const c of content.cases || []) {
          if (!c.intentRef || typeof c.intentRef !== 'string') continue;
          const ref = c.intentRef as string;
          if (ref.startsWith(scopedPrefix)) {
            // Scoped form: "<storyId>:CHK-xxx:lane:idx" → store the CHK suffix.
            refs.add(ref.slice(scopedPrefix.length));
          } else if (c.storyId === storyId && /^CHK-\d+:(happy|edge|adversarial):\d+$/.test(ref)) {
            // Legacy unscoped form on a case that explicitly claims storyId.
            refs.add(ref);
          }
          // Anything else (bare unscoped + no case.storyId) is dropped.
        }
      } catch { /* ignore */ }
    }
  };
  scanDir(fixturesDir);
  return refs;
}

export function createChecklistHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    checklist_get(args: { storyId: string }) {
      return store.readChecklist(args.storyId);
    },

    checklist_add(args: {
      storyId: string;
      title: string;
      context?: string;
      relatedDocs?: string[];
      phase?: 'DEV' | 'TEST_CASE';
    }): string {
      if (!args.title) throw new Error('title is required');

      // 验证 story 存在
      store.readStory(args.storyId);

      const cl = store.readChecklist(args.storyId);

      // 从已有 item 中找最大 CHK 编号，分配下一个
      let maxNum = 0;
      for (const item of cl.items) {
        const m = item.id.match(/^CHK-(\d+)$/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxNum) maxNum = n;
        }
      }
      const nextId = `CHK-${String(maxNum + 1).padStart(3, '0')}`;

      cl.items.push({
        id: nextId,
        title: args.title,
        context: args.context,
        ...(args.relatedDocs !== undefined ? { relatedDocs: args.relatedDocs } : {}),
        ...(args.phase !== undefined ? { phase: args.phase } : {}),
        status: 'pending',
        startTime: null,
        endTime: null,
      });

      store.writeChecklist(args.storyId, cl);
      return `Checklist item ${nextId} added to ${args.storyId}`;
    },

    checklist_update(args: {
      storyId: string;
      itemId: string;
      status?: 'pending' | 'in_progress' | 'done';
      title?: string;
      context?: string;
      relatedDocs?: string[];
      phase?: 'DEV' | 'TEST_CASE';
      testIntent?: { happy: Array<string | { desc: string; type: string }>; edge: Array<string | { desc: string; type: string }>; adversarial: Array<string | { desc: string; type: string }> };
      reason?: string;
      agent?: string;
    }): string {
      if (!args.status && args.testIntent === undefined && args.title === undefined && args.context === undefined && args.relatedDocs === undefined && args.phase === undefined) {
        throw new Error('At least one of status/testIntent/title/context/relatedDocs/phase must be provided');
      }

      const cl = store.readChecklist(args.storyId);
      const item = cl.items.find(i => i.id === args.itemId);
      if (!item) throw new Error(`Checklist item ${args.itemId} not found`);

      const results: string[] = [];
      const now = new Date().toISOString();
      const oldStatus = item.status;

      if (args.title !== undefined) {
        (item as any).title = args.title;
        results.push(`title updated`);
      }
      if (args.context !== undefined) {
        (item as any).context = args.context;
        results.push(`context updated`);
      }
      if (args.relatedDocs !== undefined) {
        (item as any).relatedDocs = args.relatedDocs;
        results.push(`relatedDocs updated (${args.relatedDocs.length})`);
      }
      if (args.phase !== undefined) {
        (item as any).phase = args.phase;
        results.push(`phase set to ${args.phase}`);
      }

      if (args.testIntent !== undefined) {
        if (args.testIntent === null) {
          // testIntent: null → 标记为不可自动化测试（文档类/配置类 item）
          (item as any).testIntent = null;
          results.push('testIntent set to null (not auto-testable)');
        } else {
          const { happy = [], edge = [], adversarial = [] } = args.testIntent;
          if (happy.length === 0) {
            throw new Error('testIntent.happy is required (at least one entry)');
          }
          (item as any).testIntent = { happy, edge, adversarial };
          results.push(`testIntent updated (${happy.length}h/${edge.length}e/${adversarial.length}a)`);
        }
      }

      if (args.status) {
        // 标 done 时检查 testIntent 覆盖率
        if (args.status === 'done' && (item as any).testIntent) {
          const intent = (item as any).testIntent as { happy: Array<string | { desc: string }>; edge: Array<string | { desc: string }>; adversarial: Array<string | { desc: string }> };
          const config = loadConfig(ctx.root);
          const fixturesDir = join(ctx.root, config.fixturesDir);
          const allRefs = collectIntentRefs(fixturesDir, args.storyId);

          const uncovered: string[] = [];
          for (const lane of ['happy', 'edge', 'adversarial'] as const) {
            const entries = intent[lane] || [];
            for (let i = 0; i < entries.length; i++) {
              const ref = `${args.itemId}:${lane}:${i}`;
              if (!allRefs.has(ref)) {
                const label = typeof entries[i] === 'string' ? entries[i] : (entries[i] as { desc: string }).desc;
                uncovered.push(`${ref} → ${label}`);
              }
            }
          }

          if (uncovered.length > 0) {
            const total = intent.happy.length + intent.edge.length + intent.adversarial.length;
            const covered = total - uncovered.length;
            throw new Error(
              `Cannot mark ${args.itemId} as done: ${uncovered.length}/${total} testIntent 未覆盖\n` +
              uncovered.map(u => `  - ${u}`).join('\n') +
              `\n\n→ 给 fixture case 添加 intentRef 字段（如 "intentRef": "${args.itemId}:happy:0"）`
            );
          }
        }

        item.status = args.status;
        if (args.status === 'in_progress' && !item.startTime) {
          item.startTime = now;
        }
        if (args.status === 'done') {
          item.endTime = now;
        }

        // 修改操作写审计日志（新建 pending→pending 不算修改）
        if (oldStatus !== args.status && args.reason) {
          const story = store.readStory(args.storyId);
          if (!cl.auditLog) cl.auditLog = [];
          cl.auditLog.push({
            timestamp: now,
            phase: story.phase,
            itemId: args.itemId,
            action: 'update',
            from: oldStatus,
            to: args.status,
            reason: args.reason,
            ...(args.agent ? { agent: args.agent } : {}),
          });
        }
        results.push(`status → ${args.status}`);
      }

      store.writeChecklist(args.storyId, cl);

      // CHK-003: pending/in_progress → done 且 item 有 relatedDocs 时，hint 关联文档清单
      const docs = (item as any).relatedDocs as string[] | undefined;
      const transitionedToDone = args.status === 'done' && oldStatus !== 'done';
      if (transitionedToDone && Array.isArray(docs) && docs.length > 0) {
        const lines = docs.map(d => `  - ${d}`).join('\n');
        return `Checklist ${args.itemId}: ${results.join(', ')}\n\n📄 关联文档（请检查代码改动是否影响这些文档，趁记忆热及时同步）：\n${lines}`;
      }

      return `Checklist ${args.itemId}: ${results.join(', ')}`;
    },

    testintent_record(args: {
      storyId: string;
      itemId: string;
      lane: 'happy' | 'edge' | 'adversarial';
      index: number;
      pass?: boolean;
      note: string;
      agent?: string;
    }): string {
      const cl = store.readChecklist(args.storyId);
      const item = cl.items.find(i => i.id === args.itemId);
      if (!item) throw new Error(`Checklist item ${args.itemId} not found`);
      if (!item.testIntent) throw new Error(`${args.itemId} has no testIntent`);

      const lane = item.testIntent[args.lane];
      if (!lane || args.index < 0 || args.index >= lane.length) {
        throw new Error(`Invalid ${args.lane}[${args.index}]: out of range (length=${lane?.length ?? 0})`);
      }

      const entry = lane[args.index];
      if (typeof entry === 'string') {
        throw new Error(`${args.itemId}:${args.lane}:${args.index} is still a string — migrate to {desc,type} first`);
      }

      // 5 轮 cap（segment-aware）：从末尾倒着数 reviewer/author 条目，遇到 human-resume 就停。
      // 当前段 ≥ 5 时拒绝再写，强制人类裁决。OMX ralplan 同款。
      const SEGMENT_CAP = 5;
      const currentSegmentRounds = (() => {
        const results = (entry as any).results || [];
        let count = 0;
        for (let i = results.length - 1; i >= 0; i--) {
          const r = results[i];
          if (r.role === 'human-resume') break;
          if (r.role === 'reviewer' || r.role === 'author') count++;
        }
        return count;
      })();
      if (currentSegmentRounds >= SEGMENT_CAP) {
        throw new Error(
          `已达 ${SEGMENT_CAP} 轮 cap（当前段，不计前面段的轮数）。\n` +
          `reviewer 与主 agent 对 ${args.itemId}:${args.lane}:${args.index} 有根本分歧。\n\n` +
          `可选项:\n` +
          `  (a) 修改 testIntent 描述本身（重新审视需求）\n` +
          `  (b) 修改 checklist item 拆解（item 可能拆得不对）\n` +
          `  (c) 调用 koala testintent_resume 让人类介入开新段:\n` +
          `      koala testintent_resume '{"storyId":"${args.storyId}","itemId":"${args.itemId}","lane":"${args.lane}","index":${args.index},"reason":"<人类裁决理由>"}'\n\n` +
          `注意 testintent_resume 只能由人类在场时执行（CLI 会要求 --human flag）。`
        );
      }

      // 从 agent 字段自动推断 role
      const AGENT_ROLE_MAP: Record<string, 'reviewer' | 'author' | 'intent'> = {
        'test-case-reviewer': 'reviewer',
        'test-intent': 'intent',
      };
      const role = (args.agent && AGENT_ROLE_MAP[args.agent]) || 'author';

      const record = {
        time: new Date().toISOString(),
        pass: args.pass,
        note: args.note,
        role,
      };

      if (!entry.results) entry.results = [];
      entry.results.push(record);

      store.writeChecklist(args.storyId, cl);
      const passLabel = args.pass === undefined ? 'response' : `pass=${args.pass}`;
      const remaining = SEGMENT_CAP - currentSegmentRounds - 1;
      const capHint = remaining <= 1 ? ` ⚠ 当前段还剩 ${remaining} 轮就触发 cap` : '';
      return `${args.itemId}:${args.lane}:${args.index} result recorded (${passLabel})${capHint}`;
    },

    testintent_resume(args: {
      storyId: string;
      itemId: string;
      lane: 'happy' | 'edge' | 'adversarial';
      index: number;
      reason: string;
      human?: boolean;
    }): string {
      // 人类介入：写一条 role:human-resume 记录，开新段，cap 计数器从 0 重置。
      // 必须带 human:true 防止主 agent 自动绕过 cap。
      if (args.human !== true) {
        throw new Error(
          `testintent_resume 必须由人类执行，需要传 human:true。\n` +
          `如果你是主 agent 在跑——这正是 cap 在保护你：先停下来等人类裁决。`
        );
      }
      if (!args.reason || args.reason.trim().length < 5) {
        throw new Error(`testintent_resume 必须给出 reason（人类裁决理由），至少 5 个字符`);
      }

      const cl = store.readChecklist(args.storyId);
      const item = cl.items.find(i => i.id === args.itemId);
      if (!item) throw new Error(`Checklist item ${args.itemId} not found`);
      if (!item.testIntent) throw new Error(`${args.itemId} has no testIntent`);
      const lane = item.testIntent[args.lane];
      if (!lane || args.index < 0 || args.index >= lane.length) {
        throw new Error(`Invalid ${args.lane}[${args.index}]: out of range`);
      }
      const entry = lane[args.index];
      if (typeof entry === 'string') {
        throw new Error(`${args.itemId}:${args.lane}:${args.index} is still a string`);
      }

      const record = {
        time: new Date().toISOString(),
        role: 'human-resume' as const,
        note: args.reason,
      };
      if (!(entry as any).results) (entry as any).results = [];
      (entry as any).results.push(record);
      store.writeChecklist(args.storyId, cl);
      return `${args.itemId}:${args.lane}:${args.index} resumed by human. cap 计数器已重置为 0，可继续 testintent_record。`;
    },

    testintent_check(args: { storyId: string }): object {
      const cl = store.readChecklist(args.storyId);
      const results: Array<{ ref: string; desc: string; pass: boolean | null; note?: string }> = [];
      let allPass = true;
      let hasUnreviewed = false;

      for (const item of cl.items) {
        if (!item.testIntent) continue;
        for (const lane of ['happy', 'edge', 'adversarial'] as const) {
          const entries = item.testIntent[lane] || [];
          for (let i = 0; i < entries.length; i++) {
            const ref = `${item.id}:${lane}:${i}`;
            const entry = entries[i];

            if (typeof entry === 'string') {
              // 旧格式无法有 results
              results.push({ ref, desc: entry, pass: null, note: '旧格式字符串，需迁移' });
              hasUnreviewed = true;
              allPass = false;
              continue;
            }

            // 找最后一条 reviewer 的判定记录（跳过 author/intent 的回复）
            const lastJudgment = entry.results
              ? [...entry.results].reverse().find(r => r.role === 'reviewer' && r.pass !== undefined)
              : undefined;

            if (!lastJudgment) {
              results.push({ ref, desc: entry.desc, pass: null });
              hasUnreviewed = true;
              allPass = false;
            } else {
              results.push({ ref, desc: entry.desc, pass: lastJudgment.pass ?? null, note: lastJudgment.note });
              if (!lastJudgment.pass) allPass = false;
            }
          }
        }
      }

      const passed = results.filter(r => r.pass === true).length;
      const failed = results.filter(r => r.pass === false).length;
      const unreviewed = results.filter(r => r.pass === null).length;

      const isAllPass = allPass && !hasUnreviewed;
      let hint: string;
      let autoAdvanced = false;
      if (isAllPass) {
        // 自动推进到 TEST
        try {
          const story = store.readStory(args.storyId);
          if (story.phase === 'TEST_CASE_REVIEW') {
            const actor = createStoryActor(args.storyId, store, story.phase);
            actor.start();
            actor.send({ type: 'REVIEW' } as any);
            actor.stop();
            story.phase = 'TEST' as any;
            const evt = collectContext('TEST' as any, 'advance');
            evt.agent = 'gate-auto';
            if (!story.events) story.events = [];
            story.events.push(evt);
            store.writeStory(args.storyId, story);
            autoAdvanced = true;
          }
        } catch { /* 推进失败不阻塞返回 */ }
        hint = autoAdvanced
          ? `→ 全部通过，已自动推进到 TEST。请立即执行: test_story('${args.storyId}')`
          : `→ 全部通过，可推进: story_advance('${args.storyId}', 'TEST')`;
      } else if (hasUnreviewed) {
        hint = `→ 有 ${unreviewed} 条未审核，请继续审核后再检查\n${waitingAntiStall(args.storyId)}`;
      } else {
        // 有 author 回复但 reviewer 还没最终判定的，提示 reviewer 再审
        const hasAuthorReply = results.some(r => {
          const item = cl.items.find(i => r.ref.startsWith(i.id));
          if (!item?.testIntent) return false;
          const [, lane, idx] = r.ref.match(/:(happy|edge|adversarial):(\d+)$/) || [];
          if (!lane) return false;
          const entry = (item.testIntent as any)[lane]?.[Number(idx)];
          if (!entry?.results) return false;
          const last = entry.results[entry.results.length - 1];
          return last?.role === 'author';
        });
        if (hasAuthorReply) {
          hint = `→ 有 author 回复待 reviewer 最终判定，请重新启动 reviewer 审核\n${reviewAntiStall(args.storyId)}`;
        } else {
          hint = `→ ${failed} 条未通过。\n${renderAntiStall({
            storyId: args.storyId,
            title: '⚠ anti-stall: 当前不是“继续解释”的时机',
            retry: `重新运行 reviewer / testintent_check '${args.storyId}'，先确认是不是旧状态或临时失败`,
            fix: `story_advance '${args.storyId}' 到 DEV 回退改代码，或到 TEST_CASE 回退改 fixture`,
          })}`;
        }
      }

      return {
        storyId: args.storyId,
        allPass: isAllPass,
        summary: { total: results.length, passed, failed, unreviewed },
        failures: results.filter(r => r.pass !== true),
        hint,
      };
    },
  };
}
