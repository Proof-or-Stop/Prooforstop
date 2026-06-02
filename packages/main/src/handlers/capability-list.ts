import { buildCapabilityList, renderCapabilityListText } from '../core/capabilities.js';

export function createCapabilityListHandlers(): Record<string, (...args: any[]) => any> {
  return {
    capability_list(args: { format?: 'text' | 'json' } = {}) {
      const list = buildCapabilityList();
      if (args.format === 'json') return list;
      return renderCapabilityListText(list);
    },
  };
}
