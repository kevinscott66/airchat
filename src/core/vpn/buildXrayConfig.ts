import type { AppConfig } from '../config';
import { log } from '../logger';

/** SNI/uTLS для Reality: внешне как обычный TLS к CDN/сайту (маскировка под HTTPS). */
function pickSni(cfg: NonNullable<AppConfig['vpn']>): string {
  const pool = (cfg.sniPool ?? []).map((s) => s.trim()).filter(Boolean);
  if (cfg.rotateSniPerStart === true && pool.length > 0) {
    return pool[Math.floor(Math.random() * pool.length)]!;
  }
  if (pool.length > 0 && !cfg.sni?.trim()) {
    return pool[0]!;
  }
  return (cfg.sni ?? 'microsoft.com').trim() || 'microsoft.com';
}

type VlessRealityLike = {
  address: string;
  port: number;
  uuid: string;
  flow: string;
  sni: string;
  publicKey: string;
  shortId: string;
  fingerprint?: string;
};

function toVlessRealityOutbound(tag: string, v: VlessRealityLike): Record<string, unknown> {
  return {
    tag,
    protocol: 'vless',
    settings: {
      vnext: [
        {
          address: v.address.trim(),
          port: v.port,
          users: [
            {
              id: v.uuid.trim(),
              encryption: 'none',
              flow: v.flow,
            },
          ],
        },
      ],
    },
    streamSettings: {
      network: 'tcp',
      security: 'reality',
      realitySettings: {
        serverName: v.sni.trim(),
        fingerprint: v.fingerprint ?? 'chrome',
        publicKey: v.publicKey.trim(),
        shortId: v.shortId.trim(),
        spiderX: '/',
      },
    },
  };
}

function backupEndpointComplete(
  b: NonNullable<AppConfig['vpn']>['backup']
): b is NonNullable<typeof b> & {
  address: string;
  port: number;
  uuid: string;
  flow: string;
  sni: string;
  publicKey: string;
  shortId: string;
} {
  if (!b?.address?.trim() || !b.uuid?.trim() || !b.publicKey?.trim() || !b.shortId?.trim()) {
    return false;
  }
  return typeof b.port === 'number' && !!b.flow?.trim() && !!b.sni?.trim();
}

/**
 * Локальный SOCKS5 + VLESS Reality (и опционально второй VLESS + балансировка + прямой выход для доменов).
 * MTProto в Xray не встроен — см. отдельную документацию / нативный модуль.
 */
export function buildXrayMobileClientJson(app: AppConfig): string {
  const cfg = app.vpn;
  if (!cfg) {
    return JSON.stringify({ log: { loglevel: 'warning' }, inbounds: [], outbounds: [] });
  }

  const port = cfg.localSocksPort ?? 10809;
  const serverName = pickSni(cfg);

  const primary: VlessRealityLike = {
    address: cfg.address,
    port: cfg.port,
    uuid: cfg.uuid,
    flow: cfg.flow,
    sni: serverName,
    publicKey: cfg.publicKey,
    shortId: cfg.shortId,
    fingerprint: cfg.fingerprint,
  };

  const outbounds: Record<string, unknown>[] = [toVlessRealityOutbound('vless-primary', primary)];

  let hasBackup = false;
  if (backupEndpointComplete(cfg.backup)) {
    const b = cfg.backup;
    hasBackup = true;
    outbounds.push(
      toVlessRealityOutbound('vless-backup', {
        address: b.address,
        port: b.port,
        uuid: b.uuid,
        flow: b.flow,
        // backupEndpointComplete уже потребовал непустой sni — запасной
        // serverName здесь был недостижим.
        sni: b.sni.trim(),
        publicKey: b.publicKey,
        shortId: b.shortId,
        fingerprint: b.fingerprint ?? cfg.fingerprint,
      })
    );
    // v4.32.331: адрес резервного сервера в лог не пишется. Это ровно то, что
    // человек и прячет, а лог уходит в отчёт о диагностике.
    log.info('vpn_xray_dual_outbound');
  }

  outbounds.push({
    protocol: 'freedom',
    tag: 'direct',
    settings: {},
  });

  const directDomains = new Set<string>();
  if (cfg.directDomains?.length) {
    for (const d of cfg.directDomains) {
      const x = d.trim().toLowerCase();
      if (x) directDomains.add(x);
    }
  }
  if (cfg.routeBypassDomainsDirect && app.bypassDomains?.length) {
    for (const d of app.bypassDomains) {
      const x = d.trim().toLowerCase();
      if (x) directDomains.add(x);
    }
  }

  const rules: Record<string, unknown>[] = [];
  for (const d of directDomains) {
    rules.push({
      type: 'field',
      domain: [`domain:${d}`],
      outboundTag: 'direct',
    });
  }

  if (hasBackup) {
    rules.push({
      type: 'field',
      network: 'tcp,udp',
      balancerTag: 'vless-lb',
    });
  } else {
    rules.push({
      type: 'field',
      network: 'tcp,udp',
      outboundTag: 'vless-primary',
    });
  }

  /**
   * Балансировщик описывается ВНУТРИ routing (v4.32.331).
   *
   * До этой версии он лежал в корне документа. Корневого поля balancers в
   * схеме Xray нет — оно просто отбрасывалось, а правило ниже ссылалось на
   * balancerTag, которого в итоге не существовало. Xray на таком конфиге не
   * стартует вообще: настроенный резервный сервер ломал не резерв, а весь
   * VPN, причём молча — наружу это выглядело как «Ошибка подключения»
   * с верными данными сервера.
   */
  const routing: Record<string, unknown> = { domainStrategy: 'AsIs', rules };
  if (hasBackup) {
    routing.balancers = [
      {
        tag: 'vless-lb',
        selector: ['vless-primary', 'vless-backup'],
        strategy: {
          type: 'random',
        },
      },
    ];
  }

  const doc: Record<string, unknown> = {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        listen: '127.0.0.1',
        port,
        protocol: 'socks',
        tag: 'socks-in',
        settings: { udp: true },
        sniffing: {
          enabled: true,
          destOverride: ['http', 'tls'],
        },
      },
    ],
    outbounds,
    routing,
  };

  return JSON.stringify(doc);
}
