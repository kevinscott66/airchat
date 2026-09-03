/**
 * Фотография профиля переживает обновление приложения (v4.32.556).
 *
 * Проверяется ровно то, из-за чего аватар пропадал: путь к файлу в
 * documentDirectory живёт до первой же новой установки — каталог данных лежит
 * в контейнере, имя которого UUID, и новая версия получает новый контейнер.
 * Поэтому в базе должно лежать ИМЯ файла, а рядом — сами байты, чтобы снимок
 * восстановился и тогда, когда файла не осталось вовсе.
 */
let mockDocDir = '/doc-A/';
const mockFiles: Record<string, string> = {};
jest.mock('expo-file-system/legacy', () => ({
  get documentDirectory() { return mockDocDir; },
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

jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  let writesFail = false;
  const kvSetSecret = jest.fn(async (key: string, value: string) => {
    if (writesFail) return false;
    kv[key] = value;
    return true;
  });
  return {
    __kv: kv,
    __failWrites: (on: boolean) => { writesFail = on; },
    kvGet: jest.fn(async (key: string) => kv[key] ?? null),
    kvSet: jest.fn(async (key: string, value: string) => { kv[key] = value; }),
    kvDelete: jest.fn(async (key: string) => { delete kv[key]; }),
    kvGetSecret: jest.fn(async (key: string) => kv[key] ?? null),
    kvGetSecretUpgrading: jest.fn(async (key: string) => kv[key] ?? null),
    kvSetSecret,
    kvSetSecretScoped: jest.fn(async (pid: number, key: string, value: string) =>
      kvSetSecret(`p${pid}:${key}`, value)),
  };
});

jest.mock('../profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1, name: 'Личный' }),
    getProfileName: () => 'Личный',
  },
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { ownAvatarNameFor, ownAvatarUri, ownAvatarUriFor, saveOwnAvatar } from '../ownAvatar';

const mockLocal = jest.requireMock('../../storage/local') as {
  __kv: Record<string, string>;
  __failWrites: (on: boolean) => void;
};

/** Установка новой версии приложения: файлы переезжают, путь к ним — нет. */
function appUpdate(nextDir: string): void {
  const moved = Object.entries(mockFiles).filter(([uri]) => uri.startsWith(mockDocDir));
  for (const [uri, data] of moved) {
    delete mockFiles[uri];
    mockFiles[nextDir + uri.slice(mockDocDir.length)] = data;
  }
  mockDocDir = nextDir;
}

beforeEach(() => {
  mockDocDir = '/doc-A/';
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockLocal.__failWrites(false);
  jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('saveOwnAvatar', () => {
  it('в базу ложится имя файла и сами байты, а не путь', async () => {
    mockFiles['/tmp/pick.jpg'] = 'БАЙТЫ';
    expect(await saveOwnAvatar('/tmp/pick.jpg')).toBe('/doc-A/avatar_1700000000000.jpg');
    // Путь в базе — это и была вся ошибка: он существует ровно до следующей
    // установки, и ни одно место, которое его прочитает, об этом не узнает.
    expect(mockLocal.__kv['p1:user_avatar_uri']).toBe('avatar_1700000000000.jpg');
    expect(mockLocal.__kv['p1:user_avatar_img']).toBe('БАЙТЫ');
  });

  it('прежний снимок удаляется только после того, как лёг новый', async () => {
    mockFiles['/tmp/a.jpg'] = 'ПЕРВЫЙ';
    await saveOwnAvatar('/tmp/a.jpg');
    jest.spyOn(Date, 'now').mockReturnValue(1700000009999);
    mockFiles['/tmp/b.jpg'] = 'ВТОРОЙ';
    expect(await saveOwnAvatar('/tmp/b.jpg')).toBe('/doc-A/avatar_1700000009999.jpg');
    expect(mockFiles['/doc-A/avatar_1700000000000.jpg']).toBeUndefined();
    expect(mockLocal.__kv['p1:user_avatar_img']).toBe('ВТОРОЙ');
  });

  it('запись не легла — файл за собой убираем и честно отвечаем null', async () => {
    // Экран по этому ответу говорит «не удалось». Ответить «сохранено» и
    // показать при следующем открытии кружок с буквой — хуже всего.
    mockFiles['/tmp/pick.jpg'] = 'БАЙТЫ';
    mockLocal.__failWrites(true);
    expect(await saveOwnAvatar('/tmp/pick.jpg')).toBeNull();
    expect(mockFiles['/doc-A/avatar_1700000000000.jpg']).toBeUndefined();
  });

  it('исходника нет — ничего не пишем', async () => {
    expect(await saveOwnAvatar('/tmp/нет.jpg')).toBeNull();
    expect(mockLocal.__kv['p1:user_avatar_uri']).toBeUndefined();
  });
});

describe('после обновления приложения', () => {
  it('снимок остаётся на месте: путь собирается заново от текущего каталога', async () => {
    mockFiles['/tmp/pick.jpg'] = 'БАЙТЫ';
    await saveOwnAvatar('/tmp/pick.jpg');
    appUpdate('/doc-B/');
    expect(await ownAvatarUri()).toBe('/doc-B/avatar_1700000000000.jpg');
  });

  it('файл потерялся — снимок собирается обратно из базы', async () => {
    mockFiles['/tmp/pick.jpg'] = 'БАЙТЫ';
    await saveOwnAvatar('/tmp/pick.jpg');
    for (const k of Object.keys(mockFiles)) delete mockFiles[k];
    const uri = await ownAvatarUri();
    expect(uri).toBe('/doc-A/avatar_1700000000000.jpg');
    expect(mockFiles[uri as string]).toBe('БАЙТЫ');
  });

  it('запись прежнего образца (абсолютный путь) чинится при первом же чтении', async () => {
    // Так выглядит база у всех, кто выбрал фото до этой версии: путь в
    // исчезнувший контейнер. Файл при этом на месте — переехал вместе с
    // каталогом.
    mockLocal.__kv['p1:user_avatar_uri'] = '/doc-A/avatar_1699999999999.jpg';
    appUpdate('/doc-B/');
    mockFiles['/doc-B/avatar_1699999999999.jpg'] = 'СТАРЫЕ БАЙТЫ';
    expect(await ownAvatarUri()).toBe('/doc-B/avatar_1699999999999.jpg');
    // И запись, и байты приведены к новому виду — второй раз чинить нечего.
    expect(mockLocal.__kv['p1:user_avatar_uri']).toBe('avatar_1699999999999.jpg');
    expect(mockLocal.__kv['p1:user_avatar_img']).toBe('СТАРЫЕ БАЙТЫ');
  });

  it('ни файла, ни байтов — фотографии просто нет', async () => {
    mockLocal.__kv['p1:user_avatar_uri'] = '/doc-A/avatar_1699999999999.jpg';
    appUpdate('/doc-B/');
    expect(await ownAvatarUri()).toBeNull();
  });

  it('пустая база — null, и ничего не пишется', async () => {
    expect(await ownAvatarUriFor(2)).toBeNull();
    expect(Object.keys(mockLocal.__kv)).toEqual([]);
  });
});

describe('ownAvatarNameFor', () => {
  it('имя устойчиво к обновлению — по нему и метят загрузку и версию карточки', async () => {
    mockFiles['/tmp/pick.jpg'] = 'БАЙТЫ';
    await saveOwnAvatar('/tmp/pick.jpg');
    const before = await ownAvatarNameFor(1);
    appUpdate('/doc-B/');
    expect(await ownAvatarNameFor(1)).toBe(before);
    expect(before).toBe('avatar_1700000000000.jpg');
  });

  it('мусор в записи именем не считается', async () => {
    mockLocal.__kv['p1:user_avatar_uri'] = '/doc-A/чужой.jpg';
    expect(await ownAvatarNameFor(1)).toBe('');
  });
});
