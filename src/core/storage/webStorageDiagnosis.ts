/**
 * Почему в браузере не завелась база — по-человечески.
 *
 * v4.32.538. На air.dobropalm.tech экран запуска показывал
 * `navigator.storage not available (not supported by your browser or context
 * is not secure)` — текст исключения из expo-sqlite, выведенный как есть. Он
 * верен и бесполезен: из него не следует ни что случилось, ни что делать, ни
 * даже то, что дело не в телефоне.
 *
 * Место хранения базы в вебе выбрано и менять его не на что: OPFS
 * (`navigator.storage.getDirectory`) — единственное браузерное хранилище, где
 * SQLite работает файлом, а не эмуляцией поверх IndexedDB. Плата за это —
 * защищённый контекст: HTTPS с действующим сертификатом. Подменять его на
 * память нельзя: переписка молча исчезала бы при перезагрузке вкладки, и это
 * хуже честного отказа.
 *
 * Поэтому здесь не запасной путь, а диагноз: разобрать, какая из двух причин
 * сработала, и сказать, чинится это сертификатом сайта или сменой браузера.
 */

/** Факты об окружении, от которых зависит диагноз. `null` — не удалось узнать. */
export type StorageEnv = {
  /** `window.isSecureContext`. */
  secureContext: boolean | null;
  /** Есть ли `navigator.storage.getDirectory`. */
  hasOpfs: boolean;
  /** Источник страницы для показа человеку, без пути и параметров. */
  origin: string | null;
};

/** Приметы отказа хранилища в тексте исключения. */
const STORAGE_FAILURE = [
  'navigator.storage',
  'getdirectory',
  'opfs',
  'context is not secure',
  'securityerror',
];

const HTTPS_HINT =
  'Откройте страницу по https:// — если браузер снова предупредит о сертификате, ' +
  'дело в сертификате сайта, а не в вашем устройстве.';

/** Похоже ли исключение на отказ браузерного хранилища. */
export function isStorageFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return STORAGE_FAILURE.some((mark) => lower.includes(mark));
}

/**
 * Текст для экрана запуска или `null`, если ошибка не про хранилище — тогда
 * показывается исходное сообщение, и подменять его догадкой нельзя.
 */
export function diagnoseStorageFailure(message: string, env: StorageEnv): string | null {
  if (!isStorageFailure(message)) return null;
  const where = env.origin ? ` (${env.origin})` : '';

  if (env.secureContext === false) {
    return (
      `Страница открыта по незащищённому соединению${where}, и браузер не выдаёт ` +
      'приложению хранилище. AirChat держит переписку в браузерной базе, а она ' +
      `доступна только на HTTPS с действующим сертификатом. ${HTTPS_HINT}`
    );
  }

  if (!env.hasOpfs) {
    return (
      'Этот браузер не умеет хранить базу приложения: нужна файловая система ' +
      'источника (OPFS). Она есть в Safari 17 и новее, в Chrome, Edge и Firefox ' +
      'последних версий — но выключена в приватных окнах. Откройте AirChat в ' +
      'обычном окне современного браузера или поставьте приложение.'
    );
  }

  // Хранилище на месте и контекст защищённый, а база всё равно не открылась.
  // Врать про причину нечем: остаётся сказать, что известно.
  return (
    `Браузер не дал приложению открыть базу${where}. Обычно это переполненный ` +
    `диск или запрет на хранение данных для сайта в настройках браузера. ${HTTPS_HINT}`
  );
}

/** Окружение текущей вкладки. На устройстве возвращает пустые факты. */
export function currentStorageEnv(): StorageEnv {
  const w = globalThis as {
    isSecureContext?: boolean;
    location?: { origin?: string };
    navigator?: { storage?: { getDirectory?: unknown } };
  };
  return {
    secureContext: typeof w.isSecureContext === 'boolean' ? w.isSecureContext : null,
    hasOpfs: typeof w.navigator?.storage?.getDirectory === 'function',
    origin: typeof w.location?.origin === 'string' ? w.location.origin : null,
  };
}
