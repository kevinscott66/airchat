/**
 * Имя снимка и его байты — одна фотография (v4.32.1010).
 *
 * Дефект. Фотография профиля лежит в двух местах сразу: файл на диске и его
 * байты в базе (см. identity/ownAvatar). Запись байтов не проверялась ни с
 * одной стороны. При сохранении `saveOwnAvatar` возвращал путь, даже когда
 * байты в базу не легли, — в базе оставалось имя НОВОГО файла при байтах
 * ПРЕЖНЕГО. При рассылке `publishOwnAvatarToDirectory` читал только базу, и
 * пустая запись байтов означала для него «фотографии нет».
 *
 * Цена. Экран по ответу `saveOwnAvatar` говорит «Фото профиля обновлено» —
 * то есть отвечал так на половину работы. Байты — это та половина, что
 * уезжает в облако и на второе устройство: там показывалось бы прежнее лицо
 * под новым именем, а стоит файлу пропасть (обновление, чистка, перенос) —
 * прежнее лицо вернулось бы и здесь. Вторая половина дороже: незаполненная
 * запись байтов при живом файле отправляла в справочник `del`, то есть
 * СНИМАЛА фотографию у всех, кто смотрит карточку по @имени, — и это сразу
 * после того, как человеку сказали «обновлено».
 *
 * Правка. Байты входят в успех сохранения: не легли — снимок откатывается к
 * прежнему и экран получает `null`, на который у него уже есть ответ. А
 * `ownAvatarBytesFor` при пустой записи дочитывает байты с диска: `null`
 * оттуда теперь значит «фотографии нет», и только это.
 *
 * Границы. Пустой файл фотографией не считается: `del` в этом случае —
 * верный ответ. Откат возвращает ИМЯ прежнего снимка, а не его файл: файл
 * никуда не девался, удаляют его только после удачной замены.
 *
 * Здесь настоящие identity/ownAvatar и social/publicAvatar: подменены диск,
 * kv и сервер, а вся цепочка от выбора снимка до запроса к справочнику —
 * своя.
 */
let mockDocDir = '/doc/';
const mockFiles: Record<string, string> = {};
jest.mock('expo-file-system/legacy', () => ({
  get documentDirectory() { return mockDocDir; },
  cacheDirectory: '/cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: jest.fn(async (uri: string) => ({ exists: mockFiles[uri] != null })),
  readAsStringAsync: jest.fn(async (uri: string) => {
    if (mockFiles[uri] == null) throw new Error('ENOENT');
    return mockFiles[uri];
  }),
  writeAsStringAsync: jest.fn(async (uri: string, data: string) => { mockFiles[uri] = data; }),
  copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    if (mockFiles[from] == null) throw new Error('ENOENT');
    mockFiles[to] = mockFiles[from];
  }),
  deleteAsync: jest.fn(async (uri: string) => { delete mockFiles[uri]; }),
}));

/** Какая запись kv не принимается — по концу ключа, чтобы не считать профиль. */
let mockFailKey: string | null = null;

jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  const set = jest.fn(async (key: string, value: string) => {
    if (mockFailKey !== null && key.endsWith(mockFailKey)) return false;
    kv[key] = value;
    return true;
  });
  return {
    __kv: kv,
    kvGet: jest.fn(async (key: string) => kv[key] ?? null),
    kvSet: jest.fn(async (key: string, value: string) => { kv[key] = value; }),
    kvDelete: jest.fn(async (key: string) => { delete kv[key]; }),
    kvGetSecret: jest.fn(async (key: string) => kv[key] ?? null),
    kvGetSecretCell: jest.fn(async (key: string) =>
      (kv[key] == null ? { state: 'absent' } : { state: 'plain', text: kv[key] })),
    kvGetSecretUpgrading: jest.fn(async (key: string) => kv[key] ?? null),
    kvGetSecretCellUpgrading: jest.fn(async (key: string) =>
      (kv[key] == null ? { state: 'absent' } : { state: 'plain', text: kv[key] })),
    kvSetSecret: set,
    kvSetSecretScoped: jest.fn(async (pid: number, key: string, value: string) => set(`p${pid}:${key}`, value)),
  };
});

const mockMyPub = new Uint8Array(32).fill(3);
jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1, name: 'Личный' }),
    getProfileName: () => 'Личный',
    getActiveKeyPair: () => ({ publicKey: mockMyPub, secretKey: new Uint8Array(64) }),
  },
}));

let mockVisibility: 'everybody' | 'contacts' | 'nobody' | null = 'everybody';
jest.mock('../../settings/avatarVisibility', () => ({
  avatarVisibilityTryFor: jest.fn(async () => mockVisibility),
}));
jest.mock('../../backup/cloudVault', () => ({ cloudBaseUrl: () => 'https://vault.test' }));
jest.mock('../../crypto/signature', () => ({
  signJson: jest.fn(async (_p: unknown, obj: Record<string, unknown>) => ({ payload: JSON.stringify(obj), signature: 'sig' })),
  verifySignedJson: jest.fn(async () => null),
}));
const mockFetch = jest.fn();
jest.mock('../../net/timedFetch', () => ({
  fetchWithDeadline: jest.fn(async (url: string, init: { body?: string }, _o: unknown, read: (r: unknown) => unknown) => {
    mockFetch(url, init.body ? JSON.parse(init.body) : null);
    return read({ ok: true, status: 200, json: async () => ({ ok: true }) });
  }),
}));
jest.mock('../contacts', () => ({
  listContacts: jest.fn(async () => []),
  subscribeContactsChanged: jest.fn(() => () => {}),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { ownAvatarUri, saveOwnAvatar } from '../../identity/ownAvatar';
import { publishOwnAvatarToDirectory, resetPublicAvatars } from '../publicAvatar';

const mockLocal = jest.requireMock('../../storage/local') as { __kv: Record<string, string> };

const NAME_KEY = 'p1:user_avatar_uri';
const IMG_KEY = 'p1:user_avatar_img';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** Что ушло в справочник последним запросом. */
function sent(): { act?: string; imageB64?: string } | null {
  const last = mockFetch.mock.calls.at(-1);
  return last ? (last[1] as { payload: string }) && JSON.parse((last[1] as { payload: string }).payload) : null;
}

beforeEach(() => {
  mockDocDir = '/doc/';
  mockFailKey = null;
  mockVisibility = 'everybody';
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockFetch.mockClear();
  resetPublicAvatars();
  jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
});

afterEach(() => { jest.restoreAllMocks(); });

/** Снимок, выбранный и сохранённый как обычно. */
async function pick(name: string, bytes: string): Promise<string | null> {
  mockFiles[`/tmp/${name}`] = b64(bytes);
  return await saveOwnAvatar(`/tmp/${name}`);
}

describe('байты не легли — снимок не сохранён', () => {
  it('ответ null, а не путь: экрану есть что сказать человеку', async () => {
    mockFailKey = 'user_avatar_img';
    expect(await pick('new.jpg', 'НОВОЕ ЛИЦО')).toBeNull();
  });

  it('в базе остаётся прежний снимок целиком, а не имя нового при байтах прежнего', async () => {
    await pick('old.jpg', 'ПРЕЖНЕЕ ЛИЦО');
    jest.spyOn(Date, 'now').mockReturnValue(1700000009999);
    mockFailKey = 'user_avatar_img';
    await pick('new.jpg', 'НОВОЕ ЛИЦО');

    expect(mockLocal.__kv[NAME_KEY]).toBe('avatar_1700000000000.jpg');
    expect(mockLocal.__kv[IMG_KEY]).toBe(b64('ПРЕЖНЕЕ ЛИЦО'));
  });

  it('прежнего снимка не было — имя без байтов в базе не остаётся', async () => {
    mockFailKey = 'user_avatar_img';
    await pick('new.jpg', 'НОВОЕ ЛИЦО');

    expect(mockLocal.__kv[NAME_KEY] ?? '').toBe('');
    expect(mockLocal.__kv[IMG_KEY]).toBeUndefined();
  });

  it('новый файл убран за собой: показывать его нечем и незачем', async () => {
    mockFailKey = 'user_avatar_img';
    await pick('new.jpg', 'НОВОЕ ЛИЦО');

    expect(mockFiles['/doc/avatar_1700000000000.jpg']).toBeUndefined();
  });

  it('на экране и в базе — одна фотография, а не две разные', async () => {
    await pick('old.jpg', 'ПРЕЖНЕЕ ЛИЦО');
    jest.spyOn(Date, 'now').mockReturnValue(1700000009999);
    mockFailKey = 'user_avatar_img';
    await pick('new.jpg', 'НОВОЕ ЛИЦО');

    const uri = await ownAvatarUri();
    expect(uri).toBe('/doc/avatar_1700000000000.jpg');
    expect(mockFiles[uri as string]).toBe(mockLocal.__kv[IMG_KEY]);
  });
});

describe('пустая запись байтов не снимает фотографию у всех', () => {
  /** База без байтов при живом файле: так выглядит снимок, чью запись не приняли. */
  function bytesLostInDb(): void {
    mockLocal.__kv[NAME_KEY] = 'avatar_1699999999999.jpg';
    mockFiles['/doc/avatar_1699999999999.jpg'] = b64('ЛИЦО');
  }

  it('в справочник уходит put с байтами файла, а не del', async () => {
    bytesLostInDb();
    await publishOwnAvatarToDirectory(1);

    expect(sent()).toMatchObject({ act: 'put', imageB64: b64('ЛИЦО') });
  });

  it('заодно байты ложатся в базу: второй раз с диска читать нечего', async () => {
    bytesLostInDb();
    await publishOwnAvatarToDirectory(1);

    expect(mockLocal.__kv[IMG_KEY]).toBe(b64('ЛИЦО'));
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: удачное сохранение как было', () => {
  it('и имя, и байты в базе, и путь в ответе', async () => {
    expect(await pick('pick.jpg', 'ЛИЦО')).toBe('/doc/avatar_1700000000000.jpg');
    expect(mockLocal.__kv[NAME_KEY]).toBe('avatar_1700000000000.jpg');
    expect(mockLocal.__kv[IMG_KEY]).toBe(b64('ЛИЦО'));
  });

  it('свежий снимок уходит в справочник целиком', async () => {
    await pick('pick.jpg', 'ЛИЦО');
    await publishOwnAvatarToDirectory(1);

    expect(sent()).toMatchObject({ act: 'put', imageB64: b64('ЛИЦО') });
  });

  it('фотографии нет вовсе — справочник по-прежнему просят снять её', async () => {
    await publishOwnAvatarToDirectory(1);

    expect(sent()).toMatchObject({ act: 'del' });
    expect(sent()?.imageB64).toBeUndefined();
  });

  it('не легло имя — по-прежнему null, и файл за собой убран', async () => {
    mockFailKey = 'user_avatar_uri';
    expect(await pick('pick.jpg', 'ЛИЦО')).toBeNull();
    expect(mockFiles['/doc/avatar_1700000000000.jpg']).toBeUndefined();
  });
});

describe('ГРАНИЦА', () => {
  it('«Кто видит фото» не «все» — снимок снимается, и диск для этого не нужен', async () => {
    await pick('pick.jpg', 'ЛИЦО');
    mockVisibility = 'contacts';
    await publishOwnAvatarToDirectory(1);

    expect(sent()).toMatchObject({ act: 'del' });
  });

  it('пустой файл фотографией не считается: del — верный ответ', async () => {
    mockLocal.__kv[NAME_KEY] = 'avatar_1699999999999.jpg';
    mockFiles['/doc/avatar_1699999999999.jpg'] = '';
    await publishOwnAvatarToDirectory(1);

    expect(sent()).toMatchObject({ act: 'del' });
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const src = (...p: string[]) => readFileSync(join(__dirname, '..', '..', ...p), 'utf8');

  it('оба экрана по-прежнему верят ответу saveOwnAvatar на слово', () => {
    for (const path of [
      ['..', 'ui', 'screens', 'ProfileScreen.tsx'],
      ['..', 'ui', 'components', 'modals', 'profile', 'ProfileEditModal.tsx'],
    ]) {
      const body = src(...path);
      expect(body).toContain('const finalUri = await saveOwnAvatar(resizedUri);');
      expect(body).toContain("'Не удалось сохранить фото профиля'");
      expect(body).toContain("showSuccess('Фото профиля обновлено')");
    }
  });

  it('байты по-прежнему уезжают в облако вместе с карточкой', () => {
    // Из-за этого несовпадение имени и байтов и стоит второго устройства:
    // туда едет база, а не файл.
    expect(src('storage', 'kvKeys.ts')).toContain("'user_avatar_img',");
  });
});
