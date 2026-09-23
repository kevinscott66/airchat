/**
 * Занятая база больше не стирает закрепление навсегда (v4.32.757).
 *
 * Дефект. `handleIncomingDmPin` возвращала `true` в любом исходе, а ветка в
 * `messaging.ts` этот ответ не читала вовсе: `await handleIncomingDmPin(...)`
 * и сразу `return 'consumed'`. «Разобрано» значит «метку докуда прочитано
 * можно двигать», а relay отдаёт накопленное только по метке — значит любая
 * секунда занятой базы стоила закрепления насовсем. Заметить это человеку
 * неоткуда: строки в переписке закрепление не создаёт, и у собеседника оно
 * просто есть, а у нас просто нет.
 *
 * Три входа в беду, и два из них были немыми даже в логе:
 *
 *   • сам список не прочитался — единственный случай, который признавался
 *     отказом (v4.32.643);
 *   • ЗАПИСЬ не легла — `scopedKvSetFor` о провале не сообщает никому, а
 *     список ниже перечитывался из kv уже после неудачи, то есть приходил
 *     прежним, и вызывающий объявлял закрепление применённым;
 *   • «открепить всё» не легло — а знак повтора к этому времени уже стоял:
 *     `acceptControlTs` проверяет и сдвигает разом. Повторная присылка того же
 *     конверта отвергалась как устаревшая, и отказ становился вечным.
 *
 * Правка. Обработчик отвечает словом `EnvelopeIntake`, развилка в `messaging`
 * отдаёт его наверх, записи стали проверяемыми, а знак сдвигается ПОСЛЕ
 * применения — парой `controlTsFresh` → `commitControlTs`.
 */

const mockKv = new Map<string, string>();
const mockPinnedIds: (string | null)[] = [];
let mockNotifies = 0;
let mockFanouts = 0;
/** Что ответит запись списка закреплений: false — база занята. */
let mockListWriteOk = true;
/** Что ответит чтение списка: null — прочитать не удалось. */
let mockListReadFails = false;

/** Ключ списка закреплений в профиле — по нему и ломаем запись. */
const mockIsListKey = (k: string): boolean => k.includes('pinned_list_');

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => {
    // null — «запрос не прошёл»; `{ value: null }` — «записи нет».
    if (mockListReadFails && mockIsListKey(k)) return null;
    return { value: mockKv.get(k) ?? null };
  },
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
  setConversationPinnedMessage: async (_peer: string, _pid: number, id: string | null) => {
    mockPinnedIds.push(id);
  },
  // Все запрошенные id считаем существующими в этой переписке: проверка
  // «сообщение есть у получателя» здесь не предмет набора.
  getChatMessageTexts: async (ids: string[]) => new Map(ids.map((id) => [id, `текст ${id}`])),
  notifyChatStorageChanged: () => {
    mockNotifies += 1;
  },
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1, name: 'Личный', did: 'did:key:z1' }) },
}));
jest.mock('../controlFanout', () => ({
  fanoutControlEnvelope: async () => {
    mockFanouts += 1;
    return { sent: true, recipients: 1 };
  },
  fanoutReasonText: () => '',
}));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  clearDmPinnedAndSync,
  encodeDmPinEnvelope,
  handleIncomingDmPin,
  loadDmPinnedIds,
  toggleDmPinAndSync,
} from '../dmPinSync';

const PEER = 'peer-pub-b64-aaaa';
const PID = 1;
const LIST_KEY = `p${PID}:pinned_list_${PEER}`;

/** Конверт закрепления отдельного сообщения. */
const pinEnv = (msgId: string, ts: number): string =>
  encodeDmPinEnvelope({ msgId, on: true, ts });

/** Конверт «открепить всё». */
const clearEnv = (ts: number): string =>
  encodeDmPinEnvelope({ msgId: '', on: false, ts, all: true });

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const read = (...p: string[]): string => readFileSync(join(__dirname, '..', ...p), 'utf8');

beforeEach(() => {
  mockKv.clear();
  mockKv.set(LIST_KEY, JSON.stringify(['m1']));
  mockPinnedIds.length = 0;
  mockNotifies = 0;
  mockFanouts = 0;
  mockListWriteOk = true;
  mockListReadFails = false;
});

describe('причина уйдёт сама — кадр откладываем', () => {
  it('запись не легла: закрепление будет перезапрошено, а не потеряно', async () => {
    mockListWriteOk = false;

    expect(await handleIncomingDmPin(pinEnv('m2', 1000), PEER, PID)).toBe('deferred');
    // И «закреплено» экрану не объявляем: в шапке этого нет.
    expect(mockNotifies).toBe(0);
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m1']);
  });

  it('список не прочитался — тоже откладываем', async () => {
    mockListReadFails = true;

    expect(await handleIncomingDmPin(pinEnv('m2', 1000), PEER, PID)).toBe('deferred');
  });

  it('«открепить всё» не легло: откладываем и знак НЕ двигаем', async () => {
    // Самое дорогое место правки. acceptControlTs ставил знак до применения:
    // стирание не проходило, знак стоял, и повторная присылка того же конверта
    // отвергалась как устаревшая — у собеседника список пуст, у нас нет, и
    // починить это было нечем, потому что повтор больше не принимался.
    mockListWriteOk = false;

    expect(await handleIncomingDmPin(clearEnv(5000), PEER, PID)).toBe('deferred');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m1']);

    // База освободилась — тот же самый конверт применяется.
    mockListWriteOk = true;
    expect(await handleIncomingDmPin(clearEnv(5000), PEER, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual([]);
  });
});

describe('своя сторона тоже перестала выдавать неудачу за успех', () => {
  it('своё закрепление не записалось — отказ с фразой, и рассылки нет', async () => {
    mockListWriteOk = false;

    const res = await toggleDmPinAndSync({ peerPubB64: PEER, msgId: 'm2', on: true });
    expect(res).toEqual({ ok: false, reason: 'write_failed' });
    // У собеседника закрепление появилось бы, а у себя нет.
    expect(mockFanouts).toBe(0);
  });

  it('своё «открепить всё» не записалось — тоже отказ без рассылки', async () => {
    mockListWriteOk = false;

    const res = await clearDmPinnedAndSync(PEER);
    expect(res.ok).toBe(false);
    expect(mockFanouts).toBe(0);
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m1']);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ — сторож здесь с двух сторон.
 *
 * Прежний код заваливает весь набор целиком: тип ответа сменился, и `.toBe` не
 * совпадёт ни в одной строке. Доказательство такое ничего не стоит. Настоящая
 * опасность — перестраховка: заменить разбор на голое `return 'deferred'` —
 * правка в одну строку, она чинит тот же дефект и выглядит надёжнее. Метку
 * такая версия не заклинит (приёмник даёт кадру ровно одну вторую попытку и
 * отпускает сам), но каждый заведомо мёртвый кадр будет разобран дважды, а в
 * журнал ляжет `internet_frame_deferred_again` — строка, по которой ищут
 * настоящие отсрочки. Проверки ниже падают именно на такой версии.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: постоянная причина держать метку не должна', () => {
  it('закрепление применилось — разобрано', async () => {
    expect(await handleIncomingDmPin(pinEnv('m2', 1000), PEER, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual(['m2', 'm1']);
    expect(mockNotifies).toBe(1);
  });

  it('«открепить всё» применилось — разобрано', async () => {
    expect(await handleIncomingDmPin(clearEnv(5000), PEER, PID)).toBe('consumed');
    expect(await loadDmPinnedIds(PEER, PID)).toEqual([]);
  });

  it('повтор «открепить всё» — не отсрочка, а отказ навсегда', async () => {
    // Повтор бесплатным быть не должен (v4.32.622), но и держать из-за него
    // метку незачем: второй раз тот же конверт не применится никогда.
    expect(await handleIncomingDmPin(clearEnv(5000), PEER, PID)).toBe('consumed');
    expect(await handleIncomingDmPin(clearEnv(5000), PEER, PID)).toBe('consumed');
  });

  it('мусор вместо конверта и конверт без отправителя — годными они не станут', async () => {
    expect(await handleIncomingDmPin('просто текст', PEER, PID)).toBe('consumed');
    expect(await handleIncomingDmPin('\x11dmpin:{нет', PEER, PID)).toBe('consumed');
    expect(await handleIncomingDmPin(pinEnv('m2', 1000), undefined, PID)).toBe('consumed');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('развилка в messaging отдаёт ответ обработчика, а не выбрасывает его', () => {
    const body = codeOnly(read('messaging.ts'));
    expect(body).toContain(
      'return await handleIncomingDmPin(textPayload.text, peerPubKeyB64, ownerPid);'
    );
  });

  it('знак «открепить всё» сдвигается после применения, а не до', () => {
    const body = codeOnly(read('dmPinSync.ts'));
    // Разом проверяющей-и-сдвигающей формы здесь больше нет.
    expect(body).not.toContain('acceptControlTs(');
    const fresh = body.indexOf("controlTsFresh('dmpin_clear'");
    const applied = body.indexOf('await clearDmPinned(senderPubB64, pid)');
    const commit = body.indexOf("commitControlTs('dmpin_clear'");
    expect(fresh).toBeGreaterThan(0);
    expect(applied).toBeGreaterThan(fresh);
    expect(commit).toBeGreaterThan(applied);
  });

  it('обе записи списка проверяются, немых не осталось', () => {
    const body = codeOnly(read('dmPinSync.ts'));
    expect(body).not.toContain('scopedKvSetFor(');
    expect(body.split('scopedKvSetCheckedFor(ownerProfileId, pinListKey(')).toHaveLength(3);
  });
});
