/**
 * Отметка медленного режима: отказ базы — не «здесь я ещё не писал» (v4.32.1050).
 *
 * ДЕФЕКТ. Отметка последней отправки читалась `scopedKvGet` и писалась
 * `scopedKvSet`. Первая сводит отказ базы к null, вторая возвращает void и
 * гасит отказ внутри. То есть «не прочиталось» значило «здесь я ещё не писал»,
 * а «не записалось» вообще ничего не значило.
 *
 * ЦЕНА. Ровно та дыра, которую закрывал v4.32.271: пауза снималась выходом из
 * группы и повторным входом, «задержка в час обходилась за две секунды».
 * Отметка для того и переехала в kv, чтобы пережить экран. Не прочитали —
 * `lastSentRef` остаётся нулём, `slowModeRemaining` отвечает 0, и медленного
 * режима у этого участника нет. Не записали — пауза живёт только в ref, то
 * есть до выхода из группы. Занятой SQLite для этого достаточно: та же база
 * отвечает отказом при блокировке на пару секунд (ui_kv_get_slow).
 *
 * ПРАВКА. Чтение различающее (`scopedKvTryGet`) и с повтором, запись —
 * проверяемая (`scopedKvSetChecked`) и тоже с повтором. Отказ отмечается в
 * журнале.
 *
 * ГРАНИЦЫ. Отсчёт заводится сразу, не дожидаясь записи: он от неё не зависит.
 * Повтор записи ставится после `startSlowCooldown` — тот снимает все таймеры
 * области. Человеку про непрочитанную отметку не говорится: это подсказка о
 * том, что пауза сейчас не держится.
 */
import fs from 'fs';
import path from 'path';

import { slowModeRemaining } from '../../../core/social/groupSendPolicy';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`не нашли начало: ${from}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`не нашли конец: ${to}`);
  return src.slice(a, b);
}

const SCREEN = (): string => read('ui', 'screens', 'GroupsScreen.tsx');
/** Восстановление отметки при входе в группу. */
const LOAD = (): string =>
  slice(SCREEN(), 'const slowKey = groupLastSentKey', '}, [slowKey, startSlowCooldown]);');
/** Запись отметки после успешной отправки. */
const WRITE = (): string =>
  slice(SCREEN(), '// Отсчёт медленного режима. Отметка пишется в kv', '} catch (e) {');

describe('чтение отметки при входе', () => {
  it('читается различающим чтением', () => {
    expect(LOAD()).toContain('const read = await scopedKvTryGet(slowKey);');
  });

  it('двузначного чтения отметки не осталось', () => {
    expect(LOAD()).not.toContain('scopedKvGet(slowKey)');
  });

  it('отказ не выдаётся за пустоту, а перечитывается', () => {
    const l = LOAD();
    expect(l).toContain("log.warn('group_slow_mark_unreadable'");
    expect(l).toContain('if (attempt >= 3) return;');
    expect(l).toContain('void load(attempt + 1);');
  });

  it('повтор заводится в области таймеров, а не голым setTimeout', () => {
    // Иначе запоздавший ответ трогал бы уже размонтированный экран — см.
    // v4.32.505 про ту же область.
    expect(LOAD()).toContain('slowScopeRef.current?.timeout(');
    expect(LOAD()).not.toContain('setTimeout(');
  });

  it('прочитанная отметка заводит отсчёт как прежде', () => {
    const l = LOAD();
    expect(l).toContain('const ts = read.value ? Number(read.value) : 0;');
    expect(l).toContain('if (Number.isFinite(ts) && ts > 0) startSlowCooldown(ts);');
  });
});

describe('запись отметки после отправки', () => {
  it('запись проверяется', () => {
    expect(WRITE()).toContain('const stored = await scopedKvSetChecked(slowKey, String(sentAt));');
  });

  it('гасящей отказ записи здесь не осталось', () => {
    expect(WRITE()).not.toContain('await scopedKvSet(slowKey');
  });

  it('несостоявшаяся запись отмечается и повторяется', () => {
    const w = WRITE();
    expect(w).toContain('if (!stored) {');
    expect(w).toContain("log.warn('group_slow_mark_write_failed'");
    expect(w).toContain('void scopedKvSetChecked(slowKey, String(sentAt))');
  });

  it('ГРАНИЦА: повтор ставится после отсчёта, иначе его снимет clearAll', () => {
    const w = WRITE();
    expect(w.indexOf('startSlowCooldown(sentAt);'))
      .toBeLessThan(w.indexOf("log.warn('group_slow_mark_write_failed'"));
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: без отметки паузы нет вовсе', () => {
    // Живой вызов: ноль в `lastSentAt` — это и «не писал», и «не прочитали».
    expect(slowModeRemaining({
      role: 'member', slowModeSeconds: 3600, lastSentAt: 0, now: Date.now(),
    })).toBe(0);
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: с отметкой пауза держится', () => {
    const now = Date.now();
    expect(slowModeRemaining({
      role: 'member', slowModeSeconds: 3600, lastSentAt: now - 60_000, now,
    })).toBe(3540);
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: сами `scopedKvGet` и `scopedKvSet` по-прежнему двузначны', () => {
    const kv = read('core', 'storage', 'profileScopedKv.ts');
    expect(kv).toContain('return (await scopedKvTryGetFor(pid, key))?.value ?? null;');
    expect(kv).toContain('export async function scopedKvSet(key: string, value: string): Promise<void>');
  });

  it('ЗАКРЕПКА: запрет на отправку по-прежнему считается от отметки', () => {
    expect(SCREEN()).toContain('lastSentAt: lastSentRef.current,');
  });

  it('ЗАКРЕПКА: администрация медленным режимом не ограничена', () => {
    expect(slowModeRemaining({
      role: 'admin', slowModeSeconds: 3600, lastSentAt: Date.now(), now: Date.now(),
    })).toBe(0);
  });
});
