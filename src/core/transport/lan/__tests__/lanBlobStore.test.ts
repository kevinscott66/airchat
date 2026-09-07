/**
 * Запись принятого по LAN вложения в кэш (v4.32.617).
 *
 * Собранные чанки накопитель забывает сразу после сборки, а протокола
 * повторного запроса blob'а нет. Значит запись в кэш — единственная копия
 * принятого вложения, и её неудача равна потере вложения. До правки
 * lanBlobCacheWrite отдавала Promise<void>, и приёмник писал в журнал
 * `lan_blob_recv_ok` независимо от того, легли байты на диск или нет.
 */
let mockWriteFails = false;
let mockExists = false;

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async () => ({ exists: mockExists, size: mockExists ? 10 : 0 })),
  writeAsStringAsync: jest.fn(async () => {
    if (mockWriteFails) throw new Error('disk full');
  }),
  deleteAsync: jest.fn(async () => undefined),
}));

jest.mock('../../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { log } from '../../../logger';
import { encodeLanBlobChunk } from '../lanBlobAssembly';
import { lanBlobCacheWrite, receiveLanBlobFrame } from '../lanBlob';

const info = log.info as jest.Mock;
const warn = log.warn as jest.Mock;

const times = (m: jest.Mock, event: string): number =>
  m.mock.calls.filter((c) => c[0] === event).length;

const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
/** Те же 16 байт, что и ID: кадр несёт их сырыми. */
const ID_BYTES = new Uint8Array(ID.match(/../g)!.map((h) => parseInt(h, 16)));

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteFails = false;
  mockExists = false;
});

describe('lanBlobCacheWrite сообщает результат', () => {
  it('запись удалась — true', async () => {
    await expect(lanBlobCacheWrite(ID, new Uint8Array([1, 2, 3]))).resolves.toBe(true);
  });

  it('диск отказал — false, но исключение наружу не идёт', async () => {
    mockWriteFails = true;
    await expect(lanBlobCacheWrite(ID, new Uint8Array([1, 2, 3]))).resolves.toBe(false);
    expect(times(warn, 'lan_blob_cache_write_failed')).toBe(1);
  });

  it('идентификатор из кадра не по форме — false и никакой записи', async () => {
    await expect(lanBlobCacheWrite('../etc/passwd', new Uint8Array([1]))).resolves.toBe(false);
    expect(times(warn, 'lan_blob_cache_write_bad_id')).toBe(1);
  });
});

describe('приём по LAN не отчитывается об успехе без записи', () => {
  it('запись сорвалась — «принято» в журнал не идёт', async () => {
    mockWriteFails = true;
    const bytes = new Uint8Array([7, 7, 7, 7]);
    await receiveLanBlobFrame(encodeLanBlobChunk(ID_BYTES, 0, 1, bytes.length, bytes));
    expect(times(info, 'lan_blob_recv_ok')).toBe(0);
    expect(times(warn, 'lan_blob_recv_not_stored')).toBe(1);
  });

  it('проверка не пустая: удачная запись «принято» получает', async () => {
    const bytes = new Uint8Array([7, 7, 7, 7]);
    await receiveLanBlobFrame(encodeLanBlobChunk(ID_BYTES, 0, 1, bytes.length, bytes));
    expect(times(info, 'lan_blob_recv_ok')).toBe(1);
    expect(times(warn, 'lan_blob_recv_not_stored')).toBe(0);
  });
});
