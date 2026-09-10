/**
 * Уборка брошенных вложений не смеет опираться на укоротившийся список профилей.
 *
 * v4.32.704. `listPostIdsEverywhere` спрашивала номера профилей у одного лишь
 * снимка в SecureStore. Снимок умеет молча укорачиваться: разбор выбрасывает
 * строку, не прошедшую проверку (`profile_manager_dropped_invalid_rows`), а
 * вовсе нечитаемый снимок подменяется одним профилем по умолчанию. Дальше
 * `scanInlineOrphans` объявляет вложения всех «пропавших» профилей байтами
 * удалённых постов, а `reconcileOrphanInlineMedia` их стирает — без следа и без
 * возврата. Единственной защитой был `ids.length === 0`, то есть случай, когда
 * профилей не осталось совсем.
 *
 * Теперь номера собираются из двух независимых источников: снимка (со словом о
 * его полноте) и файлов баз ленты на диске. Файл `airchat_feed_p<N>.db`
 * переживает порчу снимка; снимок работает там, где файлов не видно (веб).
 * Отказ от поиска сирот наступает ровно тогда, когда полного списка нет ни у
 * одного из источников.
 */
let mockRaw: string | null = null;
let mockDocDir: string | null = 'file:///doc/';
let mockDirExists = true;
let mockDirNames: string[] = [];
let mockReadThrows = false;

jest.mock('expo-file-system/legacy', () => ({
  get documentDirectory() {
    return mockDocDir;
  },
  getInfoAsync: jest.fn(async () => ({ exists: mockDirExists })),
  readDirectoryAsync: jest.fn(async () => {
    if (mockReadThrows) throw new Error('нет доступа к каталогу');
    return mockDirNames;
  }),
}));

jest.mock('../../storage/secureStoreQueued', () => ({
  getItemAsync: jest.fn(async (key: string) =>
    key === 'airchat_profiles_state_v1' ? mockRaw : null
  ),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

jest.mock('../../crypto/keyManager', () => ({
  loadKeyPair: jest.fn(async () => null),
  persistKeyPair: jest.fn(async () => {}),
}));

jest.mock('../../backup/seedPhrase', () => ({
  getStoredMnemonic: jest.fn(async () => 'слово '.repeat(12).trim()),
  deriveKeyPairFromMnemonicForProfile: jest.fn((_m: string, idx: number) => ({
    publicKey: Uint8Array.from([idx, 200, 201]),
    secretKey: Uint8Array.from([idx, 100, 101]),
  })),
}));

jest.mock('../../identity/did', () => ({
  publicKeyToDidKey: (pub: Uint8Array) => `did:key:z${pub[0]}`,
}));

jest.mock('../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

const FEED_SERVICE = readFileSync(join(__dirname, '..', 'feedService.ts'), 'utf8');

function row(id: number) {
  return { id, derivationIndex: id - 1, name: `Профиль ${id}`, createdAt: 1, lastUsed: 1 };
}

function snapshot(profiles: unknown[]): string {
  return JSON.stringify({ v: 1, activeProfileId: 1, nextProfileId: 9, nextDerivationIndex: 9, profiles });
}

/** Свежий менеджер профилей поверх заданного снимка. */
async function managerFor(raw: string | null) {
  mockRaw = raw;
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../../identity/profileManager');
  await mod.profileManager.init();
  return mod.profileManager as {
    getProfileIds(): number[];
    getProfileIdsComplete(): { ids: number[]; complete: boolean };
  };
}

/** Свежий feedStorage поверх заданного состояния каталога. */
function feedStorageModule() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../storage/feedStorage') as {
    listFeedDbProfileIds(): Promise<number[] | null>;
  };
}

describe('снимок профилей честно говорит о своей полноте', () => {
  it('целый снимок — список полон', async () => {
    const pm = await managerFor(snapshot([row(1), row(2)]));
    expect(pm.getProfileIdsComplete()).toEqual({ ids: [1, 2], complete: true });
  });

  it('выброшенная строка укорачивает список и снимает признак полноты', async () => {
    const pm = await managerFor(snapshot([row(1), { id: 'нет', derivationIndex: 1 }, row(3)]));
    const got = pm.getProfileIdsComplete();
    expect(got.ids).toEqual([1, 3]);
    expect(got.complete).toBe(false);
  });

  it('нечитаемый снимок подменяется одним профилем — и это тоже неполнота', async () => {
    const pm = await managerFor('}{ это не json');
    const got = pm.getProfileIdsComplete();
    expect(got.ids).toEqual([1]);
    expect(got.complete).toBe(false);
  });

  it('снимок другой версии — тоже неполнота', async () => {
    const pm = await managerFor(JSON.stringify({ v: 7, profiles: [row(1), row(2)] }));
    expect(pm.getProfileIdsComplete().complete).toBe(false);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: устройство без снимка вовсе — список полон', async () => {
    const pm = await managerFor(null);
    const got = pm.getProfileIdsComplete();
    expect(got.ids).toEqual([1]);
    // Терять было нечего: первый запуск не повод навсегда отключить уборку.
    expect(got.complete).toBe(true);
  });
});

describe('файлы баз ленты — второй, независимый источник номеров', () => {
  beforeEach(() => {
    mockDocDir = 'file:///doc/';
    mockDirExists = true;
    mockDirNames = [];
    mockReadThrows = false;
  });

  it('номера берутся из имён файлов, посторонние имена не в счёт', async () => {
    mockDirNames = ['airchat_feed_p3.db', 'airchat_local.db', 'airchat_feed_p7.db', 'что-то.txt'];
    expect(await feedStorageModule().listFeedDbProfileIds()).toEqual([3, 7]);
  });

  it('каталога SQLite ещё нет — это пусто, а не «не знаю»', async () => {
    mockDirExists = false;
    expect(await feedStorageModule().listFeedDbProfileIds()).toEqual([]);
  });

  it('каталога приложения не видно (веб) — спросить не у кого', async () => {
    mockDocDir = null;
    expect(await feedStorageModule().listFeedDbProfileIds()).toBeNull();
  });

  it('чтение каталога сорвалось — спросить не у кого', async () => {
    mockReadThrows = true;
    expect(await feedStorageModule().listFeedDbProfileIds()).toBeNull();
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: полное удаление баз по-прежнему берёт номера отсюда', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'storage', 'feedStorage.ts'), 'utf8');
    expect(src).toContain('for (const id of (await listFeedDbProfileIds()) ?? []) ids.add(id);');
  });
});

describe('обход постов всех профилей объединяет оба источника', () => {
  const body = (() => {
    const at = FEED_SERVICE.indexOf('async function listPostIdsEverywhere(');
    expect(at).toBeGreaterThan(-1);
    return FEED_SERVICE.slice(at, FEED_SERVICE.indexOf('\n}\n', at));
  })();

  it('спрашивает и снимок, и диск', () => {
    expect(body).toContain('const { ids: stateIds, complete } = profileManager.getProfileIdsComplete();');
    expect(body).toContain('const diskIds = await listFeedDbProfileIds();');
  });

  it('номера складываются без повторов', () => {
    expect(body).toContain('const ids = diskIds === null ? stateIds : [...new Set([...stateIds, ...diskIds])];');
  });

  it('неполный снимок вместе с недоступным диском означает отказ', () => {
    const at = body.indexOf('if (!complete && diskIds === null) {');
    expect(at).toBeGreaterThan(-1);
    expect(body.slice(at, at + 200)).toContain('return null;');
  });

  it('прежний одиночный источник сюда не вернулся', () => {
    expect(body).not.toContain('profileManager.getProfileIds()');
  });

  it('пустой список по-прежнему повод не искать сирот', () => {
    expect(body).toContain('if (ids.length === 0) return null;');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: неизвестный номер поста так и означает удаление байтов', () => {
    const at = FEED_SERVICE.indexOf('export async function reconcileOrphanInlineMedia(');
    expect(at).toBeGreaterThan(-1);
    const fn = FEED_SERVICE.slice(at, FEED_SERVICE.indexOf('\n}\n', at));
    expect(fn).toContain('orphanKeys');
    expect(fn).toContain('kvDelete(');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: общий список постов идёт именно отсюда', () => {
    expect(FEED_SERVICE).toContain('const knownPostIdsEverywhere = await listPostIdsEverywhere();');
  });
});
