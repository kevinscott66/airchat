/**
 * OpenFlux — туннель через документ Яндекса (v4.32.723).
 *
 * Ядро — сборка github.com/.../OpenFlux под Android (Go, c-shared): оно держит
 * переписку с документом и кладёт на loopback обычный SOCKS5. Модуль поднимает
 * ядро, отдаёт адрес этого SOCKS5 и переключает на него сетевой стек
 * приложения целиком — и запросы, и веб-сокеты.
 *
 * Почему целиком, а не отдельными вызовами, как в `airchat-vpn`. Там нативные
 * `fetchGet`/`postMultipartFile` заведены под IPFS-шлюзы: адресов немного, и
 * каждый вызывается явно. Здесь задача обратная — приложение должно работать в
 * сети, где напрямую не открывается ничего, кроме белого списка. Главный
 * канал AirChat (ntfy) держится на веб-сокете, а его через «ещё одну функцию
 * скачивания» не пропустишь. Поэтому прокси ставится под весь OkHttp, который
 * React Native использует и для `fetch`, и для `WebSocket`.
 *
 * `null`, когда нативной части нет: на iOS и web ядра нет, и потребители
 * (openFluxController) написаны под проверку `if (!mod)`. См. и
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
};

export default requireOptionalNativeModule<AirChatOpenFluxNative | null>('AirChatOpenFlux');
