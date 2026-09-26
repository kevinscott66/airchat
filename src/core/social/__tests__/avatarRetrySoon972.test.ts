/**
 * Сорвавшаяся загрузка прятала лицо на полчаса (v4.32.972).
 *
 * Дефект. Справочник, узнав версию фото, ставит ключу отметку «спрашивали
 * только что» ДО того, как за снимком сходили:
 *
 *     known.set(pubB64, { uri: prev?.uri ?? null, ver: prev?.ver ?? null, at: now });
 *     pending.push({ pubB64, urlKey, version });
 *
 * По этой же отметке `requestPublicAvatar` полчаса (`LOOKUP_TTL_MS`)
 * отказывается спрашивать снова. Отметка про ОТВЕТ справочника честная —
 * ответ и правда свежий. Нечестно то, что ею же закрывается дорога к
 * снимку, которого на устройстве так и не появилось.
 *
 * Цена. Один моргнувший запрос за байтами — и у собеседника, чьего фото мы
 * ещё не видели, полчаса буква в кружке. При том что сервер снимок отдаёт, и
 * версию его мы знаем. Само не чинится: каждая отрисовка упирается в ту же
 * отметку и молча уходит.
 *
 * Правка. `retryLater`: при пустом ответе разборки и при исключении отметка
 * сдвигается назад ровно настолько, чтобы до следующего похода осталась
 * минута (`RETRY_TTL_MS`). Сдвиг всегда в прошлое — свежее, чем поставил
 * справочник, отметка стать не может.
 *
 * Границы. Минута — это про «не достали байты», а не про «фото нет»: ответ
 * справочника по-прежнему помнится полчаса. И разобранный отказ (подпись не
 * сошлась, свёртка не та) не повторяется вовсе: за той же версией принесут
 * те же байты, и `hopeless` держит их в стороне.
 *
 * Подпись здесь настоящая, как и в проверках v4.32.940/965: поддельные сеть
 * и файлы, порядок проверок — нет. Часы подменены: без этого ни одна
 * выдержка не проверяется.
 */
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

const mockFiles = new Map<string, string>();
let mockLookupBody: unknown = null;
let mockSignedBody: unknown = null;
let mockSignedOk = true;
/** Бросать вместо ответа: связь оборвалась, а не сервер отказал. */
let mockSignedThrows = false;
/** Куда ходили за эту проверку: по адресам видно, что переспросили. */
const mockFetches: string[] = [];
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
    mockFetches.push(String(url));
    if (String(url).endsWith('/signed')) {
      if (mockSignedThrows) throw new Error('network went away');
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

const OWNER = keyPair(33);
const STRANGER = keyPair(44);
const PUB_B64 = Buffer.from(OWNER.publicKey).toString('base64');
const URL_KEY = Buffer.from(OWNER.publicKey).toString('base64url');

const IMAGE_OLD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 3, 1, 4, 1, 5]);
const IMAGE_NEW = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 2, 7, 1, 8]);
const OLD_B64 = IMAGE_OLD.toString('base64');
const NEW_B64 = IMAGE_NEW.toString('base64');
const hashOf = (b: Buffer): string => createHash('sha256').update(b).digest('hex').slice(0, 32);
const VER_OLD = hashOf(IMAGE_OLD);
const VER_NEW = hashOf(IMAGE_NEW);
const FILE_OLD = `file:///cache/pubavatar-${URL_KEY}-${VER_OLD}.img`;
const FILE_NEW = `file:///cache/pubavatar-${URL_KEY}-${VER_NEW}.img`;

/** Выдержка на ответ справочника: столько помнят «есть фото или нет». */
const TTL_MS = 30 * 60 * 1000;
/** Выдержка на сорвавшуюся загрузку: столько ждут до второго похода. */
const RETRY_MS = 60 * 1000;

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

/** Перевести часы вперёд. */
const advance = (ms: number): void => {
  mockNow += ms;
};

const signedCalls = (): number => mockFetches.filter((u) => u.endsWith('/signed')).length;
const lookupCalls = (): number => mockFetches.filter((u) => u.endsWith('/lookup')).length;

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
  mockNow = 1_700_000_000_000;
  resetPublicAvatars();
  mockFiles.clear();
  mockFetches.length = 0;
  mockSignedOk = true;
  mockSignedThrows = false;
  mockLookupBody = { found: { [URL_KEY]: VER_OLD } };
  mockSignedBody = await proof(OLD_B64);
});

describe('за сорвавшимся снимком возвращаются через минуту, а не через полчаса', () => {
  it('первое же фото: сервер не отдал снимок — через минуту лицо на месте', async () => {
    mockSignedOk = false;
    mockSignedBody = { error: 'avatar_proof_missing' };
    expect(await ask()).toBeNull();

    advance(RETRY_MS + 1);
    mockSignedOk = true;
    mockSignedBody = await proof(OLD_B64);

    expect(await ask()).toBe(FILE_OLD);
  });

  it('связь оборвалась посреди загрузки — та же минута', async () => {
    mockSignedThrows = true;
    expect(await ask()).toBeNull();

    advance(RETRY_MS + 1);
    mockSignedThrows = false;

    expect(await ask()).toBe(FILE_OLD);
  });

  it('новое фото собеседника доезжает через минуту, а не через полчаса', async () => {
    expect(await ask()).toBe(FILE_OLD);

    advance(TTL_MS + 1);
    mockLookupBody = { found: { [URL_KEY]: VER_NEW } };
    mockSignedOk = false;
    mockSignedBody = { error: 'avatar_proof_missing' };
    // Прежнее лицо на экране остаётся — это уже правка v4.32.965.
    expect(await ask()).toBe(FILE_OLD);

    advance(RETRY_MS + 1);
    mockSignedOk = true;
    mockSignedBody = await proof(NEW_B64);

    expect(await ask()).toBe(FILE_NEW);
    expect(mockFiles.get(FILE_NEW)).toBe(NEW_B64);
  });

  it('пока минута не прошла, за снимком не бегают каждую отрисовку', async () => {
    mockSignedOk = false;
    mockSignedBody = { error: 'avatar_proof_missing' };
    expect(await ask()).toBeNull();
    const after = signedCalls();

    advance(RETRY_MS - 1000);
    expect(await ask()).toBeNull();

    expect(signedCalls()).toBe(after);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Минута — это послабление ровно для «байты не доехали». Ответ справочника
 * по-прежнему живёт полчаса, разобранный отказ не повторяется вовсе, а
 * доехавшее фото не перекачивается.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: послабление узкое', () => {
  it('у честного фото путь до экрана есть', async () => {
    expect(await ask()).toBe(FILE_OLD);
    expect(mockFiles.get(FILE_OLD)).toBe(OLD_B64);
  });

  it('ГРАНИЦА: ответ «фото нет» через минуту не переспрашивают', async () => {
    mockLookupBody = { found: {} };
    expect(await ask()).toBeNull();
    const after = lookupCalls();

    advance(RETRY_MS + 1);
    expect(await ask()).toBeNull();

    expect(lookupCalls()).toBe(after);
  });

  it('ГРАНИЦА: разобранный отказ не повторяют — принесут те же байты', async () => {
    // Подпись чужим ключом: разобрали и отвергли. Связь тут ни при чём.
    mockSignedBody = await proof(OLD_B64, STRANGER);
    expect(await ask()).toBeNull();
    const after = signedCalls();

    advance(RETRY_MS + 1);
    expect(await ask()).toBeNull();

    expect(signedCalls()).toBe(after);
  });

  it('ГРАНИЦА: доехавшее фото через минуту не перекачивают', async () => {
    expect(await ask()).toBe(FILE_OLD);
    const after = lookupCalls();

    advance(RETRY_MS + 1);
    expect(await ask()).toBe(FILE_OLD);

    expect(lookupCalls()).toBe(after);
  });

  it('ГРАНИЦА: смена аккаунта отметки уносит вместе со всем остальным', async () => {
    expect(await ask()).toBe(FILE_OLD);
    resetPublicAvatars();
    expect(publicAvatarUri(PUB_B64)).toBeNull();
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Отметку ставит справочник — до того, как снимок доехал; и он же закрывает
 * дорогу на полчаса. Обе половины повода на месте, иначе правка лечила бы
 * то, чего нет.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('справочник ставит отметку, ещё не зная, доедет ли снимок', () => {
    expect(SRC).toContain('known.set(pubB64, { uri: prev?.uri ?? null, ver: prev?.ver ?? null, at: now });');
    expect(SRC).toContain('pending.push({ pubB64, urlKey, version });');
  });

  it('и по этой же отметке спрашивать нельзя полчаса', () => {
    expect(SRC).toContain('const LOOKUP_TTL_MS = 30 * 60 * 1000;');
    expect(SRC).toContain('if (prev && Date.now() - prev.at');
  });
});

describe('форма исходников: отступление с возвратом', () => {
  it('выдержка повтора отдельная и короткая', () => {
    expect(SRC).toContain('const RETRY_TTL_MS = 60 * 1000;');
    expect(SRC).toContain('at: Date.now() - LOOKUP_TTL_MS + RETRY_TTL_MS');
  });

  it('к нему возвращаются с обоих путей неудачи', () => {
    expect(SRC).toContain('function retryLater(pubB64: string, version: string): void {');
    expect(SRC.split('retryLater(pubB64, version);').length - 1).toBe(2);
  });

  it('отвергнутую версию держат в стороне и забывают при смене аккаунта', () => {
    expect(SRC).toContain('const hopeless = new Set<string>();');
    expect(SRC).toContain('if (hopeless.has(`${pubB64}:${version}`)) return;');
    expect(SRC).toContain('hopeless.clear();');
  });
});
