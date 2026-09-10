/**
 * Нечитаемая запись подсказок больше не переписывается (v4.32.697).
 *
 * Подсказка переписки — это хвост: адрес последнего сообщения, от которого
 * обход истории идёт назад. Их до тысячи в одной записи профиля, и живёт она
 * только на устройстве. Читалась она через kvGetSecretUpgrading, который сам
 * же в local.ts объявлен сводящим «записи нет» и «не открылась» в один null, —
 * а сразу за чтением идёт запись всей карты целиком. Значит заминка базы или
 * недоступный ключ давали «подсказок нет», и первое же отправленное сообщение
 * клало карту из одной своей пары поверх всех остальных.
 *
 * Проверка поведением: модуль настоящий, отказ подделан на уровне ячейки.
 */
const mockKv = new Map<string, string>();
/** Ключи, ячейка которых не открывается (state: 'unreadable'). */
const mockUnreadable = new Set<string>();

jest.mock('../../storage/local', () => ({
  kvGetSecretCell: async (k: string) => {
    if (mockUnreadable.has(k)) return { state: 'unreadable' };
    const v = mockKv.get(k);
    return v == null ? { state: 'absent' } : { state: 'plain', text: v };
  },
  kvGetSecretCellUpgrading: async (k: string) => {
    if (mockUnreadable.has(k)) return { state: 'unreadable' };
    const v = mockKv.get(k);
    return v == null ? { state: 'absent' } : { state: 'plain', text: v };
  },
  // Прежние строковые чтения подделаны так же, как в local.ts: и «нет
  // записи», и «не открылась» отдают null. Нужны, чтобы встречная проверка
  // (файл до правки) шла по настоящему коду, а не падала на пустом импорте.
  kvGetSecret: async (k: string) => (mockUnreadable.has(k) ? null : mockKv.get(k) ?? null),
  kvGetSecretUpgrading: async (k: string) => (mockUnreadable.has(k) ? null : mockKv.get(k) ?? null),
  kvSetSecret: async (k: string, v: string) => { mockKv.set(k, v); return true; },
  kvSetSecretScoped: async (pid: number, k: string, v: string) => {
    mockKv.set(`p${pid}:${k}`, v);
    return true;
  },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  profileScopedKey: (pid: number, k: string) => `p${pid}:${k}`,
  notifyChatStorageChanged: () => {},
}));
jest.mock('../../transport/ipfs/node', () => ({ addToIpfs: jest.fn(), catFromIpfs: jest.fn() }));
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => false }));
jest.mock('../../crypto/signature', () => ({ signJson: jest.fn() }));
jest.mock('../ownProfile', () => ({
  getOwnDisplayName: jest.fn(async () => null),
  ownFieldGet: jest.fn(async () => null),
  ownFieldSet: jest.fn(async () => undefined),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const mockDidA = 'did:key:zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
jest.mock('../profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1, did: mockDidA }),
    getAllProfiles: () => [{ id: 1, did: mockDidA }],
  },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CONVERSATION_TIPS_KEY,
  getLocalConversationTips,
  setLocalConversationTip,
} from '../profile';

const SRC = readFileSync(join(__dirname, '..', 'profile.ts'), 'utf8');

const PEER_1 = 'did:key:zPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP1';
const PEER_2 = 'did:key:zPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP2';
const CID_1 = `Qm${'1'.repeat(44)}`;
const CID_2 = `Qm${'2'.repeat(44)}`;
const OWN = `p1:${CONVERSATION_TIPS_KEY}`;

/** Ключ пары — как dmPairKey: отсортированные did через двоеточие. */
function pair(x: string, y: string): string {
  return [x, y].sort().join(':');
}

beforeEach(() => {
  mockKv.clear();
  mockUnreadable.clear();
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: подсказки вообще пишутся и читаются', () => {
  it('новая пара дописывается к прежним, а не заменяет их', async () => {
    mockKv.set(OWN, JSON.stringify({ [pair(mockDidA, PEER_1)]: CID_1 }));
    await setLocalConversationTip(pair(mockDidA, PEER_2), CID_2);
    expect(await getLocalConversationTips()).toEqual({
      [pair(mockDidA, PEER_1)]: CID_1,
      [pair(mockDidA, PEER_2)]: CID_2,
    });
  });

  it('на чистом устройстве первая пара создаёт запись', async () => {
    await setLocalConversationTip(pair(mockDidA, PEER_1), CID_1);
    expect(mockKv.get(OWN)).toContain(CID_1);
  });
});

describe('не прочиталось — не переписываем', () => {
  it('новая подсказка не ложится поверх нечитаемой записи', async () => {
    const before = JSON.stringify({
      [pair(mockDidA, PEER_1)]: CID_1,
      [pair(mockDidA, PEER_2)]: CID_2,
    });
    mockKv.set(OWN, before);
    mockUnreadable.add(OWN);

    await setLocalConversationTip(pair(mockDidA, PEER_1), CID_2);

    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: запись побайтно та же.
    expect(mockKv.get(OWN)).toBe(before);
  });

  it('запись не превращается в карту из одной последней пары', async () => {
    mockKv.set(OWN, JSON.stringify({ [pair(mockDidA, PEER_1)]: CID_1 }));
    mockUnreadable.add(OWN);
    await setLocalConversationTip(pair(mockDidA, PEER_2), CID_2);

    // База ответила на следующем заходе — прежняя пара на месте.
    mockUnreadable.clear();
    expect(await getLocalConversationTips()).toEqual({ [pair(mockDidA, PEER_1)]: CID_1 });
  });

  it('но показать переписки не мешает', async () => {
    mockKv.set(OWN, JSON.stringify({ [pair(mockDidA, PEER_1)]: CID_1 }));
    mockUnreadable.add(OWN);
    await expect(getLocalConversationTips()).resolves.toEqual({});
  });
});

describe('нечитаемая общая запись не закрывает перенос навсегда', () => {
  it('пустая запись профиля не создаётся, пока общую не открыли', async () => {
    mockKv.set(CONVERSATION_TIPS_KEY, JSON.stringify({ [pair(mockDidA, PEER_1)]: CID_1 }));
    mockUnreadable.add(CONVERSATION_TIPS_KEY);

    await setLocalConversationTip(pair(mockDidA, PEER_2), CID_2);
    expect(mockKv.has(OWN)).toBe(false);
    expect(mockKv.get(CONVERSATION_TIPS_KEY)).toContain(CID_1);

    // Открылась — перенос проходит, и прежняя пара доезжает.
    mockUnreadable.clear();
    expect(await getLocalConversationTips()).toEqual({ [pair(mockDidA, PEER_1)]: CID_1 });
  });
});

describe('испорченное содержимое — по-прежнему пустая карта', () => {
  it('не json и массив читаются как пустота и переписываются', async () => {
    mockKv.set(OWN, 'не json');
    await setLocalConversationTip(pair(mockDidA, PEER_1), CID_1);
    expect(await getLocalConversationTips()).toEqual({ [pair(mockDidA, PEER_1)]: CID_1 });
  });
});

describe('исходник: чтение подсказок объявлено тройственным', () => {
  it('readTipsFor различает три состояния ячейки', () => {
    expect(SRC).toContain(
      "const cell = await kvGetSecretCellUpgrading(profileScopedKey(pid, CONVERSATION_TIPS_KEY));"
    );
    expect(SRC).toContain("if (cell.state === 'unreadable') return null;");
    expect(SRC).toContain("if (cell.state === 'absent') return await claimSharedConversationTips(pid, did);");
    expect(SRC).not.toContain('kvGetSecretUpgrading(');
    expect(SRC).not.toContain("const raw = await kvGetSecret(CONVERSATION_TIPS_KEY);");
  });

  it('запись отказывается идти вслепую', () => {
    expect(SRC).toContain('const tips = await readTipsFor(pid, did);');
    expect(SRC).toContain('if (tips === null) {');
    expect(SRC).toContain("log.warn('conversation_tips_unreadable', { pid });");
    expect(SRC).toContain("const shared = await kvGetSecretCell(CONVERSATION_TIPS_KEY);");
    expect(SRC).toContain("if (shared.state === 'unreadable') {");
  });
});
