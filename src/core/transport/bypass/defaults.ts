import type { BypassFeatureFlags } from './types';

export const defaultBypassFlags: BypassFeatureFlags = {
  enabled: false,
  domainFronting: false,
  dnsTunnel: false,
  webRTC: false,
  publicServices: false,
  retryCount: 3,
  retryDelayMs: 5000,
};

export function mergeBypassDefaults(patch?: Partial<BypassFeatureFlags>): BypassFeatureFlags {
  return { ...defaultBypassFlags, ...patch };
}
