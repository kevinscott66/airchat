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
 * Поэтому здесь не запасной путь, а диагноз: разобрать, какая из причин
 * сработала, и сказать, чинится это сертификатом сайта, сменой браузера или
 * закрытием второй вкладки.
 *
 * v4.32.580. Третья причина — занятый файл. OPFS-хранилище expo-sqlite держит
 * пул `FileSystemSyncAccessHandle`, и такой handle на файл существует ровно
 * один на всё происхождение: вторая вкладка AirChat (или недобитая прежняя)
 * не открывает базу вовсе. Браузеры говорят об этом по-разному — Chrome
 * называет причину, WebKit отдаёт `UnknownError: ... unknown transient reason
 * (e.g. out of memory)`, из которого человек делает вывод, что у него кончилась
 * память. Повторить попытку в той же вкладке нечем: worker expo-sqlite
 * присваивает `_sqlite3` до создания VFS, поэтому после падения на
 * `AccessHandlePoolVFS.create` он остаётся с `_vfs === null` и на любой
 * следующий вызов отвечает `Invalid VFS state`. Лечится только новой загрузкой
 * страницы — значит, задача экрана в том, чтобы человек знал, что закрыть
 * перед перезагрузкой.
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

/**
 * Приметы того, что файл базы уже кем-то занят.
 *
 * Первые три — точные: так пишут Chrome и Firefox, и сомневаться не в чем.
 * Последняя — вся формулировка WebKit целиком: `UnknownError` сам по себе
 * слишком общий, им же отвечает и IndexedDB на свои беды, поэтому здесь ищется
 * не имя ошибки, а её текст, и диагноз по нему выдаётся с оговоркой.
 */
const LOCKED_EXACT = [
  'another open access handle',
  'nomodificationallowederror',
  'createsyncaccesshandle',
];
const LOCKED_VAGUE = 'unknown transient reason';

const HTTPS_HINT =
  'Откройте страницу по https:// — если браузер снова предупредит о сертификате, ' +
  'дело в сертификате сайта, а не в вашем устройстве.';

/** Похоже ли исключение на отказ браузерного хранилища. */
export function isStorageFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    STORAGE_FAILURE.some((mark) => lower.includes(mark)) ||
    isLockedFile(lower) !== null
  );
}

/**
 * Занят ли файл базы другой вкладкой: `'exact'` — браузер сказал прямо,
 * `'vague'` — так отвечает WebKit, и утверждать наверняка нельзя, `null` —
 * ошибка не про это.
 */
function isLockedFile(lower: string): 'exact' | 'vague' | null {
  if (LOCKED_EXACT.some((mark) => lower.includes(mark))) return 'exact';
  if (lower.includes(LOCKED_VAGUE)) return 'vague';
  return null;
}

const LOCKED_HOW_TO_FIX =
  'Закройте остальные вкладки с AirChat и обновите страницу. Если вкладка одна, ' +
  'значит файл держит не до конца закрытая прежняя: закройте браузер целиком — ' +
  'на iPhone смахните Safari из списка запущенных — и откройте AirChat заново. ' +
  'Данные при этом никуда не денутся: база на месте, её просто некому было отдать.';

/**
 * Текст для экрана запуска или `null`, если ошибка не про хранилище — тогда
 * показывается исходное сообщение, и подменять его догадкой нельзя.
 */
export function diagnoseStorageFailure(message: string, env: StorageEnv): string | null {
  if (!isStorageFailure(message)) return null;
  const where = env.origin ? ` (${env.origin})` : '';

  // Раньше остальных: занятый файл проходит с исправным HTTPS и живым OPFS, то
  // есть по фактам окружения неотличим от «переполненного диска» — и получил бы
  // ровно тот неверный совет, ради которого этот модуль и написан.
  const locked = isLockedFile(message.toLowerCase());
  if (locked === 'exact') {
    return (
      `Файл базы уже занят: AirChat открыт ещё где-то${where}. Браузер отдаёт ` +
      'базу одной вкладке за раз. ' +
      LOCKED_HOW_TO_FIX
    );
  }
  if (locked === 'vague') {
    return (
      `Браузер не дал приложению открыть базу${where} и не назвал причину. Почти ` +
      'всегда это значит, что файл занят: AirChat открыт в другой вкладке, а ' +
      'браузер отдаёт базу одной за раз. ' +
      LOCKED_HOW_TO_FIX
    );
  }

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
