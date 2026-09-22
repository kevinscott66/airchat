/**
 * OpenFlux — туннель через документ Яндекса (v4.32.724).
 *
 * Ядро — сборка github.com/.../OpenFlux (Go) под Android и iOS: оно держит
 * переписку с документом и кладёт на loopback обычный SOCKS5. Модуль поднимает
 * ядро, отдаёт адрес этого SOCKS5 и уводит в него сетевой стек приложения.
 *
 * Почему стек целиком, а не отдельными вызовами, как в `airchat-vpn`. Там
 * нативные `fetchGet`/`postMultipartFile` заведены под IPFS-шлюзы: адресов
 * немного, и каждый вызывается явно. Здесь задача обратная — приложение должно
 * работать в сети, где напрямую не открывается ничего, кроме белого списка.
 * Главный канал AirChat (ntfy) держится на веб-сокете, а его через «ещё одну
 * функцию скачивания» не пропустишь.
 *
 * Полнота перехвата у платформ разная, и это принципиально. На Android один
 * `ProxySelector.setDefault` покрывает весь OkHttp, то есть и `fetch`, и
 * `WebSocket`. На iOS единой точки нет: там два слоя (системный прокси
 * Network.framework и конфигурация сессии React Native), и веб-сокеты в них
 * могут не попасть — см. modules/airchat-openflux/ios/OpenFluxRouting.swift.
 * Поэтому у iOS есть то, чего нет у Android: `enableTunnelStats`/`tunnelStats`,
 * счётчик соединений из самого ядра — единственный способ не гадать, а увидеть.
 *
 * `null`, когда нативной части нет: на web ядра нет и быть не может, и
 * потребители (openFluxController) написаны под проверку `if (!mod)`. См.
 * web/shims/airchat-openflux.ts, где то же `null` подставляется явно.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export type OpenFluxStartOptions = {
  /** Транспорт ядра. Сейчас поддержан только 'yandex'. */
  transport: string;
  /** Ссылка на документ Яндекса (старый редактор, доступ на запись). */
  docUrl: string;
  /** Где повесить локальный SOCKS5. Порт 0 — ядро займёт свободный. */
  socksAddr: string;
  /** DNS, которым ядро резолвит имена внутри туннеля. */
  dns: string;
};

export type AirChatOpenFluxNative = {
  isSupported: () => Promise<boolean>;
  /**
   * Поднять туннель и увести трафик приложения в него.
   * Возвращает адрес локального SOCKS5 (`127.0.0.1:port`).
   * Бросает с текстом ошибки ядра, если документ недоступен.
   */
  start: (options: OpenFluxStartOptions) => Promise<string>;
  /** Опустить туннель и вернуть трафик напрямую. */
  stop: () => Promise<void>;
  isRunning: () => Promise<boolean>;
  /** Адрес SOCKS5, пока туннель поднят, иначе null. */
  socksAddr: () => Promise<string | null>;
  /**
   * Включить подсчёт соединений в ядре. Необязательные — их нет на Android,
   * где перехват доказывать не нужно: прокси стоит на самом OkHttp. Поле
   * помечено `?`, чтобы вызывающий был обязан проверить наличие, а не
   * полагаться на платформу (JS не должен знать, у кого что реализовано).
   *
   * Обратного хода нет: отладочный флаг ядра односторонний.
   */
  enableTunnelStats?: () => Promise<void>;
  /** Сколько соединений ядро приняло и куда шло последнее. */
  tunnelStats?: () => Promise<{
    counting: boolean;
    connections: number;
    failures: number;
    lastTarget: string | null;
    lastAt: number | null;
    systemProxy: boolean;
    httpProxy: boolean;
  }>;
};

export default requireOptionalNativeModule<AirChatOpenFluxNative | null>('AirChatOpenFlux');
