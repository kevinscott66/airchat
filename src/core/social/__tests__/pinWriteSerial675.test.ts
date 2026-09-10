/**
 * Закрепления пишутся по очереди — v4.32.675.
 *
 * Дефект. Список закреплений читается перед КАЖДОЙ записью и пишется целиком
 * (так сделано намеренно: v4.32.643 научило чтение отличать «пусто» от «не
 * прочиталось»). Но пишущих двое и они друг о друге ничего не знают: своё
 * нажатие «Закрепить» — и входящий конверт `pin` от другого участника, который
 * разбирается в groupMessaging/handleIncomingDmPin. Между чтением списка и
 * записью стоит await; второй пишущий успевает прочитать список ДО того, как
 * первый его записал, и его запись ложится поверх.
 *
 * Наружу это выходит как молчаливая пропажа: одно из двух закреплений исчезает,
 * ошибки нет, повтора нет, а у остальных участников оно есть — конверт-то уже
 * разошёлся. Ровно тот же класс расхождения «у меня одно, у всех другое», что
 * и в прошлых кругах.
 *
 * Здесь закреплено: две записи, начатые одновременно, обе доходят.
 */
const mockKv = new Map<string, string>();
const mockTexts = new Map<string, string>();

/** Пропустить такт: без него чтение и запись не успевают перемешаться. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => {
    await new Promise((r) => setTimeout(r, 0));
    return { value: mockKv.get(k) ?? null };
  },
  kvSet: async (k: string, v: string) => {
    mockKv.set(k, v);
  },
  kvSetChecked: async (k: string, v: string) => {
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => {
    mockKv.delete(k);
  },
  setConversationPinnedMessage: async () => undefined,
  setGroupPinnedMessage: async () => undefined,
  notifyChatStorageChanged: () => undefined,
  listGroupMembers: async () => [],
  getGroup: async () => null,
  getChatMessageTexts: async (ids: string[]) =>
    new Map(ids.filter((i) => mockTexts.has(i)).map((i) => [i, mockTexts.get(i) as string])),
  getGroupMessageTexts: async (ids: string[]) =>
    new Map(ids.filter((i) => mockTexts.has(i)).map((i) => [i, mockTexts.get(i) as string])),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 7 }) },
}));

jest.mock('../controlFanout', () => ({
  fanoutControlEnvelope: async () => ({ sent: true, recipients: 1 }),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { applyLocalDmPin, clearDmPinned, loadDmPinnedIds } from '../dmPinSync';
import { applyLocalPin, clearPinned, loadPinnedIds } from '../groupPinSync';

const PID = 7;
const GROUP = 'g-1';
const PEER = 'P'.repeat(43);

const src = (name: string): string => readFileSync(join(__dirname, '..', name), 'utf8');

beforeEach(() => {
  mockKv.clear();
  mockTexts.clear();
  for (const id of ['m1', 'm2', 'm3', 'm4']) mockTexts.set(id, `текст ${id}`);
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('список по-прежнему читается целиком и пишется целиком', () => {
    // Если бы запись стала точечной (добавить один id), очередь была бы не нужна.
    for (const f of ['groupPinSync.ts', 'dmPinSync.ts']) {
      const s = src(f);
      expect(s).toContain('JSON.stringify(nextIds)');
      expect(s).toContain('const current = await read');
    }
  });

  it('писать может не только своё нажатие', () => {
    // Входящий конверт зовёт ту же запись — второй пишущий, о котором первый
    // не знает.
    expect(src('groupMessaging.ts')).toContain("const { applyLocalPin } = await import('./groupPinSync');");
    expect(src('dmPinSync.ts')).toContain('export async function handleIncomingDmPin');
  });
});

describe('две записи подряд, начатые одновременно', () => {
  it('в группе доходят обе', async () => {
    const a = applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true });
    const b = applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm2', on: true });
    await Promise.all([a, b]);
    expect((await loadPinnedIds(GROUP, PID)).sort()).toEqual(['m1', 'm2']);
  });

  it('в личке доходят обе', async () => {
    const a = applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: PID, msgId: 'm1', on: true });
    const b = applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: PID, msgId: 'm2', on: true });
    await Promise.all([a, b]);
    expect((await loadDmPinnedIds(PEER, PID)).sort()).toEqual(['m1', 'm2']);
  });

  it('открепление не воскрешается закреплением, начатым раньше', async () => {
    await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true });
    const add = applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm2', on: true });
    const off = applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: false });
    await Promise.all([add, off]);
    expect(await loadPinnedIds(GROUP, PID)).toEqual(['m2']);
  });

  it('«открепить всё» не оставляет позади себя запись, начатую раньше', async () => {
    await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true });
    const add = applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm2', on: true });
    const clear = clearPinned(GROUP, PID);
    await Promise.all([add, clear]);
    expect(await loadPinnedIds(GROUP, PID)).toEqual([]);
  });

  it('в личке «открепить всё» тоже последнее', async () => {
    const add = applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: PID, msgId: 'm1', on: true });
    const clear = clearDmPinned(PEER, PID);
    await Promise.all([add, clear]);
    expect(await loadDmPinnedIds(PEER, PID)).toEqual([]);
  });

  it('четыре записи разом — все четыре', async () => {
    await Promise.all(
      ['m1', 'm2', 'm3', 'm4'].map((id) =>
        applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: id, on: true })
      )
    );
    expect((await loadPinnedIds(GROUP, PID)).sort()).toEqual(['m1', 'm2', 'm3', 'm4']);
  });
});

describe('очередь не съедает обычную работу', () => {
  it('одна запись возвращает свой же список', async () => {
    const entries = await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true });
    expect(entries?.map((e) => e.id)).toEqual(['m1']);
  });

  it('падение одной записи не останавливает следующие', async () => {
    // Дорожка держится успешной намеренно: иначе первая же ошибка базы
    // навсегда заперла бы закрепления.
    mockTexts.clear();
    await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true });
    mockTexts.set('m2', 'текст m2');
    await tick();
    const entries = await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm2', on: true });
    expect(entries?.map((e) => e.id)).toEqual(['m2']);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходники прочитаны', () => {
    expect(src('groupPinSync.ts').length).toBeGreaterThan(3_000);
    expect(src('dmPinSync.ts').length).toBeGreaterThan(3_000);
  });

  it('пустой kv по-прежнему значит «ничего не закреплено»', async () => {
    expect(await loadPinnedIds(GROUP, PID)).toEqual([]);
    expect(await loadDmPinnedIds(PEER, PID)).toEqual([]);
  });
});
