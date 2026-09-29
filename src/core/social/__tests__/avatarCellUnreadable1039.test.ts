/**
 * Нечитаемая ячейка снимка стирала фотографию у всех (v4.32.1039).
 *
 * ДЕФЕКТ. Путь к своей фотографии собирает `ownAvatarUriFor`, и обе ячейки
 * карточки он читал собирающей формой `ownFieldGetFor` — той, что сводит
 * «записи нет» и «запись не открылась» к одному `null`. Различающая форма
 * рядом есть с v4.32.705, а соседнее имя файла её уже спрашивает
 * (`ownAvatarNameTryFor`, v4.32.1023). Сам снимок остался последним, кто
 * этого не делал.
 *
 * ЦЕНА. Пустой ответ отсюда читают двое, и оба делают из него вывод, а не
 * показ. Рассылка карточки на пустой путь не заливает файл и отправляет
 * конверт БЕЗ `avatarCid`, а получатель по такому конверту пишет
 * `avatarCid: profile.avatarCid ?? ''` — стирает фотографию у себя
 * (contacts, setPeerProfileForChecked). Справочник по @имени на тот же ответ
 * шлёт `act: 'del'` — снимает выставленное фото у всех, кто смотрит карточку.
 * Ячейка шифрованная: при закрытом устройстве ключа нет вовсе, а рассылку
 * зовут и на запуске, и из фона. Отменить нечем — фотография у контактов уже
 * стёрта, и вернётся она лишь следующей удачной рассылкой.
 *
 * ПРАВКА. `ownAvatarUriTryFor` и `ownAvatarBytesTryFor`: `null` — «ячейку не
 * открыли», `{ uri: null }` / `{ b64: null }` — «фотографии нет». Рассылка на
 * первое отвечает исходом `'unreadable'` (тем же, что у остальных восьми
 * полей конверта), справочник — молчанием. Собирающие формы остались
 * обёртками: экрану, который просто рисует кружок, разницы нет.
 *
 * ГРАНИЦЫ. Настоящее отсутствие снимка по-прежнему стирает его и у
 * собеседника — иначе удалить фотографию стало бы нельзя. Пустой файл
 * фотографией не считается: это «нет», а не «не прочитали». Неудача ЗАЛИВКИ
 * — по-прежнему просто отсутствие `avatarCid`: это сеть, она вернётся сама.
 */

/** Содержимое ячеек карточки: логический ключ → строка. */
let mockCells: Record<string, string> = {};
/** Логические ключи, чтение которых отказывает. */
let mockCellFail = new Set<string>();

/** Ключ без префикса профиля: `p7:user_avatar_img` → `user_avatar_img`. */
const bare = (key: string): string => key.replace(/^p\d+:/, '');

const cellFor = (key: string) => {
  const k = bare(key);
  if (mockCellFail.has(k)) return { state: 'unreadable' as const };
  return k in mockCells
    ? { state: 'plain' as const, text: mockCells[k] }
    : { state: 'absent' as const };
};

jest.mock('../../storage/local', () => ({
  kvGetSecretCellUpgrading: async (key: string) => cellFor(key),
  kvGetSecretCell: async (key: string) => cellFor(key),
  kvSetSecret: async () => true,
  kvSetSecretScoped: async () => true,
  kvDelete: async () => undefined,
  kvGet: async () => null,
  kvSet: async () => undefined,
}));

/** Файлы на диске: путь → содержимое (пустая строка — пустой файл). */
let mockFiles: Record<string, string> = {};

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/doc/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: async (uri: string) => ({ exists: uri in mockFiles }),
  readAsStringAsync: async (uri: string) => {
    if (!(uri in mockFiles)) throw new Error('ENOENT');
    return mockFiles[uri];
  },
  writeAsStringAsync: async (uri: string, data: string) => { mockFiles[uri] = data; },
  copyAsync: async () => undefined,
  deleteAsync: async () => undefined,
  makeDirectoryAsync: async () => undefined,
  readDirectoryAsync: async () => Object.keys(mockFiles).map((f) => f.replace('/doc/', '')),
}));

let mockKv: Record<string, string> = {};

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: async (_pid: number, key: string) => ({ value: mockKv[key] ?? null }),
  scopedKvGetFor: async (_pid: number, key: string) => mockKv[key] ?? null,
  scopedKvSetCheckedFor: async (_pid: number, key: string, value: string) => {
    mockKv[key] = value;
    return true;
  },
  scopedKvSetFor: async (_pid: number, key: string, value: string) => { mockKv[key] = value; },
  scopedKvSet: async (key: string, value: string) => { mockKv[key] = value; },
  scopedKvTryGetSecretFor: async (_pid: number, key: string) => ({ value: mockKv[key] ?? null }),
  scopedKvSetSecretCheckedFor: async (_pid: number, key: string, value: string) => {
    mockKv[key] = value;
    return true;
  },
}));

let mockSent: { peer: string; text: string }[] = [];

jest.mock('../messaging', () => ({
  getMessagingService: () => ({
    sendMessage: async (peer: string, text: string) => {
      mockSent.push({ peer, text });
      return 'cid1';
    },
  }),
}));

let mockContacts: { peerPublicKey: string }[] = [];
jest.mock('../contacts', () => ({
  listContactsFor: async () => mockContacts,
  setPeerProfileForChecked: async () => 'applied',
  isMyContact: async () => true,
}));

jest.mock('../sendGate', () => ({ canReachPeer: async () => true }));
jest.mock('../../settings/avatarVisibility', () => ({
  avatarVisibilityTryFor: async () => 'everybody',
}));
jest.mock('../publicAvatar', () => ({ publishOwnAvatarToDirectory: async () => undefined }));
jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 7 }),
    getProfileName: () => '',
    getAllProfiles: () => [{ id: 7, did: 'did:key:zOwner' }],
  },
}));
/** Заливка всегда удаётся: здесь проверяется чтение, а не сеть. */
jest.mock('../media/mediaBlob', () => ({}), { virtual: true });
jest.mock('../../media/mediaBlob', () => ({
  uploadEncryptedBlob: async () => ({ cid: 'bafy', key: 'k' }),
  makeNbCid: () => 'nb:bafy',
}));
jest.mock('../../media/blobRef', () => ({ guessImageMime: () => 'image/jpeg' }));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { ownAvatarBytesTryFor, ownAvatarUriTryFor } from '../../identity/ownAvatar';
import { broadcastMyProfile } from '../profileSync';

const PEER = 'P'.repeat(43);
const STAMP_KEY = 'profile:changed_at';
const REAL_STAMP = 1_700_000_000_000;
const NAME_KEY = 'user_avatar_uri';
const IMG_KEY = 'user_avatar_img';
const FACE = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64');
/** Имя обязано подходить под avatar_<время>.jpg — иначе оно не имя (avatarFiles). */
const FILE = 'avatar_1700000000000.jpg';
const URI = `/doc/${FILE}`;

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const here = (...p: string[]): string => join(__dirname, '..', '..', ...p);
const SYNC = (): string => codeOnly(readFileSync(here('social', 'profileSync.ts'), 'utf8'));
const PUBLIC = (): string => codeOnly(readFileSync(here('social', 'publicAvatar.ts'), 'utf8'));
const OWN = (): string => codeOnly(readFileSync(here('identity', 'ownAvatar.ts'), 'utf8'));

const lastEnvelope = (): Record<string, unknown> =>
  JSON.parse(mockSent[mockSent.length - 1].text.replace(/^[^{]*/, '')) as Record<string, unknown>;

beforeEach(() => {
  mockCells = { user_username: 'Аня', [NAME_KEY]: FILE, [IMG_KEY]: FACE };
  mockCellFail = new Set();
  mockFiles = { [URI]: FACE };
  mockKv = { [STAMP_KEY]: String(REAL_STAMP) };
  mockSent = [];
  mockContacts = [{ peerPublicKey: PEER }];
});

describe('чтение снимка исходом', () => {
  it('фотография есть — путь и байты отдаются', async () => {
    await expect(ownAvatarUriTryFor(7)).resolves.toEqual({ uri: URI });
    await expect(ownAvatarBytesTryFor(7)).resolves.toEqual({ b64: FACE });
  });

  it('фотографии нет — прочитали, внутри пусто', async () => {
    mockCells = { user_username: 'Аня' };
    mockFiles = {};
    await expect(ownAvatarUriTryFor(7)).resolves.toEqual({ uri: null });
    await expect(ownAvatarBytesTryFor(7)).resolves.toEqual({ b64: null });
  });

  it('ячейка имени не открылась — «не прочитали», а не «нет фотографии»', async () => {
    mockCellFail.add(NAME_KEY);
    await expect(ownAvatarUriTryFor(7)).resolves.toBeNull();
    await expect(ownAvatarBytesTryFor(7)).resolves.toBeNull();
  });

  it('файла нет, а ячейка байтов не открылась — тоже «не прочитали»', async () => {
    mockFiles = {};
    mockCellFail.add(IMG_KEY);
    await expect(ownAvatarUriTryFor(7)).resolves.toBeNull();
    await expect(ownAvatarBytesTryFor(7)).resolves.toBeNull();
  });

  it('ГРАНИЦА: пустой файл — это «нет фотографии», а не отказ', async () => {
    mockCells = { user_username: 'Аня', [NAME_KEY]: FILE };
    mockFiles = { [URI]: '' };
    await expect(ownAvatarBytesTryFor(7)).resolves.toEqual({ b64: null });
  });
});

describe('рассылка карточки', () => {
  it('ячейка снимка не открылась — карточка никому не уезжает', async () => {
    mockFiles = {};
    mockCellFail.add(IMG_KEY);

    await broadcastMyProfile();

    expect(mockSent).toEqual([]);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: та же карточка при читаемой ячейке уходит с фото', async () => {
    await broadcastMyProfile();

    expect(mockSent.map((s) => s.peer)).toEqual([PEER]);
    expect(lastEnvelope()).toMatchObject({ name: 'Аня', avatarCid: 'nb:bafy' });
  });

  it('ГРАНИЦА: фотографии нет по-настоящему — конверт уходит без неё', async () => {
    mockCells = { user_username: 'Аня' };
    mockFiles = {};

    await broadcastMyProfile();

    expect(mockSent.map((s) => s.peer)).toEqual([PEER]);
    expect(lastEnvelope()).toMatchObject({ name: 'Аня', avatarCid: null });
  });
});

describe('форма исходников', () => {
  it('различающие формы заведены, а собирающие остались обёртками', () => {
    const o = OWN();
    expect(o).toContain(
      'export async function ownAvatarUriTryFor(pid: number): Promise<{ uri: string | null } | null> {'
    );
    expect(o).toContain(
      'export async function ownAvatarBytesTryFor(pid: number): Promise<{ b64: string | null } | null> {'
    );
    expect(o).toContain('return (await ownAvatarUriTryFor(pid))?.uri ?? null;');
    expect(o).toContain('return (await ownAvatarBytesTryFor(pid))?.b64 ?? null;');
    // Собирающей формы чтения ячеек в модуле не осталось вовсе.
    expect(o).not.toContain('ownFieldGetFor');
  });

  it('рассылка отвечает на отказ тем же исходом, что и на остальные поля', () => {
    const s = SYNC();
    expect(s).toContain("if (read === null) return 'unreadable';");
    expect(s).toContain("if (cid === 'unreadable') return unreadableField('avatar_bytes', pid);");
    expect(s).not.toContain('await ownAvatarUriFor(pid)');
  });

  it('справочник по @имени на отказ молчит, а не шлёт del', () => {
    const p = PUBLIC();
    const at = p.indexOf('const read = await ownAvatarBytesTryFor(pid);');
    expect(at).toBeGreaterThan(0);
    expect(p.slice(at, at + 200)).toContain('if (read === null) {');
    expect(p).not.toContain('await ownAvatarBytesFor(pid)');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: пустой cid у получателя стирает фотографию', () => {
    const c = codeOnly(readFileSync(here('social', 'contacts.ts'), 'utf8'));
    expect(c).toContain("avatarCid: profile.avatarCid ?? ''");
  });
});
