/**
 * B-4f46 CHK-003: signature-registry CLI surface (Experience Layer Phase 1b).
 *
 * Minimal read/list + mutate commands over the audit-only signature-registry
 * (`.lattice/learning/signature-registry.json`). This catalog is AUDIT-ONLY: no
 * gate reads it; it only folds finding `signatureTag`s into canonical families so
 * the Phase-1a finding-signals become more meaningful over time.
 *
 * The registry file lives under `.lattice/learning/`, which is materialHash-
 * EXCLUDED (the `experience-layer-learning-cache` runtime-artifact-registry
 * entry covers the prefix), so writes never make evidence stale.
 */

import type { HandlerContext } from './context.js';
import {
  aliasSignatureTag,
  approveSignatureTag,
  deprecateSignatureTag,
  listSignatureTags,
  proposeSignatureTag,
  resolveTag,
  type SignatureTagEntry,
} from '../core/learning-store.js';

const SIGNATURE_REGISTRY_ACTIONS = ['propose', 'approve', 'alias', 'deprecate'] as const;
type SignatureRegistryAction = typeof SIGNATURE_REGISTRY_ACTIONS[number];

function formatEntry(t: SignatureTagEntry): string {
  const aliases = t.aliases.length > 0 ? ` aliases=[${t.aliases.join(', ')}]` : '';
  const merged = t.mergedInto ? ` mergedInto=${t.mergedInto}` : '';
  return `  - ${t.tag} [${t.status}]${aliases}${merged} (createdBy=${t.createdBy}, approvedBy=${t.approvedBy ?? 'none'})`;
}

export function createSignatureRegistryHandlers(ctx: HandlerContext) {
  return {
    /** List all registered signature tags + statuses. storyId is optional (audit-only; not story-scoped). */
    signature_registry_list(args: { storyId?: string } = {}): string {
      void args;
      const tags = listSignatureTags(ctx.root);
      if (tags.length === 0) {
        return 'signature-registry: no tags registered yet.';
      }
      const sorted = [...tags].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
      return `signature-registry (${sorted.length} tag(s)):\n${sorted.map(formatEntry).join('\n')}`;
    },

    /**
     * Mutate the signature-registry. action=approve flips proposed->active
     * (active requires this explicit approve). Audit-only; never read by any gate.
     */
    signature_registry_set(args: {
      tag: string;
      action: string;
      alias?: string;
      mergedInto?: string;
      by?: string;
      storyId?: string;
    }): string {
      const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
      if (!tag) throw new Error('signature_registry_set: tag must be a non-empty string');
      const action = args.action as SignatureRegistryAction;
      if (!(SIGNATURE_REGISTRY_ACTIONS as readonly string[]).includes(action)) {
        throw new Error(`signature_registry_set: action must be one of ${SIGNATURE_REGISTRY_ACTIONS.join('|')}`);
      }
      const by = (args.by || process.env.LATTICE_AGENT || 'main').trim() || 'main';

      let entry: SignatureTagEntry;
      switch (action) {
        case 'propose':
          entry = proposeSignatureTag(ctx.root, tag, by);
          break;
        case 'approve':
          entry = approveSignatureTag(ctx.root, tag, by);
          break;
        case 'alias': {
          const alias = typeof args.alias === 'string' ? args.alias.trim() : '';
          if (!alias) throw new Error('signature_registry_set: action=alias requires --alias');
          entry = aliasSignatureTag(ctx.root, tag, alias, by);
          break;
        }
        case 'deprecate':
          entry = deprecateSignatureTag(ctx.root, tag, args.mergedInto, by);
          break;
        default:
          throw new Error(`signature_registry_set: unsupported action ${String(action)}`);
      }

      const canonical = resolveTag(ctx.root, tag);
      const foldHint = canonical !== entry.tag ? ` → folds to "${canonical}"` : '';
      return `signature-registry: ${action} "${tag}" => [${entry.status}]${foldHint}\n${formatEntry(entry)}`;
    },
  };
}
