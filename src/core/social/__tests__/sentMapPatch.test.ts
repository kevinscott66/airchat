/**
 * Карта «кому что отправлено»: правка вместо снимка и один владелец на заход.
 *
 * v4.32.479. Обе службы рассылки читали карту целиком, уходили в сеть на
 * секунды и записывали свой снимок обратно — поверх того, что за это время
 * записал сосед, и в namespace того профиля, который активен К МОМЕНТУ ЗАПИСИ,
 * а не к моменту чтения.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  isSentFlag,
  isSentVersion,
  mergeSentMap,
  parseSentMap,
  trimSentMap,
} from '../sentMap';

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const profileSrc = read('social/profileSync.ts');
const presenceSrc = read('social/presencePrefSync.ts');
const kvSrc = read('storage/profileScopedKv.ts');

describe('правка ложится поверх того, что в базе сейчас', () => {
  it('чужая запись, появившаяся во время рассылки, не теряется', () => {
    const stored = { anna: 1, boris: 2 };
    expect(mergeSentMap(stored, { vera: 3 })).toEqual({ anna: 1, boris: 2, vera: 3 });
  });

  it('отменённое значение не восстанавливается снимком', () => {
    // Сосед сказал собеседнику «не показывай» (false). Наша правка его не
    // касается — и не должна вернуть туда true.
    const stored = { anna: false };
    expect(mergeSentMap(stored, { boris: true })).toEqual({ anna: false, boris: true });
  });

  it('правка того же адресата побеждает сохранённое', () => {
    expect(mergeSentMap({ anna: true }, { anna: false })).toEqual({ anna: false });
  });

  it('правленый адресат уходит в конец, чтобы его не срезала обрезка', () => {
    const merged = mergeSentMap({ anna: 1, boris: 2 }, { anna: 9 });
    expect(Object.keys(merged)).toEqual(['boris', 'anna']);
  });

  it('пустая правка ничего не меняет', () => {
    expect(mergeSentMap({ anna: 1 }, {})).toEqual({ anna: 1 });
  });
});

describe('обрезка режет самых старых', () => {
  it('оставляет предел последних', () => {
    expect(trimSentMap({ a: 1, b: 2, c: 3 }, 2)).toEqual({ b: 2, c: 3 });
  });

  it('карта короче предела не трогается', () => {
    const map = { a: 1 };
    expect(trimSentMap(map, 5)).toBe(map);
  });

  it('только что записанное переживает обрезку', () => {
    const merged = mergeSentMap({ a: 1, b: 2, c: 3 }, { a: 9 });
    expect(trimSentMap(merged, 2)).toEqual({ c: 3, a: 9 });
  });
});

describe('разбор сохранённого', () => {
  it('пустая и испорченная запись — это «ничего не отправляли»', () => {
    expect(parseSentMap(null, isSentVersion)).toEqual({});
    expect(parseSentMap('', isSentVersion)).toEqual({});
    expect(parseSentMap('{не json', isSentVersion)).toEqual({});
    expect(parseSentMap('[1,2]', isSentVersion)).toEqual({});
    expect(parseSentMap('"строка"', isSentVersion)).toEqual({});
  });

  it('значения не того типа отбрасываются поимённо', () => {
    expect(parseSentMap('{"a":1,"b":"два","c":null}', isSentVersion)).toEqual({ a: 1 });
    expect(parseSentMap('{"a":true,"b":1}', isSentFlag)).toEqual({ a: true });
  });

  it('NaN и бесконечность версией не считаются', () => {
    expect(isSentVersion(NaN)).toBe(false);
    expect(isSentVersion(Infinity)).toBe(false);
    expect(isSentVersion(0)).toBe(true);
  });

  it('__proto__ в записи не подменяет прототип', () => {
    const map = parseSentMap('{"__proto__":1,"a":2}', isSentVersion);
    expect(map).toEqual({ a: 2 });
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });
});

describe('у захода один владелец от начала до конца', () => {
  it('профильный kv умеет записывать названному профилю', () => {
    expect(kvSrc).toContain('export async function scopedKvSetFor(pid: number, key: string, value: string)');
    expect(kvSrc).toContain('await scopedKvSetFor(activeProfileId(), key, value);');
  });

  it('рассылка профиля выбирает профиль один раз и больше не спрашивает экран', () => {
    expect(profileSrc).not.toMatch(/await scopedKvGet\(/);
    expect(profileSrc).toContain('const pid = activeProfileId();');
    expect(profileSrc).toContain('await listContactsFor(pid)');
    expect(profileSrc).toContain('await buildEnvelope(pid)');
    expect(profileSrc).toContain('await getOwnDisplayNameFor(pid)');
  });

  it('рассылка решения о времени входа — так же', () => {
    expect(presenceSrc).not.toMatch(/await scopedKvGet\(/);
    expect(presenceSrc).toContain('const pid = activeProfileId();');
    expect(presenceSrc).toContain('await listContactsFor(pid)');
    expect(presenceSrc).toContain('await currentVisibility(pid)');
  });

  it('переключение аккаунта посреди рассылки её останавливает', () => {
    expect(profileSrc).toContain("log.info('profile_broadcast_profile_switched'");
    expect(presenceSrc).toContain("log.info('presence_pref_profile_switched'");
    for (const src of [profileSrc, presenceSrc]) {
      expect(src).toContain('if (activeProfileId() !== pid) {');
    }
  });

  it('снимок карты обратно не записывается — только правка, по очереди', () => {
    for (const src of [profileSrc, presenceSrc]) {
      expect(src).not.toContain('saveSent(sent)');
      expect(src).toContain('let sentTx: Promise<unknown> = Promise.resolve();');
      expect(src).toContain('const started = sentTx.then(run, run);');
      expect(src).toContain('sentTx = started.catch(() => {});');
      expect(src).toContain('await recordSent(pid,');
    }
  });
});

describe('проверка не пустая', () => {
  it('исходники прочитаны', () => {
    expect(profileSrc.length).toBeGreaterThan(1000);
    expect(presenceSrc.length).toBeGreaterThan(1000);
    expect(kvSrc.length).toBeGreaterThan(1000);
  });
});
