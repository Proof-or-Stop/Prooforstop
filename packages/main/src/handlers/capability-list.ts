import {
  buildCapabilityList,
  buildCapabilityProbe,
  renderCapabilityListText,
  renderCapabilityProbeText,
} from '../core/capabilities.js';

export function createCapabilityListHandlers(): Record<string, (...args: any[]) => any> {
  return {
    capability_list(args: { format?: 'text' | 'json' } = {}) {
      const list = buildCapabilityList();
      if (args.format === 'json') return list;
      return renderCapabilityListText(list);
    },
    capability_probe(args: { host: string; format?: 'text' | 'json' }) {
      const probe = buildCapabilityProbe(args.host);
      if (args.format === 'json') return probe;
      return renderCapabilityProbeText(probe);
    },
  };
}
