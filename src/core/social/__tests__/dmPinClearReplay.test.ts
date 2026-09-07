/**
 * «Открепить всё» нельзя подать дважды (v4.32.622).
 *
 * Конверт `dmpin` с `all: true` — единственная операция закрепления, которая не
 * называет сообщения: она стирает список целиком. Пока у неё не было водяного
 * знака, повтор был бесплатным: relay хранит накопленное тридцать суток, темы
 * выводятся из открытых DID, писать в них может кто угодно — один перехваченный
 * подписанный кадр стирал список закреплений заново хоть через месяц, и так
 * сколько угодно раз.
 *
 * Ячейка знака своя (`dmpin_clear`) и намеренно отдельная от закреплений
 * отдельных сообщений: у тех состояние привязано к msgId, общий знак на пару
 * выбрасывал бы законное закрепление сообщения B из-за более поздней метки у A.
 */

const mockKv = new Map<string, string>();
const mockPinnedIds: (string | null)[] = [];
let mockNotifies = 0;

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
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
  kvListKeysByPrefix: async () => [],
  setConversationPinnedMessage: async (_peer: string, _pid: number, id: string | null) => {
    mockPinnedIds.push(id);
  },
  // Все запрошенные id считаем существующими в этой переписке: проверка
  // «сообщение есть у получателя» здесь не предмет теста.
  getChatMessageTexts: async (ids: string[]) => new Map(ids.map((id) => [id, `текст ${id}`])),
  notifyChatStorageChanged: () => {
    mockNotifies += 1;
  },
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1, name: 'Личный', did: 'did:key:z1' }) },
}));
jest.mock('../controlFanout', () => ({
  fanoutControlEnvelope: async () => ({ sent: true, recipients: 1 }),
  fanoutReasonText: () => '',
}));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import {
  applyLocalDmPin,
  encodeDmPinEnvelope,
  handleIncomingDmPin,
  loadDmPinnedIds,
} from '../dmPinSync';
import { watermarkKey } from '../controlWatermark';

const PEER = 'peer-pub-b64-aaaa';
const PID = 1;

beforeEach(() => {
  mockKv.clear();
  mockPinnedIds.length = 0;
  mockNotifies = 0;
});

const clearEnv = (ts: number): string =>
  encodeDmPinEnvelope({ msgId: '', on: false, ts, all: true });

describe('повтор «открепить всё»', () => {
  it('второй раз тот же конверт список не стирает', async () => {
    const ts = Date.now() - 1000;

    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: PID, msgId: 'm1', on: true });
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m1']);

    // Первое применение — законное: список стирается.
    expect(await handleIncomingDmPin(clearEnv(ts), PEER, PID)).toBe(true);
    expect(await loadDmPinnedIds(PEER, PID)).toEqual([]);

    // Человек закрепил заново — и тут приходит ТОТ ЖЕ кадр ещё раз.
    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: PID, msgId: 'm2', on: true });
    const notifiesBefore = mockNotifies;
    expect(await handleIncomingDmPin(clearEnv(ts), PEER, PID)).toBe(true);

    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m2']);
    // Отброшенный повтор не должен и будить открытый чат на перерисовку.
    expect(mockNotifies).toBe(notifiesBefore);
  });

  it('проверка не пустая: конверт с БОЛЬШЕЙ меткой стирает список', async () => {
    const ts = Date.now() - 10_000;
    await handleIncomingDmPin(clearEnv(ts), PEER, PID);

    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: PID, msgId: 'm2', on: true });
    const notifiesBefore = mockNotifies;
    expect(await handleIncomingDmPin(clearEnv(ts + 1), PEER, PID)).toBe(true);

    expect(await loadDmPinnedIds(PEER, PID)).toEqual([]);
    // Закрепления строк в переписке не создают — без этого сигнала открытый
    // чат так и рисовал бы стёртый список.
    expect(mockNotifies).toBeGreaterThan(notifiesBefore);
  });

  it('конверт с МЕНЬШЕЙ меткой отбрасывается', async () => {
    const ts = Date.now() - 10_000;
    await handleIncomingDmPin(clearEnv(ts), PEER, PID);

    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: PID, msgId: 'm3', on: true });
    expect(await handleIncomingDmPin(clearEnv(ts - 5000), PEER, PID)).toBe(true);

    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m3']);
  });

  it('знак стоит в своей ячейке, а не в общей для пары', async () => {
    const ts = Date.now() - 1000;
    await handleIncomingDmPin(clearEnv(ts), PEER, PID);

    expect(mockKv.get(`p${PID}:${watermarkKey('dmpin_clear', PEER)}`)).toBe(String(ts));
    expect(mockKv.get(`p${PID}:${watermarkKey('presence', PEER)}`)).toBeUndefined();
    expect(mockKv.get(`p${PID}:${watermarkKey('copyguard', PEER)}`)).toBeUndefined();
  });
});

describe('закрепление отдельного сообщения знаком «открепить всё» не задето', () => {
  it('пин с меньшей меткой применяется после clear', async () => {
    const now = Date.now();
    await handleIncomingDmPin(clearEnv(now - 1000), PEER, PID);

    // Метка МЕНЬШЕ, чем у уже применённого clear: будь знак общим на пару,
    // законное закрепление отвергалось бы.
    const pin = encodeDmPinEnvelope({ msgId: 'mX', on: true, ts: now - 5000 });
    expect(await handleIncomingDmPin(pin, PEER, PID)).toBe(true);

    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['mX']);
  });

  it('пин с большой меткой не сдвигает знак «открепить всё»', async () => {
    const now = Date.now();
    const pin = encodeDmPinEnvelope({ msgId: 'mY', on: true, ts: now - 1000 });
    await handleIncomingDmPin(pin, PEER, PID);

    expect(mockKv.get(`p${PID}:${watermarkKey('dmpin_clear', PEER)}`)).toBeUndefined();

    // Значит clear со СВОЕЙ, меньшей меткой всё ещё применим.
    expect(await handleIncomingDmPin(clearEnv(now - 3000), PEER, PID)).toBe(true);
    expect(await loadDmPinnedIds(PEER, PID)).toEqual([]);
  });
});
