/**
 * Рэтчет к v4.32.535: одна точка на карте — один адрес.
 *
 * До этого адрес OpenStreetMap собирали шесть раз вручную, и копии разошлись:
 * разный масштаб, разная точность координаты. Тесты закрепляют форму адреса и
 * отказ на негодных числах, чтобы копии не завелись заново.
 */
import { appleMapsUrl, geoUri, isMapCoord, mapLinkUrl } from '../mapLink';

const MOSCOW: [number, number] = [55.755826, 37.6173];

describe('isMapCoord', () => {
  it('принимает координату в пределах широты и долготы', () => {
    expect(isMapCoord(MOSCOW[0], MOSCOW[1])).toBe(true);
    expect(isMapCoord(0, 0)).toBe(true);
    expect(isMapCoord(-90, -180)).toBe(true);
    expect(isMapCoord(90, 180)).toBe(true);
  });

  it('отвергает нечисловое, бесконечное и NaN', () => {
    expect(isMapCoord(NaN, 0)).toBe(false);
    expect(isMapCoord(0, NaN)).toBe(false);
    expect(isMapCoord(Infinity, 0)).toBe(false);
    expect(isMapCoord(0, -Infinity)).toBe(false);
    expect(isMapCoord('55.7', 37.6)).toBe(false);
    expect(isMapCoord(null, 0)).toBe(false);
    expect(isMapCoord(undefined, undefined)).toBe(false);
  });

  it('отвергает выход за пределы глобуса', () => {
    expect(isMapCoord(90.0001, 0)).toBe(false);
    expect(isMapCoord(-90.0001, 0)).toBe(false);
    expect(isMapCoord(0, 180.0001)).toBe(false);
    expect(isMapCoord(0, -180.0001)).toBe(false);
  });
});

describe('адрес точки', () => {
  it('все три вида отказывают на негодной координате', () => {
    expect(mapLinkUrl(NaN, 0)).toBeNull();
    expect(geoUri(0, Infinity)).toBeNull();
    expect(appleMapsUrl(91, 0)).toBeNull();
  });

  it('браузерный адрес один и тот же и просит масштаб 16', () => {
    const url = mapLinkUrl(MOSCOW[0], MOSCOW[1]);
    expect(url).toBe('https://www.openstreetmap.org/?mlat=55.755826&mlon=37.6173#map=16/55.755826/37.6173');
  });

  it('geo: несёт координату и q-параметр', () => {
    expect(geoUri(MOSCOW[0], MOSCOW[1])).toBe('geo:55.755826,37.6173?q=55.755826%2C37.6173');
  });

  it('адрес Apple Maps экранирует запятую в q', () => {
    expect(appleMapsUrl(MOSCOW[0], MOSCOW[1])).toBe('https://maps.apple.com/?q=55.755826%2C37.6173&ll=55.755826,37.6173');
  });

  it('лишние знаки после запятой срезаются до шести', () => {
    expect(mapLinkUrl(1.123456789, 2.987654321)).toBe('https://www.openstreetmap.org/?mlat=1.123457&mlon=2.987654#map=16/1.123457/2.987654');
  });

  it('целая координата не превращается в 1.000000', () => {
    expect(mapLinkUrl(1, 2)).toBe('https://www.openstreetmap.org/?mlat=1&mlon=2#map=16/1/2');
  });

  it('координата не уходит в экспоненциальную запись', () => {
    const url = mapLinkUrl(0.0000001, 0.0000002);
    expect(url).not.toContain('e-');
    expect(url).toBe('https://www.openstreetmap.org/?mlat=0&mlon=0#map=16/0/0');
  });

  it('отрицательные координаты сохраняют знак', () => {
    expect(mapLinkUrl(-33.8688, -151.2093)).toContain('mlat=-33.8688&mlon=-151.2093');
  });
});
