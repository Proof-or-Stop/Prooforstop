/**
 * @task B-727f
 * @checklist CHK-001
 * @title anti-stall retry/fix/discard guardrail
 * @type feature
 * @priority high
 * @description
 *   把“卡死不推进”显式变成 retry / fix / discard 三选一的反模式护栏。
 *   当 story 卡在 TEST_CASE_REVIEW / TEST / waiting 状态时，系统必须给出
 *   retry、fix、discard 三条出口，而不是让 main agent 无限重复同一个命令。
 * @changes
 *   - [CHK-001] anti-stall helper 统一输出 retry / fix / discard 三路提示，覆盖“卡死不推进是反模式”
 */
export interface AntiStallOptions {
  storyId: string;
  retry?: string;
  fix?: string;
  discard?: string;
  title?: string;
}

function storyDiscardCommand(storyId: string): string {
  return `story_discard '{"storyId":"${storyId}","reason":"<放弃原因>"}'`;
}

export function renderAntiStall(options: AntiStallOptions): string {
  const lines: string[] = [];
  lines.push(options.title || '⚠ anti-stall: 不要卡在当前状态不动');
  if (options.retry) lines.push(`  - retry: ${options.retry}`);
  if (options.fix) lines.push(`  - fix: ${options.fix}`);
  lines.push(`  - discard: ${options.discard || storyDiscardCommand(options.storyId)}`);
  return lines.join('\n');
}

export function reviewAntiStall(storyId: string): string {
  return renderAntiStall({
    storyId,
    title: '⚠ anti-stall: TEST_CASE_REVIEW 卡住时，不要只停在“继续审核”',
    retry: `重新运行 reviewer / testintent_check '${storyId}'，先确认是不是暂时状态`,
    fix: `story_advance '${storyId}' 到 DEV 回退改代码，或到 TEST_CASE 回退改 fixture`,
  });
}

export function testAntiStall(storyId: string, openBugIds: string[] = []): string {
  const fix = openBugIds.length > 0
    ? `先修 ${openBugIds.slice(0, 3).join(', ')}，再跑 test_fixture / test_story 验证`
    : `补 test_story 证据或修掉当前测试阻塞，再继续推进 DONE`;
  return renderAntiStall({
    storyId,
    title: '⚠ anti-stall: TEST 阶段卡住时，不要只重复跑命令',
    retry: `先重新运行 test_story '${storyId}' / test_fixture 确认是不是瞬时失败或旧状态`,
    fix,
  });
}

export function waitingAntiStall(storyId: string): string {
  return renderAntiStall({
    storyId,
    title: '⚠ anti-stall: 当前像是在等待，不要长期悬空',
    retry: `重新运行 session_brief / testintent_check 看状态是否已经变化`,
    fix: `如果状态没变化，就回到 DEV 或 TEST_CASE 修掉真正的阻塞点`,
  });
}
