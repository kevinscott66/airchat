/**
 * DID отправителя не уезжает через чужой push-сервис (v4.32.614).
 *
 * Ретранслятор клал в полезную нагрузку FCM поле `contactDid` — открытый,
 * публично разрешаемый did:key отправителя. Токен FCM уже указывает на
 * устройство получателя, а DID разворачивается в профиль, юзернейм и ленту,
 * поэтому посредник (на Android — Google, на iOS — Google и Apple) получал
 * готовый социальный граф с настоящими именами: кто кому пишет и когда.
 * Текст сообщения не утекал никогда — баннер собирается на устройстве, —
 * но отправитель утекал каждый раз.
 *
 * Вместо DID уходит метка, посоленная ключом ПОЛУЧАТЕЛЯ. Соль здесь — суть
 * защиты, а не украшение: без неё метка была бы одна на отправителя, и её
 * разобрали бы одним проходом радужной таблицы по открытому списку DID, да
 * ещё и связали бы между собой всех его собеседников.
 *
 * Проверяется вся цепочка: правило метки совпадает с серверным побайтово,
 * метка своя у каждого получателя, разбор намерения принимает её и отвергает
 * подделку, обратный перебор по контактам находит отправителя, а старое поле
 * `contactDid` от необновлённого ретранслятора по-прежнему принимается.
 */
import fs from 'fs';
import path from 'path';

import { SENDER_TAG_SHAPE, parseOpenIntent, parseCallOpenIntent } from '../openIntent';
import { SELF_PEER_MIRROR_KEY, pushSenderTag } from '../pushSenderTag';
import { didFromPubB64 } from '../../core/identity/did';

// Таблица kv фонового контекста: имена строк контактов не шифруются намеренно
// (contacts.ts, v4.32.286), поэтому перебор работает при запертом телефоне.
let mockKv: Record<string, string> = {};
let mockOpenFails = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    if (mockOpenFails) throw new Error('SQLITE_CANTOPEN: unable to open database file');
    return {
      getAllAsync: jest.fn(async (sql: string, params: string[] = []) => {
        if (/WHERE k IN/.test(sql)) {
          return params.filter((k) => mockKv[k] !== undefined).map((k) => ({ k, v: mockKv[k] }));
        }
        if (/k LIKE/.test(sql)) {
          const rx = params.map((p) => new RegExp(`^${p.replace(/%/g, '.*')}$`));
          return Object.keys(mockKv)
            .filter((k) => rx.some((r) => r.test(k)))
            .map((k) => ({ k, v: mockKv[k] }));
        }
        return [];
      }),
      getFirstAsync: jest.fn(async () => null),
      closeAsync: jest.fn(async () => undefined),
    };
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { didForSenderTag } = require('../senderTagLookup') as typeof import('../senderTagLookup');

const SELF_PUB = Buffer.alloc(32, 1).toString('base64');
const PEER_PUB = Buffer.alloc(32, 2).toString('base64');
const OTHER_PUB = Buffer.alloc(32, 3).toString('base64');
const MIRROR = 'active_profile_id';
const CID = 'a1b2c3d4e5f60718';

const read = (...rel: string[]): string => fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8');
// Пояснение к дефекту в самом push.js цитирует старое поле, поэтому храповик
// смотрит только на код: строки комментариев отбрасываются.
const RELAY = (): string =>
  read('..', '..', 'signaling-server', 'push.js')
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');

beforeEach(() => {
  mockKv = {};
  mockOpenFails = false;
});

describe('правило метки отправителя', () => {
  it('совпадает с серверным побайтово', () => {
    // Значение посчитано отдельно по формуле ретранслятора:
    // sha256("airchat-push-sender-v1|<получатель>|<отправитель>").hex[:32]
    expect(pushSenderTag(SELF_PUB, PEER_PUB)).toBe('b343a94bacc6a9a8cab540cd1dad5126');
  });

  it('метка подходит по виду', () => {
    expect(SENDER_TAG_SHAPE.test(pushSenderTag(SELF_PUB, PEER_PUB))).toBe(true);
  });

  it('один отправитель — разные метки разным получателям', () => {
    // Ради этого и берётся соль получателя: иначе посредник склеил бы
    // переписки одного человека со всеми его собеседниками.
    expect(pushSenderTag(SELF_PUB, PEER_PUB)).not.toBe(pushSenderTag(OTHER_PUB, PEER_PUB));
  });

  it('одна пара — всегда одна метка', () => {
    expect(pushSenderTag(SELF_PUB, PEER_PUB)).toBe(pushSenderTag(SELF_PUB, PEER_PUB));
  });

  it('направление учитывается', () => {
    expect(pushSenderTag(SELF_PUB, PEER_PUB)).not.toBe(pushSenderTag(PEER_PUB, SELF_PUB));
  });
});

describe('разбор намерения', () => {
  const TAG = pushSenderTag(SELF_PUB, PEER_PUB);

  it('метка доезжает до намерения переписки', () => {
    expect(parseOpenIntent({ cid: CID, senderTag: TAG })).toEqual({
      kind: 'chat' as const,
      cid: CID,
      senderTag: TAG,
    });
  });

  it('метка доезжает до намерения звонка', () => {
    const call = parseCallOpenIntent({ kind: 'call', cid: CID, senderTag: TAG });
    expect(call?.senderTag).toBe(TAG);
  });

  it('подделка вида отбрасывается', () => {
    for (const bad of ['', 'ZZ', TAG.toUpperCase(), `${TAG}0`, TAG.slice(0, 31), 'did:key:z6Mkfoo']) {
      expect(parseOpenIntent({ cid: CID, senderTag: bad })).toEqual({ kind: 'chat' as const, cid: CID });
    }
  });

  it('старое поле от необновлённого ретранслятора всё ещё принимается', () => {
    const did = didFromPubB64(PEER_PUB) as string;
    expect(parseOpenIntent({ cid: CID, contactDid: did })).toEqual({
      kind: 'chat' as const,
      cid: CID,
      contactDid: did,
    });
  });
});

describe('обратный перебор по контактам', () => {
  it('находит отправителя среди контактов профиля', async () => {
    mockKv[SELF_PEER_MIRROR_KEY] = SELF_PUB;
    mockKv[MIRROR] = '1';
    mockKv[`p1:contact:${OTHER_PUB}`] = 'enc';
    mockKv[`p1:contact:${PEER_PUB}`] = 'enc';
    await expect(didForSenderTag(pushSenderTag(SELF_PUB, PEER_PUB))).resolves.toBe(didFromPubB64(PEER_PUB));
  });

  it('записи без префикса принадлежат первому профилю', async () => {
    mockKv[SELF_PEER_MIRROR_KEY] = SELF_PUB;
    mockKv[MIRROR] = '1';
    mockKv[`contact:${PEER_PUB}`] = 'enc';
    await expect(didForSenderTag(pushSenderTag(SELF_PUB, PEER_PUB))).resolves.toBe(didFromPubB64(PEER_PUB));
  });

  it('контакты чужого профиля не отвечают за активный', async () => {
    mockKv[SELF_PEER_MIRROR_KEY] = SELF_PUB;
    mockKv[MIRROR] = '2';
    mockKv[`p1:contact:${PEER_PUB}`] = 'enc';
    await expect(didForSenderTag(pushSenderTag(SELF_PUB, PEER_PUB))).resolves.toBeUndefined();
  });

  it('без зеркала своего ключа перебирать нечем', async () => {
    mockKv[MIRROR] = '1';
    mockKv[`p1:contact:${PEER_PUB}`] = 'enc';
    await expect(didForSenderTag(pushSenderTag(SELF_PUB, PEER_PUB))).resolves.toBeUndefined();
  });

  it('незнакомый отправитель — без имени, но и без падения', async () => {
    mockKv[SELF_PEER_MIRROR_KEY] = SELF_PUB;
    mockKv[MIRROR] = '1';
    mockKv[`p1:contact:${OTHER_PUB}`] = 'enc';
    await expect(didForSenderTag(pushSenderTag(SELF_PUB, PEER_PUB))).resolves.toBeUndefined();
  });

  it('мусор вместо метки не доходит до базы', async () => {
    await expect(didForSenderTag(undefined)).resolves.toBeUndefined();
    await expect(didForSenderTag('did:key:z6MkfooBarBaz')).resolves.toBeUndefined();
  });

  it('база недоступна из фона — молча без имени', async () => {
    mockOpenFails = true;
    await expect(didForSenderTag(pushSenderTag(SELF_PUB, PEER_PUB))).resolves.toBeUndefined();
  });
});

describe('ретранслятор не кладёт DID в чужой сервис', () => {
  it('поле отправителя заменено меткой', () => {
    const src = RELAY();
    expect(src).not.toMatch(/contactDid:\s*claim\.senderDid/);
    expect(src).toMatch(/senderTag:\s*senderTagFor\(claim\.targetPeerId,\s*claim\.senderPeerId\)/);
  });

  it('соль — ключ получателя, а не одна на всех', () => {
    expect(RELAY()).toMatch(/airchat-push-sender-v1\|\$\{targetPeerId\}\|\$\{senderPeerId\}/);
  });

  it('клиент разворачивает метку в обоих обработчиках', () => {
    expect(read('pushNotifications.ts')).toMatch(/didForSenderTag\(intent\.senderTag\)/);
    expect(read('..', 'firebaseMessagingBackground.ts')).toMatch(/didForSenderTag\(intent\.senderTag\)/);
  });
});
