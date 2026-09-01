/**
 * EDUCATIONAL MODULE: Public API Integration Study
 *
 * Демонстрирует обращение к официальным HTTP API (VK, Telegram Bot API).
 * Токены не логируются. Без валидных токенов запросы не выполняются.
 */

import { log } from '../../logger';

export type PublicServiceStudyConfig = {
  vkToken?: string;
  telegramBotToken?: string;
  yandexToken?: string;
  enabled: boolean;
};

export class PublicAPIIntegration {
  private readonly config: PublicServiceStudyConfig;

  constructor(config?: Partial<PublicServiceStudyConfig>) {
    this.config = {
      enabled: false,
      ...config,
    };
  }

  /** Проверка `users.get` при наличии токена (официальный метод VK API). */
  async demonstrateVKAPI(): Promise<boolean> {
    if (!this.config.enabled || !this.config.vkToken) {
      log.info('educational_vk_api_disabled');
      return false;
    }

    log.info('educational_vk_api_demo_start');

    try {
      const response = await fetch('https://api.vk.com/method/users.get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          access_token: this.config.vkToken,
          v: '5.131',
        }),
      });

      const result = (await response.json()) as { error?: unknown };
      log.info('educational_vk_api_demo_done', { hasError: Boolean(result.error) });

      return !result.error;
    } catch (error) {
      log.warn('educational_vk_api_demo_failed', {
        err: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** `getMe` для бота — не требует chatId; параметр зарезервирован для будущих демо. */
  async demonstrateTelegramAPI(_chatId: string): Promise<boolean> {
    void _chatId;
    if (!this.config.enabled || !this.config.telegramBotToken) {
      log.info('educational_telegram_api_disabled');
      return false;
    }

    log.info('educational_telegram_api_demo_start');

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${encodeURIComponent(this.config.telegramBotToken)}/getMe`
      );
      const result = (await response.json()) as { ok?: boolean };
      log.info('educational_telegram_api_demo_done', { ok: result.ok === true });

      return result.ok === true;
    } catch (error) {
      log.warn('educational_telegram_api_demo_failed', {
        err: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async explainPublicAPIs(): Promise<string> {
    return `
Публичные API (VK, Telegram, Яндекс и др.) — официальные интерфейсы для интеграций.
Типичный порядок: зарегистрировать приложение/бота, получить токен, соблюдать ToS и лимиты.

Этот модуль вызывает только документированные методы и не отправляет произвольный пользовательский контент без вашего отдельного кода.
    `.trim();
  }
}
