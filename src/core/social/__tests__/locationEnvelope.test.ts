/**
 * Место и живая геолокация от чужого клиента.
 *
 * Координаты и срок жизни проверялись строго, а подпись места — только по
 * длине. Подпись рисуется заголовком пузыря вместо слова «Геолокация», так
 * что перевод строки и невидимый U+202E показывали там что угодно.
 */

import {
  LIVELOC_PREFIX,
  LOCATION_PREFIX,
  MAX_LOCATION_ENVELOPE,
  MAX_LOCATION_LABEL,
  isLiveLocMessage,
  isLocationMessage,
  makeLiveLocText,
  makeLocationText,
  parseLiveLoc,
  parseLocationMeta,
  sanitizeLocationLabel,
} from '../locationEnvelope';

const NOW = 1_800_000_000_000;
const rawLoc = (payload: unknown): string => `${LOCATION_PREFIX}${JSON.stringify(payload)}`;
const rawLive = (payload: unknown): string => `${LIVELOC_PREFIX}${JSON.stringify(payload)}`;

describe('sanitizeLocationLabel', () => {
  it('обычный адрес не меняется', () => {
    expect(sanitizeLocationLabel('ул. Ленина, 12, Магадан')).toBe('ул. Ленина, 12, Магадан');
  });

  it('перевод строки не дописывает вторую строку к заголовку', () => {
    expect(sanitizeLocationLabel('Дом\nПодтверждено AirChat')).toBe('Дом Подтверждено AirChat');
  });

  it('метки направления письма вырезаются', () => {
    expect(sanitizeLocationLabel('дом\u202EабмаР')).toBe('домабмаР');
  });

  it('не строка, пустое или одни невидимки — пустая подпись', () => {
    for (const v of [null, undefined, 42, {}, [], '', '   ', '\u202E', '\n\t']) {
      expect(sanitizeLocationLabel(v)).toBe('');
    }
  });

  it('длина ограничена', () => {
    expect(sanitizeLocationLabel('я'.repeat(300)).length).toBe(MAX_LOCATION_LABEL);
  });
});

describe('parseLocationMeta', () => {
  it('round-trip', () => {
    const t = makeLocationText(59.9386, 30.3141, 'Дворцовая площадь');
    expect(isLocationMessage(t)).toBe(true);
    expect(parseLocationMeta(t)).toEqual({ lat: 59.9386, lon: 30.3141, label: 'Дворцовая площадь' });
  });

  it('подпись чистится на приёме', () => {
    expect(parseLocationMeta(rawLoc({ lat: 0, lon: 0, label: 'дом\u202EабмаР' }))!.label).toBe('домабмаР');
    expect(parseLocationMeta(rawLoc({ lat: 0, lon: 0, label: 'а\nб' }))!.label).toBe('а б');
  });

  it('подпись не строкой — пустая, но само место остаётся', () => {
    expect(parseLocationMeta(rawLoc({ lat: 1, lon: 2, label: { a: 1 } }))).toEqual({ lat: 1, lon: 2, label: '' });
    expect(parseLocationMeta(rawLoc({ lat: 1, lon: 2 }))).toEqual({ lat: 1, lon: 2, label: '' });
  });

  it('координаты вне диапазона или не числом — конверт отброшен', () => {
    for (const p of [
      { lat: 91, lon: 0 }, { lat: -91, lon: 0 }, { lat: 0, lon: 181 }, { lat: 0, lon: -181 },
      { lat: '55', lon: 0 }, { lat: 0, lon: null }, { lat: NaN, lon: 0 }, { lat: 0, lon: Infinity },
    ]) {
      expect(parseLocationMeta(rawLoc(p))).toBeNull();
    }
  });

  it('не конверт места или битый JSON — null', () => {
    for (const t of ['', 'привет', LOCATION_PREFIX, `${LOCATION_PREFIX}не json`, rawLoc([1, 2]), rawLoc('строка')]) {
      expect(parseLocationMeta(t)).toBeNull();
    }
  });
});

describe('parseLiveLoc', () => {
  const ok = { lat: 55.75, lon: 37.61, expireAt: NOW + 60_000, liveId: 'live-1' };

  it('round-trip', () => {
    const t = makeLiveLocText(ok);
    expect(isLiveLocMessage(t)).toBe(true);
    expect(parseLiveLoc(t, NOW)).toEqual(ok);
  });

  it('подпись чистится, пустая не попадает в результат', () => {
    expect(parseLiveLoc(rawLive({ ...ok, label: 'дом\u202EабмаР' }), NOW)!.label).toBe('домабмаР');
    expect(parseLiveLoc(rawLive({ ...ok, label: '' }), NOW)).not.toHaveProperty('label');
    expect(parseLiveLoc(rawLive({ ...ok, label: '\u202E' }), NOW)).not.toHaveProperty('label');
  });

  it('срок за пределами восьми часов — пузырь не станет вечно «живым»', () => {
    expect(parseLiveLoc(rawLive({ ...ok, expireAt: NOW + 9 * 60 * 60_000 }), NOW)).toBeNull();
    expect(parseLiveLoc(rawLive({ ...ok, expireAt: 9e15 }), NOW)).toBeNull();
  });

  it('v4.32.563: закончившаяся сессия разбирается, а не исчезает', () => {
    // До этой версии нижняя граница отвергала посылку через минуту после
    // конца сессии: в переписке пузырь становился пустым прямоугольником, в
    // группе на экран выпадал сырой конверт. Ветка «Геолокация завершена»
    // была недостижима.
    expect(parseLiveLoc(rawLive({ ...ok, expireAt: NOW - 30_000 }), NOW)).not.toBeNull();
    expect(parseLiveLoc(rawLive({ ...ok, expireAt: NOW - 120_000 }), NOW)).not.toBeNull();
    expect(parseLiveLoc(rawLive({ ...ok, expireAt: NOW - 9 * 60 * 60_000 }), NOW)!.expireAt).toBe(
      NOW - 9 * 60 * 60_000,
    );
  });

  it('v4.32.563: время отправки принимается, но не из будущего', () => {
    expect(parseLiveLoc(rawLive({ ...ok, ts: NOW - 90_000 }), NOW)!.ts).toBe(NOW - 90_000);
    expect(parseLiveLoc(rawLive({ ...ok, ts: NOW - 9e11 }), NOW)!.ts).toBe(NOW - 9e11);
    // Иначе вечно «свежая» точка — тот же приём, что и expireAt на сто лет.
    for (const ts of [NOW + 120_000, 9e15, Infinity, NaN, '5', null]) {
      expect(parseLiveLoc(rawLive({ ...ok, ts }), NOW)).not.toHaveProperty('ts');
    }
    expect(parseLiveLoc(rawLive({ ...ok }), NOW)).not.toHaveProperty('ts');
  });

  it('expireAt не числом — null', () => {
    for (const expireAt of [undefined, null, 'скоро', NaN, Infinity]) {
      expect(parseLiveLoc(rawLive({ ...ok, expireAt }), NOW)).toBeNull();
    }
  });

  it('liveId не строкой, пустой или огромный — null', () => {
    for (const liveId of [undefined, null, 5, '', 'x'.repeat(129)]) {
      expect(parseLiveLoc(rawLive({ ...ok, liveId }), NOW)).toBeNull();
    }
  });

  it('координаты вне диапазона — null', () => {
    expect(parseLiveLoc(rawLive({ ...ok, lat: 200 }), NOW)).toBeNull();
    expect(parseLiveLoc(rawLive({ ...ok, lon: '37' }), NOW)).toBeNull();
  });

  it('не конверт живой геолокации — null', () => {
    for (const t of ['', 'привет', LIVELOC_PREFIX, `${LIVELOC_PREFIX}{`, rawLive([1]), rawLive(7)]) {
      expect(parseLiveLoc(t, NOW)).toBeNull();
    }
  });
});

/**
 * v4.32.380. Ни у места, ни у живой геолокации потолка длины до JSON.parse не
 * было. Живая геолокация приходит ещё и повторно, обновлением за обновлением.
 */
describe('потолок длины конверта', () => {
  it('настоящее место с самой длинной подписью проходит', () => {
    const s = makeLocationText(55.75, 37.61, 'у'.repeat(MAX_LOCATION_LABEL));
    expect(s.length).toBeLessThanOrEqual(MAX_LOCATION_ENVELOPE);
    expect(parseLocationMeta(s)?.label).toHaveLength(MAX_LOCATION_LABEL);
  });

  it('место длиннее потолка отвергается', () => {
    expect(parseLocationMeta(rawLoc({ lat: 55.75, lon: 37.61, junk: 'x'.repeat(MAX_LOCATION_ENVELOPE) }))).toBeNull();
  });

  it('живая геолокация длиннее потолка отвергается', () => {
    const s = rawLive({ lat: 55.75, lon: 37.61, expireAt: NOW + 60_000, liveId: 'a', junk: 'x'.repeat(MAX_LOCATION_ENVELOPE) });
    expect(parseLiveLoc(s, NOW)).toBeNull();
  });

  it('до JSON.parse дело не доходит ни там, ни там', () => {
    const spy = jest.spyOn(JSON, 'parse');
    try {
      expect(parseLocationMeta(LOCATION_PREFIX + 'x'.repeat(MAX_LOCATION_ENVELOPE))).toBeNull();
      expect(parseLiveLoc(LIVELOC_PREFIX + 'x'.repeat(MAX_LOCATION_ENVELOPE), NOW)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
