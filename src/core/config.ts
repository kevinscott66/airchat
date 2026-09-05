import * as FileSystem from 'expo-file-system/legacy';
import { defaultBypassFlags } from './transport/bypass/defaults';
import type { BypassFeatureFlags } from './transport/bypass/types';
import { resolveIpfsLoopbackForAndroid } from './transport/ipfs/resolveLoopback';
import { normalizeServerBase } from './net/serverBaseUrl';
import { DEFAULT_RELAY_BASE, DEFAULT_WS_BASE } from './transport/internet/relayConfig';
import { log } from './logger';

export type AppConfig = {
  ipfs: {
    apiUrl: string;
    gatewayUrl: string;
    /** Preferred gateway list (if present, used before fallbackGateways). */
    gatewayUrls?: string[];
    bootstrapPeers: string[];
    fallbackGateways: string[];
    /**
     * Полные URL для HTTP POST (Kubo-совместимый /api/v0/add), если Kubo и Helia недоступны.
     * Пример: "https://ipfs.io/api/v0/add" (может отказать без своего узла — тогда см. очередь офлайн).
     */
    addApiUrls: string[];
    /** Try primary endpoints first, then public fallbacks. */
    usePrimaryFirst?: boolean;
    /** Per-request timeout for IPFS HTTP calls. */
    timeoutMs?: number;
    /** Retries per endpoint before moving to next URL. */
    retries?: number;
    lowPowerMode?: boolean;
    blockCacheMb?: number;
    /** Max libp2p connections when custom Helia libp2p is used */
    maxPeers?: number;
  };
  webrtc: {
    signalingUrl?: string;
    stunServers: { urls: string }[];
    turnServers: { urls: string; username?: string; credential?: string }[];
  };
  /**
   * Локальная сеть (общий Wi‑Fi роутер): mDNS `_airchat._tcp` + TCP-порт для DM без интернета.
   * Требует `npx expo prebuild` после установки `react-native-zeroconf` / `react-native-tcp-socket`.
   */
  lan?: {
    enabled: boolean;
    port?: number;
    discovery?: { enabled?: boolean; type?: string };
  };
  /**
   * Онлайн-транспорт через публичный pub-sub relay (по умолчанию ntfy.sh).
   * Работает в любой сети с интернетом (WiFi/мобильные данные), дополняет LAN
   * когда устройства в разных подсетях. См. src/core/transport/internet/.
   */
  internet?: {
    /** Включён по умолчанию. Можно отключить в airchat-config.json или kvStore. */
    enabled: boolean;
    /** HTTP base для POST, например https://ntfy.sh (можно заменить на self-host). */
    relayBase?: string;
    /** WebSocket base, например wss://ntfy.sh. */
    wsBase?: string;
  };
  /** Optional persistent endpoint for encrypted seed-bound account snapshots. */
  cloudBackup?: {
    enabled: boolean;
    /** HTTPS base URL of the AirChat cloud-vault service. */
    baseUrl?: string;
  };
  legal: {
    allowDisableE2EE: boolean;
  };
  /** Optional Sentry DSN for release crash reporting */
  sentry?: {
    dsn?: string;
  };
  /** Store-and-forward mesh (см. core/mesh) */
  mesh?: {
    enabled: boolean;
    maxHops: number;
    maxPayloadBytes: number;
  };
  /** Альтернативные каналы доставки (заглушки; по умолчанию выключено) */
  bypass: BypassFeatureFlags;
  /** Токены для будущих мостов (не храните секреты в git) */
  publicServices?: {
    vkToken?: string;
    yandexToken?: string;
    telegramBotToken?: string;
    /**
     * v4.32.364: ключ Tenor для подборщика GIF. Свой ключ выдаётся поимённо
     * (Google Cloud → Tenor API), поэтому в сборке его нет и быть не может.
     * Пусто — вкладка GIF не показывается.
     */
    tenorKey?: string;
    note?: string;
  };
  /** Список доменов для будущей конфигурации (сам по себе не активирует обход) */
  bypassDomains?: string[];
  /** Образовательный модуль: зашифрованный транспорт через API из белого списка (по умолчанию выкл.) */
  whitelist?: {
    enabled: boolean;
    description?: string;
    note?: string;
    services: {
      yandex: {
        enabled: boolean;
        token: string;
        description?: string;
        basePath?: string;
        incomingPath?: string;
      };
      vk: {
        enabled: boolean;
        token: string;
        description?: string;
        peerId?: string;
      };
      mailru: {
        enabled: boolean;
        token: string;
        description?: string;
        basePath?: string;
      };
    };
  };
  /**
   * Встроенный Xray (Android): локальный SOCKS + VLESS Reality к вашему VPS.
   * Секреты не коммитьте; переопределение через Documents/airchat-config.json.
   */
  vpn?: {
    enabled: boolean;
    autoStart: boolean;
    /** Локальный SOCKS5 (должен совпадать с inbounds в JSON Xray) */
    localSocksPort: number;
    address: string;
    port: number;
    uuid: string;
    flow: string;
    sni: string;
    publicKey: string;
    shortId: string;
    fingerprint?: string;
    /** Проксировать HTTP(S) к публичным IPFS-шлюзам через SOCKS, если туннель поднят */
    routeHttp?: boolean;
    /**
     * Если SOCKS к 127.0.0.1 не отвечает, повторить тот же HTTP-запрос без прокси (крайний случай).
     * По умолчанию true — иначе сообщения/IPFS могут «застыть» при сбое локального SOCKS.
     */
    fallbackDirectOnSocksFailure?: boolean;
    /**
     * Резервный VLESS+Reality (например зарубежный узел). При полной конфигурации Xray балансирует
     * трафик между primary и backup (random). VLESS — основной рабочий протокол в приложении.
     */
    backup?: {
      address: string;
      port: number;
      uuid: string;
      flow: string;
      sni: string;
      publicKey: string;
      shortId: string;
      fingerprint?: string;
    };
    /**
     * Домены с прямым выходом (freedom), без туннеля — удобно при «белом списке» РФ (yandex, vk, …).
     */
    directDomains?: string[];
    /** Подмешать в direct также `bypassDomains` из корня конфига */
    routeBypassDomainsDirect?: boolean;
    /**
     * MTProto (Telegram MTProxy) — зарезервировано; полноценная доставка требует нативного клиента MTProto.
     * Пока не используется — оставьте enabled: false.
     */
    mtproto?: {
      enabled: boolean;
      host?: string;
      port?: number;
      /** Секрет прокси (обычно base64) */
      secret?: string;
    };
    /**
     * Допустимые SNI для Reality (должны быть перечислены на сервере в realitySettings.serverNames).
     * Случайный выбор при rotateSniPerStart — только если сервер принимает все имена из списка.
     */
    sniPool?: string[];
    /** При каждом start выбирать случайный SNI из sniPool (или из sni, если пул пуст) */
    rotateSniPerStart?: boolean;
    /** Повторы при неудачном старте (retry в UI) */
    startRetries?: number;
    retryDelayMs?: number;
  };
  /** Образовательные модули (сеть/API — только при явных флагах) */
  educational?: {
    description?: string;
    experimentalModules?: {
      domainFrontingStudy?: { enabled: boolean; description?: string };
      dnsStudy?: { enabled: boolean; description?: string };
      publicAPIs?: { enabled: boolean; description?: string };
    };
  };
};

const DEFAULT_CONFIG: AppConfig = {
  ipfs: {
    apiUrl: 'http://127.0.0.1:5001',
    gatewayUrl: 'http://127.0.0.1:8080',
    gatewayUrls: [],
    bootstrapPeers: [],
    fallbackGateways: [],
    addApiUrls: [],
    usePrimaryFirst: true,
    timeoutMs: 5000,
    retries: 2,
    lowPowerMode: true,
    blockCacheMb: 500,
    maxPeers: 20,
  },
  webrtc: {
    signalingUrl: undefined,
    stunServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    turnServers: [],
  },
  lan: {
    /** Android / iOS dev: тот же Wi‑Fi → mDNS `_airchat._tcp` + TCP (см. lanTransport). Отключите в airchat-config.json при необходимости. */
    enabled: true,
    port: 9000,
    discovery: { enabled: true, type: 'bonjour' },
  },
  internet: {
    /** Онлайн-транспорт через ntfy.sh (WebSocket + HTTP POST). Работает в любой
     *  сети с интернетом; дополняет LAN (parallel, MultiTransportRouter выбирает
     *  лучший). Отключите в airchat-config.json, если не нужен relay. */
    enabled: true,
    relayBase: DEFAULT_RELAY_BASE,
    wsBase: DEFAULT_WS_BASE,
  },
  cloudBackup: {
    enabled: false,
    baseUrl: '',
  },
  legal: {
    allowDisableE2EE: false,
  },
  sentry: {},
  mesh: {
    enabled: false,
    maxHops: 7,
    maxPayloadBytes: 64 * 1024,
  },
  bypass: { ...defaultBypassFlags },
  publicServices: {
    vkToken: '',
    yandexToken: '',
    telegramBotToken: '',
    tenorKey: '',
    note: 'Tokens should be obtained officially from respective services',
  },
  bypassDomains: [],
  vpn: {
    enabled: false,
    autoStart: false,
    localSocksPort: 10809,
    address: '',
    port: 8443,
    uuid: '',
    flow: 'xtls-rprx-vision',
    sni: 'microsoft.com',
    publicKey: '',
    shortId: '',
    fingerprint: 'chrome',
    routeHttp: true,
    fallbackDirectOnSocksFailure: true,
    routeBypassDomainsDirect: false,
    mtproto: { enabled: false },
    sniPool: ['microsoft.com'],
    rotateSniPerStart: false,
    startRetries: 3,
    retryDelayMs: 2000,
  },
  whitelist: {
    enabled: false,
    description: 'Зашифрованный транспорт через сервисы из белого списка (образовательный модуль)',
    note: 'Данные шифруются на устройстве; токены не коммитьте в git.',
    services: {
      yandex: {
        enabled: false,
        token: '',
        description: 'Яндекс.Диск — загрузка зашифрованных файлов',
        basePath: '/airchat',
        incomingPath: '/airchat/incoming',
      },
      vk: {
        enabled: false,
        token: '',
        description: 'ВКонтакте — сообщения с opaque payload',
        peerId: '',
      },
      mailru: {
        enabled: false,
        token: '',
        description: 'Mail.ru Cloud — заготовка API',
        basePath: '/airchat',
      },
    },
  },
  educational: {
    description: 'Educational research modules for studying alternative communication methods',
    experimentalModules: {
      domainFrontingStudy: {
        enabled: false,
        description: 'Study of CDN and HTTP mechanisms (educational only)',
      },
      dnsStudy: {
        enabled: false,
        description: 'Study of DNS protocol and resolution mechanisms',
      },
      publicAPIs: {
        enabled: false,
        description: 'Integration with official public APIs (VK, Telegram, Yandex)',
      },
    },
  },
};

let cached: AppConfig | null = null;

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const k of Object.keys(patch)) {
    const pv = patch[k as keyof T];
    const bv = base[k as keyof T];
    if (
      pv &&
      typeof pv === 'object' &&
      !Array.isArray(pv) &&
      bv &&
      typeof bv === 'object' &&
      !Array.isArray(bv)
    ) {
      out[k] = deepMerge(bv as Record<string, unknown>, pv as Record<string, unknown>);
    } else if (pv !== undefined) {
      out[k] = pv as unknown;
    }
  }
  return out as T;
}

function patchIpfsUrlsForAndroid(cfg: AppConfig): AppConfig {
  const addUrls = (cfg.ipfs.addApiUrls ?? []).map((u) => resolveIpfsLoopbackForAndroid(u));
  const gatewayUrls = (cfg.ipfs.gatewayUrls ?? []).map((u) => resolveIpfsLoopbackForAndroid(u));
  const fallbackGateways = (cfg.ipfs.fallbackGateways ?? []).map((u) => resolveIpfsLoopbackForAndroid(u));
  return {
    ...cfg,
    ipfs: {
      ...cfg.ipfs,
      apiUrl: resolveIpfsLoopbackForAndroid(cfg.ipfs.apiUrl),
      gatewayUrl: resolveIpfsLoopbackForAndroid(cfg.ipfs.gatewayUrl),
      gatewayUrls,
      fallbackGateways,
      addApiUrls: addUrls,
    },
  };
}

/**
 * Адреса серверов — через то же правило, что и адрес, введённый руками в
 * настройках (v4.32.381).
 *
 * Правило разбора (core/net/serverBaseUrl) применялось ровно на экране «свой
 * сервер». Всё, что попадало в конфиг мимо экрана — assets/config.json,
 * правка Documents/airchat-config.json, запись старой версии приложения, —
 * уезжало в запрос как есть:
 *
 *   relayBase: ''                → `opts.relayBase ?? DEFAULT` не срабатывает
 *                                  (пустая строка не nullish), и транспорт
 *                                  собирает относительный адрес '/<тема>';
 *   relayBase: 'https://x.com/'  → `${relayBase}/${topic}` даёт двойной слэш;
 *   signalingUrl: 'wss://…'      → socket.io такой адрес принимает, а fetch на
 *                                  `${base}/register-token` — нет: звонки
 *                                  работают, регистрация пуш-токена молча нет.
 *
 * Чинить это у потребителей нельзя: их четверо, они нормализуют по-разному, и
 * два из них (internetTransport, internetCoordinator) трогать запрещено.
 * Значит, чинить надо на границе — здесь, где конфиг собирается, и на КАЖДОМ
 * пути сборки. Для этого ниже есть finalizeConfig: другого способа получить
 * готовый конфиг в этом модуле нет.
 */
function normalizeEndpoints(cfg: AppConfig): AppConfig {
  const out: AppConfig = { ...cfg };

  if (cfg.internet) {
    const relay = normalizeServerBase(cfg.internet.relayBase);
    const ws = normalizeServerBase(cfg.internet.wsBase);
    // Один сервер — одна пара адресов. Если годно только одно из двух полей,
    // второе достраивается из него, а не берётся из ntfy.sh: отправлять на
    // свой сервер и слушать чужой — значит не видеть собственных сообщений.
    let pairRelay = relay ?? ws;
    let pairWs = ws ?? relay;
    if (relay && ws && relay.httpBase !== ws.httpBase) {
      // Оба адреса годные, но указывают на разные серверы. Почти всегда это
      // значит, что переопределили половину пары (в airchat-config.json
      // достаточно написать один relayBase), а вторая осталась заводской.
      // Заводская половина уступает — иначе отправка и подписка разъезжаются
      // молча, и выглядит это как «сообщения уходят, но не приходят».
      if (relay.httpBase === DEFAULT_RELAY_BASE) pairRelay = ws;
      else if (ws.wsBase === DEFAULT_WS_BASE) pairWs = relay;
    }
    const relayBase = pairRelay?.httpBase ?? DEFAULT_RELAY_BASE;
    const wsBase = pairWs?.wsBase ?? DEFAULT_WS_BASE;
    if (relayBase !== cfg.internet.relayBase || wsBase !== cfg.internet.wsBase) {
      log.warn('config_relay_normalized', {
        from: `${cfg.internet.relayBase ?? ''}|${cfg.internet.wsBase ?? ''}`,
        to: `${relayBase}|${wsBase}`,
      });
    }
    out.internet = { ...cfg.internet, relayBase, wsBase };
  }

  if (cfg.cloudBackup) {
    const rawCloudBase = cfg.cloudBackup.baseUrl;
    const parsedCloudBase = rawCloudBase ? normalizeServerBase(rawCloudBase) : null;
    const cloudBase = parsedCloudBase && !parsedCloudBase.insecure ? parsedCloudBase.httpBase : undefined;
    if (rawCloudBase && !cloudBase) log.warn('config_cloud_backup_rejected');
    out.cloudBackup = {
      ...cfg.cloudBackup,
      enabled: !!cfg.cloudBackup.enabled && !!cloudBase,
      baseUrl: cloudBase ?? '',
    };
  }

  // Значение читают и socket.io, и fetch — поэтому годится только http-форма.
  // Негодное значение выключает функцию (undefined), а не остаётся как есть:
  // остаться как есть — это и есть запрос на 'file://…/register-token'.
  const rawSignaling = cfg.webrtc?.signalingUrl;
  if (rawSignaling != null && rawSignaling !== '') {
    // v4.32.581. `http://` отвергается так же, как у cloudBackup выше. По
    // этому каналу идут SDP и ICE, а имя собеседника берётся из поля, которое
    // ставит сервер: открытый http делает сигнальным сервером любого
    // посредника в сети — чужой Wi-Fi подменяет обе стороны и слушает звонок,
    // не тронув настоящий сервер.
    const parsedSignaling = normalizeServerBase(rawSignaling);
    const signalingUrl = parsedSignaling && !parsedSignaling.insecure ? parsedSignaling.httpBase : undefined;
    if (!signalingUrl) log.warn('config_signaling_rejected', { raw: String(rawSignaling).slice(0, 120) });
    out.webrtc = { ...cfg.webrtc, signalingUrl };
  } else if (rawSignaling === '') {
    out.webrtc = { ...cfg.webrtc, signalingUrl: undefined };
  }

  return out;
}

/**
 * Единственный способ получить готовый конфиг: и адреса IPFS под Android, и
 * адреса серверов приводятся здесь. Пути сборки кэша расходятся (бандл есть /
 * бандла нет / синхронный / после сохранения переопределения), и раньше на
 * каждом из них шаг подстановки писался заново — то есть забыть его было
 * можно. Теперь забыть нельзя: собирать конфиг больше нечем.
 */
function finalizeConfig(cfg: AppConfig): AppConfig {
  return patchIpfsUrlsForAndroid(normalizeEndpoints(cfg));
}

/** Documents/airchat-config.json — пользовательский runtime-override (relay и т.п.). */
async function readUserOverride(): Promise<Partial<AppConfig>> {
  try {
    const uri = `${FileSystem.documentDirectory ?? ''}airchat-config.json`;
    const info = await FileSystem.getInfoAsync(uri);
    // v4.32.194 (Round-24 #7): reject oversized / non-object overrides.
    // A 500MB file freezes JS on read; `[]` or `null` crashes deepMerge.
    if (info.exists && (info.size ?? 0) <= 256 * 1024) {
      const raw = await FileSystem.readAsStringAsync(uri);
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Partial<AppConfig>;
      }
    }
  } catch {
    /* optional user override */
  }
  return {};
}

/**
 * Имена, которые по RFC 2606 и RFC 6761 зарезервированы под примеры и никогда
 * не будут ничьим настоящим сервером.
 *
 * Нужны ровно для одного: узнать заглушку из git в bundledConfig ниже.
 * К адресу, который вписал человек, правило не применяется — его выбор его
 * дело, и example.com в своём файле он пишет осознанно.
 */
const RESERVED_HOSTS = new Set(['example.com', 'example.org', 'example.net']);
const RESERVED_SUFFIXES = ['.example.com', '.example.org', '.example.net', '.example', '.invalid', '.test'];

function isPlaceholderHost(raw: string): boolean {
  let host: string;
  try {
    host = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (RESERVED_HOSTS.has(host)) return true;
  return RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Заводской конфиг сборки: `assets/config.json` плюс адрес облачной копии из
 * переменной сборки (v4.32.541).
 *
 * В git на месте адреса лежит заглушка `agents.example.com`. Настоящий адрес
 * в публичный репозиторий класть незачем, поэтому он приходит из
 * `EXPO_PUBLIC_CLOUD_VAULT_URL` — тем же способом, что и DSN в
 * core/errorHandler.
 *
 * v4.32.596. Сборка без переменной оставалась с заглушкой, и это молчало не
 * так, как ожидалось: заглушка разбирается, она https, общее правило её
 * пропускало — `enabled` оставался true, `isCloudVaultConfigured()` отвечал
 * «настроено», а запросы уходили на хост, которого не существует. Больнее
 * всего это било по восстановлению секретными словами в веб-сборке:
 * приложение обещало облако и отдавало пустой аккаунт с правильным DID.
 * Поэтому заглушка приравнивается к «адреса нет»: честное «облака в этой
 * сборке нет» лучше, чем ожидание ответа от несуществующего сервера.
 *
 * Переменная отвечает на вопрос «куда», а не «включать ли»: флаг `enabled`
 * остаётся из файла, и сборка с выключённой облачной копией не включится от
 * одной переменной. Негодное значение переменной здесь не отсеивается —
 * его отсеет общее правило в normalizeEndpoints и запишет в журнал.
 *
 * `require` оставлен внутри: три пути сборки конфига полагаются на то, что он
 * бросает, когда файла в сборке нет.
 */
function bundledConfig(): AppConfig {
  const bundled = require('../../assets/config.json') as AppConfig;
  const fromEnv =
    typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_CLOUD_VAULT_URL
      ? process.env.EXPO_PUBLIC_CLOUD_VAULT_URL
      : '';
  if (fromEnv) {
    return { ...bundled, cloudBackup: { ...bundled.cloudBackup, enabled: !!bundled.cloudBackup?.enabled, baseUrl: fromEnv } };
  }
  if (bundled.cloudBackup?.baseUrl && isPlaceholderHost(bundled.cloudBackup.baseUrl)) {
    log.warn('config_cloud_backup_placeholder');
    return { ...bundled, cloudBackup: { ...bundled.cloudBackup, enabled: false, baseUrl: '' } };
  }
  return bundled;
}

export async function loadConfig(): Promise<AppConfig> {
  if (cached) return cached;
  // v4.32.226: read the user override FIRST and apply it on EVERY path. The
  // bundled-asset require below throws when assets/config.json is absent from
  // the build, and the old catch branch returned bare defaults — silently
  // discarding Documents/airchat-config.json, which made runtime relay
  // switching (saveConfigOverride / manual file push) a no-op on such builds.
  const patch = await readUserOverride();
  try {
    const bundled = bundledConfig();
    cached = finalizeConfig(deepMerge(DEFAULT_CONFIG, { ...bundled, ...patch }));
    return cached;
  } catch (e) {
    log.warn('config_load_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    cached = finalizeConfig(deepMerge(DEFAULT_CONFIG, patch as AppConfig));
    return cached;
  }
}

export function getConfigSync(): AppConfig {
  if (cached) return cached;
  try {
    const bundled = bundledConfig();
    cached = finalizeConfig(deepMerge(DEFAULT_CONFIG, bundled));
    return cached;
  } catch {
    cached = finalizeConfig(DEFAULT_CONFIG);
    return cached;
  }
}

function documentConfigOverrideUri(): string {
  return `${FileSystem.documentDirectory ?? ''}airchat-config.json`;
}

async function readConfigOverride(): Promise<Partial<AppConfig>> {
  try {
    const uri = documentConfigOverrideUri();
    const info = await FileSystem.getInfoAsync(uri);
    // v4.32.581. Тот же потолок, что и у readUserOverride: файл один и тот же,
    // а читателей у него два, и второй читал без ограничения — подложенный
    // многомегабайтный override вешал JS-поток на старте.
    if (!info.exists || (info.size ?? 0) > 256 * 1024) return {};
    const raw = await FileSystem.readAsStringAsync(uri);
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Partial<AppConfig>)
      : {};
  } catch (e) {
    log.warn('config_override_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return {};
  }
}

/**
 * Сохранить частичное переопределение конфига в `Documents/airchat-config.json`
 * (тот же файл, что читает loadConfig), аккуратно слив с уже существующими
 * переопределениями, и обновить in-memory кэш — чтобы запущенное приложение
 * сразу увидело новые значения без перезапуска.
 *
 * Возвращает пересобранный эффективный конфиг. Секреты пользователя (uuid,
 * publicKey и т.п.) живут только в песочнице приложения и не попадают в git.
 */
export async function saveConfigOverride(patch: Partial<AppConfig>): Promise<AppConfig> {
  const existingOverride = await readConfigOverride();
  const mergedOverride = deepMerge(
    existingOverride as Record<string, unknown>,
    patch as Record<string, unknown>,
  ) as Partial<AppConfig>;

  const uri = documentConfigOverrideUri();
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(mergedOverride, null, 2));

  let bundled: Partial<AppConfig> = {};
  try {
    bundled = bundledConfig();
  } catch {
    /* no bundled config — defaults + override only */
  }
  cached = finalizeConfig(
    deepMerge(DEFAULT_CONFIG, { ...bundled, ...mergedOverride } as Partial<AppConfig>),
  );
  return cached;
}
