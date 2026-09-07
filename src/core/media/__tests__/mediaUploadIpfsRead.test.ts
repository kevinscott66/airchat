/**
 * IPFS-ветка загрузки читает файл неизвестного размера с пределом (v4.32.622).
 *
 * `chooseUploadRoute` нарочно пропускает неизвестный размер — его собственный
 * комментарий обещает, что «читающая сторона проверит размер сама, до чтения
 * байтов в память». На blob-ветке эта проверка есть (v4.32.617), на IPFS-ветке
 * её не было ни до, ни после: файл, о размере которого файловая система
 * промолчала (документ облачного провайдера, поток), читался целиком —
 * base64-строка плюс два двоичных буфера, ~3.4× от файла. Ровно та беда, ради
 * которой этот модуль и заводился.
 */

/** Виртуальный размер файла; null — система размер не сообщает. */
let mockFileSize: number | null = null;
/** Сколько байт «есть на диске»: столько и отдаётся, но не больше запрошенного. */
let mockFileBytes = 0;
/** Аргументы каждого чтения — по ним видно, ограничено ли оно. */
const mockReads: Array<Record<string, unknown> | undefined> = [];

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async () => (mockFileSize === null
    ? { exists: true }
    : { exists: true, size: mockFileSize })),
  readAsStringAsync: jest.fn(async (_uri: string, options?: Record<string, unknown>) => {
    mockReads.push(options);
    const asked = typeof options?.length === 'number' ? (options.length as number) : mockFileBytes;
    // Точная base64 нужных байт: 'A'.repeat(floor(n/3)*4) теряет остаток, а
    // именно лишний байт сверх предела и обязан доехать до проверки.
    return Buffer.alloc(Math.min(asked, mockFileBytes)).toString('base64');
  }),
  writeAsStringAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async () => undefined),
  readDirectoryAsync: jest.fn(async () => []),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: jest.fn(() => true) }));
jest.mock('../../transport/ipfs/node', () => ({
  addToIpfs: jest.fn(async () => 'bafyTEST'),
}));

import { addToIpfs } from '../../transport/ipfs/node';
import { uploadMediaToCid } from '../mediaUpload';

const LIMIT = 1_000_000;
const added = addToIpfs as jest.Mock;

beforeEach(() => {
  mockReads.length = 0;
  added.mockClear();
});

it('размер неизвестен — чтение ограничено пределом маршрута', async () => {
  mockFileSize = null;
  mockFileBytes = 300;

  const res = await uploadMediaToCid('file:///doc.pdf', { ipfsMaxBytes: LIMIT });

  expect(res).toEqual({ ok: true, cid: 'bafyTEST', sizeBytes: null });
  expect(mockReads).toHaveLength(1);
  expect(mockReads[0]).toMatchObject({ position: 0, length: LIMIT + 1 });
});

it('проверка не пустая: с известным размером предел на чтении не нужен', async () => {
  mockFileSize = 300;
  mockFileBytes = 300;

  const res = await uploadMediaToCid('file:///doc.pdf', { ipfsMaxBytes: LIMIT });

  expect(res).toEqual({ ok: true, cid: 'bafyTEST', sizeBytes: 300 });
  expect(mockReads).toHaveLength(1);
  expect(mockReads[0]?.length).toBeUndefined();
  expect(mockReads[0]?.position).toBeUndefined();
});

it('файл неизвестного размера сверх предела отвергается, не дойдя до IPFS', async () => {
  mockFileSize = null;
  mockFileBytes = 2 * LIMIT;

  const res = await uploadMediaToCid('file:///huge.bin', { ipfsMaxBytes: LIMIT });

  expect(res).toEqual({ ok: false, reason: 'oversize', limitBytes: LIMIT });
  // Прочитано ровно на байт больше предела — им превышение и доказывается.
  expect(mockReads[0]).toMatchObject({ position: 0, length: LIMIT + 1 });
  expect(added).not.toHaveBeenCalled();
});

it('проверка не пустая: известный размер сверх предела отвергается без чтения вовсе', async () => {
  mockFileSize = 2 * LIMIT;
  mockFileBytes = 2 * LIMIT;

  const res = await uploadMediaToCid('file:///huge.bin', { ipfsMaxBytes: LIMIT });

  expect(res).toEqual({ ok: false, reason: 'oversize', limitBytes: LIMIT });
  expect(mockReads).toHaveLength(0);
});
