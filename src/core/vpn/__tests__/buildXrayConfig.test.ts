/**
 * Конфигурация Xray, которую получает нативный модуль (v4.32.331).
 *
 * Этот JSON никто не читает глазами: он уходит в Xray, и любая ошибка в нём
 * выглядит снаружи одинаково — «Ошибка подключения» при верных данных сервера.
 * Поэтому проверяется форма документа, а не то, что функция что-то вернула.
 */
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { AppConfig } from '../../config';
import { log } from '../../logger';
import { buildXrayMobileClientJson } from '../buildXrayConfig';

type Vpn = NonNullable<AppConfig['vpn']>;

const PRIMARY: Partial<Vpn> = {
  enabled: true,
  address: 'vps.example.com',
  port: 443,
  uuid: '11111111-1111-1111-1111-111111111111',
  flow: 'xtls-rprx-vision',
  sni: 'microsoft.com',
  publicKey: 'pbk-primary',
  shortId: 'aa11',
  fingerprint: 'chrome',
};

const BACKUP: NonNullable<Vpn['backup']> = {
  address: 'backup.example.net',
  port: 8443,
  uuid: '22222222-2222-2222-2222-222222222222',
  flow: 'xtls-rprx-vision',
  sni: 'apple.com',
  publicKey: 'pbk-backup',
  shortId: 'bb22',
};

/** Собирает документ и сразу разбирает обратно: тесты смотрят на структуру. */
function build(vpn?: Partial<Vpn>, app?: Partial<AppConfig>) {
  const cfg = { ...(app ?? {}), vpn } as AppConfig;
  return JSON.parse(buildXrayMobileClientJson(cfg)) as {
    inbounds: { port: number; listen: string; protocol: string; sniffing: { enabled: boolean } }[];
    outbounds: {
      tag?: string;
      protocol: string;
      settings?: { vnext?: { address: string; port: number; users: { id: string; flow: string }[] }[] };
      streamSettings?: { realitySettings?: { serverName: string; publicKey: string; shortId: string; fingerprint: string } };
    }[];
    routing: {
      domainStrategy: string;
      rules: { domain?: string[]; outboundTag?: string; balancerTag?: string }[];
      balancers?: { tag: string; selector: string[]; strategy: { type: string } }[];
    };
    balancers?: unknown;
  };
}

beforeEach(() => jest.clearAllMocks());

describe('buildXrayMobileClientJson — основной сервер', () => {
  it('локальный SOCKS слушает только петлю', () => {
    const doc = build(PRIMARY);
    expect(doc.inbounds).toHaveLength(1);
    expect(doc.inbounds[0].listen).toBe('127.0.0.1');
    expect(doc.inbounds[0].protocol).toBe('socks');
    expect(doc.inbounds[0].port).toBe(10809);
  });

  it('порт SOCKS берётся из конфига', () => {
    expect(build({ ...PRIMARY, localSocksPort: 10888 }).inbounds[0].port).toBe(10888);
  });

  it('весь трафик уходит в основной сервер, пока резерва нет', () => {
    const doc = build(PRIMARY);
    const tags = doc.outbounds.map((o) => o.tag);
    expect(tags).toEqual(['vless-primary', 'direct']);
    expect(doc.routing.rules.at(-1)).toEqual({
      type: 'field',
      network: 'tcp,udp',
      outboundTag: 'vless-primary',
    });
    expect(doc.routing.balancers).toBeUndefined();
  });

  it('данные сервера доезжают до outbound без изменений', () => {
    const o = build(PRIMARY).outbounds[0];
    expect(o.settings?.vnext?.[0]).toMatchObject({ address: 'vps.example.com', port: 443 });
    expect(o.settings?.vnext?.[0].users[0]).toMatchObject({
      id: PRIMARY.uuid,
      flow: 'xtls-rprx-vision',
    });
    expect(o.streamSettings?.realitySettings).toMatchObject({
      serverName: 'microsoft.com',
      publicKey: 'pbk-primary',
      shortId: 'aa11',
      fingerprint: 'chrome',
    });
  });

  it('без секции vpn возвращается пустой документ, а не сломанный', () => {
    const doc = build(undefined);
    expect(doc.inbounds).toEqual([]);
    expect(doc.outbounds).toEqual([]);
  });
});

describe('резервный сервер и балансировщик', () => {
  it('балансировщик лежит ВНУТРИ routing (v4.32.331)', () => {
    const doc = build({ ...PRIMARY, backup: BACKUP });
    // Корневого поля balancers в схеме Xray нет: там оно отбрасывалось, и
    // ссылка balancerTag повисала — Xray не стартовал вообще.
    expect(doc.balancers).toBeUndefined();
    expect(doc.routing.balancers).toEqual([
      { tag: 'vless-lb', selector: ['vless-primary', 'vless-backup'], strategy: { type: 'random' } },
    ]);
  });

  it('правило ссылается на существующий тег балансировщика', () => {
    const doc = build({ ...PRIMARY, backup: BACKUP });
    const last = doc.routing.rules.at(-1);
    expect(last?.balancerTag).toBe('vless-lb');
    expect(doc.routing.balancers?.map((b) => b.tag)).toContain(last?.balancerTag);
  });

  it('каждый тег из selector есть среди outbounds', () => {
    const doc = build({ ...PRIMARY, backup: BACKUP });
    const tags = doc.outbounds.map((o) => o.tag);
    for (const sel of doc.routing.balancers?.[0].selector ?? []) expect(tags).toContain(sel);
  });

  it('у резерва свои SNI и ключи', () => {
    const doc = build({ ...PRIMARY, backup: BACKUP });
    const backup = doc.outbounds.find((o) => o.tag === 'vless-backup');
    expect(backup?.settings?.vnext?.[0]).toMatchObject({ address: 'backup.example.net', port: 8443 });
    expect(backup?.streamSettings?.realitySettings).toMatchObject({
      serverName: 'apple.com',
      publicKey: 'pbk-backup',
      shortId: 'bb22',
      // fingerprint у резерва не задан — берётся от основного.
      fingerprint: 'chrome',
    });
  });

  it('неполный резерв игнорируется, а не ломает конфиг', () => {
    const doc = build({ ...PRIMARY, backup: { ...BACKUP, publicKey: '  ' } });
    expect(doc.outbounds.map((o) => o.tag)).toEqual(['vless-primary', 'direct']);
    expect(doc.routing.balancers).toBeUndefined();
    expect(doc.routing.rules.at(-1)?.outboundTag).toBe('vless-primary');
  });

  it('адрес резервного сервера не попадает в лог', () => {
    build({ ...PRIMARY, backup: BACKUP });
    const written = JSON.stringify((log.info as jest.Mock).mock.calls);
    expect(written).not.toContain('backup.example.net');
  });
});

describe('домены в обход туннеля', () => {
  it('каждый домен получает своё правило на direct — до общего правила', () => {
    const doc = build({ ...PRIMARY, directDomains: ['VK.com', ' yandex.ru '] });
    const direct = doc.routing.rules.filter((r) => r.outboundTag === 'direct');
    expect(direct.map((r) => r.domain?.[0])).toEqual(['domain:vk.com', 'domain:yandex.ru']);
    expect(doc.routing.rules.at(-1)?.outboundTag).toBe('vless-primary');
  });

  it('пустые строки в списке пропускаются', () => {
    const doc = build({ ...PRIMARY, directDomains: ['', '   ', 'ok.ru'] });
    expect(doc.routing.rules.filter((r) => r.outboundTag === 'direct')).toHaveLength(1);
  });

  it('bypassDomains подмешиваются только по флагу', () => {
    const app = { bypassDomains: ['gosuslugi.ru'] };
    const off = build({ ...PRIMARY }, app);
    expect(off.routing.rules.some((r) => r.domain?.[0] === 'domain:gosuslugi.ru')).toBe(false);
    const on = build({ ...PRIMARY, routeBypassDomainsDirect: true }, app);
    expect(on.routing.rules.some((r) => r.domain?.[0] === 'domain:gosuslugi.ru')).toBe(true);
  });

  it('дубликат домена не даёт двух правил', () => {
    const doc = build(
      { ...PRIMARY, directDomains: ['vk.com'], routeBypassDomainsDirect: true },
      { bypassDomains: ['VK.com'] }
    );
    expect(doc.routing.rules.filter((r) => r.outboundTag === 'direct')).toHaveLength(1);
  });
});

describe('выбор SNI', () => {
  it('явный sni сильнее пула, пока ротация выключена', () => {
    const doc = build({ ...PRIMARY, sniPool: ['a.example', 'b.example'] });
    expect(doc.outbounds[0].streamSettings?.realitySettings?.serverName).toBe('microsoft.com');
  });

  it('без явного sni берётся первый из пула', () => {
    const doc = build({ ...PRIMARY, sni: '', sniPool: ['a.example', 'b.example'] });
    expect(doc.outbounds[0].streamSettings?.realitySettings?.serverName).toBe('a.example');
  });

  it('при ротации выбирается имя из пула — сервер обязан принимать их все', () => {
    const doc = build({ ...PRIMARY, rotateSniPerStart: true, sniPool: ['a.example', 'b.example'] });
    expect(['a.example', 'b.example']).toContain(
      doc.outbounds[0].streamSettings?.realitySettings?.serverName
    );
  });

  it('без sni и пула остаётся значение по умолчанию', () => {
    const doc = build({ ...PRIMARY, sni: '   ' });
    expect(doc.outbounds[0].streamSettings?.realitySettings?.serverName).toBe('microsoft.com');
  });
});
