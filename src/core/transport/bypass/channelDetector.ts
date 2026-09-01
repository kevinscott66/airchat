import type { BypassFeatureFlags, BypassChannelInfo, BypassTransportId } from './types';

/**
 * Проверка доступности каналов без лишних сетевых запросов.
 */
export async function detectAvailableBypassChannels(
  _flags: BypassFeatureFlags
): Promise<BypassChannelInfo[]> {
  const ids: BypassTransportId[] = [
    'domain_fronting',
    'dns_tunnel',
    'webrtc',
    'public_services',
  ];

  return ids.map((id) => ({ id, available: false }));
}
