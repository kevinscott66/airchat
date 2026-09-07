/**
 * Отправка вложения: три места, где неудача выглядела удачей (v4.32.617).
 *
 * 1. Размер файла система сообщает не всегда, и на ветке «не сообщила» файл
 *    читался целиком: проверка предела стояла ПОСЛЕ base64-строки и двух
 *    двоичных буферов, то есть после втрое большего файла в памяти. Ровно тот
 *    дефект, который на соседней ветке починили в v4.32.358.
 * 2. uploadSyncMedia возвращает `response.ok`, и результат отбрасывался:
 *    сервер, ответивший `{"ok":false}`, попадал в журнал как
 *    `blob_upload_cloud_ok` — «долговечная копия есть», когда её нет.
 * 3. lanBlobCacheWrite отдавала Promise<void>: неудача записи была не видна
 *    ни отправителю (нет кэша — нет повторной отправки), ни приёмнику.
 */
const mockRelay = 'https://ntfy.sh';
/** Виртуальный размер файла в байтах; null — система размер не сообщает. */
let mockFileSize: number | null = null;
/** Сколько байт «есть на диске» — столько отдаётся, но не больше запрошенного. */
let mockFileBytes = 0;
/** Аргументы каждого чтения: по ним видно, ограничено ли оно. */
let mockReads: Array<Record<string, unknown> | undefined> = [];
let mockCloudOk = true;
let mockCacheWriteOk = true;

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async () => (mockFileSize === null
    ? { exists: true }
    : { exists: true, size: mockFileSize })),
  readAsStringAsync: jest.fn(async (_uri: string, options?: Record<string, unknown>) => {
    mockReads.push(options);
    const asked = typeof options?.length === 'number' ? (options.length as number) : mockFileBytes;
    const bytes = Math.min(asked, mockFileBytes);
    // base64 нулевых байт — 'A' по четыре символа на каждые три байта.
    return 'A'.repeat(Math.floor(bytes / 3) * 4);
  }),
  writeAsStringAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async () => undefined),
  readDirectoryAsync: jest.fn(async () => []),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../../transport/internet/internetTransport', () => ({
  getInternetTransportSingleton: jest.fn(() => ({ getStatus: () => ({ relay: 'https://ntfy.sh' }) })),
}));
jest.mock('../../config', () => ({
  getConfigSync: jest.fn(() => ({
    internet: { relayBase: 'https://ntfy.sh' },
    cloudBackup: { enabled: true },
  })),
}));
jest.mock('../../backup/seedPhrase', () => ({
  getMnemonicGeneration: jest.fn(() => 1),
  getStoredMnemonic: jest.fn(async () => 'слова'),
  deriveKeyPairFromMnemonic: jest.fn(() => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) })),
}));
jest.mock('../../sync/syncApi', () => ({
  uploadSyncMedia: jest.fn(async () => mockCloudOk),
  downloadSyncMedia: jest.fn(async () => null),
}));
jest.mock('../../transport/lan/lanBlob', () => ({
  lanBlobCacheWrite: jest.fn(async () => mockCacheWriteOk),
  lanBlobPush: jest.fn(async () => true),
  lanBlobCachedPath: jest.fn(async () => null),
  lanBlobCacheDelete: jest.fn(async () => undefined),
}));
jest.mock('../../crypto/encrypt', () => ({
  ...jest.requireActual('../../crypto/encrypt'),
  encryptSymmetric: jest.fn(() => new Uint8Array([9, 9, 9])),
}));

import { log } from '../../logger';
import { MAX_BLOB_BYTES } from '../blobRef';
import { uploadEncryptedBlob } from '../mediaBlob';

const info = log.info as jest.Mock;
const warn = log.warn as jest.Mock;

/** Сколько раз в журнал попала запись с таким событием. */
const times = (m: jest.Mock, event: string): number =>
  m.mock.calls.filter((c) => c[0] === event).length;

beforeEach(() => {
  jest.clearAllMocks();
  mockFileSize = null;
  mockFileBytes = 3_000;
  mockReads = [];
  mockCloudOk = true;
  mockCacheWriteOk = true;
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ attachment: { url: `${mockRelay}/file/aa.bin` } }),
  })) as unknown as typeof fetch;
});

describe('чтение файла ограничено, когда размер неизвестен', () => {
  it('система размер не сообщила — читается предел плюс байт, не весь файл', async () => {
    mockFileSize = null;
    await uploadEncryptedBlob('file:///doc/a.bin');
    expect(mockReads).toHaveLength(1);
    expect(mockReads[0]).toMatchObject({ position: 0, length: MAX_BLOB_BYTES + 1 });
  });

  it('проверка не пустая: с известным размером ограничение не нужно', async () => {
    // Обратная сторона: если бы проверка выше срабатывала на любом чтении,
    // она не отличала бы починенную ветку от соседней.
    mockFileSize = 3_000;
    await uploadEncryptedBlob('file:///doc/a.bin');
    expect(mockReads).toHaveLength(1);
    expect(mockReads[0]?.length).toBeUndefined();
  });

  it('файл сверх предела отвергается, а не уходит в память целиком', async () => {
    mockFileSize = null;
    mockFileBytes = MAX_BLOB_BYTES * 3;
    const ref = await uploadEncryptedBlob('file:///doc/big.bin');
    expect(ref).toBeNull();
    // Прочитано ровно «предел плюс байт» — лишний байт и выдал превышение.
    expect(mockReads[0]).toMatchObject({ length: MAX_BLOB_BYTES + 1 });
    expect(times(warn, 'blob_upload_bad_size')).toBe(1);
  });
});

describe('отказ сервера не записывается как успех', () => {
  it('облачная копия отвергнута — «ok» в журнал не идёт', async () => {
    mockCloudOk = false;
    await uploadEncryptedBlob('file:///doc/a.bin');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(times(info, 'blob_upload_cloud_ok')).toBe(0);
    expect(times(warn, 'blob_upload_cloud_rejected')).toBe(1);
  });

  it('проверка не пустая: принятая копия «ok» получает', async () => {
    mockCloudOk = true;
    await uploadEncryptedBlob('file:///doc/a.bin');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(times(info, 'blob_upload_cloud_ok')).toBe(1);
    expect(times(warn, 'blob_upload_cloud_rejected')).toBe(0);
  });
});

describe('неудачная запись кэша видна', () => {
  it('кэш не записался — отправка идёт, но об этом сказано', async () => {
    mockCacheWriteOk = false;
    const ref = await uploadEncryptedBlob('file:///doc/a.bin');
    expect(ref).not.toBeNull();
    expect(times(warn, 'blob_cache_write_failed')).toBe(1);
  });

  it('проверка не пустая: удачная запись молчит', async () => {
    mockCacheWriteOk = true;
    await uploadEncryptedBlob('file:///doc/a.bin');
    expect(times(warn, 'blob_cache_write_failed')).toBe(0);
  });
});
