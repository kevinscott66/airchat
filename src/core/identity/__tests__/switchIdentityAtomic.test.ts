/**
 * Переключение аккаунта не должно быть наблюдаемо наполовину.
 *
 * v4.32.480. `getActiveProfile()` отвечает из кеша на 5 секунд, а
 * `getActiveKeyPair()` читает состояние напрямую. Между записью нового номера
 * профиля и сбросом кеша стоял поход в SecureStore — и всё это время на один
 * и тот же вопрос «кто я» было два ответа: номер старого профиля и ключ
 * нового. Какой достанется вызывающему, решал возраст кеша.
 */
import { Buffer } from 'buffer';

jest.mock('../../storage/secureStoreQueued', () => {
  const store: Record<string, string> = {};
  let probe: (() => void) | null = null;
  return {
    __store: store,
    __setProbe: (fn: (() => void) | null) => { probe = fn; },
    getItemAsync: jest.fn(async (key: string) => store[key] ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      // Момент внутри persistState: состояние уже поменяли, запись ещё идёт.
      if (probe) probe();
      store[key] = value;
    }),
    deleteItemAsync: jest.fn(async (key: string) => { delete store[key]; }),
  };
});

jest.mock('../../crypto/keyManager', () => {
  let probe: (() => void) | null = null;
  return {
    __setKeyProbe: (fn: (() => void) | null) => { probe = fn; },
    loadKeyPair: jest.fn(async () => null),
    persistKeyPair: jest.fn(async () => { if (probe) probe(); }),
  };
});

jest.mock('../../backup/seedPhrase', () => ({
  getStoredMnemonic: jest.fn(async () => 'слово '.repeat(12).trim()),
  // Ключ однозначно указывает на индекс деривации: по нему тест и проверяет,
  // чей ключ отдали.
  deriveKeyPairFromMnemonicForProfile: jest.fn((_m: string, idx: number) => ({
    publicKey: Uint8Array.from([idx, 200, 201]),
    secretKey: Uint8Array.from([idx, 100, 101]),
  })),
}));

jest.mock('../did', () => ({
  publicKeyToDidKey: (pub: Uint8Array) => `did:key:z${pub[0]}`,
}));

jest.mock('../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../storage/dekDerivation', () => ({
  bytesEqualConstTime: (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]),
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { profileManager } from '../profileManager';

const secure = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string>;
  __setProbe: (fn: (() => void) | null) => void;
};
const keys = jest.requireMock('../../crypto/keyManager') as {
  __setKeyProbe: (fn: (() => void) | null) => void;
};

const STATE_KEY = 'airchat_profiles_state_v1';
const managerSrc = readFileSync(join(__dirname, '..', 'profileManager.ts'), 'utf8');
const reactionSrc = readFileSync(join(__dirname, '..', '..', 'social', 'reactionSync.ts'), 'utf8');
const pinSrc = readFileSync(join(__dirname, '..', '..', 'social', 'groupPinSync.ts'), 'utf8');

/** Профиль 1 → индекс 0, профиль 2 → индекс 1: ключ выдаёт, чей он. */
function seedState(): void {
  secure.__store[STATE_KEY] = JSON.stringify({
    v: 1,
    activeProfileId: 1,
    nextProfileId: 3,
    nextDerivationIndex: 2,
    profiles: [
      { id: 1, derivationIndex: 0, name: 'Личный', createdAt: 1, lastUsed: 2 },
      { id: 2, derivationIndex: 1, name: 'Рабочий', createdAt: 3, lastUsed: 4 },
    ],
  });
}

beforeEach(async () => {
  for (const k of Object.keys(secure.__store)) delete secure.__store[k];
  secure.__setProbe(null);
  keys.__setKeyProbe(null);
  seedState();
  await profileManager.init();
  await profileManager.switchProfile(1);
});

afterEach(() => {
  secure.__setProbe(null);
  keys.__setKeyProbe(null);
});

/** Что отвечают оба источника прямо сейчас. */
function snapshot(): { pid: number | null; keyIdx: number } {
  return {
    pid: profileManager.getActiveProfile()?.id ?? null,
    keyIdx: profileManager.getActiveKeyPair().publicKey[0],
  };
}

describe('«кто я» — один ответ на всём переключении', () => {
  it('номер профиля и ключ не расходятся, пока идёт запись состояния', async () => {
    // Кеш профиля прогрет старым значением — как у любого живого экрана.
    expect(profileManager.getActiveProfile()?.id).toBe(1);
    const seen: { pid: number | null; keyIdx: number }[] = [];
    secure.__setProbe(() => seen.push(snapshot()));
    await profileManager.switchProfile(2);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.keyIdx).toBe((s.pid ?? 0) - 1);
  });

  it('то же в момент записи ключа на устройство', async () => {
    expect(profileManager.getActiveProfile()?.id).toBe(1);
    const seen: { pid: number | null; keyIdx: number }[] = [];
    keys.__setKeyProbe(() => seen.push(snapshot()));
    await profileManager.switchProfile(2);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.keyIdx).toBe((s.pid ?? 0) - 1);
  });

  it('после переключения оба источника указывают на новый профиль', async () => {
    await profileManager.switchProfile(2);
    expect(snapshot()).toEqual({ pid: 2, keyIdx: 1 });
  });
});

describe('номер профиля и открытый ключ берутся одним чтением', () => {
  it('getActiveIdentity отдаёт пару из одного состояния', () => {
    expect(profileManager.getActiveIdentity()).toEqual({
      pid: 1,
      myPubB64: Buffer.from(Uint8Array.from([0, 200, 201])).toString('base64'),
    });
  });

  it('после переключения — пара нового профиля', async () => {
    await profileManager.switchProfile(2);
    expect(profileManager.getActiveIdentity()).toEqual({
      pid: 2,
      myPubB64: Buffer.from(Uint8Array.from([1, 200, 201])).toString('base64'),
    });
  });

  it('и она согласована с getActiveProfile в тот же момент', async () => {
    await profileManager.switchProfile(2);
    const me = profileManager.getActiveIdentity();
    expect(me?.pid).toBe(profileManager.getActiveProfile()?.id);
  });
});

describe('вызывающие больше не собирают личность из двух источников', () => {
  it('сброс кеша идёт вплотную к записи номера, без await между ними', () => {
    expect(managerSrc).toContain(
      'this.state.activeProfileId = profileId;\n    row.lastUsed = Date.now();\n    this.invalidateProfileCache();\n    await this.persistState();'
    );
  });

  it('реакции спрашивают личность у profileManager, а не у хранилища устройства', () => {
    expect(reactionSrc).not.toContain('await loadKeyPair()');
    expect(reactionSrc).not.toContain("from '../crypto/keyManager'");
    expect(reactionSrc).toContain('profileManager.getActiveIdentity()');
    // Отправляющая ветка берёт номер профиля из того же чтения.
    expect(reactionSrc).toContain('const pid = me.pid;');
  });

  it('закрепление сообщения — так же', () => {
    expect(pinSrc).not.toContain('await loadKeyPair()');
    expect(pinSrc).not.toContain("from '../crypto/keyManager'");
    expect(pinSrc).toContain('const me = profileManager.getActiveIdentity();');
    expect(pinSrc).toContain('const { pid, myPubB64: myPub } = me;');
  });
});

describe('проверка не пустая', () => {
  it('исходники прочитаны', () => {
    expect(managerSrc.length).toBeGreaterThan(1000);
    expect(reactionSrc.length).toBeGreaterThan(1000);
    expect(pinSrc.length).toBeGreaterThan(1000);
  });
});
