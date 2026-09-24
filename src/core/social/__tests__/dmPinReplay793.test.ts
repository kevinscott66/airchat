/**
 * Закрепление в личке получило знак свежести (v4.32.793).
 *
 * Дефект. Из всего, что приходит служебным конвертом, закрепление отдельного
 * сообщения оставалось без водяного знака последним среди скалярных состояний.
 * «Открепить всё» знак получило ещё в v4.32.622, у группового закрепления он
 * появился версией раньше (v4.32.792) — а закрепление в переписке применялось
 * как есть.
 *
 * Цена. Положение названо в самом кадре (`on`), тема relay выводится из
 * открытых DID, конверт живёт тридцать суток. Значит сохранённое «закрепить»
 * возвращает в шапку снятый баннер, а сохранённое «открепить» снимает
 * нынешний — столько раз, сколько кадр подадут. Хуже, чем в группе: закрепление
 * в личке не создаёт в переписке никакой строки, поэтому человек не видит ни
 * события, ни его отката. Бьёт по каждому получателю отдельно: у собеседника
 * шапка остаётся правильной.
 *
 * Правка. Ячейка на пару «собеседник + сообщение»: знак на одного собеседника
 * выбросил бы законное закрепление сообщения B, пришедшее следом за более
 * поздним про A, — relay отдаёт накопленное пачкой и порядка не держит.
 * Проверка до применения, сдвиг после: обе причины отказа (список не
 * прочитался, запись не легла) проходят сами, и знак не должен хоронить
 * перезапрос, ради которого сказано `deferred` (v4.32.757).
 */

const mockKv = new Map<string, string>();
let mockNotifies = 0;
/** Что ответит запись списка закреплений: false — база занята. */
let mockListWriteOk = true;

/** Ключ списка закреплений в профиле — по нему и ломаем запись. */
const mockIsListKey = (k: string): boolean => k.includes('pinned_list_');

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => {
    mockKv.set(k, v);
  },
  kvSetChecked: async (k: string, v: string) => {
    if (!mockListWriteOk && mockIsListKey(k)) return false;
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => {
    mockKv.delete(k);
  },
  kvListKeysByPrefix: async () => [],
  setConversationPinnedMessage: async () => {},
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

import { readFileSync } from 'fs';
import { join } from 'path';

import { dmPinWatermarkKey, resetControlTsMirrorForTests } from '../controlWatermark';
import { encodeDmPinEnvelope, handleIncomingDmPin, loadDmPinnedIds } from '../dmPinSync';

const PEER = 'peer-pub-b64-aaaa';
const OTHER_PEER = 'peer-pub-b64-bbbb';
const PID = 1;
const LIST_KEY = `p${PID}:pinned_list_${PEER}`;
const TS = 1_700_000_000_000;

/** Конверт закрепления или открепления отдельного сообщения. */
const pinEnv = (msgId: string, ts: number, on = true): string =>
  encodeDmPinEnvelope({ msgId, on, ts });

/** Конверт «открепить всё» — у него своя, давно закрытая ячейка. */
const clearEnv = (ts: number): string => encodeDmPinEnvelope({ msgId: '', on: false, ts, all: true });

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const read = (...p: string[]): string => readFileSync(join(__dirname, '..', ...p), 'utf8');

beforeEach(() => {
  // Зеркало знака живёт на уровне модуля и уборку базы переживает (v4.32.791).
  resetControlTsMirrorForTests();
  mockKv.clear();
  mockKv.set(LIST_KEY, JSON.stringify(['m1']));
  mockNotifies = 0;
  mockListWriteOk = true;
});

describe('перехваченный кадр больше не переключает закрепление', () => {
  it('тот же кадр, поданный второй раз, не применяется', async () => {
    expect(await handleIncomingDmPin(pinEnv('m2', TS), PEER, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m2', 'm1']);

    // Собеседник снял закрепление — законно и позже.
    expect(await handleIncomingDmPin(pinEnv('m2', TS + 1000, false), PEER, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m1']);

    // А вот тот самый первый кадр, сохранённый и поданный снова.
    expect(await handleIncomingDmPin(pinEnv('m2', TS), PEER, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m1']);
  });

  it('сохранённое «открепить» не снимает нынешнее закрепление', async () => {
    await handleIncomingDmPin(pinEnv('m1', TS, false), PEER, PID);
    expect(await loadDmPinnedIds(PEER, PID)).toEqual([]);
    await handleIncomingDmPin(pinEnv('m1', TS + 1000, true), PEER, PID);
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m1']);

    expect(await handleIncomingDmPin(pinEnv('m1', TS, false), PEER, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m1']);
  });

  it('повтор не объявляется экрану обновлением', async () => {
    await handleIncomingDmPin(pinEnv('m2', TS), PEER, PID);
    mockNotifies = 0;
    await handleIncomingDmPin(pinEnv('m2', TS), PEER, PID);
    expect(mockNotifies).toBe(0);
  });
});

describe('ячейка узкая: законное не выбрасывается', () => {
  it('у каждого сообщения своя отметка', async () => {
    await handleIncomingDmPin(pinEnv('m2', TS + 5000), PEER, PID);
    // Кадр про ДРУГОЕ сообщение с меньшей меткой — законный: relay отдаёт
    // накопленное пачкой, порядка между сообщениями нет.
    expect(await handleIncomingDmPin(pinEnv('m3', TS), PEER, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m3', 'm2', 'm1']);
  });

  it('у каждого собеседника своя отметка', async () => {
    await handleIncomingDmPin(pinEnv('m2', TS + 5000), PEER, PID);
    expect(await handleIncomingDmPin(pinEnv('m2', TS, true), OTHER_PEER, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(OTHER_PEER, PID)).toEqual(['m2']);
    expect(dmPinWatermarkKey(PEER, 'm2')).not.toBe(dmPinWatermarkKey(OTHER_PEER, 'm2'));
  });

  it('подобрать чужую ячейку нечем: неограниченная часть в имени одна', () => {
    // Собеседник управляет только идентификатором сообщения, и тот стоит
    // последним — хвост имени принадлежит ему целиком, сколько бы двоеточий он
    // туда ни вписал. Столкнуть два разных сообщения в одну ячейку нельзя.
    expect(dmPinWatermarkKey(PEER, 'a:b')).not.toBe(dmPinWatermarkKey(PEER, 'a'));
    expect(dmPinWatermarkKey(PEER, 'a:b')).not.toBe(dmPinWatermarkKey(PEER, 'b'));
    // Вторая часть, собеседник, берётся из ПОДПИСАННОГО отправителя, а не из
    // поля конверта: подставить туда двоеточие можно только с чужим ключом.
    expect(codeOnly(read('dmPinSync.ts'))).toContain(
      'dmPinTsFresh(senderPubB64, env.msgId, pid, env.ts)'
    );
  });

  it('«открепить всё» живёт в своей ячейке и закреплениями не двигается', async () => {
    await handleIncomingDmPin(pinEnv('m2', TS + 9000), PEER, PID);
    // Метка меньше, чем у закрепления выше, — но это другое состояние.
    expect(await handleIncomingDmPin(clearEnv(TS), PEER, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual([]);
  });
});

describe('знак не хоронит перезапрос (v4.32.757 цел)', () => {
  it('запись не легла — кадр отложен, знак не поставлен', async () => {
    mockListWriteOk = false;
    expect(await handleIncomingDmPin(pinEnv('m2', TS), PEER, PID)).toBe('deferred');

    mockListWriteOk = true;
    expect(await handleIncomingDmPin(pinEnv('m2', TS), PEER, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m2', 'm1']);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычная работа не задета', () => {
  it('закрепление применяется и объявляется экрану', async () => {
    expect(await handleIncomingDmPin(pinEnv('m2', TS), PEER, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m2', 'm1']);
    expect(mockNotifies).toBe(1);
  });

  it('поток честных кадров проходит целиком', async () => {
    expect(await handleIncomingDmPin(pinEnv('m2', TS), PEER, PID)).toBe('consumed');
    expect(await handleIncomingDmPin(pinEnv('m2', TS + 1, false), PEER, PID)).toBe('consumed');
    expect(await handleIncomingDmPin(pinEnv('m2', TS + 2, true), PEER, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m2', 'm1']);
  });

  it('мусор и конверт без отправителя годными не станут', async () => {
    expect(await handleIncomingDmPin('просто текст', PEER, PID)).toBe('consumed');
    expect(await handleIncomingDmPin(pinEnv('m2', TS), undefined, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m1']);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('положение берётся из кадра — потому повтор его и переключает', () => {
    // Будь в кадре «переключить», отметка на сообщение ничего бы не спасла.
    expect(codeOnly(read('dmPinSync.ts'))).toContain('on: env.on,');
  });

  it('закрепление в личке не создаёт строки — подмены не видно', () => {
    const body = codeOnly(read('messaging.ts'));
    expect(body).toContain(
      'return await handleIncomingDmPin(textPayload.text, peerPubKeyB64, ownerPid);'
    );
    // Своего пузыря ветка не пишет: ответ обработчика — и сразу наверх.
    expect(body).not.toContain('handleIncomingDmPin(textPayload.text, peerPubKeyB64, ownerPid);\n    insert');
  });

  it('конверт живёт достаточно долго, чтобы повтор был не теорией', () => {
    expect(codeOnly(read('messaging.ts'))).toContain(
      'const ENVELOPE_MAX_AGE_MS = RELAY_RETENTION_MS;'
    );
    expect(codeOnly(read('..', 'transport', 'retentionWindow.ts'))).toContain(
      'export const RELAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;'
    );
  });

  it('соседние скалярные состояния знак имеют давно', () => {
    const body = codeOnly(read('dmPinSync.ts'));
    expect(body).toContain("controlTsFresh('dmpin_clear'");
    expect(body).toContain("commitControlTs('dmpin_clear'");
  });
});
