/**
 * Синхронизация перестала молча выбрасывать записи (v4.32.845).
 *
 * Дефект. У прохода четыре места, где запись выбывает насовсем, и все четыре
 * писали строку в журнал и шли дальше:
 *
 *   1. `encryptEntity` отдавал `null`, когда шифротекст перевалил предел на
 *      одну сущность. Голова ей не сохранялась — значит следующий проход
 *      собирал её заново и выбрасывал так же. Вечно, каждым проходом.
 *   2. Придержанная строка (`hold`) нарочно не уезжает: показать её на другом
 *      устройстве нечем. Счёт был — но только в `log.warn`.
 *   3. Сервер отвергал один и тот же набор, и проход, поняв, что топчется на
 *      месте, переставал повторять. Правильно — и тоже молча.
 *   4. Приехавшая строка, которая здесь не проецируется, после трёх попыток
 *      признавалась испорченной; курсор уходил за неё, и сервер её больше не
 *      отдаст.
 *
 * Цена. Экран настроек в это самое время писал под заголовком
 * «Синхронизация»: «Переписка и настройки открываются на других ваших
 * устройствах», и рядом зелёное «Вкл». Для выбывших записей это неправда — а
 * именно они человеку и важны: он видит их на этом телефоне и уверен, что они
 * есть и на втором. Проверить было негде: журнал читает разработчик.
 *
 * Правка. Проход отвечает счётом невыехавшего, счёт живёт в памяти рядом с
 * состоянием связи, а экран перестаёт обещать то, чего не делает.
 */

import fs from 'fs';
import path from 'path';

import {
  NO_SYNC_STUCK,
  syncStuckBadge,
  syncStuckCount,
  syncStuckText,
  type SyncStuck,
} from '../syncStuckReport';
import {
  isSyncStuck,
  readSyncStuck,
  recordSyncStuck,
  resetSyncStuckForTests,
  subscribeSyncStuck,
} from '../syncStuckState';

const stuck = (p: Partial<SyncStuck>): SyncStuck => ({ ...NO_SYNC_STUCK, ...p });

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

/** Только код: комментарий, где написано «как надо», за исходник не считается. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

afterEach(() => {
  resetSyncStuckForTests();
});

describe('своё и чужое — разные беды, и названы порознь', () => {
  it('своё не уехало — сказано, что на других устройствах его не будет', () => {
    const text = syncStuckText(stuck({ oversize: 1 }));
    // ПРОВЕРКА НЕ ПУСТАЯ: и число, и последствие.
    expect(text).not.toBeNull();
    expect(text).toContain('1 запись');
    // Сказуемое согласовано с числом: «1 запись не уезжает», а не «не уезжают».
    expect(text).toContain('не уезжает в облачную копию');
    expect(text).toContain('на других устройствах её не будет');
  });

  it('чужое не приехало — сказано обратное: там оно осталось', () => {
    const text = syncStuckText(stuck({ poisoned: 2 }));
    expect(text).toContain('2 записи');
    expect(text).toContain('не открылись здесь');
    expect(text).toContain('там они остались');
    expect(syncStuckText(stuck({ poisoned: 1 }))).toContain('не открылась здесь — там она осталась');
    expect(text).not.toContain('не уезжают');
  });

  it('три причины «своего» складываются в одно число: человеку они неразличимы', () => {
    const text = syncStuckText(stuck({ oversize: 1, held: 1, rejected: 1 }));
    expect(text).toContain('3 записи');
    // Ни «слишком велика», ни «сервер не принял» человек руками не исправит —
    // называть их значит требовать решения, которого у него нет.
    expect(text).not.toContain('велик');
    expect(text).not.toContain('сервер');
  });

  it('и своё, и чужое сразу — сказано про обе стороны', () => {
    const text = syncStuckText(stuck({ held: 2, poisoned: 1 }));
    expect(text).toContain('2 записи не уезжают');
    expect(text).toContain('1 запись с другого устройства');
  });

  it('числа склоняются', () => {
    expect(syncStuckText(stuck({ oversize: 1 }))).toContain('1 запись ');
    expect(syncStuckText(stuck({ oversize: 4 }))).toContain('4 записи');
    expect(syncStuckText(stuck({ oversize: 5 }))).toContain('5 записей');
    expect(syncStuckText(stuck({ oversize: 11 }))).toContain('11 записей');
    expect(syncStuckText(stuck({ oversize: 21 }))).toContain('21 запись');
  });

  it('всё уехало — молчат, и значка нет', () => {
    expect(syncStuckText(NO_SYNC_STUCK)).toBeNull();
    expect(syncStuckBadge(NO_SYNC_STUCK)).toBeNull();
    expect(syncStuckCount(NO_SYNC_STUCK)).toBe(0);
    expect(syncStuckCount(stuck({ oversize: 1, held: 2, rejected: 3, poisoned: 4 }))).toBe(10);
    expect(syncStuckBadge(stuck({ held: 1 }))).toBe('Не всё');
  });
});

describe('счёт заменяется, а не копится', () => {
  it('следующий проход перебивает предыдущий', () => {
    recordSyncStuck(stuck({ oversize: 3 }));
    expect(readSyncStuck().oversize).toBe(3);
    expect(isSyncStuck()).toBe(true);
    // Запись починили — счёт обязан обнулиться, иначе предупреждение останется
    // висеть навсегда и его перестанут читать.
    recordSyncStuck(NO_SYNC_STUCK);
    expect(isSyncStuck()).toBe(false);
  });

  it('подписчика будят только на изменении', () => {
    let woke = 0;
    const off = subscribeSyncStuck(() => {
      woke += 1;
    });
    recordSyncStuck(stuck({ held: 1 }));
    recordSyncStuck(stuck({ held: 1 }));
    expect(woke).toBe(1);
    recordSyncStuck(stuck({ held: 2 }));
    expect(woke).toBe(2);
    off();
    recordSyncStuck(NO_SYNC_STUCK);
    expect(woke).toBe(2);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('прежде о выбывшей записи знал только журнал', () => {
    // Ровно то, что стояло на всех четырёх местах: строка в журнал и `continue`.
    const journal: string[] = [];
    const oldSkip = (): void => {
      journal.push('live_sync_entity_oversize');
    };
    oldSkip();
    expect(journal).toHaveLength(1);
    // Наружу при этом не уезжало ничего: у вызывающего не было поля, куда
    // это положить, — а значит и у экрана не было, что показать.
    expect(Object.keys(NO_SYNC_STUCK).sort()).toEqual([
      'held',
      'oversize',
      'poisoned',
      'rejected',
    ]);
  });

  it('прежнее обещание экрана было неправдой ровно для выбывших записей', () => {
    const oldPromise = 'Переписка и настройки открываются на других ваших устройствах';
    // Фраза осталась — но только там, где она верна.
    expect(read('ui', 'screens', 'SettingsScreen.tsx')).toContain(oldPromise);
    // А когда часть не уехала, говорят другое, и значок уже не зелёный.
    expect(syncStuckText(stuck({ oversize: 1 }))).not.toContain('открываются');
    expect(syncStuckBadge(stuck({ oversize: 1 }))).not.toBe('Вкл');
  });
});

describe('форма исходников', () => {
  const LIVE = codeOnly(read('core', 'sync', 'liveAccountSync.ts'));
  const ONCE = codeOnly(read('core', 'sync', 'accountSync.ts'));
  const SCREEN = codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));

  it('каждый пропуск при сборке считается, а не проходит молча', () => {
    expect(LIVE).toContain('let oversize = 0;');
    // Три места, где сущность не удалось зашифровать в предел.
    expect(LIVE.split('oversize += 1;').length - 1).toBe(3);
    expect(LIVE).not.toContain('if (!ciphertextB64) continue;');
    expect(LIVE).toContain('return { mutations, pendingHeads, oversize, held };');
  });

  it('испорченная входящая строка доезжает до вызывающего числом', () => {
    expect(ONCE).toContain('  poisoned: number;');
    expect(ONCE).toContain('poisoned += 1;');
    expect(ONCE).toContain("log.warn('sync_pull_row_poisoned'");
    // Необязательного поля со значением по умолчанию тут быть не должно:
    // это и есть молчаливый пропуск.
    expect(ONCE).not.toContain('poisoned?: number');
  });

  it('итог прохода записывается после ответа сервера, а не до', () => {
    const atResult = LIVE.indexOf('const stuck = hasRejected && accepted === 0');
    const atRecord = LIVE.indexOf('recordSyncStuck(seen);');
    expect(atResult).toBeGreaterThan(-1);
    expect(atRecord).toBeGreaterThan(atResult);
    expect(LIVE).toContain('poisonedTotal += result.poisoned;');
    expect(LIVE).toContain('rejected: stuck ? rejected.length : 0,');
  });

  it('экран подписан на счёт и молчит об обещании, когда оно неверно', () => {
    expect(SCREEN).toContain(
      "import { readSyncStuck, subscribeSyncStuck } from '../../core/sync/syncStuckState';",
    );
    expect(SCREEN).toContain(
      'const stuck = useSyncExternalStore(subscribeSyncStuck, readSyncStuck, readSyncStuck);',
    );
    expect(SCREEN).toContain('stuckText ?? ');
    expect(SCREEN).toContain("stuckText ? 'warning' : 'success'");
  });

  it('счёт и слова живут отдельно от сети и базы', () => {
    const mod = codeOnly(read('core', 'sync', 'syncStuckReport.ts'));
    const imports = mod.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual(["import { ruPlural } from '../text/ruPlural';"]);
    const state = codeOnly(read('core', 'sync', 'syncStuckState.ts'));
    expect(state.match(/^import .*$/gm) ?? []).toEqual([
      "import { NO_SYNC_STUCK, syncStuckCount, type SyncStuck } from './syncStuckReport';",
    ]);
  });
});
