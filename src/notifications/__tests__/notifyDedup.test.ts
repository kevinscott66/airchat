/**
 * v4.32.571. Баннер показывался один раз на сообщение — или ни одного.
 * Отметка «уже показано» ставилась до показа и не снималась никогда, поэтому
 * любая осечка на пути к notifee означала, что сообщение не покажется больше
 * никогда: ни при повторе доставки оператором, ни по другому пути.
 */
import fs from 'fs';
import path from 'path';

import { NOTIFY_DEDUP_MAX, createNotifyDedup } from '../notifyDedup';

const SRC = path.join(__dirname, '..', '..');
const PUSH = (): string => fs.readFileSync(path.join(SRC, 'notifications', 'pushNotifications.ts'), 'utf8');
const MODULE = (): string => fs.readFileSync(path.join(SRC, 'notifications', 'notifyDedup.ts'), 'utf8');

describe('бронь на показ', () => {
  it('первый показ разрешён, второй по тому же ключу — нет', () => {
    const d = createNotifyDedup();
    expect(d.reserve('cid-1')).toBe(true);
    expect(d.reserve('cid-1')).toBe(false);
    expect(d.has('cid-1')).toBe(true);
  });

  it('разные ключи не мешают друг другу', () => {
    const d = createNotifyDedup();
    expect(d.reserve('a')).toBe(true);
    expect(d.reserve('b')).toBe(true);
    expect(d.size()).toBe(2);
  });

  it('снятая бронь возвращает право показать', () => {
    const d = createNotifyDedup();
    d.reserve('cid-1');
    d.release('cid-1');
    expect(d.has('cid-1')).toBe(false);
    expect(d.reserve('cid-1')).toBe(true);
  });

  it('снятие чужого ключа ничего не ломает', () => {
    const d = createNotifyDedup();
    d.reserve('a');
    d.release('b');
    d.release('');
    expect(d.has('a')).toBe(true);
    expect(d.size()).toBe(1);
  });

  it('снятие снимает только свой ключ', () => {
    const d = createNotifyDedup();
    d.reserve('a');
    d.reserve('b');
    d.release('a');
    expect(d.has('a')).toBe(false);
    expect(d.has('b')).toBe(true);
  });
});

describe('пустой ключ', () => {
  it('без ключа показ разрешён всегда — иначе первое такое сообщение запретит все', () => {
    const d = createNotifyDedup();
    expect(d.reserve('')).toBe(true);
    expect(d.reserve('')).toBe(true);
    expect(d.has('')).toBe(false);
    expect(d.size()).toBe(0);
  });
});

describe('память ограничена', () => {
  it('вытесняет самые старые ключи, храня не больше предела', () => {
    const d = createNotifyDedup(3);
    d.reserve('1');
    d.reserve('2');
    d.reserve('3');
    d.reserve('4');
    expect(d.size()).toBe(3);
    expect(d.has('1')).toBe(false);
    expect(d.has('4')).toBe(true);
  });

  it('вытесненный ключ снова можно показать — так работала и прежняя очередь', () => {
    const d = createNotifyDedup(2);
    d.reserve('1');
    d.reserve('2');
    d.reserve('3');
    expect(d.reserve('1')).toBe(true);
  });

  it('бессмысленный предел заменяется прежним значением', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = createNotifyDedup(bad);
      for (let i = 0; i < NOTIFY_DEDUP_MAX + 5; i += 1) d.reserve(`k${i}`);
      expect(d.size()).toBe(NOTIFY_DEDUP_MAX);
    }
  });

  it('предел по умолчанию — прежние двести ключей', () => {
    expect(NOTIFY_DEDUP_MAX).toBe(200);
    const d = createNotifyDedup();
    for (let i = 0; i < 400; i += 1) d.reserve(`k${i}`);
    expect(d.size()).toBe(200);
  });

  it('тысяча повторов одного ключа не раздувает память', () => {
    const d = createNotifyDedup();
    for (let i = 0; i < 1000; i += 1) d.reserve('same');
    expect(d.size()).toBe(1);
  });
});

describe('ветка показа берёт бронь, а на отказе возвращает', () => {
  const dmBannerBody = (): string => {
    const s = PUSH();
    const at = s.indexOf('private async showDmBanner(');
    expect(at).toBeGreaterThan(-1);
    const end = s.indexOf('\n  async registerTokenWithSignaling(', at);
    expect(end).toBeGreaterThan(at);
    return s.slice(at, end);
  };

  it('бронь берётся до чтения настроек и до показа', () => {
    const body = dmBannerBody();
    const reserve = body.indexOf('if (!notifyDedup.reserve(cid)) {');
    expect(reserve).toBeGreaterThan(-1);
    expect(reserve).toBeLessThan(body.indexOf("kvGet('notify_preview')"));
    expect(reserve).toBeLessThan(body.indexOf('await notifee.displayNotification({'));
  });

  it('на отказе показа бронь снимается', () => {
    const body = dmBannerBody();
    const release = body.indexOf('notifyDedup.release(cid);');
    expect(release).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(body.indexOf('await notifee.displayNotification({'));
    expect(release).toBeLessThan(body.indexOf("log.warn('push_local_notify_failed'"));
  });

  it('прежней отметки без снятия не осталось', () => {
    const s = PUSH();
    expect(s).not.toContain('function markNotifyCid');
    expect(s).not.toContain('recentNotifyCids');
    expect(s).not.toContain('markNotifyCid(cid);');
  });

  it('учёт один на весь модуль, а не свой на каждый показ', () => {
    const s = PUSH();
    expect(s).toContain('const notifyDedup = createNotifyDedup(NOTIFY_DEDUP_MAX);');
    expect(s.split('createNotifyDedup(').length - 1).toBe(1);
  });
});

describe('модуль проверяем в отрыве от notifee', () => {
  it('ни одного импорта', () => {
    expect(MODULE()).not.toMatch(/^import /m);
  });
});
