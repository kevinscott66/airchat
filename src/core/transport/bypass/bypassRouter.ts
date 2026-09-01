import type { BypassFeatureFlags } from './types';
import { mergeBypassDefaults } from './defaults';
import { detectAvailableBypassChannels } from './channelDetector';

export type BypassRouterOptions = Partial<BypassFeatureFlags>;

export class BypassRouter {
  private readonly flags: BypassFeatureFlags;

  constructor(flags?: BypassRouterOptions) {
    this.flags = mergeBypassDefaults(flags);
  }

  getFlags(): BypassFeatureFlags {
    return this.flags;
  }

  async send(_data: Uint8Array, _targetDid: string): Promise<boolean> {
    if (!this.flags.enabled) return false;
    return false;
  }

  async listChannels() {
    return detectAvailableBypassChannels(this.flags);
  }
}

export function createBypassRouterFromFlags(flags?: BypassRouterOptions): BypassRouter {
  return new BypassRouter(flags);
}
