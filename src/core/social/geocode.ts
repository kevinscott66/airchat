/**
 * geocode — обратное геокодирование для подписи пузыря места.
 *
 * v4.32.534. Функция жила в хвосте ChatScreen.tsx рядом с кодеками конвертов,
 * хотя кодеком не является: она ходит в системный геокодер через
 * expo-location. Импортировал её GroupsScreen — через экран диалога, потому
 * что другого места не было.
 *
 * Отдельно от locationEnvelope.ts намеренно: тот модуль — чистый разбор
 * строки конверта, и тянуть в него платформенный модуль нельзя.
 */

/**
 * Reverse-geocode coords into a short human address for the location bubble
 * label (e.g. «ул. Ленина, 12, Магадан»). Uses the on-device platform geocoder
 * via expo-location; fully best-effort — returns '' on any failure (offline, no
 * Play Services, no result) so the bubble falls back to showing coordinates.
 * Caller must already hold foreground-location permission.
 */
export async function reverseGeocodeLabel(lat: number, lon: number): Promise<string> {
  try {
    const Location = await import('expo-location');
    const results = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
    const a = results[0];
    if (!a) return '';
    const street = a.street ? (a.streetNumber ? `${a.street}, ${a.streetNumber}` : a.street) : (a.name ?? '');
    const city = a.city ?? a.subregion ?? a.region ?? '';
    const parts = [street, city].map((s) => (s ?? '').trim()).filter((s) => s.length > 0);
    // de-dup when street already equals the city/name
    const uniq = parts.filter((s, i) => parts.indexOf(s) === i);
    return uniq.join(', ').slice(0, 120);
  } catch {
    return '';
  }
}
