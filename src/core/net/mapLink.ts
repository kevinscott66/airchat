/**
 * mapLink — как выглядит ссылка на точку на карте.
 *
 * v4.32.535. Одна и та же строка адреса OpenStreetMap была собрана шестью
 * копиями: дважды в списке групп, в пузыре геолокации, в пузыре живой
 * геолокации и дважды в отдельном сообщении с картой. Копии успели разойтись:
 * пять просили масштаб 16, шестая — 15; четыре подставляли координату как
 * есть, две — округлённой до шести знаков. Так одна и та же точка открывалась
 * по-разному в зависимости от того, из какого места приложения на неё нажать.
 *
 * Координаты приходят ИЗ СЕТИ — из текста сообщения собеседника. Разбор их уже
 * проверяет (`locationEnvelope`), но собирать адрес из чисел, никем не
 * проверенных прямо здесь, значит держать правило в двух местах и надеяться,
 * что второе не забудут. Поэтому проверка повторяется на самой границе: число
 * должно быть конечным и лежать в пределах широты и долготы, иначе ссылки нет.
 *
 * Округление до шести знаков — это примерно десять сантиметров на местности;
 * дальше идут не координаты, а разрядность, с которой их посчитал датчик.
 * Заодно это ограничивает длину адреса.
 *
 * Модуль чистый: ни одного импорта, никакой платформы. Какое из трёх
 * представлений показать человеку, решает вызывающий — здесь только форма.
 */

/** Масштаб, одинаковый для всех мест: дом различим, улица целиком видна. */
const MAP_ZOOM = 16;

/** Шесть знаков после запятой — около десяти сантиметров. */
const COORD_DECIMALS = 6;

/** Координата пригодна для ссылки: конечное число в своих пределах. */
export function isMapCoord(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' && typeof lon === 'number'
    && Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90
    && lon >= -180 && lon <= 180
  );
}

/** Координата в том виде, в каком она уходит в адрес. */
function coord(value: number): string {
  return String(Number(value.toFixed(COORD_DECIMALS)));
}

/**
 * Точка на карте в браузере. Работает всюду и потому служит запасным путём,
 * когда приложения карт на устройстве нет.
 */
export function mapLinkUrl(lat: number, lon: number): string | null {
  if (!isMapCoord(lat, lon)) return null;
  const la = coord(lat);
  const lo = coord(lon);
  return `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=${MAP_ZOOM}/${la}/${lo}`;
}

/**
 * Точка для Android: `geo:` открывает любое установленное приложение карт —
 * Google Maps, Яндекс, 2ГИС, — а не обязательно браузер.
 */
export function geoUri(lat: number, lon: number): string | null {
  if (!isMapCoord(lat, lon)) return null;
  const la = coord(lat);
  const lo = coord(lon);
  return `geo:${la},${lo}?q=${encodeURIComponent(`${la},${lo}`)}`;
}

/** Точка для iOS: штатное приложение «Карты». */
export function appleMapsUrl(lat: number, lon: number): string | null {
  if (!isMapCoord(lat, lon)) return null;
  const la = coord(lat);
  const lo = coord(lon);
  return `https://maps.apple.com/?q=${encodeURIComponent(`${la},${lo}`)}&ll=${la},${lo}`;
}
