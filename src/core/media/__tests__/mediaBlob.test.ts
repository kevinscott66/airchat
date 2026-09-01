/**
 * mediaBlob: чей адрес устройство открывает само и какие файлы стирает (v4.32.354).
 *
 * Дескриптор вложения приходит внутри сообщения, а useResolvedMediaUrls зовёт
 * resolveBlobToLocalFile при отрисовке чата — без нажатия, без спроса. Значит
 * адрес в дескрипторе выбирает отправитель, а идёт по нему получатель: это
 * маячок ровно того вида, от которого в v4.32.243 закрыли адрес IPFS-шлюза.
 *
 * Вторая половина файла — про удаление: file:// приходит из той же строки
 * сообщения, и ограничение «только кэш приложения» до этого раунда проверялось
 * по началу строки, чего для пути с '..' не хватает.
 */
const mockFiles = new Map<string, string>();
const mockDeleted: string[] = [];
/** Время правки файла в кэше, epoch-СЕКУНДЫ; нет записи — «неизвестно». */
const mockMtimes = new Map<string, number>();
/** Ссылки на вложения из уцелевших строк базы; null — база недоступна. */
let mockLiveIds: Set<string> | null = null;
let mockLiveCalls = 0;
let mockRelay: string | null = 'https://ntfy.sh';
let mockConfiguredRelay = 'https://ntfy.sh';
let mockTransportThrows = false;
let mockMoveFails = false;

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async (uri: string) => {
    const content = mockFiles.get(uri);
    if (content === undefined) return { exists: false };
    return { exists: true, size: content.length, modificationTime: mockMtimes.get(uri) };
  }),
  readAsStringAsync: jest.fn(async (uri: string) => {
    const content = mockFiles.get(uri);
    if (content === undefined) throw new Error('ENOENT');
    return content;
  }),
  writeAsStringAsync: jest.fn(async (uri: string, content: string) => {
    mockFiles.set(uri, content);
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    if (mockMoveFails) throw new Error('move failed');
    const content = mockFiles.get(from);
    if (content === undefined) throw new Error('ENOENT');
    mockFiles.set(to, content);
    mockFiles.delete(from);
  }),
  deleteAsync: jest.fn(async (uri: string) => {
    mockDeleted.push(uri);
    mockFiles.delete(uri);
  }),
  readDirectoryAsync: jest.fn(async () => [...mockFiles.keys()].map((u) => u.slice('file:///cache/'.length))),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../../transport/internet/internetTransport', () => ({
  getInternetTransportSingleton: jest.fn(() => {
    if (mockTransportThrows) throw new Error('transport not started');
    return { getStatus: () => ({ relay: mockRelay }) };
  }),
}));
jest.mock('../../config', () => ({
  getConfigSync: jest.fn(() => ({ internet: { relayBase: mockConfiguredRelay } })),
}));
// v4.32.427: заглушены только две функции. Константы берутся настоящие —
// иначе SYMMETRIC_KEY_BYTES приезжает undefined, проверка длины ключа
// проходит всегда, и тест перестаёт проверять то, ради чего написан.
jest.mock('../../crypto/encrypt', () => ({
  ...jest.requireActual('../../crypto/encrypt'),
  encryptSymmetric: jest.fn(() => new Uint8Array([9, 9, 9])),
  decryptSymmetric: jest.fn(() => new Uint8Array([1, 2, 3])),
}));

import { Buffer } from 'buffer';
import { blobCacheId } from '../blobRef';
import { cachedFileUrisPresent, deleteCachedFileUris, resolveBlobToLocalFile, sweepMediaCache, type LiveBlobIdsLoader } from '../mediaBlob';

const DIR = 'file:///cache/';
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const CIPHER_B64 = Buffer.from([1, 2, 3, 4]).toString('base64');

/** Ответ релея: тело — base64 ciphertext'а, заголовок можно подделать. */
function okResponse(body: string, contentLength?: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? contentLength ?? null : null) },
    text: async () => body,
  } as unknown as Response;
}

let mockFetch: jest.Mock;

beforeEach(() => {
  mockFiles.clear();
  mockDeleted.length = 0;
  mockMtimes.clear();
  mockLiveIds = new Set<string>();
  mockLiveCalls = 0;
  mockRelay = 'https://ntfy.sh';
  mockConfiguredRelay = 'https://ntfy.sh';
  mockTransportThrows = false;
  mockMoveFails = false;
  mockFetch = jest.fn(async () => okResponse(CIPHER_B64));
  (global as unknown as { fetch: unknown }).fetch = mockFetch;
});

describe('resolveBlobToLocalFile: куда позволено идти за вложением', () => {
  it('вложение со своего релея скачивается и расшифровывается', () => {
    return expect(
      resolveBlobToLocalFile({ u: 'https://ntfy.sh/file/aBc1.bin', k: KEY_B64 }, 'jpg'),
    ).resolves.toMatch(/^file:\/\/\/cache\/airchat_media_.+\.jpg$/);
  });

  it('чужой хост не открывается вовсе', async () => {
    // Не «скачали и выбросили»: запроса быть не должно — сам факт запроса и
    // есть то, что отправитель хотел получить.
    await expect(
      resolveBlobToLocalFile({ u: 'https://schetchik.example/file/x', k: KEY_B64 }, 'jpg'),
    ).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('адрес в локальной сети получателя не открывается', async () => {
    await expect(
      resolveBlobToLocalFile({ u: 'http://192.168.1.1/file/x', k: KEY_B64 }, 'jpg'),
    ).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('подмена через userinfo не открывается', async () => {
    // Строка начинается с 'https://ntfy.sh', ведёт на evil.example.
    await expect(
      resolveBlobToLocalFile({ u: 'https://ntfy.sh@evil.example/file/x', k: KEY_B64 }, 'jpg'),
    ).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('свой self-host из конфига разрешён, даже когда транспорт ещё не поднят', async () => {
    mockTransportThrows = true;
    mockConfiguredRelay = 'https://ntfy.razvedchick.ru';
    await expect(
      resolveBlobToLocalFile({ u: 'https://ntfy.razvedchick.ru/file/x', k: KEY_B64 }, 'jpg'),
    ).resolves.not.toBeNull();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('заводской ntfy.sh разрешён и при своём релее в настройках', async () => {
    // Иначе смена релея разом обрывала бы уже полученные вложения.
    mockRelay = 'https://ntfy.razvedchick.ru';
    mockConfiguredRelay = 'https://ntfy.razvedchick.ru';
    await expect(
      resolveBlobToLocalFile({ u: 'https://ntfy.sh/file/x', k: KEY_B64 }, 'jpg'),
    ).resolves.not.toBeNull();
  });

  it('релей на своём порту совпадает сам с собой', async () => {
    mockRelay = 'https://ntfy.razvedchick.ru:8443';
    await expect(
      resolveBlobToLocalFile({ u: 'https://ntfy.razvedchick.ru:8443/file/x', k: KEY_B64 }, 'jpg'),
    ).resolves.not.toBeNull();
  });

  it('уже расшифрованный файл отдаётся без сети', async () => {
    const ref = { u: 'https://ntfy.sh/file/aBc1.bin', k: KEY_B64 };
    const dest = `${DIR}airchat_media_${blobCacheId(ref)}.jpg`;
    mockFiles.set(dest, 'уже лежит');
    await expect(resolveBlobToLocalFile(ref, 'jpg')).resolves.toBe(dest);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('resolveBlobToLocalFile: сколько позволено скачать', () => {
  it('заявленный размер сверх потолка — тело не читается', async () => {
    const text = jest.fn(async () => CIPHER_B64);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => '99000000' },
      text,
    } as unknown as Response);
    await expect(
      resolveBlobToLocalFile({ u: 'https://ntfy.sh/file/x', k: KEY_B64 }, 'jpg'),
    ).resolves.toBeNull();
    // Смысл проверки заголовка в том, чтобы не буферизовать тело: проверка
    // после res.text() от переполнения памяти не защищает вовсе.
    expect(text).not.toHaveBeenCalled();
  });

  it('солгавший заголовок ловится проверкой после чтения', async () => {
    mockFetch.mockResolvedValueOnce(okResponse('A'.repeat(12_000_001), '10'));
    await expect(
      resolveBlobToLocalFile({ u: 'https://ntfy.sh/file/x', k: KEY_B64 }, 'jpg'),
    ).resolves.toBeNull();
  });

  it('пустое тело — не вложение', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(''));
    await expect(
      resolveBlobToLocalFile({ u: 'https://ntfy.sh/file/x', k: KEY_B64 }, 'jpg'),
    ).resolves.toBeNull();
  });

  it('ответ без заголовка размера скачивается', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(CIPHER_B64));
    await expect(
      resolveBlobToLocalFile({ u: 'https://ntfy.sh/file/x', k: KEY_B64 }, 'jpg'),
    ).resolves.not.toBeNull();
  });

  it('ключ не той длины — не расшифровываем', async () => {
    await expect(
      resolveBlobToLocalFile({ u: 'https://ntfy.sh/file/x', k: Buffer.alloc(16).toString('base64') }, 'jpg'),
    ).resolves.toBeNull();
  });

  it('ошибка перемещения не оставляет расшифрованный temp-файл', async () => {
    mockMoveFails = true;
    await expect(
      resolveBlobToLocalFile({ u: 'https://ntfy.sh/file/x', k: KEY_B64 }, 'jpg'),
    ).resolves.toBeNull();
    expect(mockDeleted.some((uri) => uri.includes('.tmp-'))).toBe(true);
  });
});

describe('deleteCachedFileUris', () => {
  const put = (uri: string) => mockFiles.set(uri, 'x');

  it('стирает файл кэша и считает удалённые', async () => {
    put(`${DIR}airchat_media_a1.jpg`);
    await expect(deleteCachedFileUris([`${DIR}airchat_media_a1.jpg`])).resolves.toBe(1);
    expect(mockDeleted).toEqual([`${DIR}airchat_media_a1.jpg`]);
  });

  it('стирает голосовое из подкаталога кэша', async () => {
    put(`${DIR}Audio/recording-1.m4a`);
    await expect(deleteCachedFileUris([`${DIR}Audio/recording-1.m4a`])).resolves.toBe(1);
  });

  it('не выходит из каталога кэша через ..', async () => {
    // Адрес приходит из строки сообщения. Проверка по началу строки этот путь
    // пропускала — а ведёт он в базу переписки.
    await expect(deleteCachedFileUris([`${DIR}../databases/airchat.db`])).resolves.toBe(0);
    expect(mockDeleted).toEqual([]);
  });

  it('не выходит из каталога кэша через проценты', async () => {
    await expect(deleteCachedFileUris([`${DIR}..%2F..%2Fdatabases/airchat.db`])).resolves.toBe(0);
    expect(mockDeleted).toEqual([]);
  });

  it('не трогает файлы вне кэша', async () => {
    // Оригинал снимка в галерее — то, ради чего ограничение и вводилось.
    await expect(deleteCachedFileUris(['file:///storage/emulated/0/DCIM/IMG_1.jpg'])).resolves.toBe(0);
    expect(mockDeleted).toEqual([]);
  });

  it('не трогает соседний каталог с тем же началом имени', async () => {
    await expect(deleteCachedFileUris(['file:///cache-evil/a.jpg'])).resolves.toBe(0);
  });

  it('запретный адрес не отменяет удаление остальных', async () => {
    put(`${DIR}airchat_media_a1.jpg`);
    await expect(
      deleteCachedFileUris([`${DIR}../databases/airchat.db`, `${DIR}airchat_media_a1.jpg`]),
    ).resolves.toBe(1);
    expect(mockDeleted).toEqual([`${DIR}airchat_media_a1.jpg`]);
  });
});

describe('cachedFileUrisPresent', () => {
  it('находит существующий файл кэша', async () => {
    mockFiles.set(`${DIR}Audio/recording-1.m4a`, 'x');
    await expect(cachedFileUrisPresent([`${DIR}Audio/recording-1.m4a`])).resolves.toEqual([
      `${DIR}Audio/recording-1.m4a`,
    ]);
  });

  it('отсутствующий файл не находит', async () => {
    await expect(cachedFileUrisPresent([`${DIR}нет.jpg`])).resolves.toEqual([]);
  });

  it('адрес с выходом из каталога не подтверждает даже для существующего файла', async () => {
    // Иначе тот же адрес ушёл бы дальше — в deleteCachedFileUris.
    mockFiles.set(`${DIR}../databases/airchat.db`, 'x');
    await expect(cachedFileUrisPresent([`${DIR}../databases/airchat.db`])).resolves.toEqual([]);
  });
});

/**
 * v4.32.518. Уборщик стирал файл, если тот старше суток, — и только поэтому.
 * Но каталог кэша хранит не только производные копии: у вложения, приехавшего
 * по LAN, `airchat_blobcache_<id>.bin` — единственный экземпляр шифротекста, а
 * у приехавшего с релея вложение на ntfy живёт около трёх часов, так что к
 * суткам единственной остаётся и расшифрованная `airchat_media_<id>.<ext>`.
 * Сообщение оставалось в переписке, а открыть его вложение было уже нечем.
 *
 * getInfoAsync в этом наборе отдаёт modificationTime только для файлов,
 * которым его задали; у остальных он undefined, что и означает «возраст
 * неизвестен» — то есть худший случай, просрочено.
 */
describe('sweepMediaCache: возраст — ещё не повод удалять', () => {
  const LIVE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const DEAD_ID = '00112233445566778899aabbccddeeff';
  const cipher = (id: string) => `${DIR}airchat_blobcache_${id}.bin`;
  /** Живые ссылки, как их отдаёт хранилище; null — база недоступна. */
  const loadLive: LiveBlobIdsLoader = async () => {
    mockLiveCalls++;
    if (mockLiveIds === null) throw new Error('database is locked');
    return mockLiveIds;
  };
  const plain = (id: string) => `${DIR}airchat_media_${id}.jpg`;

  it('шифротекст LAN-вложения остаётся, пока сообщение с ним живо', async () => {
    mockFiles.set(cipher(LIVE_ID), 'ciphertext');
    mockLiveIds = new Set([LIVE_ID]);
    await sweepMediaCache(loadLive);
    expect(mockDeleted).toEqual([]);
  });

  it('расшифрованная копия живого вложения тоже остаётся: с релея её уже не взять', async () => {
    mockFiles.set(plain(LIVE_ID), 'plaintext');
    mockLiveIds = new Set([LIVE_ID]);
    await sweepMediaCache(loadLive);
    expect(mockDeleted).toEqual([]);
  });

  it('файл, на который не ссылается ни одна строка, удаляется', async () => {
    mockFiles.set(cipher(DEAD_ID), 'ciphertext');
    mockFiles.set(plain(DEAD_ID), 'plaintext');
    mockLiveIds = new Set([LIVE_ID]);
    await sweepMediaCache(loadLive);
    expect(mockDeleted.sort()).toEqual([cipher(DEAD_ID), plain(DEAD_ID)].sort());
  });

  it('база недоступна — не удаляется ничего', async () => {
    mockFiles.set(cipher(DEAD_ID), 'ciphertext');
    mockLiveIds = null;
    await sweepMediaCache(loadLive);
    expect(mockDeleted).toEqual([]);
  });

  it('свежий файл не трогается, даже если ссылок на него нет', async () => {
    const uri = cipher(DEAD_ID);
    mockFiles.set(uri, 'ciphertext');
    mockMtimes.set(uri, Math.floor(Date.now() / 1000) - 60);
    await sweepMediaCache(loadLive);
    expect(mockDeleted).toEqual([]);
  });

  it('чужой файл в том же каталоге уборщика не касается', async () => {
    mockFiles.set(`${DIR}IMG_0042.jpg`, 'photo');
    await sweepMediaCache(loadLive);
    expect(mockDeleted).toEqual([]);
  });

  it('если стирать нечего, база не открывается вовсе', async () => {
    const uri = cipher(DEAD_ID);
    mockFiles.set(uri, 'ciphertext');
    mockMtimes.set(uri, Math.floor(Date.now() / 1000) - 60);
    mockFiles.set(`${DIR}IMG_0042.jpg`, 'photo');
    await sweepMediaCache(loadLive);
    // Полная расшифровка переписки на каждом запуске — не та цена, которую
    // стоит платить, когда просроченного нет ни одного файла.
    expect(mockLiveCalls).toBe(0);
  });
});
