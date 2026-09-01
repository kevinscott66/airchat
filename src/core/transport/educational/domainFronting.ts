/**
 * EDUCATIONAL MODULE: Domain Fronting / CDN Study
 *
 * Демонстрирует принципы работы HTTP/HTTPS и того, как запросы к публичным
 * хостам проходят через сеть. Не является реализацией «domain fronting» в смысле
 * обхода фильтрации; используется только для обучения.
 *
 * LEGAL NOTICE: выполняются только обычные запросы к публичным HTTPS-эндпоинтам,
 * аналогичные работе браузера. Включение — только через флаг `enabled`.
 */

import { log } from '../../logger';

/** Публичные домены для демонстрации HEAD/GET (образовательный сценарий). */
const EDUCATIONAL_DOMAINS = [
  'yandex.ru',
  'vk.com',
  'mail.ru',
  'google.com',
  'github.com',
];

export type DomainFrontingStudyConfig = {
  domains: string[];
  timeout: number;
  /** По умолчанию false — без явного включения сеть не трогаем. */
  enabled: boolean;
};

export class DomainFrontingStudy {
  private readonly config: DomainFrontingStudyConfig;

  constructor(config?: Partial<DomainFrontingStudyConfig>) {
    this.config = {
      domains: EDUCATIONAL_DOMAINS,
      timeout: 10000,
      enabled: false,
      ...config,
    };
  }

  /**
   * Демонстрация: один легальный HTTPS HEAD к первому домену из списка (если модуль включён).
   */
  async demonstrateCDNRequest(_data: Uint8Array): Promise<boolean> {
    void _data;
    if (!this.config.enabled) {
      log.info('educational_domain_fronting_disabled');
      return false;
    }

    log.info('educational_domain_fronting_demo_start');

    try {
      const domain = this.config.domains[0];
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), this.config.timeout);
      const response = await fetch(`https://${domain}/`, {
        method: 'HEAD',
        headers: {
          'User-Agent': 'AirChat Educational Client/1.0',
          Accept: '*/*',
        },
        signal: controller.signal,
      });
      clearTimeout(t);

      log.info('educational_domain_fronting_demo_done', { status: response.status, domain });
      return response.ok;
    } catch (error) {
      log.warn('educational_domain_fronting_demo_failed', {
        err: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Краткое текстовое описание HTTP для экранов «О модуле». */
  async explainHTTPProtocol(): Promise<string> {
    return `
HTTP/HTTPS — стандартные протоколы передачи данных.
При запросе клиент отправляет метод (GET, POST, HEAD и т.д.), заголовки (Host, User-Agent, Accept) и опционально тело.

CDN и обратные прокси — обычные легальные компоненты современной сети. Этот модуль не меняет SNI/TLS и не маскирует трафик под чужие сервисы.
    `.trim();
  }
}
