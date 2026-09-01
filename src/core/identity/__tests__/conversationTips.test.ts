/**
 * Подсказки переписок по профилям (v4.32.290).
 *
 * Запись была одна на устройство, и в ней рядом лежали пары адресов всех
 * профилей сразу. Здесь проверяется разделение: каждый профиль забирает своё
 * и не видит чужого, а общая запись исчезает, когда забирать из неё больше
 * нечего.
 */
jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  // Шифрование подменено обратимым префиксом — см. ownProfile.test.ts.
  const PREFIX = 'enc2:';
  let writesFail = false;
  const kvSetSecret = jest.fn(async (k: string, v: string) => {
    if (writesFail) return false;
    kv[k] = PREFIX + v;
    return true;
  });
  const kvGetSecret = jest.fn(async (k: string) => {
    const stored = kv[k];
    if (stored == null) return null;
    return stored.startsWith(PREFIX) ? stored.slice(PREFIX.length) : stored;
  });
  return {
    __kv: kv,
    __prefix: PREFIX,
    __failWrites: (on: boolean) => { writesFail = on; },
    kvGet: jest.fn(async (k: string) => kv[k] ?? null),
    kvSet: jest.fn(async (k: string, v: string) => { kv[k] = v; }),
    kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
    kvGetSecret,
    kvSetSecret,
    kvGetSecretUpgrading: jest.fn(async (k: string) => {
      const stored = kv[k];
      if (stored == null) return null;
      if (stored.startsWith(PREFIX)) return stored.slice(PREFIX.length);
      await kvSetSecret(k, stored);
      return stored;
    }),
    kvSetSecretScoped: jest.fn(async (pid: number, k: string, v: string) =>
      kvSetSecret(`p${pid}:${k}`, v)),
    profileScopedKey: (pid: number, k: string) => `p${pid}:${k}`,
    notifyChatStorageChanged: jest.fn(),
  };
});

// IPFS и подпись тянут нативные модули — в этом тесте они не участвуют.
jest.mock('../../transport/ipfs/node', () => ({ addToIpfs: jest.fn(), catFromIpfs: jest.fn() }));
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => false }));
jest.mock('../../crypto/signature', () => ({ signJson: jest.fn() }));
jest.mock('../ownProfile', () => ({
  getOwnDisplayName: jest.fn(async () => null),
  ownFieldGet: jest.fn(async () => null),
  ownFieldSet: jest.fn(async () => undefined),
}));

let mockActiveProfile: { id: number; did: string } | null = null;
// v4.32.473: владельца пары определяет did в ключе, поэтому список профилей
// теперь тоже участвует — по нему находится хозяин чужой (не активной) пары.
let mockAllProfiles: { id: number; did: string }[] = [];
jest.mock('../profileManager', () => ({
  profileManager: {
    getActiveProfile: () => mockActiveProfile,
    getAllProfiles: () => mockAllProfiles,
  },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  CONVERSATION_TIPS_KEY,
  buildSignedProfile,
  getLocalConversationTips,
  setLocalConversationTip,
} from '../profile';

const mockLocal = jest.requireMock('../../storage/local') as {
  __kv: Record<string, string>;
  __prefix: string;
  __failWrites: (on: boolean) => void;
};
const mockSignature = jest.requireMock('../../crypto/signature') as {
  signJson: jest.Mock;
};

const DID_A = 'did:key:zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const DID_B = 'did:key:zBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PEER_1 = 'did:key:zPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP1';
const PEER_2 = 'did:key:zPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP2';

/**
 * v4.32.432: хвост принимает только строку формы настоящего CID (core/cid),
 * поэтому фикстура записи — CIDv0-подобная строка, а не короткая заглушка.
 */
const CID_1 = `Qm${'1'.repeat(44)}`;
const CID_2 = `Qm${'2'.repeat(44)}`;

/** Ключ пары — как dmPairKey: отсортированные did через двоеточие. */
function pair(x: string, y: string): string {
  return [x, y].sort().join(':');
}

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockLocal.__failWrites(false);
  mockActiveProfile = { id: 1, did: DID_A };
  mockAllProfiles = [];
});

describe('подсказки переписок принадлежат профилю', () => {
  it('пишутся под ключ с префиксом профиля, а не в общий', async () => {
    mockActiveProfile = { id: 2, did: DID_B };
    await setLocalConversationTip(pair(DID_B, PEER_1), CID_1);
    expect(mockLocal.__kv[`p2:${CONVERSATION_TIPS_KEY}`]).toContain(CID_1);
    expect(mockLocal.__kv[CONVERSATION_TIPS_KEY]).toBeUndefined();
  });

  it('второй профиль не видит подсказок первого', async () => {
    await setLocalConversationTip(pair(DID_A, PEER_1), CID_1);
    mockActiveProfile = { id: 2, did: DID_B };
    expect(await getLocalConversationTips()).toEqual({});
  });

  it('из общей записи каждый профиль забирает только свои пары', async () => {
    mockLocal.__kv[CONVERSATION_TIPS_KEY] = JSON.stringify({
      [pair(DID_A, PEER_1)]: 'cid-a1',
      [pair(DID_B, PEER_2)]: 'cid-b2',
    });
    expect(await getLocalConversationTips()).toEqual({ [pair(DID_A, PEER_1)]: 'cid-a1' });
    // Чужая пара осталась в общей записи — второму профилю ещё забирать.
    expect(mockLocal.__kv[CONVERSATION_TIPS_KEY]).toContain('cid-b2');
    expect(mockLocal.__kv[CONVERSATION_TIPS_KEY]).not.toContain('cid-a1');
  });

  it('опустевшую общую запись убирает последний забравший', async () => {
    mockLocal.__kv[CONVERSATION_TIPS_KEY] = JSON.stringify({
      [pair(DID_A, PEER_1)]: 'cid-a1',
      [pair(DID_B, PEER_2)]: 'cid-b2',
    });
    await getLocalConversationTips();
    mockActiveProfile = { id: 2, did: DID_B };
    await getLocalConversationTips();
    expect(mockLocal.__kv[CONVERSATION_TIPS_KEY]).toBeUndefined();
  });

  it('забирает один раз: после переноса общая запись больше не читается', async () => {
    mockLocal.__kv[CONVERSATION_TIPS_KEY] = JSON.stringify({ [pair(DID_A, PEER_1)]: 'cid-a1' });
    await getLocalConversationTips();
    // Общая запись «ожила» (например восстановилась из старой копии) — но
    // профиль уже перенёс своё и живёт в своей.
    mockLocal.__kv[CONVERSATION_TIPS_KEY] = JSON.stringify({ [pair(DID_A, PEER_2)]: 'подкинули' });
    expect(await getLocalConversationTips()).toEqual({ [pair(DID_A, PEER_1)]: 'cid-a1' });
  });

  it('без известного did ничего не переносится и не теряется', async () => {
    // profileManager ещё не поднялся: разделить пары не по чему, а стереть
    // подсказки значит заставить переписку начаться с пустой истории.
    mockActiveProfile = null;
    mockLocal.__kv[CONVERSATION_TIPS_KEY] = JSON.stringify({ [pair(DID_A, PEER_1)]: 'cid-a1' });
    expect(await getLocalConversationTips()).toEqual({ [pair(DID_A, PEER_1)]: 'cid-a1' });
    expect(mockLocal.__kv[CONVERSATION_TIPS_KEY]).toContain('cid-a1');
    expect(mockLocal.__kv['p1:' + CONVERSATION_TIPS_KEY]).toBeUndefined();
  });

  it('чужая пара из восстановленной копии не показывается', async () => {
    // Копия, снятая до v4.32.290, хранит общую запись целиком — на
    // восстановлении она ложится в namespace профиля вместе с чужими парами.
    mockLocal.__kv[`p1:${CONVERSATION_TIPS_KEY}`] = JSON.stringify({
      [pair(DID_A, PEER_1)]: 'cid-a1',
      [pair(DID_B, PEER_2)]: 'cid-b2',
    });
    expect(await getLocalConversationTips()).toEqual({ [pair(DID_A, PEER_1)]: 'cid-a1' });
  });

  it('битое значение не роняет вызывающего', async () => {
    mockLocal.__kv[`p1:${CONVERSATION_TIPS_KEY}`] = '[1,2,3]';
    expect(await getLocalConversationTips()).toEqual({});
    mockLocal.__kv[`p1:${CONVERSATION_TIPS_KEY}`] = 'не json';
    expect(await getLocalConversationTips()).toEqual({});
  });

  it('слишком длинный cid отбрасывается', async () => {
    mockLocal.__kv[`p1:${CONVERSATION_TIPS_KEY}`] = JSON.stringify({
      [pair(DID_A, PEER_1)]: 'x'.repeat(129),
      [pair(DID_A, PEER_2)]: 'ok',
    });
    expect(await getLocalConversationTips()).toEqual({ [pair(DID_A, PEER_2)]: 'ok' });
  });

  it('did не путается с чужим, начинающимся так же', async () => {
    const longer = `${DID_A}XY`;
    mockLocal.__kv[`p1:${CONVERSATION_TIPS_KEY}`] = JSON.stringify({
      [pair(longer, PEER_1)]: 'чужой',
    });
    expect(await getLocalConversationTips()).toEqual({});
  });
});

/**
 * v4.32.306. Ключ пары составлен из двух did: запись целиком — это список
 * «кто с кем переписывается», рядом с contacts, где имена зашифрованы с
 * v4.32.286.
 */
describe('подсказки не лежат открытым текстом', () => {
  it('в kv попадает шифртекст', async () => {
    await setLocalConversationTip(pair(DID_A, PEER_1), CID_1);
    expect(mockLocal.__kv[`p1:${CONVERSATION_TIPS_KEY}`].startsWith(mockLocal.__prefix)).toBe(true);
  });

  it('записанное открытым текстом дошифровывается при первом чтении', async () => {
    mockLocal.__kv[`p1:${CONVERSATION_TIPS_KEY}`] = JSON.stringify({
      [pair(DID_A, PEER_1)]: 'cid-a1',
    });
    expect(await getLocalConversationTips()).toEqual({ [pair(DID_A, PEER_1)]: 'cid-a1' });
    expect(mockLocal.__kv[`p1:${CONVERSATION_TIPS_KEY}`].startsWith(mockLocal.__prefix)).toBe(true);
  });

  it('остаток общей записи дожидается второго профиля зашифрованным', async () => {
    mockLocal.__kv[CONVERSATION_TIPS_KEY] = JSON.stringify({
      [pair(DID_A, PEER_1)]: 'cid-a1',
      [pair(DID_B, PEER_2)]: 'cid-b2',
    });
    await getLocalConversationTips();
    expect(mockLocal.__kv[CONVERSATION_TIPS_KEY].startsWith(mockLocal.__prefix)).toBe(true);
    mockActiveProfile = { id: 2, did: DID_B };
    expect(await getLocalConversationTips()).toEqual({ [pair(DID_B, PEER_2)]: 'cid-b2' });
  });

  it('не зашифровалось — общую запись не трогаем', async () => {
    // Иначе свои пары исчезли бы, а чужие — у тех, кто ещё не забирал.
    mockLocal.__kv[CONVERSATION_TIPS_KEY] = JSON.stringify({
      [pair(DID_A, PEER_1)]: 'cid-a1',
      [pair(DID_B, PEER_2)]: 'cid-b2',
    });
    mockLocal.__failWrites(true);
    expect(await getLocalConversationTips()).toEqual({ [pair(DID_A, PEER_1)]: 'cid-a1' });
    expect(mockLocal.__kv[CONVERSATION_TIPS_KEY]).toContain('cid-a1');
    expect(mockLocal.__kv[CONVERSATION_TIPS_KEY]).toContain('cid-b2');
  });
});

describe('подписанная карточка не раздаёт круг общения', () => {
  it('в payload нет списка переписок', async () => {
    // v4.32.291: карточка публикуется одним документом по CID, и этот CID
    // раздаётся контактам. Список пар раздавал каждому из них did всех
    // остальных, хотя читателю нужна ровно одна запись — его собственная.
    let captured: Record<string, unknown> | null = null;
    mockSignature.signJson.mockImplementation(
      async (_pair: unknown, payload: Record<string, unknown>) => {
        captured = payload;
        return { payload: JSON.stringify(payload), signature: 'sig' };
      }
    );
    mockLocal.__kv[`p1:${CONVERSATION_TIPS_KEY}`] = JSON.stringify({
      [pair(DID_A, PEER_1)]: 'cid-a1',
    });
    await buildSignedProfile({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
      'Аня', undefined, 'обо мне');
    expect(captured).not.toBeNull();
    expect(captured!).not.toHaveProperty('conversationTips');
    // Всё остальное на месте — поле убрано, а не карточка.
    expect(captured!.username).toBe('Аня');
    expect(captured!.bio).toBe('обо мне');
    expect(typeof captured!.did).toBe('string');
  });
});

/**
 * v4.32.473: хвост переписки принадлежит тому профилю, чей did стоит в ключе
 * пары, а не тому, который открыт на экране в момент записи.
 */
describe('хвост переписки ложится владельцу пары', () => {
  const mockNotify = (jest.requireMock('../../storage/local') as { notifyChatStorageChanged: jest.Mock })
    .notifyChatStorageChanged;

  beforeEach(() => {
    mockNotify.mockClear();
  });

  it('пара первого профиля пишется первому, даже когда открыт второй', async () => {
    mockActiveProfile = { id: 2, did: DID_B };
    mockAllProfiles = [
      { id: 1, did: DID_A },
      { id: 2, did: DID_B },
    ];
    await setLocalConversationTip(pair(DID_A, PEER_1), CID_1);
    expect(mockLocal.__kv[`p1:${CONVERSATION_TIPS_KEY}`]).toContain(CID_1);
    expect(mockLocal.__kv[`p2:${CONVERSATION_TIPS_KEY}`]).toBeUndefined();
  });

  it('пара открытого профиля по-прежнему пишется ему', async () => {
    mockActiveProfile = { id: 2, did: DID_B };
    mockAllProfiles = [
      { id: 1, did: DID_A },
      { id: 2, did: DID_B },
    ];
    await setLocalConversationTip(pair(DID_B, PEER_1), CID_1);
    expect(mockLocal.__kv[`p2:${CONVERSATION_TIPS_KEY}`]).toContain(CID_1);
    expect(mockLocal.__kv[`p1:${CONVERSATION_TIPS_KEY}`]).toBeUndefined();
  });

  it('чужая пара не подкладывается открытому профилю', async () => {
    mockActiveProfile = { id: 1, did: DID_A };
    mockAllProfiles = [{ id: 1, did: DID_A }];
    await setLocalConversationTip(pair(PEER_1, PEER_2), CID_1);
    expect(mockLocal.__kv[`p1:${CONVERSATION_TIPS_KEY}`]).toBeUndefined();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('без списка профилей поведение прежнее — пишем открытому', async () => {
    mockActiveProfile = { id: 3, did: DID_A };
    mockAllProfiles = [];
    await setLocalConversationTip(pair(DID_A, PEER_1), CID_1);
    expect(mockLocal.__kv[`p3:${CONVERSATION_TIPS_KEY}`]).toContain(CID_1);
  });

  it('отказ записи не выдаётся за успех', async () => {
    mockLocal.__failWrites(true);
    await setLocalConversationTip(pair(DID_A, PEER_1), CID_1);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('две записи подряд не затирают друг друга', () => {
  it('оба хвоста на месте после одновременной записи', async () => {
    mockActiveProfile = { id: 1, did: DID_A };
    await Promise.all([
      setLocalConversationTip(pair(DID_A, PEER_1), CID_1),
      setLocalConversationTip(pair(DID_A, PEER_2), CID_2),
    ]);
    const stored = mockLocal.__kv[`p1:${CONVERSATION_TIPS_KEY}`];
    expect(stored).toContain(CID_1);
    expect(stored).toContain(CID_2);
  });

  it('запись идёт через очередь, а не читает-и-кладёт поверх', () => {
    const src = readFileSync(join(__dirname, '..', 'profile.ts'), 'utf8');
    expect(src).toContain('let tipsTx: Promise<unknown> = Promise.resolve();');
    expect(src).toContain('const started = tipsTx.then(run, run);');
    // Номер профиля для записи больше не берётся после чтения.
    expect(src).not.toContain(
      "  const pid = profileManager.getActiveProfile()?.id ?? 1;\n  await kvSetSecretScoped(",
    );
  });
});
