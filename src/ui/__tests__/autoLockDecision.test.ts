/**
 * Замок при выходе: непрочитанная настройка — это не «выключено» (v4.32.724).
 *
 * Отказ базы на этом чтении правдоподобен и не редок: SQLite блокируется на
 * секунды, а приложение может подняться из переключателя до первой разблокировки
 * устройства. Прежде такой отказ был неотличим от выключенного замка, и телефон
 * открывался прямо в переписку.
 */
import * as fs from 'fs';
import * as path from 'path';

import { autoLockEnabled } from '../autoLockDecision';

describe('autoLockEnabled', () => {
  it('замок включён — запираем', () => {
    expect(autoLockEnabled({ value: 'true' })).toBe(true);
  });

  it('замок выключен — не запираем', () => {
    expect(autoLockEnabled({ value: 'false' })).toBe(false);
  });

  it('настройки нет вовсе — не запираем: человек её не включал', () => {
    expect(autoLockEnabled({ value: null })).toBe(false);
  });

  it('прочитать не удалось — запираем', () => {
    // Здесь и лежал дефект: этот случай приходил тем же null, что и «выключено».
    expect(autoLockEnabled(null)).toBe(true);
  });

  it('«не смогли прочитать» и «выключено» решаются по-разному', () => {
    expect(autoLockEnabled(null)).not.toBe(autoLockEnabled({ value: 'false' }));
  });
});

describe('App подключает решение, а не читает настройку напрямую', () => {
  const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'App.tsx'), 'utf8');

  it('настройка замка читается различающим kvTryGet', () => {
    expect(APP).toContain("await kvTryGet('auto_lock_on_exit')");
    // kvGet стёр бы разницу обратно.
    expect(APP).not.toContain("kvGet('auto_lock_on_exit')");
  });

  it('решение принимает autoLockEnabled', () => {
    expect(APP).toContain('if (!autoLockEnabled(lockRead)) return;');
  });

  it('непрочитанная настройка оставляет след в журнале', () => {
    expect(APP).toContain("log.warn('auto_lock_pref_unreadable')");
  });
});
