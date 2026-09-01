/**
 * Заготовка под Mail.ru Cloud API (OAuth2 + загрузка файлов).
 * Реальные endpoint'ы и OAuth-флоу зависят от продукта; при отсутствии валидного токена операции no-op.
 */
import type { KeyPairBytes } from '../../crypto/keyManager';
import { log } from '../../logger';
import { EncryptedWhitelistTransport } from './EncryptedWhitelistTransport';

export type MailRuConfig = {
  token: string;
  /** Базовый путь для объектов */
  basePath?: string;
};

/**
 * Минимальная заглушка: при успешном ответе API возвращает true.
 * Для продакшена нужен полный OAuth и актуальные пути cloud.mail.ru.
 */
export class MailRuTransport extends EncryptedWhitelistTransport {
  private readonly config: MailRuConfig;

  constructor(pair: KeyPairBytes, config: MailRuConfig) {
    super(pair);
    this.config = config;
  }

  protected async sendRaw(encryptedData: string, _recipientId: string): Promise<boolean> {
    if (!this.config.token.trim()) {
      log.warn('mailru_no_token', {});
      return false;
    }
    try {
      log.info('mailru_stub_send', { len: encryptedData.length });
      return false;
    } catch (e) {
      log.warn('mailru_send_failed', { err: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  protected async receiveRaw(): Promise<{ data: string; fromId: string } | null> {
    log.info('mailru_stub_receive', {});
    return null;
  }
}
