import type { AppConfig } from '../../config';
import type { KeyPairBytes } from '../../crypto/keyManager';
import { EncryptedWhitelistTransport } from './EncryptedWhitelistTransport';
import { YandexDiskTransport } from './YandexDiskTransport';
import { VKTransport } from './VKTransport';
import { MailRuTransport } from './MailRuTransport';

export type WhitelistKind = 'yandex' | 'vk' | 'mailru';

/**
 * Создаёт транспорт, если глобально включён whitelist и включён конкретный сервис с токеном.
 */
export function createWhitelistTransport(
  kind: WhitelistKind,
  pair: KeyPairBytes,
  cfg: AppConfig['whitelist']
): EncryptedWhitelistTransport | null {
  if (!cfg?.enabled) return null;
  const services = cfg.services;
  if (!services) return null;
  switch (kind) {
    case 'yandex': {
      const s = services.yandex;
      if (!s?.enabled || !s.token?.trim()) return null;
      return new YandexDiskTransport(pair, {
        token: s.token.trim(),
        basePath: s.basePath,
        incomingPath: s.incomingPath,
      });
    }
    case 'vk': {
      const s = services.vk;
      if (!s?.enabled || !s.token?.trim()) return null;
      return new VKTransport(pair, {
        token: s.token.trim(),
        peerId: s.peerId,
      });
    }
    case 'mailru': {
      const s = services.mailru;
      if (!s?.enabled || !s.token?.trim()) return null;
      return new MailRuTransport(pair, { token: s.token.trim(), basePath: s.basePath });
    }
    default:
      return null;
  }
}
