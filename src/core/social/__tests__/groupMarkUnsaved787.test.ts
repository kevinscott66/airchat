/**
 * База не приняла пометку — человек всё равно не возвращается (v4.32.787).
 *
 * Дефект. Пометки «из этой группы я вышел» (v4.32.621) и «этого человека
 * отсюда исключили» (v4.32.618) — единственное, что стоит между человеком и
 * повтором старого конверта. Строки в составе группы к этому моменту уже нет:
 * выход её удаляет, kick тоже. Реле хранит конверты тридцать суток, темы
 * выводятся из открытых DID, и переслать те же подписанные байты может кто
 * угодно — сам приглашавший, сосед по группе, посторонний со снимком трафика.
 * Без пометки повтор неотличим от законного первого приглашения.
 *
 * Обе пометки писались гасящей `scopedKvSetFor`. Та зовёт проверяемую форму и
 * ВЫБРАСЫВАЕТ её ответ, так что собственный `try/catch` у пометок не
 * срабатывал никогда: занятой на долю секунды базы хватало, чтобы пометки не
 * стало совсем, и об этом не говорилось ни строчкой. Цена — покинутая группа
 * заводится на устройстве заново, с прежней перепиской и прежним составом; а
 * исключённый по старой ссылке возвращается к каждому, у кого нет
 * пригласительного токена, то есть ко всем, кроме администраторов.
 *
 * Правка. Пишем проверяемой формой. Не легло — пометка живёт в памяти
 * процесса (markFallback) и судит наравне с диском, а первое же чтение
 * пробует дописать её на диск, чтобы она пережила перезапуск.
 */
const mockKv = new Map<string, string>();
const mockState = { failSet: false, readable: true };

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: jest.fn(async (pid: number, key: string) =>
    (mockState.readable ? { value: mockKv.get(`${pid}|${key}`) ?? null } : null)),
  // Гасящая форма подделана так же, как она устроена в profileScopedKv: зовёт
  // проверяемую и выбрасывает её ответ. Без неё встречная проверка (файлы до
  // правки) шла бы не по настоящему коду, а спотыкалась о невыставленную
  // заглушку.
  scopedKvSetFor: jest.fn(async (pid: number, key: string, value: string) => {
    if (mockState.failSet) return;
    mockKv.set(`${pid}|${key}`, value);
  }),
  // Ровно так отказывает настоящая проверяемая запись: значение не легло, и об
  // этом сказано ответом, а не исключением.
  scopedKvSetCheckedFor: jest.fn(async (pid: number, key: string, value: string) => {
    if (mockState.failSet) return false;
    mockKv.set(`${pid}|${key}`, value);
    return true;
  }),
  scopedKvDeleteFor: jest.fn(async (pid: number, key: string) => {
    mockKv.delete(`${pid}|${key}`);
  }),
}));

import * as fs from 'fs';
import * as path from 'path';

import { clearGroupLeft, inviteNewerThanLeave, leaveMarkKey, markGroupLeft } from '../groupLeaveMark';
import {
  clearGroupRemoval,
  markGroupRemoval,
  removalMarkKey,
  wasRemovedFromGroup,
} from '../groupRemovalMark';
import { createMarkFallback } from '../markFallback';

const PID = 7;
const PEER = 'cGVlcg==';

/** Лежит ли пометка на диске — независимо от того, что помнит процесс. */
const leftOnDisk = (groupId: string): string | null =>
  mockKv.get(`${PID}|${leaveMarkKey(groupId)}`) ?? null;

const removedOnDisk = (groupId: string): string | null =>
  mockKv.get(`${PID}|${removalMarkKey(PEER, groupId)}`) ?? null;

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockState.failSet = false;
  mockState.readable = true;
});

describe('выход: база отказала в пометке', () => {
  it('повтор приглашения всё равно отвергнут', async () => {
    mockState.failSet = true;
    await markGroupLeft('g-leave-hold', PID, 5_000);
    expect(leftOnDisk('g-leave-hold')).toBeNull();

    // До правки здесь возвращалось true: пометки нет, значит «новое
    // приглашение», и покинутая группа заводилась заново.
    mockState.failSet = false;
    expect(await inviteNewerThanLeave('g-leave-hold', PID, 4_000)).toBe(false);
  });

  it('первое же чтение дописывает пометку на диск', async () => {
    mockState.failSet = true;
    await markGroupLeft('g-leave-repair', PID, 5_000);

    mockState.failSet = false;
    await inviteNewerThanLeave('g-leave-repair', PID, 4_000);
    // Теперь она переживёт перезапуск — память процесса больше не нужна.
    expect(leftOnDisk('g-leave-repair')).toBe('5000');
  });

  it('законное новое приглашение проходит и по памяти процесса', async () => {
    mockState.failSet = true;
    await markGroupLeft('g-leave-newer', PID, 5_000);

    mockState.failSet = false;
    expect(await inviteNewerThanLeave('g-leave-newer', PID, 6_000)).toBe(true);
  });

  it('снятие пометки чистит и память процесса', async () => {
    mockState.failSet = true;
    await markGroupLeft('g-leave-clear', PID, 5_000);

    mockState.failSet = false;
    await clearGroupLeft('g-leave-clear', PID);
    // Пометки нет нигде: приглашение принято по существу.
    expect(await inviteNewerThanLeave('g-leave-clear', PID, 4_000)).toBe(true);
    expect(leftOnDisk('g-leave-clear')).toBeNull();
  });
});

describe('исключение: база отказала в пометке', () => {
  it('исключённый по старой ссылке не возвращается', async () => {
    mockState.failSet = true;
    await markGroupRemoval('g-kick-hold', PEER, PID, 5_000);
    expect(removedOnDisk('g-kick-hold')).toBeNull();

    // До правки здесь возвращалось false: памяти об исключении не осталось, и
    // голый join принимался как приход нового участника.
    mockState.failSet = false;
    expect(await wasRemovedFromGroup('g-kick-hold', PEER, PID)).toBe(true);
  });

  it('первое же чтение дописывает пометку на диск', async () => {
    mockState.failSet = true;
    await markGroupRemoval('g-kick-repair', PEER, PID, 5_000);

    mockState.failSet = false;
    await wasRemovedFromGroup('g-kick-repair', PEER, PID);
    expect(removedOnDisk('g-kick-repair')).toBe('5000');
  });

  it('администратор вернул человека — память процесса тоже чистится', async () => {
    mockState.failSet = true;
    await markGroupRemoval('g-kick-clear', PEER, PID, 5_000);

    mockState.failSet = false;
    await clearGroupRemoval('g-kick-clear', PEER, PID);
    expect(await wasRemovedFromGroup('g-kick-clear', PEER, PID)).toBe(false);
  });

  it('пометка одного человека не отвечает за другого', async () => {
    mockState.failSet = true;
    await markGroupRemoval('g-kick-other', PEER, PID, 5_000);

    mockState.failSet = false;
    expect(await wasRemovedFromGroup('g-kick-other', 'b3RoZXI=', PID)).toBe(false);
    expect(await wasRemovedFromGroup('g-kick-other', PEER, PID)).toBe(true);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный путь не изменился', () => {
  it('пометка выхода легла — судит диск', async () => {
    await markGroupLeft('g-plain-leave', PID, 5_000);
    expect(leftOnDisk('g-plain-leave')).toBe('5000');
    expect(await inviteNewerThanLeave('g-plain-leave', PID, 4_000)).toBe(false);
    expect(await inviteNewerThanLeave('g-plain-leave', PID, 6_000)).toBe(true);
  });

  it('нечитаемая база по-прежнему пропускает приглашение', async () => {
    // У приглашения нет обратной связи: отвергнутое молча, оно не порождает
    // ни ошибки у отправителя, ни строки у получателя.
    mockState.readable = false;
    expect(await inviteNewerThanLeave('g-unreadable', PID, 4_000)).toBe(true);
  });

  it('пометка исключения легла — судит диск', async () => {
    await markGroupRemoval('g-plain-kick', PEER, PID, 5_000);
    expect(removedOnDisk('g-plain-kick')).toBe('5000');
    expect(await wasRemovedFromGroup('g-plain-kick', PEER, PID)).toBe(true);
    expect(await wasRemovedFromGroup('g-never-kicked', PEER, PID)).toBe(false);
  });
});

describe('запас памяти процесса ограничен сверху', () => {
  it('потолок держится, вытесняется самая давняя', () => {
    // Конверты об исключении приходят снаружи, и считать их некому: без
    // потолка карта росла бы от чужих данных.
    const fallback = createMarkFallback(2);
    fallback.remember(PID, 'a', 1);
    fallback.remember(PID, 'b', 2);
    fallback.remember(PID, 'c', 3);

    expect(fallback.size()).toBe(2);
    expect(fallback.pending(PID, 'a')).toBeNull();
    expect(fallback.pending(PID, 'b')).toBe(2);
    expect(fallback.pending(PID, 'c')).toBe(3);
  });

  it('повторная запись того же ключа место не занимает', () => {
    const fallback = createMarkFallback(2);
    fallback.remember(PID, 'a', 1);
    fallback.remember(PID, 'a', 9);
    fallback.remember(PID, 'b', 2);

    expect(fallback.size()).toBe(2);
    expect(fallback.pending(PID, 'a')).toBe(9);
  });

  it('профили не делят запас', () => {
    const fallback = createMarkFallback();
    fallback.remember(1, 'a', 1);
    expect(fallback.pending(2, 'a')).toBeNull();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const LEAVE = fs.readFileSync(path.join(ROOT, 'social', 'groupLeaveMark.ts'), 'utf8');
  const KICK = fs.readFileSync(path.join(ROOT, 'social', 'groupRemovalMark.ts'), 'utf8');
  const SCOPED = fs.readFileSync(path.join(ROOT, 'storage', 'profileScopedKv.ts'), 'utf8');

  it('гасящая форма выбрасывает ответ проверяемой', () => {
    // Вот почему try/catch у пометок не срабатывал: бросать было нечему.
    expect(SCOPED).toContain('export async function scopedKvSetFor(pid: number, key: string, value: string): Promise<void> {');
    expect(SCOPED).toContain('await scopedKvSetCheckedFor(pid, key, value);');
  });

  it('обе пометки пишутся проверяемой формой', () => {
    expect(LEAVE).toContain('if (await scopedKvSetCheckedFor(pid, leaveMarkKey(groupId), String(at))) {');
    expect(KICK).toContain('if (await scopedKvSetCheckedFor(pid, removalMarkKey(peerPubB64, groupId), String(at))) {');
    expect(LEAVE).not.toContain('scopedKvSetFor(');
    expect(KICK).not.toContain('scopedKvSetFor(');
  });

  it('пометка — единственное, что стоит между повтором и группой', () => {
    // Состава группы к этому моменту уже нет: решение принимается только по
    // пометке, и другого источника у него нет.
    expect(LEAVE).toContain('const kept = unsavedLeaves.pending(pid, groupId);');
    expect(KICK).toContain('const kept = unsavedRemovals.pending(pid, fallbackKey(peerPubB64, groupId));');
  });
});
