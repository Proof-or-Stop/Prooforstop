import type { HandlerContext } from './context.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import {
  loadReviewInventoryAdmitApis,
  loadVerifiedCertificationWindow,
  persistBlockedCertificationWindow,
  persistCancelledCertificationWindow,
  projectCertificationWindowStatus,
  renderCertificationWindowStatus,
  inventoryReceiptAuthorizesPrecert,
  PRE_CERT_INVENTORY_API_ABSENT,
  PRE_CERT_INVENTORY_NOT_AUTHORITY,
  type CertificationWindowStatusProjection,
} from '../core/certification-window.js';

function persistHint(root: string, storyId: string, command: string): string {
  try {
    return autoCommitStoryMetadata(root, storyId, command);
  } catch {
    return '';
  }
}

function render(projection: CertificationWindowStatusProjection, hint = ''): string {
  const text = renderCertificationWindowStatus(projection);
  return hint ? `${text}${hint}` : text;
}

function refuseBlocked(text: string): never {
  throw new Error(text);
}

export function createCertificationWindowHandlers(ctx: HandlerContext) {
  return {
    certification_window_begin(args: { storyId: string }): string {
      const storyId = args.storyId.trim();
      if (!storyId) throw new Error('certification_window_begin: storyId is required');
      const apis = loadReviewInventoryAdmitApis();
      if (!apis) {
        const window = persistBlockedCertificationWindow({
          store: ctx.store,
          storyId,
          blockerCode: PRE_CERT_INVENTORY_API_ABSENT,
          blockerDetail: 'Review inventory admit APIs are absent; begin stays fail-closed and does not stub-always-admit. Inventory completeness is not PRE_CERT.',
        });
        const hint = persistHint(ctx.root, storyId, 'certification_window_begin');
        refuseBlocked(render(projectCertificationWindowStatus(storyId, window, null), hint));
      }
      const inventory = apis.finalizedUnconsumedReviewInventory(ctx.store, storyId);
      const inventoryReceipt = inventory?.receipt ?? null;
      if (!inventory || inventoryReceiptAuthorizesPrecert(inventoryReceipt)) {
        const window = persistBlockedCertificationWindow({
          store: ctx.store,
          storyId,
          blockerCode: PRE_CERT_INVENTORY_NOT_AUTHORITY,
          blockerDetail: 'No FINALIZED unconsumed review inventory lineage is available, or the inventory receipt is completeness-only and cannot authorize PRE_CERT.',
          inventory: inventoryReceipt ? {
            epochId: inventory?.epoch?.epochId,
            receiptId: inventoryReceipt.receiptId,
            authority: inventoryReceipt.authority,
            authorizesTest: inventoryReceipt.authorizesTest,
          } : undefined,
        });
        const hint = persistHint(ctx.root, storyId, 'certification_window_begin');
        refuseBlocked(render(projectCertificationWindowStatus(storyId, window, null), hint));
      }
      const window = persistBlockedCertificationWindow({
        store: ctx.store,
        storyId,
        blockerCode: PRE_CERT_INVENTORY_API_ABSENT,
        blockerDetail: 'Inventory APIs are present but CHK-001 does not admit; PRE_CERT admission belongs to CHK-002.',
      });
      const hint = persistHint(ctx.root, storyId, 'certification_window_begin');
      refuseBlocked(render(projectCertificationWindowStatus(storyId, window, null), hint));
    },

    certification_window_status(args: { storyId: string }): string {
      const storyId = args.storyId.trim();
      if (!storyId) throw new Error('certification_window_status: storyId is required');
      const { window, receipt } = loadVerifiedCertificationWindow(ctx.store, storyId);
      return render(projectCertificationWindowStatus(storyId, window, receipt));
    },

    certification_window_cancel(args: { storyId: string; reason: string }): string {
      const storyId = args.storyId.trim();
      if (!storyId) throw new Error('certification_window_cancel: storyId is required');
      const window = persistCancelledCertificationWindow({
        store: ctx.store,
        storyId,
        reason: args.reason,
      });
      const hint = persistHint(ctx.root, storyId, 'certification_window_cancel');
      return render(projectCertificationWindowStatus(storyId, window, null), hint);
    },
  };
}
