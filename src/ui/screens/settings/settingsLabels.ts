/**
 * Подписи в настройках: как называется то, что человек там видит.
 *
 * Чистые функции, вынесенные из SettingsScreen. Они ничего не знают ни о
 * состоянии экрана, ни о теме — и ровно поэтому их можно проверить тестом, а
 * не глазами на устройстве. Внутри трёхтысячестрочного экрана они были
 * непроверяемы просто из-за соседства: чтобы добраться до них, тест поднимал
 * бы весь экран с его двумя десятками эффектов.
 */
import { formatByteSize } from '../../../core/media/byteSize';
import type { SyncDevice } from '../../../core/sync/syncApi';

/**
 * Запасной список стран — на случай, если в этой сборке Hermes нет
 * Intl.DisplayNames. Здесь только те, откуда заходят чаще всего.
 */
const COUNTRY_NAMES: Record<string, string> = {
  RU: 'Россия', UA: 'Украина', KZ: 'Казахстан', BY: 'Беларусь', DE: 'Германия',
  US: 'США', TR: 'Турция', AM: 'Армения', GE: 'Грузия',
};

/**
 * Название страны по её коду.
 *
 * v4.32.595: список выше знал девять стран, а сервер с этой версии отвечает
 * кодом для любого выделенного блока адресов. Всё остальное показывалось как
 * «AE» или «NL» — формально верно и человеку бесполезно. Intl.DisplayNames
 * знает их все и склоняет по-русски, но собран он не в каждой сборке Hermes,
 * поэтому обращение к нему обёрнуто: не вышло — остаётся прежний список, за
 * ним сам код.
 */
let countryNamer: Intl.DisplayNames | null | undefined;

export function countryName(code: string): string {
  if (countryNamer === undefined) {
    try {
      countryNamer = new Intl.DisplayNames(['ru'], { type: 'region', fallback: 'none' });
    } catch {
      countryNamer = null;
    }
  }
  try {
    const named = countryNamer?.of(code);
    if (named && named !== code) return named;
  } catch {
    // Код не из ISO 3166 — ниже отработает запасной список.
  }
  return COUNTRY_NAMES[code] ?? code;
}

/** Откуда заходили: город и страна, насколько их знает сервер. */
export function sessionLocation(device: SyncDevice): string {
  const country = device.countryCode ? countryName(device.countryCode) : '';
  return [device.city, country].filter(Boolean).join(', ') || 'Регион не определён';
}

/**
 * Как приложение до v4.32.848 называло любой браузер. Сессии с этой подписью
 * уже лежат на сервере и будут лежать ещё долго: строку пишет то устройство,
 * которое входило, и задним числом её не исправить.
 */
const UNNAMED_BROWSER = 'Web browser';

/** Чем заходили. Модель точнее данной пользователем подписи, поэтому первая. */
export function sessionDeviceName(device: SyncDevice): string {
  const model = device.deviceModel ?? '';
  // v4.32.848: «Web browser» — не название браузера, а признак того, что его
  // не спросили. По-русски это и написано: человек, читающий список ради
  // вопроса «чей это вход», должен видеть, что здесь ответа нет, а не
  // англоязычную подпись, похожую на имя программы.
  if (model === UNNAMED_BROWSER) return device.label || 'Неизвестный браузер';
  return model || device.label || 'Неизвестное устройство';
}

/** Как платформа называется по-русски. Веб — это для человека браузер. */
const PLATFORM_LABEL: Record<string, string> = {
  ios: 'iOS',
  android: 'Android',
  web: 'Браузер',
  macos: 'macOS',
  windows: 'Windows',
};

/**
 * Чем платформа обозначает «версию не знаю». На вебе `Platform.Version` —
 * ровно «0.0.0», и до v4.32.848 оно так и печаталось рядом со словом Web:
 * версия, которой никогда не существовало, в списке, по которому решают, свой
 * это вход или чужой.
 */
const NO_VERSION = new Set(['', '0', '0.0', '0.0.0', 'unknown', 'undefined', 'null', 'nan']);

/**
 * Вторая строка сессии: система и версия приложения.
 *
 * Правило склейки одно и держится на том, что записано в поле. Если версия —
 * голое число (iOS «26.0», Android «14»), она принадлежит названию платформы и
 * пишется с ним слитно. Если там названная система («macOS 14.6» из строки
 * агента браузера), она сама себя называет и стоит отдельным словом.
 */
export function sessionSystemLine(device: SyncDevice): string {
  const platform = device.platform ? PLATFORM_LABEL[device.platform] ?? device.platform : '';
  const os = (device.osVersion ?? '').trim();
  const known = os !== '' && !NO_VERSION.has(os.toLowerCase());
  const head = !known
    ? platform
    : /^[0-9]/.test(os)
      ? `${platform} ${os}`.trim()
      : [platform, os].filter(Boolean).join(' · ');
  const app = (device.appVersion ?? '').trim();
  return [head, app ? `AirChat ${app}` : ''].filter(Boolean).join(' · ');
}

/**
 * Размер кэша словами (v4.32.880).
 *
 * Раньше состояний было два — число и `null`, — а положений три: считаем,
 * посчитали, посчитать не вышло. Отказ чтения папки клал тот же `null`, что и
 * до начала подсчёта, и строка «Вычисляется…» оставалась на экране навсегда.
 * Человек ждал числа, которого не будет, и не знал, стоит ли жать «Очистить»;
 * после очистки поверх этого «Вычисляется…» ещё и говорили «Кэш очищен».
 */
export type CacheSizePhase = 'loading' | 'ready' | 'unknown';

export const CACHE_SIZE_LOADING_TEXT = 'Вычисляется…';
export const CACHE_SIZE_UNKNOWN_TEXT = 'Размер посчитать не удалось';

export function cacheSizeLabel(phase: CacheSizePhase, bytes: number | null): string {
  if (phase === 'loading') return CACHE_SIZE_LOADING_TEXT;
  if (phase === 'ready' && bytes !== null) return formatByteSize(bytes);
  return CACHE_SIZE_UNKNOWN_TEXT;
}

/**
 * Срок автоудаления словами. Округляет вниз до знакомого срока: показать
 * «1 день» там, где стоит 25 часов, честнее, чем «25 ч» — выбирают-то из
 * четырёх готовых значений, а не вводят число.
 */
export function autoDeleteLabel(ms: number | null): string {
  if (!ms) return 'Выкл';
  if (ms >= 86_400_000 * 7) return '7 дней';
  if (ms >= 86_400_000) return '1 день';
  if (ms >= 3_600_000) return '1 час';
  return '1 мин';
}
