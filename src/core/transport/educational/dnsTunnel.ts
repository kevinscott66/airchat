/**
 * EDUCATIONAL MODULE: DNS / DoH Study
 *
 * Демонстрирует разрешение имён через публичный DNS-over-HTTPS (JSON).
 * Это не «туннелирование полезной нагрузки» через DNS — только учебный запрос A-записи.
 *
 * LEGAL NOTICE: используются публичные DoH-эндпоинты и стандартные параметры запроса.
 */

import { log } from '../../logger';

const PUBLIC_DNS_SERVERS = [
  'https://dns.yandex.ru/dns-query',
  'https://dns.cloudflare.com/dns-query',
  'https://dns.google/dns-query',
];

export type DNSProtocolStudyConfig = {
  dnsServers: string[];
  enabled: boolean;
};

export class DNSProtocolStudy {
  private readonly config: DNSProtocolStudyConfig;

  constructor(config?: Partial<DNSProtocolStudyConfig>) {
    this.config = {
      dnsServers: PUBLIC_DNS_SERVERS,
      enabled: false,
      ...config,
    };
  }

  /**
   * Демонстрация: один запрос `application/dns-json` для указанного имени.
   */
  async demonstrateDNSQuery(domain: string = 'example.com'): Promise<boolean> {
    if (!this.config.enabled) {
      log.info('educational_dns_study_disabled');
      return false;
    }

    log.info('educational_dns_study_start', { domain });

    try {
      const dnsServer = this.config.dnsServers[0];
      const response = await fetch(`${dnsServer}?name=${encodeURIComponent(domain)}&type=A`, {
        headers: {
          Accept: 'application/dns-json',
        },
      });

      const data = (await response.json()) as unknown;
      log.info('educational_dns_study_response', { ok: response.ok, sample: typeof data });

      return response.ok;
    } catch (error) {
      log.warn('educational_dns_study_failed', {
        err: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async explainDNSProtocol(): Promise<string> {
    return `
DNS (Domain Name System) сопоставляет имена хостов с IP-адресами.
Публичные DNS-over-HTTPS серверы отвечают стандартными DNS-сообщениями в формате JSON.

Этот модуль показывает один такой запрос и не предназначен для передачи произвольных данных через поля имени.
    `.trim();
  }
}
