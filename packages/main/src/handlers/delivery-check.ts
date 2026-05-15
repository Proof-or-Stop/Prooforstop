/**
 * Delivery Check handler — koala delivery_check_set
 *
 * TEST → DONE 硬门槛产物 delivery-check.json 的签名工具函数。
 *
 * 由 koala-review-delivery reviewer 在 TEST 末尾 spawn 时调用，
 * 逆向扫 git diff 列 docsPromises + 真机 transcript + 闭合自检，
 * 写签名 JSON 作为 DONE 的第三把钥匙（前两把：test-evidence PASS + bug 全 fixed）。
 *
 * 签名域：storyId + JSON.stringify(docsPromises) + JSON.stringify(realMachineTests)
 *          + JSON.stringify(closingSelfCheck) + reviewRound + salt
 *
 * waiverReason (≥ 30 字符) 入 realMachineTests 的 JSON.stringify，自动纳入签名。
 */

import type { HandlerContext } from './context.js';
import type { DeliveryCheckData, DocsPromise, RealMachineTest, ClosingSelfCheck } from '../core/types.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import {
  DELIVERY_CHECK_SALT,
  signDeliveryCheck,
  recomputeDeliveryCheckHash,
} from '../core/delivery-check-hash.js';

// Signature primitives live in core/delivery-check-hash.ts (single source of
// truth) so core consumers can verify the hash without a core→handlers import.
// Re-exported here for existing callers that import from this handler module.
export { DELIVERY_CHECK_SALT, signDeliveryCheck, recomputeDeliveryCheckHash };

/**
 * delivery_check_set handler 工厂。
 *
 * 由 koala-review-delivery subagent 调用，写入 delivery-check.json。
 * 校验逻辑：
 * - waiverReason 非空时必须 ≥ 30 字符（入 _hash 防事后篡改）
 * - closingSelfCheck.summary ≥ 10 字符
 */
export function createDeliveryCheckHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;
  return {
    delivery_waiver_add(args: {
      storyId: string;
      promiseId: string;
      waiverReason: string;
    }): string {
      // 1) waiverReason 长度校验
      if (!args.waiverReason || args.waiverReason.trim().length < 30) {
        throw new Error('waiverReason must be at least 30 characters');
      }

      // 2) 读取现有 delivery-check.json
      const data = store.readDeliveryCheck(args.storyId);
      if (!data) {
        throw new Error('delivery-check.json not found, run delivery reviewer first');
      }

      // 3) 找到 matching promise by docPath
      const promise = data.docsPromises.find(p => p.docPath === args.promiseId);
      if (!promise) {
        throw new Error(`promiseId "${args.promiseId}" not found in docsPromises`);
      }

      // 3.5) 验证现有 _hash 合法（防止在已篡改的文件上追加 waiver 洗白签名）
      const currentExpected = signDeliveryCheck(
        data.storyId,
        data.docsPromises,
        data.realMachineTests,
        data.closingSelfCheck,
        data.reviewRound,
      );
      if (data._hash !== currentExpected) {
        throw new Error('delivery-check.json _hash 已失效（文件可能被篡改），请重跑 koala-review-delivery reviewer');
      }

      // 4) 设置 waiverReason
      promise.waiverReason = args.waiverReason.trim();
      promise.status = 'waived';

      // 5) 重新签名（docsPromises 含 waiverReason 后 hash 变化）
      data._hash = signDeliveryCheck(
        data.storyId,
        data.docsPromises,
        data.realMachineTests,
        data.closingSelfCheck,
        data.reviewRound,
      );

      // 6) 写回
      store.writeDeliveryCheck(args.storyId, data);

      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'delivery_waiver_add');
      return `Waiver added for "${args.promiseId}" in ${args.storyId}: "${args.waiverReason.trim().slice(0, 50)}..."${commitHint}`;
    },

    delivery_check_set(args: {
      storyId: string;
      docsPromises: DocsPromise[];
      realMachineTests: RealMachineTest[];
      closingSelfCheck: ClosingSelfCheck;
      agentId?: string;
    }): string {
      // 1) story 存在性校验
      let reviewRound = '';
      try {
        const story = store.readStory(args.storyId);
        reviewRound = story.currentReviewRound || '';
      } catch {
        throw new Error(`Story ${args.storyId} not found`);
      }

      // 2) runtime 校验
      const docsPromises = Array.isArray(args.docsPromises) ? args.docsPromises.map(p => ({ ...p })) : [];
      const realMachineTests = Array.isArray(args.realMachineTests) ? args.realMachineTests : [];
      const closingSelfCheck = args.closingSelfCheck;

      if (!closingSelfCheck || typeof closingSelfCheck.summary !== 'string' || closingSelfCheck.summary.trim().length < 10) {
        throw new Error('delivery_check_set: closingSelfCheck.summary 必须 ≥ 10 字符');
      }

      for (const promise of docsPromises) {
        if (promise.status === 'met' || promise.status === 'verified') {
          promise.verifiedBy = promise.verifiedBy || `status:${promise.status}`;
        } else if (promise.status === 'waived') {
          if (!promise.waiverReason || promise.waiverReason.trim().length < 30) {
            throw new Error(
              `delivery_check_set: docsPromises status=waived 时 waiverReason 必须 ≥ 30 字符（docPath: ${promise.docPath}）`,
            );
          }
        }
      }

      // waiverReason 校验：非空时必须 ≥ 30 字符
      for (const test of realMachineTests) {
        if (test.waiverReason && test.waiverReason.trim().length < 30) {
          throw new Error(
            `delivery_check_set: waiverReason 非空时必须 ≥ 30 字符（featureId: ${test.featureId}）`,
          );
        }
      }

      // 3) 计算签名
      const _hash = signDeliveryCheck(
        args.storyId,
        docsPromises,
        realMachineTests,
        closingSelfCheck,
        reviewRound,
      );

      // 4) 构造 DeliveryCheckData 并落盘
      const data: DeliveryCheckData = {
        storyId: args.storyId,
        checkedAt: new Date().toISOString(),
        reviewRound,
        agentId: args.agentId ?? '',
        docsPromises,
        realMachineTests,
        closingSelfCheck,
        _hash,
      };
      store.writeDeliveryCheck(args.storyId, data);

      // 5) 返回摘要
      const unverified = docsPromises.filter(p => !p.verifiedBy).length;
      const waived = realMachineTests.filter(t => !!t.waiverReason).length;
      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'delivery_check_set');
      return `Delivery check saved for ${args.storyId}: ${docsPromises.length} docsPromises (${unverified} unverified), ${realMachineTests.length} realMachineTests (${waived} waived), selfCheck: ${closingSelfCheck.hasRealMachineTest ? 'hasRealMachine' : 'noRealMachine'}${commitHint}`;
    },
  };
}
