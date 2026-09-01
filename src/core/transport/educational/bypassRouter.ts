/**
 * EDUCATIONAL MODULE: Multi-channel connectivity study
 *
 * Объединяет учебные классы выше. Все подмодули по умолчанию выключены;
 * сетевые проверки в `checkChannelAvailability` — лёгкие и опциональны.
 */

import { Platform } from 'react-native';
import { log } from '../../logger';
import { DomainFrontingStudy } from './domainFronting';
import { DNSProtocolStudy } from './dnsTunnel';
import { PublicAPIIntegration } from './publicServices';

export type EducationalRouterConfig = {
  enableDomainStudy: boolean;
  enableDNSStudy: boolean;
  enablePublicAPIs: boolean;
  vkToken?: string;
  telegramBotToken?: string;
  yandexToken?: string;
  /** Локальные исследования (например, более подробные логи). */
  experimentalMode: boolean;
};

export class EducationalCommunicationRouter {
  private readonly config: EducationalRouterConfig;
  private readonly domainStudy: DomainFrontingStudy;
  private readonly dnsStudy: DNSProtocolStudy;
  private readonly publicAPIs: PublicAPIIntegration;

  constructor(config?: Partial<EducationalRouterConfig>) {
    this.config = {
      enableDomainStudy: false,
      enableDNSStudy: false,
      enablePublicAPIs: false,
      experimentalMode: __DEV__,
      ...config,
    };

    this.domainStudy = new DomainFrontingStudy({ enabled: this.config.enableDomainStudy });
    this.dnsStudy = new DNSProtocolStudy({ enabled: this.config.enableDNSStudy });
    this.publicAPIs = new PublicAPIIntegration({
      enabled: this.config.enablePublicAPIs,
      vkToken: this.config.vkToken,
      telegramBotToken: this.config.telegramBotToken,
      yandexToken: this.config.yandexToken,
    });
  }

  /** Запуск демонстраций подмодулей (каждый уважает свой `enabled`). */
  async demonstrateChannels(): Promise<{
    domainStudy: boolean;
    dnsStudy: boolean;
    publicAPIs: boolean;
  }> {
    if (this.config.experimentalMode) {
      log.debug('educational_router_demonstrate_channels');
    }

    const results = {
      domainStudy: await this.domainStudy.demonstrateCDNRequest(new Uint8Array()),
      dnsStudy: await this.dnsStudy.demonstrateDNSQuery(),
      publicAPIs: await this.publicAPIs.demonstrateVKAPI(),
    };

    log.info('educational_router_channel_results', results);
    return results;
  }

  async getProtocolDocumentation(): Promise<Record<string, string>> {
    return {
      http: await this.domainStudy.explainHTTPProtocol(),
      dns: await this.dnsStudy.explainDNSProtocol(),
      apis: await this.publicAPIs.explainPublicAPIs(),
    };
  }

  /**
   * Эвристическая проверка доступности классов каналов (не гарантия «работает чат»).
   */
  async checkChannelAvailability(): Promise<Record<string, boolean>> {
    return {
      'HTTPS (CDN)': await this.checkHTTPS(),
      DNS: await this.checkDNS(),
      WebRTC: await this.checkWebRTC(),
      'Public APIs': await this.checkPublicAPIs(),
    };
  }

  private async checkHTTPS(): Promise<boolean> {
    try {
      const response = await fetch('https://ya.ru', { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async checkDNS(): Promise<boolean> {
    try {
      const response = await fetch('https://dns.yandex.ru/dns-query?name=ya.ru&type=A', {
        headers: { Accept: 'application/dns-json' },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async checkWebRTC(): Promise<boolean> {
    /** На нативных клиентах доступен `react-native-webrtc`; веб-сборка вне фокуса этого демо. */
    return Platform.OS !== 'web';
  }

  private async checkPublicAPIs(): Promise<boolean> {
    try {
      const response = await fetch('https://api.vk.com/method/users.get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ v: '5.131' }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
