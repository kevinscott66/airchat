/**
 * Подписи в настройках: как называется то, что человек там видит.
 *
 * Чистые функции, вынесенные из SettingsScreen. Они ничего не знают ни о
 * состоянии экрана, ни о теме — и ровно поэтому их можно проверить тестом, а
 * не глазами на устройстве. Внутри трёхтысячестрочного экрана они были
 * непроверяемы просто из-за соседства: чтобы добраться до них, тест поднимал
 * бы весь экран с его двумя десятками эффектов.
 */
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

/** Чем заходили. Модель точнее данной пользователем подписи, поэтому первая. */
export function sessionDeviceName(device: SyncDevice): string {
  return device.deviceModel || device.label || 'Неизвестное устройство';
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
