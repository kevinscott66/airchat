import type { PublicServicesTokens } from './types';

/**
 * Заглушка мостов через публичные API (VK, Яндекс.Диск, Telegram).
 * Любая интеграция должна соблюдать ToS сервисов и законодательство; токены — только у пользователя.
 */
export class PublicServicesBridge {
  constructor(private readonly _tokens: PublicServicesTokens = {}) {
    void this._tokens;
  }

  async sendViaVK(_data: Uint8Array, _targetVkId: string): Promise<boolean> {
    return false;
  }

  async sendViaYandexDisk(_data: Uint8Array, _targetDid: string): Promise<boolean> {
    return false;
  }

  async sendViaTelegram(_data: Uint8Array, _targetChatId: string): Promise<boolean> {
    return false;
  }

  async checkAvailability(_service: 'vk' | 'yandex' | 'telegram'): Promise<boolean> {
    void _service;
    return false;
  }
}
