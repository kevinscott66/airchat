/**
 * Конфигурация альтернативных каналов доставки.
 * По умолчанию всё выключено.
 */
export type BypassFeatureFlags = {
  enabled: boolean;
  domainFronting: boolean;
  dnsTunnel: boolean;
  webRTC: boolean;
  publicServices: boolean;
  retryCount: number;
  retryDelayMs: number;
};

export type PublicServicesTokens = {
  vkToken?: string;
  yandexToken?: string;
  telegramBotToken?: string;
};

export type BypassTransportId =
  | 'domain_fronting'
  | 'dns_tunnel'
  | 'webrtc'
  | 'public_services';

export type BypassChannelInfo = {
  id: BypassTransportId;
  available: boolean;
};
