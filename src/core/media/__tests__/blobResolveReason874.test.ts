/**
 * v4.32.874. Нажали на файл — не открылось, и об этом никто не сказал.
 *
 * Дефект. `resolveBlobToLocalFile` отвечал одним `null` на все причины сразу:
 * чужой хост в дескрипторе, ушедшее по сроку вложение с релея, молчащая сеть,
 * непринятый шифротекст, нехватка кэша. Карточка файла в переписке с этим
 * ответом делала ровно одно — `if (!local) return;`, — а её `catch` был пуст.
 *
 * Цена. Человек жмёт на файл: крутилка мигнула и погасла, карточка на месте,
 * сообщения нет. Он жмёт второй и третий раз с тем же итогом. Ни «подождите»,
 * ни «файла больше нет на сервере», ни «попросите отправить снова» — при том,
 * что разбор все эти случаи различает и пишет в свой лог. Вложение на релее
 * живёт часы, а переписка — месяц, так что «файла больше нет» — обычный
 * случай, а не край.
 *
 * Правка. Разбор отвечает причиной (`BlobResolveResult`), карточка эту причину
 * показывает словами (`blobResolveText`). Прежняя форма с `null` оставлена как
 * обёртка — остальным вызывающим причина не нужна. Ни одна причина не
 * называется наугад: когда источники промолчали, говорится «не удалось
 * открыть», и только прямой ответ сервера (404/410) превращается в «больше не
 * хранится».
 */
const mockFiles = new Map<string, string>();
let mockRelay: string | null = 'https://ntfy.sh';
let mockCloudEnabled = false;
let mockCloudBody: Uint8Array | null = null;
const mockLanPaths = new Map<string, string>();
const mockUndecryptable = new Set<string>();
const mockBytesKey = (bytes: Uint8Array | readonly number[]): string => Array.from(bytes).join(',');

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async (uri: string) => {
    const content = mockFiles.get(uri);
    if (content === undefined) return { exists: false };
    return { exists: true, size: content.length };
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
    const content = mockFiles.get(from);
    if (content === undefined) throw new Error('ENOENT');
    mockFiles.set(to, content);
    mockFiles.delete(from);
  }),
  deleteAsync: jest.fn(async (uri: string) => { mockFiles.delete(uri); }),
  readDirectoryAsync: jest.fn(async () => []),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../../transport/internet/internetTransport', () => ({
  getInternetTransportSingleton: jest.fn(() => ({ getStatus: () => ({ relay: mockRelay }) })),
}));
jest.mock('../../config', () => ({
  getConfigSync: jest.fn(() => ({
    internet: { relayBase: 'https://ntfy.sh' },
    cloudBackup: { enabled: mockCloudEnabled },
  })),
}));
jest.mock('../../backup/seedPhrase', () => ({
  getMnemonicGeneration: jest.fn(() => 1),
  getStoredMnemonic: jest.fn(async () => 'слова'),
  deriveKeyPairFromMnemonic: jest.fn(() => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) })),
}));
jest.mock('../../sync/syncApi', () => ({
  uploadSyncMedia: jest.fn(async () => undefined),
  downloadSyncMedia: jest.fn(async () => mockCloudBody),
}));
jest.mock('../../transport/lan/lanBlob', () => ({
  lanBlobCachedPath: jest.fn(async (idHex: string) => mockLanPaths.get(idHex) ?? null),
  lanBlobCacheDelete: jest.fn(async (idHex: string) => { mockLanPaths.delete(idHex); }),
}));
jest.mock('../../crypto/encrypt', () => ({
  ...jest.requireActual('../../crypto/encrypt'),
  encryptSymmetric: jest.fn(() => new Uint8Array([9, 9, 9])),
  decryptSymmetric: jest.fn((_key: Uint8Array, cipher: Uint8Array) =>
    (mockUndecryptable.has(mockBytesKey(cipher)) ? null : new Uint8Array([1, 2, 3]))),
}));

import fs from 'fs';
import path from 'path';
import { Buffer } from 'buffer';

import {
  resolveBlobToLocalFile,
  resolveBlobToLocalFileResult,
  type BlobResolveFailure,
} from '../mediaBlob';
import { blobResolveText } from '../blobResolveText';

const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const CIPHER_B64 = Buffer.from([1, 2, 3, 4]).toString('base64');

/** Ответ релея с телом. */
function okResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body,
  } as unknown as Response;
}

/** Ответ релея без тела: сервер сказал, чего у него нет. */
function errResponse(status: number): Response {
  return { ok: false, status, headers: { get: () => null }, text: async () => '' } as unknown as Response;
}

let mockFetch: jest.Mock;
let counter = 0;
/** Каждый раз новый ключ: одинаковые дескрипторы делят кэш и полёт запроса. */
const freshKey = (): string => Buffer.alloc(32, (counter += 1) % 200).toString('base64');

beforeEach(() => {
  mockFiles.clear();
  mockRelay = 'https://ntfy.sh';
  mockCloudEnabled = false;
  mockCloudBody = null;
  mockLanPaths.clear();
  mockUndecryptable.clear();
  mockFetch = jest.fn(async () => okResponse(CIPHER_B64));
  (global as unknown as { fetch: unknown }).fetch = mockFetch;
});

/** Кусок исходника карточки файла. */
const DOC = (): string => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'chat-components', 'DocBubble.tsx'),
  'utf8',
);

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** Тело обработчика от его объявления до закрывающей скобки формы. */
function handler(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = async (): Promise<void> => {`);
  expect(at).toBeGreaterThan(0);
  const end = src.indexOf('\n  };', at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('карточка файла по-прежнему единственный вход к вложению', () => {
    const c = codeOnly(DOC());
    expect(c).toContain('const blobRef = parseNbCid(meta.cid);');
    for (const name of ['playBlobVideo', 'openBlobDoc']) {
      expect([name, handler(c, name).includes('resolveBlobToLocalFile')]).toEqual([name, true]);
    }
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('крутилка по-прежнему гаснет в finally: сама по себе она ничего не говорит', () => {
    const c = codeOnly(DOC());
    for (const name of ['playBlobVideo', 'openBlobDoc']) {
      expect([name, handler(c, name).includes('setOpening(false);')]).toEqual([name, true]);
    }
  });

  it('причин отказа и правда несколько — разбор их сам различает в логе', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'mediaBlob.ts'), 'utf8');
    for (const mark of [
      'blob_download_foreign_host',
      'blob_download_http_err',
      'blob_download_relay_unreachable',
      'blob_download_bad_key',
      'blob_download_decrypt_failed',
    ]) {
      expect([mark, src.includes(mark)]).toEqual([mark, true]);
    }
  });
});

describe('разбор называет причину, а не молчит', () => {
  it('удача отдаёт файл', async () => {
    const res = await resolveBlobToLocalFileResult({ u: 'https://ntfy.sh/file/a.bin', k: freshKey() }, 'jpg');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.uri).toMatch(/^file:\/\/\/cache\/airchat_media_.+\.jpg$/);
  });

  it('чужой хост: ходить туда нельзя, и это не «попробуйте ещё раз»', async () => {
    const res = await resolveBlobToLocalFileResult({ u: 'https://schetchik.example/f', k: freshKey() }, 'jpg');
    expect(res).toEqual({ ok: false, reason: 'blocked-host' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('сервер ответил, что файла нет: вложение ушло по сроку', async () => {
    mockFetch.mockImplementation(async () => errResponse(404));
    const res = await resolveBlobToLocalFileResult({ u: 'https://ntfy.sh/file/b.bin', k: freshKey() }, 'jpg');
    expect(res).toEqual({ ok: false, reason: 'gone' });
  });

  it('сервер ответил не тем: это повторимо, и «файла нет» тут было бы враньём', async () => {
    mockFetch.mockImplementation(async () => errResponse(502));
    const res = await resolveBlobToLocalFileResult({ u: 'https://ntfy.sh/file/c.bin', k: freshKey() }, 'jpg');
    expect(res).toEqual({ ok: false, reason: 'offline' });
  });

  it('сеть не ответила вовсе', async () => {
    mockFetch.mockImplementation(async () => { throw new Error('network down'); });
    const res = await resolveBlobToLocalFileResult({ u: 'https://ntfy.sh/file/d.bin', k: freshKey() }, 'jpg');
    expect(res).toEqual({ ok: false, reason: 'offline' });
  });

  it('ключ в конверте не того размера', async () => {
    const res = await resolveBlobToLocalFileResult(
      { u: 'https://ntfy.sh/file/e.bin', k: Buffer.alloc(8, 3).toString('base64') },
      'jpg',
    );
    expect(res).toEqual({ ok: false, reason: 'bad-key' });
  });

  it('байты пришли, а расшифровка их не приняла', async () => {
    mockUndecryptable.add(mockBytesKey([1, 2, 3, 4]));
    const res = await resolveBlobToLocalFileResult({ u: 'https://ntfy.sh/file/f.bin', k: freshKey() }, 'jpg');
    expect(res).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('испорченное важнее недоступного: повтор тут не поможет', async () => {
    // LAN-кэш отдал байты, которые ключ не открывает, а релей молчит.
    const id = 'ab'.repeat(16);
    mockLanPaths.set(id, 'file:///cache/lan.bin');
    mockFiles.set('file:///cache/lan.bin', Buffer.from([5, 5]).toString('base64'));
    mockUndecryptable.add(mockBytesKey([5, 5]));
    mockFetch.mockImplementation(async () => { throw new Error('network down'); });
    const res = await resolveBlobToLocalFileResult({ i: id, u: 'https://ntfy.sh/file/g.bin', k: freshKey() }, 'jpg');
    expect(res).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('не сказал никто — причина не выдумывается', async () => {
    // Ни адреса релея, ни LAN-кэша, ни облачной копии: спросить было некого.
    const res = await resolveBlobToLocalFileResult({ i: 'cd'.repeat(16), k: freshKey() }, 'jpg');
    expect(res).toEqual({ ok: false, reason: 'unknown' });
  });

  it('прежняя форма с null осталась для тех, кому причина не нужна', async () => {
    await expect(
      resolveBlobToLocalFile({ u: 'https://schetchik.example/f', k: freshKey() }, 'jpg'),
    ).resolves.toBeNull();
    await expect(
      resolveBlobToLocalFile({ u: 'https://ntfy.sh/file/h.bin', k: freshKey() }, 'jpg'),
    ).resolves.not.toBeNull();
  });
});

describe('причина словами: ничего лишнего и ничего выдуманного', () => {
  const ALL: readonly BlobResolveFailure[] = [
    'unsupported', 'bad-key', 'blocked-host', 'offline', 'gone', 'corrupt', 'storage', 'unknown',
  ];

  it('у каждой причины свой текст, и все они разные', () => {
    const texts = ALL.map((r) => blobResolveText(r, 'file'));
    expect(new Set(texts).size).toBe(ALL.length);
    for (const t of texts) expect(t.length).toBeGreaterThan(20);
  });

  it('род вложения не ломает фразу: «видео не открылся» получиться не может', () => {
    for (const subject of ['file', 'video', 'photo', 'voice'] as const) {
      for (const r of ALL) {
        const t = blobResolveText(r, subject);
        expect([subject, r, /открылся|скачался|сохранился|пришёл/.test(t)]).toEqual([subject, r, false]);
      }
    }
  });

  it('«больше не хранится» говорится только там, где сервер ответил об этом', () => {
    expect(blobResolveText('gone', 'file')).toContain('больше не хранится');
    for (const r of ALL.filter((x) => x !== 'gone')) {
      expect([r, blobResolveText(r, 'file').includes('больше не хранится')]).toEqual([r, false]);
    }
  });

  it('там, где причина неизвестна, её и не называют', () => {
    const t = blobResolveText('unknown', 'file');
    expect(t).toContain('Попробуйте ещё раз');
    expect(t).not.toMatch(/сервер|сеть|повреж|ключ/);
  });

  it('повторять советуют только там, где это осмысленно', () => {
    for (const r of ['gone', 'corrupt', 'bad-key'] as const) {
      expect([r, blobResolveText(r, 'file').includes('Попробуйте ещё раз')]).toEqual([r, false]);
      expect([r, blobResolveText(r, 'file').includes('Попросите отправить снова')]).toEqual([r, true]);
    }
    expect(blobResolveText('offline', 'file')).toContain('Попробуйте ещё раз');
  });
});

describe('карточка файла перестала молчать', () => {
  it('оба обработчика показывают причину', () => {
    const c = codeOnly(DOC());
    for (const [name, subject] of [['playBlobVideo', 'video'], ['openBlobDoc', 'file']] as const) {
      const b = handler(c, name);
      expect([name, b.includes('resolveBlobToLocalFileResult(')]).toEqual([name, true]);
      expect([name, b.includes(`showError(blobResolveText(res.reason, '${subject}'));`)]).toEqual([name, true]);
    }
  });

  it('прежнего немого выхода не осталось', () => {
    const c = codeOnly(DOC());
    expect(c).not.toContain('if (!local) return;');
    // Пустой `catch` — тот же немой выход, только через исключение.
    expect(c).not.toMatch(/catch \{/);
    for (const name of ['playBlobVideo', 'openBlobDoc']) {
      const b = handler(c, name);
      expect([name, b.includes("blobResolveText('unknown'")]).toEqual([name, true]);
    }
  });

  it('нечем открыть файл — это тоже сказано, а не тишина', () => {
    const b = handler(codeOnly(DOC()), 'openBlobDoc');
    expect(b).toContain('if (!(await sharing.isAvailableAsync())) {');
    expect(b).toContain("showError('На этом устройстве нечем открыть файл');");
  });
});
