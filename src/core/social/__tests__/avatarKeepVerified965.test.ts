/**
 * Сорвавшаяся загрузка нового фото больше не стирает прежнее лицо (v4.32.965).
 *
 * Дефект. Разбор скачанного снимка (`materialize`) отступался молча только
 * тогда, когда показывать и так было нечего:
 *
 *     if (uri === null && prev.uri === null) continue;
 *     known.set(pubB64, { uri, ver: uri ? version : null, at: prev.at });
 *
 * То есть при `uri === null` и живом прежнем фото вторая строка затирала
 * проверенный снимок пустотой. А пустой ответ тут значит ровно «не достали
 * или не проверили»: снятое фото сюда не доходит вовсе — у него в справочнике
 * нет версии, и разбирается оно отдельной веткой выше.
 *
 * Цена. Связь моргнула ровно в ту секунду, когда собеседник сменил фото, — и
 * вместо прежнего лица в списке чатов остаётся буква в кружке. Хуже, чем до
 * смены: раньше фото было. И это надолго — за справочником ходят раз в
 * полчаса (`LOOKUP_TTL_MS`). Ровно это же обещание двумя функциями ниже
 * записано словами: «Старое проверенное фото остаётся на экране, пока не
 * проверено новое».
 *
 * Правка. `if (uri === null) continue;` — при неудаче не трогаем ничего.
 * Версия в памяти остаётся прежней, поэтому следующий поход в справочник
 * снова увидит версию как новую и сходит за снимком: чинится само, лишнего
 * потока не создаёт.
 *
 * Границы. Подпись здесь настоящая, как и в проверке v4.32.940: сеть и файлы
 * поддельные, а порядок проверок — нет. Часы подменены, потому что без этого
 * второй поход в справочник упрётся в получасовую выдержку.
 */
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

const mockFiles = new Map<string, string>();
let mockLookupBody: unknown = null;
let mockSignedBody: unknown = null;
let mockSignedOk = true;
/** Пока стоит — справка о снимке не отдаётся: снимок «качается». */
let mockSignedGate: Promise<void> | null = null;
let mockNow = 0;

jest.mock('../../backup/cloudVault', () => ({ cloudBaseUrl: () => 'https://vault.test' }));
jest.mock('../../settings/avatarVisibility', () => ({ avatarVisibilityTryFor: jest.fn(async () => null) }));
jest.mock('../../identity/ownProfile', () => ({ ownFieldGetFor: jest.fn(async () => null) }));
jest.mock('../../identity/ownAvatar', () => ({
  ownAvatarUriFor: jest.fn(async () => null),
  ownAvatarUri: jest.fn(async () => null),
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }), getActiveKeyPair: () => null },
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  documentDirectory: null,
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async (path: string) => ({ exists: mockFiles.has(path) })),
  writeAsStringAsync: jest.fn(async (path: string, data: string) => { mockFiles.set(path, data); }),
}));
jest.mock('../../net/timedFetch', () => ({
  fetchWithDeadline: jest.fn(async (url: string, _init: unknown, _opts: unknown, read: (r: unknown) => unknown) => {
    if (String(url).endsWith('/signed')) {
      if (mockSignedGate) await mockSignedGate;
      return read({ ok: mockSignedOk, status: mockSignedOk ? 200 : 404, json: async () => mockSignedBody });
    }
    return read({ ok: true, status: 200, json: async () => mockLookupBody });
  }),
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { signJson } from '../../crypto/signature';
import { publicAvatarUri, requestPublicAvatar, resetPublicAvatars } from '../publicAvatar';

function keyPair(seedByte: number) {
  const secretKey = new Uint8Array(32).fill(seedByte);
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

const OWNER = keyPair(11);
const STRANGER = keyPair(22);
const PUB_B64 = Buffer.from(OWNER.publicKey).toString('base64');
const URL_KEY = Buffer.from(OWNER.publicKey).toString('base64url');

const IMAGE_OLD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const IMAGE_NEW = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5]);
const OLD_B64 = IMAGE_OLD.toString('base64');
const NEW_B64 = IMAGE_NEW.toString('base64');
const hashOf = (b: Buffer): string => createHash('sha256').update(b).digest('hex').slice(0, 32);
const VER_OLD = hashOf(IMAGE_OLD);
const VER_NEW = hashOf(IMAGE_NEW);
const FILE_OLD = `file:///cache/pubavatar-${URL_KEY}-${VER_OLD}.img`;
const FILE_NEW = `file:///cache/pubavatar-${URL_KEY}-${VER_NEW}.img`;

/** Выдержка справочника — столько фото не переспрашивают (`LOOKUP_TTL_MS`). */
const TTL_MS = 30 * 60 * 1000;

/** Подписать справку о фото так, как её подписывает владелец при выкладке. */
async function proof(imageB64: string, pair = OWNER) {
  return signJson(pair, {
    v: 1,
    ts: Date.now(),
    nonce: 'n'.repeat(22),
    publicKeyB64: PUB_B64,
    act: 'put',
    imageB64,
  });
}

const settle = () => new Promise((r) => setTimeout(r, 120));

/** Спросить фото и дождаться, пока справка и проверка отработают. */
async function ask(): Promise<string | null> {
  requestPublicAvatar(PUB_B64);
  await settle();
  return publicAvatarUri(PUB_B64);
}

/** Перевести часы: без этого второй поход упрётся в выдержку справочника. */
const advance = (ms: number): void => {
  mockNow += ms;
};

/** Владелец сменил фото: в справочнике новая версия, справка про новый снимок. */
async function ownerChangedPhoto(): Promise<void> {
  advance(TTL_MS + 1);
  mockLookupBody = { found: { [URL_KEY]: VER_NEW } };
  mockSignedBody = await proof(NEW_B64);
}

/** Только код: пояснение не должно само удовлетворять закрепку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const SRC = codeOnly(readFileSync(join(__dirname, '..', 'publicAvatar.ts'), 'utf8'));

beforeAll(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => mockNow);
});

afterAll(() => {
  jest.restoreAllMocks();
});

beforeEach(async () => {
  mockNow = 1_800_000_000_000;
  resetPublicAvatars();
  mockFiles.clear();
  mockSignedOk = true;
  mockSignedGate = null;
  mockLookupBody = { found: { [URL_KEY]: VER_OLD } };
  mockSignedBody = await proof(OLD_B64);
});

describe('неудачная загрузка нового фото прежнее лицо не трогает', () => {
  it('сервер не отдал справку — на экране остаётся прежний проверенный снимок', async () => {
    expect(await ask()).toBe(FILE_OLD);

    await ownerChangedPhoto();
    mockSignedOk = false;
    mockSignedBody = { error: 'avatar_proof_missing' };

    expect(await ask()).toBe(FILE_OLD);
  });

  it('справка не сошлась — тоже остаётся прежний, а не буква в кружке', async () => {
    expect(await ask()).toBe(FILE_OLD);

    await ownerChangedPhoto();
    // Подпись чужим ключом: снимок не проверен, показывать его нельзя — но и
    // стирать проверенное прежнее не за что.
    mockSignedBody = await proof(NEW_B64, STRANGER);

    expect(await ask()).toBe(FILE_OLD);
  });

  it('за сорвавшимся снимком приходят снова, и лицо не пропадало ни разу', async () => {
    expect(await ask()).toBe(FILE_OLD);

    await ownerChangedPhoto();
    mockSignedOk = false;
    mockSignedBody = { error: 'avatar_proof_missing' };
    expect(await ask()).toBe(FILE_OLD);

    // Версия в памяти осталась прежней — значит следующий поход в справочник
    // снова увидит версию как новую и сходит за снимком. Чинится само.
    advance(TTL_MS + 1);
    mockSignedOk = true;
    mockSignedBody = await proof(NEW_B64);
    expect(await ask()).toBe(FILE_NEW);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Оставлять прежнее лицо можно ровно до тех пор, пока это не делает его
 * несменяемым. Новое фото обязано доезжать, снятое — исчезать, а из ничего
 * лицо не обязано появляться.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: фото по-прежнему меняется и снимается', () => {
  it('у честного фото путь до экрана есть', async () => {
    expect(await ask()).toBe(FILE_OLD);
    expect(mockFiles.get(FILE_OLD)).toBe(OLD_B64);
  });

  it('доехавшее новое фото прежнее заменяет', async () => {
    expect(await ask()).toBe(FILE_OLD);
    await ownerChangedPhoto();
    expect(await ask()).toBe(FILE_NEW);
    expect(mockFiles.get(FILE_NEW)).toBe(NEW_B64);
  });

  it('ГРАНИЦА: снятое фото лицо убирает — это не неудача загрузки', async () => {
    expect(await ask()).toBe(FILE_OLD);
    // У снятого фото версии нет вовсе: такой ответ разбирается в справочнике,
    // до разбора снимка он не доходит и правкой не затронут.
    advance(TTL_MS + 1);
    mockLookupBody = { found: {} };
    expect(await ask()).toBeNull();
  });

  it('ГРАНИЦА: фото не было — сорвавшаяся загрузка его не выдумывает', async () => {
    mockSignedOk = false;
    mockSignedBody = { error: 'avatar_proof_missing' };
    expect(await ask()).toBeNull();
  });

  it('ГРАНИЦА: смена ключа (другой аккаунт) прежнее лицо не показывает', async () => {
    expect(await ask()).toBe(FILE_OLD);
    resetPublicAvatars();
    expect(publicAvatarUri(PUB_B64)).toBeNull();
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Справочник, узнав новую версию, прежнее лицо намеренно оставляет на месте —
 * значит стирала его именно разборка скачанного, и больше некому.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: пока снимок качается, прежнее лицо на экране', () => {
  it('новая версия узнана, снимок ещё в пути — показывается прежний', async () => {
    expect(await ask()).toBe(FILE_OLD);

    await ownerChangedPhoto();
    let release: () => void = () => {};
    mockSignedGate = new Promise<void>((r) => {
      release = r;
    });

    requestPublicAvatar(PUB_B64);
    await settle();
    expect(publicAvatarUri(PUB_B64)).toBe(FILE_OLD);

    mockSignedGate = null;
    release();
    await settle();
  });

  it('пустой ответ разборки — это молчание, а не исключение', async () => {
    mockSignedOk = false;
    mockSignedBody = { error: 'avatar_proof_missing' };
    await expect(ask()).resolves.toBeNull();
  });
});

describe('форма исходников: неудача загрузки ничего не переписывает', () => {
  it('отступаются на любом пустом ответе, а не только когда нечего терять', () => {
    expect(SRC).toContain('if (uri === null) continue;');
    expect(SRC).not.toContain('uri === null && prev.uri === null');
  });

  it('записывается только проверенный снимок — с его же версией', () => {
    expect(SRC).toContain('known.set(pubB64, { uri, ver: version, at: prev.at });');
    expect(SRC).not.toContain('ver: uri ? version : null');
  });
});
